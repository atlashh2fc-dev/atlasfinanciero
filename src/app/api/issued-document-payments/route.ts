import { NextRequest, NextResponse } from "next/server";
import { requireOrganizationExpenseReadAccess, requireOrganizationFinanceAccess, isUuid } from "@/lib/admin-access";
import { parseWholeClpAmount } from "@/lib/clp";

const allowedMimeTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);

function readDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : null;
}

function readAmount(value: unknown) {
  return parseWholeClpAmount(value);
}

function readText(value: unknown, maxLength: number) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length <= maxLength ? text || null : undefined;
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!isUuid(organizationId))
    return NextResponse.json({ error: "invalid_organization" }, { status: 400 });

  const context = await requireOrganizationExpenseReadAccess(organizationId);
  if (context.error || !context.supabase)
    return NextResponse.json({ error: context.error }, { status: context.status });

  const paymentId = request.nextUrl.searchParams.get("paymentId");
  if (paymentId) {
    if (!isUuid(paymentId))
      return NextResponse.json({ error: "invalid_payment" }, { status: 400 });
    const { data: payment, error } = await context.supabase
      .from("issued_document_payments")
      .select("proof_path")
      .eq("id", paymentId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (error || !payment?.proof_path)
      return NextResponse.json({ error: "payment_proof_not_found" }, { status: 404 });
    const { data: signed, error: signedError } = await context.supabase.storage
      .from("issued-document-files")
      .createSignedUrl(payment.proof_path, 60);
    if (signedError || !signed)
      return NextResponse.json({ error: "unable_to_open_payment_proof" }, { status: 409 });
    return NextResponse.json({ signedUrl: signed.signedUrl });
  }

  const { data, error } = await context.supabase
    .from("issued_document_payments")
    .select("id, organization_id, issued_document_id, payment_execution_id, amount, paid_on, payment_method, notes, proof_path, proof_name, proof_mime_type, proof_size, created_at")
    .eq("organization_id", organizationId)
    .order("paid_on", { ascending: false })
    .order("created_at", { ascending: false });
  if (error)
    return NextResponse.json({ error: "unable_to_load_issued_document_payments" }, { status: 500 });
  return NextResponse.json({ payments: data ?? [] });
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data"))
    return NextResponse.json({ error: "multipart_payment_required" }, { status: 400 });

  const form = await request.formData();
  const organizationId = form.get("organizationId");
  const issuedDocumentId = form.get("issuedDocumentId");
  const amount = readAmount(form.get("amount"));
  const paidOn = readDate(form.get("paidOn"));
  const paymentMethod = readText(form.get("paymentMethod"), 120);
  const notes = readText(form.get("notes"), 2_000);
  const idempotencyKey =
    form.get("idempotencyKey") ?? request.headers.get("idempotency-key");
  const proof = form.get("proof");
  if (!isUuid(organizationId) || !isUuid(issuedDocumentId) || !isUuid(idempotencyKey) || !amount || !paidOn || paymentMethod === undefined || notes === undefined || (proof !== null && !(proof instanceof File)))
    return NextResponse.json({ error: "invalid_issued_document_payment" }, { status: 400 });
  if (proof instanceof File && (proof.size === 0 || proof.size > 52_428_800 || !allowedMimeTypes.has(proof.type)))
    return NextResponse.json({ error: "invalid_payment_proof" }, { status: 400 });

  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase || !context.user)
    return NextResponse.json({ error: context.error }, { status: context.status });

  const { data: document, error: documentError } = await context.supabase
    .from("issued_documents")
    .select("id, total_amount")
    .eq("id", issuedDocumentId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (documentError)
    return NextResponse.json({ error: "unable_to_read_document" }, { status: 500 });
  if (!document)
    return NextResponse.json({ error: "document_not_found" }, { status: 404 });

  const proofName = proof instanceof File
    ? proof.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "comprobante"
    : null;
  const proofPath = proof instanceof File && proofName
    ? `${organizationId}/issued-payment-installments/${idempotencyKey}-${proofName}`
    : null;
  let uploadedProof = false;
  if (proof instanceof File && proofPath) {
    const { error } = await context.supabase.storage
      .from("issued-document-files")
      .upload(proofPath, proof, { contentType: proof.type, upsert: false });
    const isExistingIdempotentProof = /already exists|duplicate/i.test(
      error?.message ?? "",
    );
    if (error && !isExistingIdempotentProof)
      return NextResponse.json({ error: "unable_to_upload_payment_proof" }, { status: 409 });
    uploadedProof = !error;
  }

  const { data: receiptRows, error: receiptError } = await context.supabase.rpc(
    "record_issued_receipt",
    {
      p_organization_id: organizationId,
      p_issued_document_id: issuedDocumentId,
      p_amount: amount,
      p_payment_date: paidOn,
      p_payment_method: paymentMethod,
      p_proof_path: proofPath,
      p_notes: notes,
      p_proof_name: proof instanceof File ? proof.name.slice(0, 300) : null,
      p_proof_mime_type: proof instanceof File ? proof.type : null,
      p_proof_size: proof instanceof File ? proof.size : null,
      p_idempotency_key: idempotencyKey,
    },
  );
  const receipt = Array.isArray(receiptRows) ? receiptRows[0] : receiptRows;
  if (receiptError || !receipt) {
    if (proofPath && uploadedProof)
      await context.supabase.storage.from("issued-document-files").remove([proofPath]);
    const message = receiptError?.message ?? "";
    const error = /exceeds|outstanding balance|overpayment/i.test(message)
      ? "payment_exceeds_outstanding_balance"
      : /not found/i.test(message)
        ? "document_not_found"
        : /not collectible|status|factoring|cancel/i.test(message)
          ? "document_not_collectible"
          : /whole|integer|CLP/i.test(message)
            ? "invalid_issued_document_payment"
            : "unable_to_create_issued_document_payment";
    return NextResponse.json(
      { error },
      { status: error === "document_not_found" ? 404 : error === "unable_to_create_issued_document_payment" ? 500 : 409 },
    );
  }

  const { data: payment, error: paymentError } = await context.supabase
    .from("issued_document_payments")
    .select("id, organization_id, issued_document_id, payment_execution_id, amount, paid_on, payment_method, notes, proof_path, proof_name, proof_mime_type, proof_size, created_at")
    .eq("id", receipt.payment_id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (paymentError)
    return NextResponse.json(
      { error: "payment_registered_but_projection_unavailable", receipt },
      { status: 201 },
    );

  return NextResponse.json(
    {
      payment: payment ?? {
        id: receipt.payment_id,
        organization_id: organizationId,
        issued_document_id: issuedDocumentId,
        payment_execution_id: receipt.payment_execution_id,
        amount,
        paid_on: paidOn,
        payment_method: paymentMethod,
        notes,
        proof_path: proofPath,
      },
      document: {
        id: receipt.issued_document_id,
        payment_status: receipt.collection_status,
      },
      balance: {
        settlement_amount: receipt.settlement_amount,
        paid_amount: receipt.paid_amount,
        outstanding_amount: receipt.outstanding_amount,
      },
    },
    { status: 201 },
  );
}
