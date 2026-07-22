import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type DocumentRequest = {
  id?: unknown;
  documentType?: unknown;
  status?: unknown;
  paymentDate?: unknown;
  paymentMethod?: unknown;
  paymentCondition?: unknown;
  notes?: unknown;
  factoringEntity?: unknown;
  factoringCounterpartyId?: unknown;
  factoredAt?: unknown;
  factoringSettledAt?: unknown;
  factoringRecourseAt?: unknown;
};

const writeRoles = new Set(["administrator", "finance", "operations"]);
const paymentConditions = new Set(["advance", "post_service"]);
const paymentStatuses = new Set(["Pendiente", "Abonada", "Pagada", "Factorizada", "Pagada al factoring", "Recomprada al factoring", "Anulada", "Nota de crédito"]);
const documentTypes = new Set(["Factura afecta", "Factura exenta", "Nota de crédito", "Nota de débito"]);

function readText(value: unknown, maxLength: number, required = false) {
  if (value === undefined || value === null) return required ? null : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if ((!text && required) || text.length > maxLength) return null;
  return text || null;
}

function readAmount(value: unknown, required = false) {
  if (value === undefined || value === null || value === "")
    return required ? undefined : null;
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

function readDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : null;
}

function readPaymentCondition(value: unknown) {
  return typeof value === "string" && paymentConditions.has(value)
    ? value
    : null;
}

