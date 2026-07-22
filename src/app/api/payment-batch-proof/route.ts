import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationFinanceAccess } from "@/lib/admin-access";

const allowedMimeTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function safeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "comprobante";
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const organizationId = form.get("organizationId");
  const batchId = form.get("batchId");
  const paidOn = form.get("paidOn");
  const paymentReference = form.get("paymentReference");
  const file = form.get("file");
  const reference = typeof paymentReference === "string" ? paymentReference.trim() : "";

  if (
    !isUuid(organizationId) ||
    !isUuid(batchId) ||
    !isDate(paidOn) ||
    !(file instanceof File) ||
    file.size === 0 ||
    file.size > 52_428_800 ||
    !allowedMimeTypes.has(file.type) ||
    reference.length > 180
  ) return NextResponse.json({ error: "invalid_payment_proof" }, { status: 400 });

  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase)
    return NextResponse.json({ error: context.error }, { status: context.status });

  const { data: batch, error: batchError } = await context.supabase
    .from("payment_batches")
    .select("id, status")
    .eq("id", batchId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (batchError || !batch)
    return NextResponse.json({ error: "payment_batch_not_found" }, { status: 404 });
  if (batch.status !== "processing")
    return NextResponse.json({ error: "payment_batch_not_ready" }, { status: 409 });

  const storagePath = `${organizationId}/payment-batches/${batchId}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
  const { error: uploadError } = await context.supabase.storage
    .from("direct-payable-files")
    .upload(storagePath, file, { contentType: file.type, upsert: false });
  if (uploadError)
    return NextResponse.json({ error: "unable_to_upload_payment_proof" }, { status: 409 });

  const paidAt = new Date(`${paidOn}T12:00:00.000Z`).toISOString();
  const { data, error } = await context.supabase
    .from("payment_batches")
    .update({
      status: "paid",
      paid_at: paidAt,
      payment_reference: reference || null,
      payment_proof_path: storagePath,
      payment_proof_name: file.name.slice(0, 300),
      payment_proof_mime_type: file.type,
      payment_proof_size: file.size,
    })
    .eq("id", batchId)
    .eq("organization_id", organizationId)
    .eq("status", "processing")
    .select("id, status, paid_at, payment_reference")
    .maybeSingle();
  if (error || !data) {
    await context.supabase.storage.from("direct-payable-files").remove([storagePath]);
    return NextResponse.json({ error: "unable_to_confirm_payment_batch" }, { status: 409 });
  }

  return NextResponse.json({ batch: data });
}
