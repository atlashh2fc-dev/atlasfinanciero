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

type IncomeHistoryRow = {
  item_kind: "sale" | "collection";
  item_id: string;
  issued_document_id: string;
  document_number: string | null;
  occurred_on: string | null;
  counterpart: string | null;
  amount: number | string | null;
  status: string | null;
  detail: string | null;
  has_proof: boolean;
  created_at: string;
};

type IncomeReference = {
  kind: "sale" | "collection";
  id: string;
  issuedDocumentId: string;
  number: string | null;
  occurredOn: string | null;
  counterpart: string | null;
  amount: number | string | null;
  status: string | null;
  detail: string | null;
  hasProof: boolean;
  createdAt: string;
};

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

function taxId(value: FormDataEntryValue | null) {
  const raw = text(value, 40);
  if (!raw) return null;
  const compact = raw.replace(/[.\s-]+/g, "").toUpperCase();
  return /^[0-9]{7,8}[0-9K]$/.test(compact)
    ? `${compact.slice(0, -1)}-${compact.slice(-1)}`
    : raw;
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
    if (!isUuid(fileId) || !["sale", "cost", "support"].includes(fileKind ?? "")) return NextResponse.json({ error: "invalid_document_file" }, { status: 400 });
    const source = fileKind === "sale"
      ? { table: "issued_documents", bucket: "issued-document-files", path: "attachment_path", name: "attachment_name" }
      : fileKind === "cost"
        ? { table: "received_documents", bucket: "received-document-files", path: "attachment_path", name: "attachment_name" }
        : { table: "data_entry_supporting_documents", bucket: "data-entry-support-files", path: "file_path", name: "file_name" };
    const { data: document, error } = await context.supabase
      .from(source.table)
      .select(`${source.path}, ${source.name}`)
      .eq("id", fileId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    const filePath = document?.[source.path as keyof typeof document];
    const fileName = document?.[source.name as keyof typeof document];
    if (error || typeof filePath !== "string") return NextResponse.json({ error: "document_file_not_found" }, { status: 404 });
    const { data: signed, error: signedError } = await context.supabase.storage
      .from(source.bucket)
      .createSignedUrl(filePath, 60);
    if (signedError || !signed) return NextResponse.json({ error: "unable_to_open_document_file" }, { status: 409 });
    return NextResponse.json({ signedUrl: signed.signedUrl, fileName });
  }

  const [customers, suppliers, costCenters, ownSales, costs, incomeHistory, supportingDocuments] = await Promise.all([
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
      .select("id, attachment_path, attachment_name")
      .eq("organization_id", organizationId)
      .limit(200),
    context.supabase
      .from("received_documents")
      .select("id, document_number, issue_date, document_type, supplier_name, total_amount, payment_status, attachment_path, attachment_name, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(200),
    context.supabase
      .from("data_entry_income_references")
      .select("item_kind, item_id, issued_document_id, document_number, occurred_on, counterpart, amount, status, detail, has_proof, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false }),
    context.supabase
      .from("data_entry_supporting_documents")
      .select("id, category, issued_document_id, issued_document_payment_id, notes, file_name, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);
  if (customers.error || suppliers.error || costCenters.error || ownSales.error || costs.error || incomeHistory.error || supportingDocuments.error) {
    return NextResponse.json({ error: "unable_to_load_data_entry_catalogs" }, { status: 500 });
  }

  const references: IncomeReference[] = ((incomeHistory.data ?? []) as IncomeHistoryRow[]).map((item) => ({
    kind: item.item_kind,
    id: item.item_id,
    issuedDocumentId: item.issued_document_id,
    number: item.document_number,
    occurredOn: item.occurred_on,
    counterpart: item.counterpart,
    amount: item.amount,
    status: item.status,
    detail: item.detail,
    hasProof: Boolean(item.has_proof),
    createdAt: item.created_at,
  }));
  const referenceById = new Map<string, IncomeReference>(references.map((item) => [`${item.kind}:${item.id}`, item]));
  const ownSaleFiles = new Map((ownSales.data ?? []).map((document) => [document.id, document]));

  return NextResponse.json({
    canCreateSuppliers: context.membership?.can_create_suppliers === true,
    customers: customers.data ?? [],
    suppliers: suppliers.data ?? [],
    costCenters: costCenters.data ?? [],
    references,
    entries: [
      ...references.map((item) => ({
        id: item.id,
        kind: item.kind,
        issuedDocumentId: item.issuedDocumentId,
        number: item.number,
        documentType: item.detail,
        counterpart: item.counterpart,
        issuedOn: item.occurredOn,
        amount: item.amount,
        status: item.status,
        attachmentName: item.kind === "sale" ? ownSaleFiles.get(item.id)?.attachment_name ?? null : null,
        hasAttachment: item.kind === "sale" && Boolean(ownSaleFiles.get(item.id)?.attachment_path),
        existingProof: item.hasProof,
        createdAt: item.createdAt,
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
        existingProof: false,
        createdAt: document.created_at,
      })),
      ...(supportingDocuments.data ?? []).map((document) => {
        const targetKind = document.category === "collection" ? "collection" : "sale";
        const targetId = document.category === "collection" ? document.issued_document_payment_id : document.issued_document_id;
        const target = targetId ? referenceById.get(`${targetKind}:${targetId}`) : null;
        return {
          id: document.id,
          kind: "support" as const,
          issuedDocumentId: document.issued_document_id,
          number: target?.number ?? "Sin referencia",
          documentType: document.category === "collection" ? "Respaldo de cobro" : "Respaldo de factura",
          counterpart: target?.counterpart ?? null,
          issuedOn: document.created_at.slice(0, 10),
          amount: target?.amount ?? null,
          status: "Cargado",
          attachmentName: document.file_name,
          hasAttachment: true,
          existingProof: true,
          createdAt: document.created_at,
        };
      }),
    ].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  });
}

export async function POST(request: NextRequest) {
  if (!(request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    return NextResponse.json({ error: "multipart_document_required" }, { status: 400 });
  }
  const form = await request.formData();
  const organizationId = form.get("organizationId");
  const action = form.get("action");
  if (!isUuid(organizationId) || !["cost", "support", "create_supplier"].includes(typeof action === "string" ? action : "")) return NextResponse.json({ error: "invalid_data_entry_action" }, { status: 400 });
  const context = await requireOrganizationDataEntryAccess(organizationId);
  if (context.error || !context.supabase || !context.user) return NextResponse.json({ error: context.error }, { status: context.status });

  if (action === "create_supplier") {
    if (context.membership?.can_create_suppliers !== true) {
      return NextResponse.json({ error: "supplier_creation_not_allowed" }, { status: 403 });
    }
    const legalName = text(form.get("legalName"), 250, true);
    const tradeName = text(form.get("tradeName"), 180);
    const supplierTaxId = taxId(form.get("taxId"));
    if (!legalName) return NextResponse.json({ error: "invalid_supplier" }, { status: 400 });

    if (supplierTaxId) {
      const { data: existing, error: existingError } = await context.supabase
        .from("counterparties")
        .select("id, legal_name, trade_name, tax_id, kind, is_active")
        .eq("organization_id", organizationId)
        .eq("tax_id", supplierTaxId)
        .is("merged_into_counterparty_id", null)
        .maybeSingle();
      if (existingError) return NextResponse.json({ error: "unable_to_check_supplier" }, { status: 500 });
      if (existing && ["supplier", "both"].includes(existing.kind) && existing.is_active) {
        return NextResponse.json({
          supplier: {
            id: existing.id,
            legal_name: existing.legal_name,
            trade_name: existing.trade_name,
            tax_id: existing.tax_id,
          },
          created: false,
        });
      }
      if (existing) return NextResponse.json({ error: "tax_id_already_registered" }, { status: 409 });
    }

    const { data: supplier, error } = await context.supabase
      .from("counterparties")
      .insert({
        organization_id: organizationId,
        legal_name: legalName,
        trade_name: tradeName,
        tax_id: supplierTaxId,
        kind: "supplier",
        is_active: true,
        created_by: context.user.id,
      })
      .select("id, legal_name, trade_name, tax_id")
      .single();
    if (error || !supplier) {
      return NextResponse.json({ error: error?.code === "23505" ? "tax_id_already_registered" : "unable_to_create_supplier" }, { status: 409 });
    }
    return NextResponse.json({ supplier, created: true }, { status: 201 });
  }

  if (action === "support") {
    const category = form.get("category");
    const targetId = form.get("targetId");
    const notes = text(form.get("notes"), 2_000);
    const upload = form.get("file");
    if (!["invoice", "collection"].includes(typeof category === "string" ? category : "") || !isUuid(targetId) || !(upload instanceof File) || upload.size === 0 || upload.size > 52_428_800 || !acceptedFileTypes.has(upload.type)) {
      return NextResponse.json({ error: "invalid_supporting_document" }, { status: 400 });
    }

    const expectedKind = category === "collection" ? "collection" : "sale";
    const { data: target, error: targetError } = await context.supabase
      .from("data_entry_income_references")
      .select("item_kind, item_id, issued_document_id")
      .eq("organization_id", organizationId)
      .eq("item_kind", expectedKind)
      .eq("item_id", targetId)
      .maybeSingle();
    if (targetError || !target) return NextResponse.json({ error: "support_target_not_found" }, { status: 404 });

    const safeName = upload.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "respaldo";
    const originalName = upload.name.trim().slice(0, 300) || safeName;
    const filePath = `${organizationId}/${context.user.id}/${crypto.randomUUID()}-${safeName}`;
    const { error: uploadError } = await context.supabase.storage
      .from("data-entry-support-files")
      .upload(filePath, upload, { contentType: upload.type, upsert: false });
    if (uploadError) return NextResponse.json({ error: "unable_to_upload_supporting_document" }, { status: 409 });

    const { data, error } = await context.supabase
      .from("data_entry_supporting_documents")
      .insert({
        organization_id: organizationId,
        category,
        issued_document_id: target.issued_document_id,
        issued_document_payment_id: category === "collection" ? targetId : null,
        notes,
        file_path: filePath,
        file_name: originalName,
        file_mime_type: upload.type,
        file_size: upload.size,
        created_by: context.user.id,
      })
      .select("id")
      .single();
    if (error || !data) {
      await context.supabase.storage.from("data-entry-support-files").remove([filePath]);
      return NextResponse.json({ error: "unable_to_create_supporting_document" }, { status: 409 });
    }
    return NextResponse.json({ supportingDocument: data }, { status: 201 });
  }

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
    if (error?.code === "23505" && error.message.includes("received_documents_business_identity_key")) {
      return NextResponse.json({ error: "duplicate_received_document" }, { status: 409 });
    }
    return NextResponse.json({ error: "unable_to_create_cost_entry" }, { status: 409 });
  }
  return NextResponse.json({ document: data }, { status: 201 });
}
