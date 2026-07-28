import { NextRequest, NextResponse } from "next/server";
import {
  isUuid,
  requireOrganizationDataEntryAccess,
} from "@/lib/admin-access";

const acceptedFileTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);
const receivedDocumentTypes = new Set([
  "Factura afecta",
  "Factura exenta",
  "Nota de crédito",
  "Nota de débito",
  "Boleta",
  "Otro",
]);

function text(value: FormDataEntryValue | null, max: number, required = false) {
  if (typeof value !== "string") return required ? null : null;
  const normalized = value.trim();
  if ((!normalized && required) || normalized.length > max) return null;
  return normalized || null;
}

function date(value: FormDataEntryValue | null) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function amount(value: FormDataEntryValue | null) {
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1_000_000_000_000
    ? Math.round(parsed * 100) / 100
    : null;
}

function dueMonth(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat("es-CL", { month: "long" })
    .format(new Date(`${value}T12:00:00`))
    .replace(/^./, (letter) => letter.toUpperCase());
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_organization" }, { status: 400 });

  const context = await requireOrganizationDataEntryAccess(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });

  const fileId = request.nextUrl.searchParams.get("fileId");
  const fileKind = request.nextUrl.searchParams.get("fileKind");
  if (fileId || fileKind) {
    if (!isUuid(fileId) || !["sale", "cost"].includes(fileKind ?? "")) return NextResponse.json({ error: "invalid_document_file" }, { status: 400 });
    const source = fileKind === "sale"
      ? { table: "issued_documents", bucket: "issued-document-files" }
      : { table: "received_documents", bucket: "received-document-files" };
    const { data: document, error } = await context.supabase
      .from(source.table)
      .select("attachment_path, attachment_name")
      .eq("id", fileId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (error || !document?.attachment_path) return NextResponse.json({ error: "document_file_not_found" }, { status: 404 });
    const { data: signed, error: signedError } = await context.supabase.storage
      .from(source.bucket)
      .createSignedUrl(document.attachment_path, 60);
    if (signedError || !signed) return NextResponse.json({ error: "unable_to_open_document_file" }, { status: 409 });
    return NextResponse.json({ signedUrl: signed.signedUrl, fileName: document.attachment_name });
  }

  const [customers, suppliers, costCenters, sales, costs] = await Promise.all([
    context.supabase
      .from("counterparties")
      .select("id, legal_name, trade_name, tax_id")
      .eq("organization_id", organizationId)
      .in("kind", ["customer", "both"])
      .eq("is_active", true)
      .order("legal_name"),
    context.supabase
      .from("counterparties")
      .select("id, legal_name, trade_name, tax_id")
      .eq("organization_id", organizationId)
      .in("kind", ["supplier", "both"])
      .eq("is_active", true)
      .order("legal_name"),
    context.supabase
      .from("cost_centers")
      .select("id, code, name")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .order("code"),
    context.supabase
      .from("issued_documents")
      .select("id, document_number, issue_date, document_type, client_name, total_amount, payment_status, attachment_path, attachment_name, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(50),
    context.supabase
      .from("received_documents")
      .select("id, document_number, issue_date, document_type, supplier_name, total_amount, payment_status, attachment_path, attachment_name, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  if (customers.error || suppliers.error || costCenters.error || sales.error || costs.error) {
    return NextResponse.json({ error: "unable_to_load_data_entry_catalogs" }, { status: 500 });
  }

  return NextResponse.json({
    customers: customers.data ?? [],
    suppliers: suppliers.data ?? [],
    costCenters: costCenters.data ?? [],
    entries: [
      ...(sales.data ?? []).map((document) => ({
        id: document.id,
        kind: "sale" as const,
        number: document.document_number,
        documentType: document.document_type,
        counterpart: document.client_name,
        issuedOn: document.issue_date,
        amount: document.total_amount,
        status: document.payment_status,
        attachmentName: document.attachment_name,
        hasAttachment: Boolean(document.attachment_path),
        createdAt: document.created_at,
      })),
      ...(costs.data ?? []).map((document) => ({
        id: document.id,
        kind: "cost" as const,
        number: document.document_number,
        documentType: document.document_type,
        counterpart: document.supplier_name,
        issuedOn: document.issue_date,
        amount: document.total_amount,
        status: document.payment_status,
        attachmentName: document.attachment_name,
        hasAttachment: Boolean(document.attachment_path),
        createdAt: document.created_at,
      })),
    ].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  });
}

export async function POST(request: NextRequest) {
  if (!(request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    return NextResponse.json({ error: "multipart_document_required" }, { status: 400 });
  }
  const form = await request.formData();
  const organizationId = form.get("organizationId");
  if (!isUuid(organizationId) || form.get("action") !== "cost") {
    return NextResponse.json({ error: "invalid_cost_entry" }, { status: 400 });
  }
  const context = await requireOrganizationDataEntryAccess(organizationId);
  if (context.error || !context.supabase || !context.user) return NextResponse.json({ error: context.error }, { status: context.status });

  const supplierId = form.get("supplierId");
  const costCenterId = form.get("costCenterId");
  const documentNumber = text(form.get("documentNumber"), 80, true);
  const documentType = text(form.get("documentType"), 80, true);
  const issueDate = date(form.get("issueDate"));
  const dueDate = form.get("dueDate") === "" ? null : date(form.get("dueDate"));
  const netAmount = amount(form.get("netAmount"));
  const vatAmount = amount(form.get("vatAmount"));
  const additionalTaxAmount = amount(form.get("additionalTaxAmount"));
  const notes = text(form.get("notes"), 2_000);
  const upload = form.get("file");

  if (!isUuid(supplierId) || !isUuid(costCenterId) || !documentNumber || !documentType || !receivedDocumentTypes.has(documentType) || !issueDate || (form.get("dueDate") !== "" && !dueDate) || netAmount === null || vatAmount === null || additionalTaxAmount === null || (upload !== null && !(upload instanceof File))) {
    return NextResponse.json({ error: "invalid_cost_entry" }, { status: 400 });
  }
  if (upload instanceof File && (upload.size === 0 || upload.size > 52_428_800 || !acceptedFileTypes.has(upload.type))) {
    return NextResponse.json({ error: "invalid_document_attachment" }, { status: 400 });
  }

  const [{ data: supplier, error: supplierError }, { data: costCenter, error: costCenterError }] = await Promise.all([
    context.supabase
      .from("counterparties")
      .select("id, legal_name, trade_name, tax_id")
      .eq("id", supplierId)
      .eq("organization_id", organizationId)
      .in("kind", ["supplier", "both"])
      .eq("is_active", true)
      .maybeSingle(),
    context.supabase
      .from("cost_centers")
      .select("id")
      .eq("id", costCenterId)
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .maybeSingle(),
  ]);
  if (supplierError || costCenterError || !supplier || !costCenter) {
    return NextResponse.json({ error: "supplier_or_cost_center_not_found" }, { status: 400 });
  }

  const safeName = upload instanceof File
    ? upload.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "documento"
    : null;
  const attachmentPath = safeName
    ? `${organizationId}/received/${context.user.id}/${crypto.randomUUID()}-${safeName}`
    : null;
  if (upload instanceof File && attachmentPath) {
    const { error } = await context.supabase.storage
      .from("received-document-files")
      .upload(attachmentPath, upload, { contentType: upload.type, upsert: false });
    if (error) return NextResponse.json({ error: "unable_to_upload_document_attachment" }, { status: 409 });
  }

  const supplierName = supplier.trade_name?.trim() || supplier.legal_name;
  const { data, error } = await context.supabase
    .from("received_documents")
    .insert({
      organization_id: organizationId,
      supplier_counterparty_id: supplier.id,
      supplier_name: supplierName,
      supplier_tax_id: supplier.tax_id,
      document_number: documentNumber,
      issue_date: issueDate,
      document_type: documentType,
      net_amount: netAmount,
      vat_amount: vatAmount,
      additional_tax_amount: additionalTaxAmount,
      total_amount: Math.round((netAmount + vatAmount + additionalTaxAmount) * 100) / 100,
      notes,
      due_date: dueDate,
      due_month: dueMonth(dueDate),
      payment_status: "Pendiente",
      cost_center_id: costCenter.id,
      attachment_path: attachmentPath,
      attachment_name: upload instanceof File ? upload.name.slice(0, 300) : null,
      attachment_mime_type: upload instanceof File ? upload.type : null,
      attachment_size: upload instanceof File ? upload.size : null,
      source_file_name: `Digitación manual ${crypto.randomUUID()}`,
      source_sheet_name: "Registro manual",
      source_row: 0,
      created_by: context.user.id,
    })
    .select("id")
    .single();

  if (error || !data) {
    if (attachmentPath) await context.supabase.storage.from("received-document-files").remove([attachmentPath]);
    return NextResponse.json({ error: "unable_to_create_cost_entry" }, { status: 409 });
  }
  return NextResponse.json({ document: data }, { status: 201 });
}