function readDocumentType(value: unknown, required = false) {
  const raw = readText(value, 100, required);
  if (!raw) return null;
  const normalized = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("es-CL");
  return (
    ({
      factura: "Factura afecta",
      "factura afecta": "Factura afecta",
      "factura exenta": "Factura exenta",
      "nota de credito": "Nota de crédito",
      "nota de debito": "Nota de débito",
    } as Record<string, string>)[normalized] ?? null
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) return NextResponse.json({ error: "multipart_document_required" }, { status: 400 });
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { error: "authentication_required" },
      { status: 401 },
    );

  const form = await request.formData();
  const issueDate = readDate(form.get("issueDate"));
  const dueDate = readDate(form.get("dueDate"));
  const documentType = readDocumentType(form.get("documentType"), true);
  const issuerName = readText(form.get("issuerName"), 250, true);
  const issuerTaxId = readText(form.get("issuerTaxId"), 40);
  const status = readText(form.get("status"), 80, true);
  const clientId = form.get("clientId");
  const contactId = form.get("contactId");
  const netAmount = readAmount(form.get("netAmount"), true);
  const paymentCondition = readPaymentCondition(form.get("paymentCondition"));
  const invoiceNumber = readText(form.get("invoiceNumber"), 80, true);
  const upload = form.get("file");
  const paymentProof = form.get("paymentProof");
  const requiresPaymentCondition = documentType?.startsWith("Factura");
  if (!invoiceNumber || !issueDate || !documentType || !issuerName || !documentTypes.has(documentType) || !paymentStatuses.has(status ?? "") || status === "Abonada" || !isUuid(clientId) || (contactId && !isUuid(contactId)) || typeof netAmount !== "number" || (requiresPaymentCondition && (!paymentCondition || !dueDate)) || (upload !== null && !(upload instanceof File))) return NextResponse.json({ error: "invalid_document" }, { status: 400 });
  if (upload instanceof File && (upload.size === 0 || upload.size > 52_428_800 || !new Set(["application/pdf", "image/jpeg", "image/png"]).has(upload.type))) return NextResponse.json({ error: "invalid_document_attachment" }, { status: 400 });
  if (paymentProof !== null && !(paymentProof instanceof File)) return NextResponse.json({ error: "invalid_payment_proof" }, { status: 400 });
  if (paymentProof instanceof File && (paymentProof.size === 0 || paymentProof.size > 52_428_800 || !new Set(["application/pdf", "image/jpeg", "image/png"]).has(paymentProof.type))) return NextResponse.json({ error: "invalid_payment_proof" }, { status: 400 });
  if (status === "Pagada" && !(paymentProof instanceof File)) return NextResponse.json({ error: "payment_proof_required" }, { status: 400 });

  const { data: memberships, error: membershipsError } = await supabase
    .from("organization_memberships")
    .select("organization_id, role")
    .eq("user_id", user.id);
  if (membershipsError)
    return NextResponse.json(
      { error: "unable_to_read_memberships" },
      { status: 500 },
    );

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("active_organization_id")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError)
    return NextResponse.json(
      { error: "unable_to_read_active_organization" },
      { status: 500 },
    );

  const eligibleMemberships = (memberships ?? []).filter((membership) =>
    writeRoles.has(membership.role),
  );
  const membership = eligibleMemberships.find((item) => item.organization_id === profile?.active_organization_id) ?? (eligibleMemberships.length === 1 ? eligibleMemberships[0] : null);

  if (!membership) {
    return NextResponse.json(
      {
        error:
          eligibleMemberships.length > 1
            ? "organization_selection_required"
            : "document_write_not_authorized",
      },
      { status: 403 },
    );
  }

  const [{ data: organization, error: organizationError }, { data: client, error: clientError }] = await Promise.all([
    supabase.from("organizations").select("legal_name, tax_id").eq("id", membership.organization_id).maybeSingle(),
    supabase.from("counterparties").select("id, legal_name, trade_name, tax_id").eq("id", clientId).eq("organization_id", membership.organization_id).in("kind", ["customer", "both"]).eq("is_active", true).maybeSingle(),
  ]);
  if (organizationError || clientError || !organization || !client) return NextResponse.json({ error: "issuer_or_customer_not_found" }, { status: 400 });
  const { data: contact, error: contactError } = contactId ? await supabase.from("counterparty_contacts").select("id, full_name").eq("id", contactId).eq("counterparty_id", client.id).eq("organization_id", membership.organization_id).maybeSingle() : { data: null, error: null };
  if (contactError || (contactId && !contact)) return NextResponse.json({ error: "customer_contact_not_found" }, { status: 400 });

  const vatAmount = documentType === "Factura afecta" ? Math.round(netAmount * 0.19 * 100) / 100 : 0;
  const totalAmount = Math.round((netAmount + vatAmount) * 100) / 100;
  const safeName = upload instanceof File ? upload.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "factura" : null;
  const attachmentPath = upload instanceof File ? `${membership.organization_id}/${client.id}/${crypto.randomUUID()}-${safeName}` : null;
  const paymentProofName = paymentProof instanceof File ? paymentProof.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "comprobante" : null;
  const paymentProofPath = paymentProof instanceof File && paymentProofName ? `${membership.organization_id}/issued-payments/${crypto.randomUUID()}-${paymentProofName}` : null;
  if (upload instanceof File && attachmentPath) {
    const { error } = await supabase.storage.from("issued-document-files").upload(attachmentPath, upload, { contentType: upload.type, upsert: false });
    if (error) return NextResponse.json({ error: "unable_to_upload_document_attachment" }, { status: 409 });
  }
  if (paymentProof instanceof File && paymentProofPath) {
    const { error } = await supabase.storage.from("issued-document-files").upload(paymentProofPath, paymentProof, { contentType: paymentProof.type, upsert: false });
    if (error) {
      if (attachmentPath) await supabase.storage.from("issued-document-files").remove([attachmentPath]);
      return NextResponse.json({ error: "unable_to_upload_payment_proof" }, { status: 409 });
    }
  }

  const { data, error } = await supabase
    .from("issued_documents")
    .insert({
      organization_id: membership.organization_id,
      counterparty_id: client.id,
      document_number: invoiceNumber,
      issue_date: issueDate,
      document_type: documentType,
      issuer_name: issuerName,
      issuer_tax_id: issuerTaxId,
      client_name: client.trade_name || client.legal_name,
      recipient_name: contact?.full_name || client.trade_name || client.legal_name,
      recipient_tax_id: client.tax_id,
      net_amount: netAmount,
      vat_amount: vatAmount,
      total_amount: totalAmount,
      due_date: dueDate,
      payment_status: status,
      payment_condition: paymentCondition,
      attachment_path: attachmentPath,
      attachment_name: upload instanceof File ? upload.name.slice(0, 300) : null,
      attachment_mime_type: upload instanceof File ? upload.type : null,
      attachment_size: upload instanceof File ? upload.size : null,
      payment_proof_path: paymentProofPath,
      payment_proof_name: paymentProof instanceof File ? paymentProof.name.slice(0, 300) : null,
      payment_proof_mime_type: paymentProof instanceof File ? paymentProof.type : null,
      payment_proof_size: paymentProof instanceof File ? paymentProof.size : null,
      source_file_name: upload instanceof File ? upload.name.slice(0, 300) : "Atlas Financiero",
      source_sheet_name: "Registro manual",
      source_row: 0,
    })
    .select(
      "id, document_number, issue_date, due_date, due_month, document_type, issuer_name, issuer_tax_id, client_name, recipient_name, recipient_tax_id, net_amount, vat_amount, total_amount, payment_status, payment_condition, attachment_path, attachment_name, attachment_mime_type, attachment_size, payment_proof_path, payment_proof_name, payment_proof_mime_type, payment_proof_size, source_file_name, source_sheet_name, source_row",
    )
    .single();

  if (error) {
    if (attachmentPath || paymentProofPath) await supabase.storage.from("issued-document-files").remove([attachmentPath, paymentProofPath].filter((path): path is string => Boolean(path)));
    return NextResponse.json(
      { error: "unable_to_create_document" },
      { status: 403 },
    );
  }
  return NextResponse.json({ document: data }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { error: "authentication_required" },
      { status: 401 },
    );

  const contentType = request.headers.get("content-type") ?? "";
  const form = contentType.includes("multipart/form-data")
    ? await request.formData()
    : null;
  const body = form
    ? ({
        id: form.get("id"),
        documentType: form.get("documentType"),
        status: form.get("status"),
        paymentDate: form.get("paymentDate"),
        paymentMethod: form.get("paymentMethod"),
        paymentCondition: form.get("paymentCondition"),
        notes: form.get("notes"),
        factoringEntity: form.get("factoringEntity"),
        factoringCounterpartyId: form.get("factoringCounterpartyId"),
        factoredAt: form.get("factoredAt"),
        factoringSettledAt: form.get("factoringSettledAt"),
        factoringRecourseAt: form.get("factoringRecourseAt"),
      } satisfies DocumentRequest)
    : ((await request.json().catch(() => null)) as DocumentRequest | null);
  const upload = form?.get("file");
  const paymentProof = form?.get("paymentProof");
  const documentId = body?.id;
  const documentType =
    body?.documentType === undefined
      ? undefined
      : readDocumentType(body.documentType, true);
  const status = readText(body?.status, 80, true);
  const paymentDateValue = body?.paymentDate;
  const paymentDate =
    paymentDateValue === "" ||
    paymentDateValue === null ||
    paymentDateValue === undefined
      ? null
      : readDate(paymentDateValue);
  const factoredAt = body?.factoredAt ? readDate(body.factoredAt) : null;
  const factoringCounterpartyId = body?.factoringCounterpartyId ? (isUuid(body.factoringCounterpartyId) ? body.factoringCounterpartyId : null) : null;
  const factoringSettledAt = body?.factoringSettledAt
    ? readDate(body.factoringSettledAt)
    : null;
  const factoringRecourseAt = body?.factoringRecourseAt
    ? readDate(body.factoringRecourseAt)
    : null;
  if (
    !isUuid(documentId) ||
    !status ||
    !paymentStatuses.has(status) ||
    (documentType !== undefined &&
      (!documentType || !documentTypes.has(documentType))) ||
    (paymentDateValue && !paymentDate) ||
    (body?.factoredAt && !factoredAt) ||
    (body?.factoringSettledAt && !factoringSettledAt) ||
    (body?.factoringRecourseAt && !factoringRecourseAt)
  )
    return NextResponse.json(
      { error: "invalid_document_update" },
      { status: 400 },
    );
  if (paymentProof !== null && paymentProof !== undefined && (!(paymentProof instanceof File) || paymentProof.size === 0 || paymentProof.size > 52_428_800 || !new Set(["application/pdf", "image/jpeg", "image/png"]).has(paymentProof.type)))
    return NextResponse.json({ error: "invalid_payment_proof" }, { status: 400 });
  if (
    upload !== null &&
    upload !== undefined &&
    (!(upload instanceof File) ||
      upload.size === 0 ||
      upload.size > 52_428_800 ||
      !new Set(["application/pdf", "image/jpeg", "image/png"]).has(
        upload.type,
      ))
  )
    return NextResponse.json(
      { error: "invalid_document_attachment" },
      { status: 400 },
    );
  if (
    (status === "Factorizada" ||
      status === "Pagada al factoring" ||
      status === "Recomprada al factoring") &&
    !factoringCounterpartyId
  )
    return NextResponse.json(
      { error: "factoring_entity_required" },
      { status: 400 },
    );

  const { data: memberships, error: membershipsError } = await supabase
    .from("organization_memberships")
    .select("organization_id, role")
    .eq("user_id", user.id);
  if (membershipsError)
    return NextResponse.json(
      { error: "unable_to_read_memberships" },
      { status: 500 },
    );

  const eligibleOrganizationIds = (memberships ?? [])
    .filter((membership) => writeRoles.has(membership.role))
    .map((membership) => membership.organization_id);
  if (!eligibleOrganizationIds.length)
    return NextResponse.json(
      { error: "document_write_not_authorized" },
      { status: 403 },
    );

  const { data: existingDocument, error: existingDocumentError } = await supabase
    .from("issued_documents")
    .select("organization_id, attachment_path, payment_proof_path, document_type, net_amount")
    .eq("id", documentId)
    .in("organization_id", eligibleOrganizationIds)
    .maybeSingle();
  if (existingDocumentError || !existingDocument)
    return NextResponse.json(
      { error: "document_not_found_or_not_authorized" },
      { status: 403 },
    );
  if (status === "Pagada" && !(paymentProof instanceof File) && !existingDocument.payment_proof_path)
    return NextResponse.json({ error: "payment_proof_required" }, { status: 400 });

  const isFactoring = ["Factorizada", "Pagada al factoring", "Recomprada al factoring"].includes(status);
  const { data: factor } = isFactoring
    ? await supabase.from("counterparties").select("id, legal_name, trade_name").eq("id", factoringCounterpartyId!).in("organization_id", eligibleOrganizationIds).in("kind", ["supplier", "both"]).eq("is_active", true).maybeSingle()
    : { data: null };
  if (isFactoring && !factor) return NextResponse.json({ error: "factoring_counterparty_required" }, { status: 400 });
  const factoringEntity = factor ? (factor.trade_name?.trim() || factor.legal_name) : null;

  const safeName =
    upload instanceof File
      ? upload.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) ||
        "factura"
      : null;
  const attachmentPath =
    upload instanceof File && safeName
      ? `${existingDocument.organization_id}/issued/${crypto.randomUUID()}-${safeName}`
      : null;
  const paymentProofName = paymentProof instanceof File ? paymentProof.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "comprobante" : null;
  const paymentProofPath = paymentProof instanceof File && paymentProofName ? `${existingDocument.organization_id}/issued-payments/${crypto.randomUUID()}-${paymentProofName}` : null;
  if (upload instanceof File && attachmentPath) {
    const { error } = await supabase.storage
      .from("issued-document-files")
      .upload(attachmentPath, upload, { contentType: upload.type, upsert: false });
    if (error)
      return NextResponse.json(
        { error: "unable_to_upload_document_attachment" },
        { status: 409 },
      );
  }
  if (paymentProof instanceof File && paymentProofPath) {
    const { error } = await supabase.storage.from("issued-document-files").upload(paymentProofPath, paymentProof, { contentType: paymentProof.type, upsert: false });
    if (error) {
      if (attachmentPath) await supabase.storage.from("issued-document-files").remove([attachmentPath]);
      return NextResponse.json({ error: "unable_to_upload_payment_proof" }, { status: 409 });
    }
  }

  const updatePayload: Record<string, unknown> = {
    payment_status: status,
    payment_date: paymentDate,
    payment_method: readText(body?.paymentMethod, 80),
    payment_condition: readPaymentCondition(body?.paymentCondition),
    notes: readText(body?.notes, 2_000),
    factoring_entity: factoringEntity,
    factoring_counterparty_id: factor?.id ?? null,
    factored_at: factoredAt,
    factoring_settled_at: factoringSettledAt,
    factoring_recourse_at: factoringRecourseAt,
  };
  if (documentType) {
    const netAmount = Number(existingDocument.net_amount ?? 0);
    const vatAmount =
      documentType === "Factura afecta"
        ? Math.round(netAmount * 0.19 * 100) / 100
        : 0;
    updatePayload.document_type = documentType;
    updatePayload.vat_amount = vatAmount;
    updatePayload.total_amount = Math.round((netAmount + vatAmount) * 100) / 100;
  }
  if (upload instanceof File && attachmentPath) {
    updatePayload.attachment_path = attachmentPath;
    updatePayload.attachment_name = upload.name.slice(0, 300);
    updatePayload.attachment_mime_type = upload.type;
    updatePayload.attachment_size = upload.size;
  }
  if (paymentProof instanceof File && paymentProofPath) {
    updatePayload.payment_proof_path = paymentProofPath;
    updatePayload.payment_proof_name = paymentProof.name.slice(0, 300);
    updatePayload.payment_proof_mime_type = paymentProof.type;
    updatePayload.payment_proof_size = paymentProof.size;
  }

  const { data, error } = await supabase
    .from("issued_documents")
    .update(updatePayload)
    .eq("id", documentId)
    .eq("organization_id", existingDocument.organization_id)
    .select(
      "id, organization_id, document_number, issue_date, document_type, issuer_name, issuer_tax_id, client_name, recipient_name, recipient_tax_id, net_amount, vat_amount, total_amount, notes, payment_term_days, due_date, due_month, payment_status, payment_date, payment_method, payment_condition, factoring_entity, factoring_counterparty_id, factored_at, factoring_settled_at, factoring_recourse_at, origin_account_or_tax_id, destination_bank, destination_account, attachment_path, attachment_name, attachment_mime_type, attachment_size, payment_proof_path, payment_proof_name, payment_proof_mime_type, payment_proof_size, source_file_name, source_sheet_name, source_row",
    )
    .maybeSingle();
  if (error || !data) {
    if (attachmentPath || paymentProofPath)
      await supabase.storage.from("issued-document-files").remove([attachmentPath, paymentProofPath].filter((path): path is string => Boolean(path)));
    return NextResponse.json(
      { error: "unable_to_update_document" },
      { status: 403 },
    );
  }
  if (attachmentPath && existingDocument.attachment_path)
    await supabase.storage
      .from("issued-document-files")
      .remove([existingDocument.attachment_path]);
  if (paymentProofPath && existingDocument.payment_proof_path)
    await supabase.storage
      .from("issued-document-files")
      .remove([existingDocument.payment_proof_path]);
  if (isFactoring && factor) {
    const { data: existing } = await supabase.from("direct_payables").select("id").eq("factoring_issued_document_id", data.id).maybeSingle();
    if (!existing) {
      const dueDate = factoringSettledAt ?? factoringRecourseAt ?? data.due_date ?? data.issue_date;
      const { error: payableError } = await supabase.from("direct_payables").insert({
        organization_id: data.organization_id, payable_number: `FAC-${data.id.slice(0, 8).toUpperCase()}`,
        supplier_counterparty_id: factor.id, supplier_name: factoringEntity, category: "other", category_detail: "Factoring",
        description: `Obligación de factoring · documento ${data.document_number ?? "sin folio"}`,
        issue_date: data.issue_date ?? dueDate, due_date: dueDate, currency_code: "CLP", total_amount: data.total_amount ?? 0,
        status: "approved", approved_at: new Date().toISOString(), approved_by: user.id, created_by: user.id,
        notes: `Referencia generada desde documento factorizado ${data.document_number ?? data.id}.`, factoring_issued_document_id: data.id, is_reference: true,
      });
      if (payableError) return NextResponse.json({ error: "unable_to_create_factoring_payable" }, { status: 409 });
    }
  }
  return NextResponse.json({ document: data });
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { error: "authentication_required" },
      { status: 401 },
    );

  const [
    { data: memberships, error: membershipsError },
    { data: profile, error: profileError },
  ] = await Promise.all([
    supabase
      .from("organization_memberships")
      .select("organization_id")
      .eq("user_id", user.id),
    supabase
      .from("profiles")
      .select("active_organization_id")
      .eq("id", user.id)
      .maybeSingle(),
  ]);
  if (membershipsError || profileError)
    return NextResponse.json(
      { error: "unable_to_read_memberships" },
      { status: 500 },
    );

  const organizationIds = (memberships ?? []).map(
    (membership) => membership.organization_id,
  );
  const organizationId =
    profile?.active_organization_id &&
    organizationIds.includes(profile.active_organization_id)
      ? profile.active_organization_id
      : organizationIds.length === 1
        ? organizationIds[0]
        : null;
  if (!organizationId)
    return NextResponse.json(
      {
        error: organizationIds.length
          ? "organization_selection_required"
          : "organization_membership_required",
      },
      { status: 403 },
    );

  const fileId = request.nextUrl.searchParams.get("fileId");
  const fileKind = request.nextUrl.searchParams.get("file") ?? "invoice";
  if (fileId) {
    if (!isUuid(fileId)) return NextResponse.json({ error: "invalid_document_file" }, { status: 400 });
    if (!["invoice", "payment-proof"].includes(fileKind)) return NextResponse.json({ error: "invalid_document_file" }, { status: 400 });
    const { data: document, error } = await supabase.from("issued_documents").select("attachment_path, payment_proof_path").eq("id", fileId).eq("organization_id", organizationId).maybeSingle();
    const path = fileKind === "payment-proof" ? document?.payment_proof_path : document?.attachment_path;
    if (error || !path) return NextResponse.json({ error: "document_file_not_found" }, { status: 404 });
    const { data: signed, error: signedError } = await supabase.storage.from("issued-document-files").createSignedUrl(path, 60);
    if (signedError || !signed) return NextResponse.json({ error: "unable_to_open_document_file" }, { status: 409 });
    return NextResponse.json({ signedUrl: signed.signedUrl });
  }

  const { data, error } = await supabase
    .from("issued_documents")
    .select(
      "id, document_number, issue_date, document_type, issuer_name, issuer_tax_id, client_name, recipient_name, recipient_tax_id, net_amount, vat_amount, total_amount, notes, payment_term_days, due_date, due_month, payment_status, payment_date, payment_method, payment_condition, factoring_entity, factoring_counterparty_id, factored_at, factoring_settled_at, factoring_recourse_at, origin_account_or_tax_id, destination_bank, destination_account, attachment_path, attachment_name, attachment_mime_type, attachment_size, payment_proof_path, payment_proof_name, payment_proof_mime_type, payment_proof_size, source_file_name, source_sheet_name, source_row",
    )
    .eq("organization_id", organizationId)
    .order("issue_date", { ascending: false });
  if (error)
    return NextResponse.json(
      { error: "unable_to_load_documents" },
      { status: 500 },
    );

  return NextResponse.json({ documents: data ?? [] });
}
