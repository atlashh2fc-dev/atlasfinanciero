import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationFinanceAccess } from "@/lib/admin-access";

type ConsolidationBody = {
  action?: unknown;
  organizationId?: unknown;
  canonicalCounterpartyId?: unknown;
  duplicateCounterpartyIds?: unknown;
  profile?: unknown;
  contacts?: unknown;
};
const contactAreas = new Set(["commercial", "billing", "payments", "collections", "legal", "other"]);

type Supplier = {
  id: string;
  legal_name: string;
  trade_name: string | null;
  tax_id: string | null;
  kind: string;
};

function asAmount(value: number | string | null) {
  return Number(value ?? 0) || 0;
}
function paymentIsSettled(status: string | null) {
  return status?.toLocaleLowerCase("es-CL").includes("pagad") ?? false;
}
function text(value: unknown, maxLength: number, required = false) {
  if (typeof value !== "string") return required ? null : null;
  const result = value.trim();
  return (!result && required) || result.length > maxLength ? null : result || null;
}
function paymentTermDays(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 365 ? parsed : undefined;
}

function displayName(supplier: Pick<Supplier, "legal_name" | "trade_name">) {
  return supplier.trade_name?.trim() || supplier.legal_name;
}

function normalize(value: string) {
  return value
    .toLocaleLowerCase("es-CL")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .replace(/(spa|ltda|limitada|eirl|sa)$/u, "");
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  const supplierId = request.nextUrl.searchParams.get("supplierId");
  const fileId = request.nextUrl.searchParams.get("fileId");
  if (!isUuid(organizationId))
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase)
    return NextResponse.json({ error: context.error }, { status: context.status });

  if (fileId) {
    if (!isUuid(fileId)) return NextResponse.json({ error: "invalid_file" }, { status: 400 });
    const { data: file, error } = await context.supabase.from("customer_files").select("storage_path, counterparty_id").eq("id", fileId).eq("organization_id", organizationId).maybeSingle();
    if (error || !file) return NextResponse.json({ error: "file_not_found" }, { status: 404 });
    const { data: supplier } = await context.supabase.from("counterparties").select("id").eq("id", file.counterparty_id).eq("organization_id", organizationId).in("kind", ["supplier", "both"]).maybeSingle();
    if (!supplier) return NextResponse.json({ error: "file_not_found" }, { status: 404 });
    const { data: signed, error: signedError } = await context.supabase.storage.from("customer-documents").createSignedUrl(file.storage_path, 60);
    if (signedError || !signed) return NextResponse.json({ error: "unable_to_open_file" }, { status: 409 });
    return NextResponse.json({ signedUrl: signed.signedUrl });
  }

  if (supplierId) {
    if (!isUuid(supplierId)) return NextResponse.json({ error: "invalid_supplier" }, { status: 400 });
    const [supplier, contacts, documents, payables, purchaseOrders, financingPlans, files] = await Promise.all([
      context.supabase.from("counterparties").select("id, legal_name, trade_name, tax_id, business_activity, address_line1, commune, city, website, email, phone, payment_term_days, billing_email, billing_phone, legal_representative_name, legal_representative_tax_id, legal_representative_phone, legal_representative_email").eq("id", supplierId).eq("organization_id", organizationId).in("kind", ["supplier", "both"]).eq("is_active", true).is("merged_into_counterparty_id", null).maybeSingle(),
      context.supabase.from("counterparty_contacts").select("id, contact_area, job_title, full_name, phone, email, is_primary").eq("organization_id", organizationId).eq("counterparty_id", supplierId).order("is_primary", { ascending: false }).order("contact_area").order("full_name"),
      context.supabase.from("received_documents").select("id, document_number, document_type, issue_date, due_date, total_amount, payment_status, payment_date, notes, source_file_name").eq("organization_id", organizationId).eq("supplier_counterparty_id", supplierId).order("issue_date", { ascending: false }).limit(100),
      context.supabase.from("direct_payables").select("id, payable_number, invoice_number, category, category_detail, description, issue_date, due_date, total_amount, currency_code, status, paid_at, notes, is_reference, reference_settled_at").eq("organization_id", organizationId).eq("supplier_counterparty_id", supplierId).neq("status", "cancelled").order("issue_date", { ascending: false }).limit(100),
      context.supabase.from("vendor_purchase_orders").select("id, purchase_order_number, ordered_on, expected_on, total_amount, currency_code, status, notes").eq("organization_id", organizationId).eq("supplier_counterparty_id", supplierId).neq("status", "cancelled").order("ordered_on", { ascending: false }).limit(50),
      context.supabase.from("asset_financing_plans").select("id, plan_number, plan_kind, asset_name, contract_reference, first_due_date, financing_total_amount, currency_code, status, notes").eq("organization_id", organizationId).eq("supplier_counterparty_id", supplierId).neq("status", "cancelled").order("created_at", { ascending: false }).limit(50),
      context.supabase.from("customer_files").select("id, file_name, document_type, notes, created_at").eq("organization_id", organizationId).eq("counterparty_id", supplierId).order("created_at", { ascending: false }),
    ]);
    if ([supplier, contacts, documents, payables, purchaseOrders, financingPlans, files].some((result) => result.error)) return NextResponse.json({ error: "unable_to_load_supplier_profile" }, { status: 500 });
    if (!supplier.data) return NextResponse.json({ error: "supplier_not_found" }, { status: 404 });

    const today = new Date().toISOString().slice(0, 10);
    const openDocuments = (documents.data ?? []).filter((document) => !paymentIsSettled(document.payment_status));
    const openPayables = (payables.data ?? []).filter((payable) => !payable.is_reference && payable.status !== "paid" && payable.status !== "rejected");
    const overdueDocuments = openDocuments.filter((document) => document.due_date && document.due_date < today);
    const overduePayables = openPayables.filter((payable) => payable.due_date && payable.due_date < today);
    const alerts = [
      ...(overdueDocuments.length ? [{ level: "critical", message: `${overdueDocuments.length} factura(s) recibida(s) vencida(s).` }] : []),
      ...(overduePayables.length ? [{ level: "critical", message: `${overduePayables.length} cuenta(s) por pagar vencida(s).` }] : []),
      ...(!(contacts.data ?? []).length ? [{ level: "warning", message: "No hay contactos comerciales ni financieros registrados." }] : []),
      ...(!supplier.data.billing_email && !supplier.data.email ? [{ level: "warning", message: "No hay correo de facturación o contacto registrado." }] : []),
      ...(!(files.data ?? []).length && !(financingPlans.data ?? []).some((plan) => plan.contract_reference) && !(documents.data ?? []).some((document) => document.source_file_name) ? [{ level: "info", message: "No hay contrato ni respaldo documental registrado en esta ficha." }] : []),
    ];
    return NextResponse.json({
      supplier: { ...supplier.data, name: displayName(supplier.data), taxId: supplier.data.tax_id },
      contacts: contacts.data ?? [], documents: documents.data ?? [], payables: payables.data ?? [], purchaseOrders: purchaseOrders.data ?? [], financingPlans: financingPlans.data ?? [], files: files.data ?? [], alerts,
      summary: {
        documentCount: (documents.data ?? []).length,
        payableCount: (payables.data ?? []).length,
        openAmount: openDocuments.reduce((total, document) => total + asAmount(document.total_amount), 0) + openPayables.reduce((total, payable) => total + asAmount(payable.total_amount), 0),
        overdueAmount: overdueDocuments.reduce((total, document) => total + asAmount(document.total_amount), 0) + overduePayables.reduce((total, payable) => total + asAmount(payable.total_amount), 0),
      },
    });
  }

  const { data, error } = await context.supabase
    .from("counterparties")
    .select("id, legal_name, trade_name, tax_id, kind")
    .eq("organization_id", organizationId)
    .in("kind", ["supplier", "both"])
    .eq("is_active", true)
    .is("merged_into_counterparty_id", null)
    .order("legal_name");
  if (error) return NextResponse.json({ error: "unable_to_load_suppliers" }, { status: 500 });

  const suppliers = (data ?? []) as Supplier[];
  const grouped = new Map<string, Supplier[]>();
  for (const supplier of suppliers) {
    const key = normalize(displayName(supplier));
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), supplier]);
  }
  const candidates = [...grouped.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([key, members]) => ({
      key,
      members: members.map((supplier) => ({
        id: supplier.id,
        name: displayName(supplier),
        legalName: supplier.legal_name,
        taxId: supplier.tax_id,
      })),
    }));

  return NextResponse.json({
    suppliers: suppliers.map((supplier) => ({
      id: supplier.id,
      name: displayName(supplier),
      legalName: supplier.legal_name,
      taxId: supplier.tax_id,
    })),
    candidates,
  });
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const organizationId = form.get("organizationId");
    const supplierId = form.get("supplierId");
    const upload = form.get("file");
    if (!isUuid(organizationId) || !isUuid(supplierId) || !(upload instanceof File) || upload.size === 0 || upload.size > 52_428_800) return NextResponse.json({ error: "invalid_contract_upload" }, { status: 400 });
    const context = await requireOrganizationFinanceAccess(organizationId);
    if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });
    const { data: supplier } = await context.supabase.from("counterparties").select("id").eq("id", supplierId).eq("organization_id", organizationId).in("kind", ["supplier", "both"]).eq("is_active", true).maybeSingle();
    const allowed = new Set(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword", "image/jpeg", "image/png"]);
    if (!supplier || !allowed.has(upload.type)) return NextResponse.json({ error: "unsupported_contract_type" }, { status: 400 });
    const safeName = upload.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "documento";
    const path = `${organizationId}/${supplierId}/${crypto.randomUUID()}-${safeName}`;
    const { error: storageError } = await context.supabase.storage.from("customer-documents").upload(path, upload, { contentType: upload.type, upsert: false });
    if (storageError) return NextResponse.json({ error: "unable_to_upload_contract" }, { status: 409 });
    const type = form.get("documentType") === "annex" ? "annex" : form.get("documentType") === "other" ? "other" : "contract";
    const { data: record, error } = await context.supabase.from("customer_files").insert({ organization_id: organizationId, counterparty_id: supplierId, file_name: upload.name.slice(0, 300), storage_path: path, mime_type: upload.type, file_size: upload.size, document_type: type, notes: text(form.get("notes"), 2_000) }).select("id").single();
    if (error) { await context.supabase.storage.from("customer-documents").remove([path]); return NextResponse.json({ error: "unable_to_save_contract" }, { status: 409 }); }
    return NextResponse.json({ id: record.id }, { status: 201 });
  }
  const body = (await request.json().catch(() => null)) as ConsolidationBody | null;
  const organizationId = body?.organizationId;
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase)
    return NextResponse.json({ error: context.error }, { status: context.status });

  if (body?.action === "save_supplier") {
    const profile = body.profile as Record<string, unknown> | null;
    const legalName = text(profile?.legalName, 250, true);
    const terms = paymentTermDays(profile?.paymentTermDays);
    const supplierId = profile?.id;
    if (!profile || !legalName || terms === undefined || (supplierId && !isUuid(supplierId))) return NextResponse.json({ error: "invalid_supplier_profile" }, { status: 400 });
    const values = {
      legal_name: legalName, trade_name: text(profile.tradeName, 180), tax_id: text(profile.taxId, 40), business_activity: text(profile.businessActivity, 500), address_line1: text(profile.addressLine1, 300), commune: text(profile.commune, 120), city: text(profile.city, 120), website: text(profile.website, 300), email: text(profile.email, 320), phone: text(profile.phone, 80), payment_term_days: terms, billing_email: text(profile.billingEmail, 320), billing_phone: text(profile.billingPhone, 80), legal_representative_name: text(profile.legalRepresentativeName, 180), legal_representative_tax_id: text(profile.legalRepresentativeTaxId, 40), legal_representative_phone: text(profile.legalRepresentativePhone, 80), legal_representative_email: text(profile.legalRepresentativeEmail, 320), is_active: profile.isActive !== false,
    };
    let counterpartyId: string;
    if (isUuid(supplierId)) {
      const { data: existing, error: existingError } = await context.supabase.from("counterparties").select("id, kind").eq("id", supplierId).eq("organization_id", organizationId).in("kind", ["supplier", "both"]).maybeSingle();
      if (existingError || !existing) return NextResponse.json({ error: "supplier_not_found" }, { status: 404 });
      const { data, error } = await context.supabase.from("counterparties").update({ ...values, kind: existing.kind === "both" ? "both" : "supplier" }).eq("id", supplierId).eq("organization_id", organizationId).select("id").maybeSingle();
      if (error || !data) return NextResponse.json({ error: "unable_to_update_supplier" }, { status: 409 });
      counterpartyId = data.id;
    } else {
      const { data, error } = await context.supabase.from("counterparties").insert({ ...values, organization_id: organizationId, kind: "supplier" }).select("id").single();
      if (error || !data) return NextResponse.json({ error: "unable_to_create_supplier" }, { status: 409 });
      counterpartyId = data.id;
    }
    const contacts = (Array.isArray(body.contacts) ? body.contacts : []).map((item) => item as Record<string, unknown>).map((contact) => ({
      contact_area: typeof contact.area === "string" && contactAreas.has(contact.area) ? contact.area : null,
      job_title: text(contact.jobTitle, 160), full_name: text(contact.fullName, 180, true), phone: text(contact.phone, 80), email: text(contact.email, 320), is_primary: contact.isPrimary === true,
    })).filter((contact) => contact.full_name || contact.contact_area || contact.job_title || contact.phone || contact.email);
    if (contacts.some((contact) => !contact.contact_area || !contact.full_name)) return NextResponse.json({ error: "invalid_supplier_contact" }, { status: 400 });
    const { error: deleteError } = await context.supabase.from("counterparty_contacts").delete().eq("organization_id", organizationId).eq("counterparty_id", counterpartyId);
    if (deleteError) return NextResponse.json({ error: "unable_to_replace_supplier_contacts" }, { status: 409 });
    if (contacts.length) {
      const { error: contactsError } = await context.supabase.from("counterparty_contacts").insert(contacts.map((contact) => ({ ...contact, organization_id: organizationId, counterparty_id: counterpartyId })));
      if (contactsError) return NextResponse.json({ error: "unable_to_save_supplier_contacts" }, { status: 409 });
    }
    return NextResponse.json({ id: counterpartyId });
  }

  const canonicalCounterpartyId = body?.canonicalCounterpartyId;
  const duplicateCounterpartyIds = Array.isArray(body?.duplicateCounterpartyIds)
    ? body.duplicateCounterpartyIds
    : [];
  if (
    !isUuid(canonicalCounterpartyId) ||
    !duplicateCounterpartyIds.length ||
    !duplicateCounterpartyIds.every(isUuid) ||
    duplicateCounterpartyIds.includes(canonicalCounterpartyId)
  ) return NextResponse.json({ error: "invalid_consolidation" }, { status: 400 });

  const { data, error } = await context.supabase.rpc("consolidate_supplier_counterparties", {
    p_organization_id: organizationId,
    p_canonical_counterparty_id: canonicalCounterpartyId,
    p_duplicate_counterparty_ids: [...new Set(duplicateCounterpartyIds)],
  });
  if (error || !data)
    return NextResponse.json({ error: "unable_to_consolidate_suppliers" }, { status: 409 });
  return NextResponse.json({ consolidation: data });
}
