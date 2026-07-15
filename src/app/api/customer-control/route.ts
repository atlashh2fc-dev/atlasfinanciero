import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const writeRoles = new Set(["administrator", "finance", "operations"]);
const frequencies = new Set(["monthly", "one_time", "annual", "quarterly"]);
const pricingCurrencies = new Set(["CLP", "UF"]);

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function text(value: unknown, maxLength: number, required = false) {
  if (typeof value !== "string") return required ? null : null;
  const result = value.trim();
  return (!result && required) || result.length > maxLength ? null : result || null;
}

function amount(value: unknown) {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

async function context(organizationId: unknown, write = false, administrator = false) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isUuid(organizationId)) return null;
  const { data: membership } = await supabase.from("organization_memberships").select("organization_id, role").eq("organization_id", organizationId).eq("user_id", user.id).maybeSingle();
  if (!membership || (write && !writeRoles.has(membership.role)) || (administrator && membership.role !== "administrator")) return null;
  return { supabase, user, membership };
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  const data = await context(organizationId);
  if (!data || !organizationId) return NextResponse.json({ error: "organization_access_required" }, { status: 403 });
  const fileId = request.nextUrl.searchParams.get("fileId");
  if (fileId) {
    if (!isUuid(fileId)) return NextResponse.json({ error: "invalid_file" }, { status: 400 });
    const { data: file, error } = await data.supabase.from("customer_files").select("storage_path").eq("id", fileId).eq("organization_id", organizationId).maybeSingle();
    if (error || !file) return NextResponse.json({ error: "file_not_found" }, { status: 404 });
    const { data: signed, error: signedError } = await data.supabase.storage.from("customer-documents").createSignedUrl(file.storage_path, 60);
    if (signedError || !signed) return NextResponse.json({ error: "unable_to_open_file" }, { status: 409 });
    return NextResponse.json({ signedUrl: signed.signedUrl });
  }
  const canReadExpenses = ["administrator", "finance", "auditor"].includes(data.membership.role);
  const [catalog, services, files, issued, received] = await Promise.all([
    data.supabase.from("service_catalog").select("id, name, category, description, unit_name, unit_price, currency, is_active").eq("organization_id", organizationId).order("name"),
    data.supabase.from("customer_services").select("id, counterparty_id, service_catalog_id, quantity, unit_price, currency, starts_on, ends_on, billing_frequency, notes, is_active").eq("organization_id", organizationId).order("created_at"),
    data.supabase.from("customer_files").select("id, counterparty_id, file_name, mime_type, file_size, document_type, notes, created_at").eq("organization_id", organizationId).order("created_at", { ascending: false }),
    data.supabase.from("issued_documents").select("id, counterparty_id, document_number, issue_date, document_type, client_name, recipient_name, total_amount, payment_status").eq("organization_id", organizationId).order("issue_date", { ascending: false }),
    canReadExpenses ? data.supabase.from("received_documents").select("id, supplier_counterparty_id, supplier_name, document_number, issue_date, document_type, total_amount, payment_status").eq("organization_id", organizationId).order("issue_date", { ascending: false }) : Promise.resolve({ data: [], error: null }),
  ]);
  if (catalog.error || services.error || files.error || issued.error || received.error) return NextResponse.json({ error: "unable_to_load_customer_control" }, { status: 500 });
  return NextResponse.json({ catalog: catalog.data ?? [], services: services.data ?? [], files: files.data ?? [], issuedDocuments: issued.data ?? [], receivedDocuments: received.data ?? [], canReadExpenses });
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const organizationId = form.get("organizationId");
    const counterpartyId = form.get("counterpartyId");
    const upload = form.get("file");
    const data = await context(organizationId, true);
    if (!data || !isUuid(counterpartyId) || !(upload instanceof File) || upload.size === 0 || upload.size > 52_428_800) return NextResponse.json({ error: "invalid_contract_upload" }, { status: 400 });
    const allowed = new Set(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword", "image/jpeg", "image/png"]);
    if (!allowed.has(upload.type)) return NextResponse.json({ error: "unsupported_contract_type" }, { status: 400 });
    const safeName = upload.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "documento";
    const path = `${organizationId}/${counterpartyId}/${crypto.randomUUID()}-${safeName}`;
    const { error: storageError } = await data.supabase.storage.from("customer-documents").upload(path, upload, { contentType: upload.type, upsert: false });
    if (storageError) return NextResponse.json({ error: "unable_to_upload_contract" }, { status: 409 });
    const { data: record, error } = await data.supabase.from("customer_files").insert({ organization_id: organizationId, counterparty_id: counterpartyId, file_name: upload.name.slice(0, 300), storage_path: path, mime_type: upload.type, file_size: upload.size, document_type: form.get("documentType") === "annex" ? "annex" : "contract", notes: text(form.get("notes"), 2000) }).select("id").single();
    if (error) { await data.supabase.storage.from("customer-documents").remove([path]); return NextResponse.json({ error: "unable_to_save_contract" }, { status: 409 }); }
    return NextResponse.json({ id: record.id }, { status: 201 });
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const organizationId = body?.organizationId;
  const action = body?.action;
  const administrator = action === "save_catalog" || action === "delete_catalog";
  const data = await context(organizationId, true, administrator);
  if (!data || !isUuid(organizationId)) return NextResponse.json({ error: "organization_write_not_authorized" }, { status: 403 });

  if (action === "save_catalog") {
    const item = body.item as Record<string, unknown> | null;
    const name = text(item?.name, 180, true); const unitPrice = amount(item?.unitPrice);
    const currency = typeof item?.currency === "string" && pricingCurrencies.has(item.currency) ? item.currency : null;
    if (!name || unitPrice === null || !currency) return NextResponse.json({ error: "invalid_catalog_item" }, { status: 400 });
    const values = { name, category: text(item?.category, 100), description: text(item?.description, 1000), unit_name: text(item?.unitName, 80) ?? "unidad", unit_price: unitPrice, currency, is_active: item?.isActive !== false };
    const id = item?.id;
    const query = isUuid(id) ? data.supabase.from("service_catalog").update(values).eq("id", id).eq("organization_id", organizationId) : data.supabase.from("service_catalog").insert({ ...values, organization_id: organizationId });
    const { error } = await query;
    return error ? NextResponse.json({ error: "unable_to_save_catalog_item" }, { status: 409 }) : NextResponse.json({ ok: true });
  }
  if (action === "delete_catalog") {
    const id = body.itemId;
    if (!isUuid(id)) return NextResponse.json({ error: "invalid_catalog_item" }, { status: 400 });
    const { error } = await data.supabase.from("service_catalog").delete().eq("id", id).eq("organization_id", organizationId);
    return error ? NextResponse.json({ error: "catalog_item_in_use" }, { status: 409 }) : NextResponse.json({ ok: true });
  }
  if (action === "save_service") {
    const item = body.item as Record<string, unknown> | null;
    const counterpartyId = item?.counterpartyId; const catalogId = item?.catalogId; const unitPrice = amount(item?.unitPrice); const quantity = Number(item?.quantity);
    const currency = typeof item?.currency === "string" && pricingCurrencies.has(item.currency) ? item.currency : null;
    const frequency = typeof item?.billingFrequency === "string" && frequencies.has(item.billingFrequency) ? item.billingFrequency : null;
    if (!isUuid(counterpartyId) || !isUuid(catalogId) || unitPrice === null || !Number.isFinite(quantity) || quantity <= 0 || !currency || !frequency) return NextResponse.json({ error: "invalid_customer_service" }, { status: 400 });
    const { error } = await data.supabase.from("customer_services").upsert({ organization_id: organizationId, counterparty_id: counterpartyId, service_catalog_id: catalogId, unit_price: unitPrice, quantity, currency, billing_frequency: frequency, starts_on: text(item?.startsOn, 10), ends_on: text(item?.endsOn, 10), notes: text(item?.notes, 2000), is_active: item?.isActive !== false }, { onConflict: "counterparty_id,service_catalog_id" });
    return error ? NextResponse.json({ error: "unable_to_save_customer_service" }, { status: 409 }) : NextResponse.json({ ok: true });
  }
  if (action === "delete_service") {
    const id = body.serviceId;
    if (!isUuid(id)) return NextResponse.json({ error: "invalid_customer_service" }, { status: 400 });
    const { error } = await data.supabase.from("customer_services").delete().eq("id", id).eq("organization_id", organizationId);
    return error ? NextResponse.json({ error: "unable_to_delete_customer_service" }, { status: 409 }) : NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "unsupported_customer_control_action" }, { status: 400 });
}
