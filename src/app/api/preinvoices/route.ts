import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSiiUfQuote, isIsoDate } from "@/lib/sii-uf";

const operatorRoles = new Set(["administrator", "finance", "operations"]);
const financeRoles = new Set(["administrator", "finance"]);

type Service = {
  id: string;
  counterparty_id: string;
  service_catalog_id: string;
  quantity: number;
  unit_price: number;
  currency: string;
  starts_on: string | null;
  ends_on: string | null;
  billing_frequency: string;
};
type PreinvoiceGenerationRow = { id: string; status: string; pricing_date: string };
type ServiceDraft = { customerServiceId: string; quantity: number; unitPrice: number; description: string; notes: string | null };

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function periodMonth(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}(?:-\d{2})?$/.test(value)) return null;
  const month = `${value.slice(0, 7)}-01`;
  const date = new Date(`${month}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.getUTCDate() !== 1 || date.toISOString().slice(0, 7) !== value.slice(0, 7) ? null : month;
}

function roundClp(value: number) {
  return Math.round(value);
}

function roundDecimal(value: number, decimals: number) {
  const multiplier = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

function positiveDecimal(value: unknown, decimals: number) {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? roundDecimal(number, decimals) : null;
}

function nonNegativeDecimal(value: unknown, decimals: number) {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? roundDecimal(number, decimals) : null;
}

function lineDrafts(value: unknown) {
  if (!Array.isArray(value) || !value.length) return null;
  const drafts: ServiceDraft[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const draft = item as Record<string, unknown>;
    const customerServiceId = draft.customerServiceId;
    const quantity = positiveDecimal(draft.quantity, 4);
    const unitPrice = nonNegativeDecimal(draft.unitPrice, 4);
    const description = typeof draft.description === "string" ? draft.description.trim() : "";
    const notes = typeof draft.notes === "string" ? draft.notes.trim() : "";
    if (!isUuid(customerServiceId) || quantity === null || unitPrice === null || !description || description.length > 500 || notes.length > 2000) return null;
    drafts.push({ customerServiceId, quantity, unitPrice, description, notes: notes || null });
  }
  return new Set(drafts.map((draft) => draft.customerServiceId)).size === drafts.length ? drafts : null;
}

function normalized(value: string | null | undefined) {
  return (value ?? "").trim().toLocaleUpperCase();
}

async function context(organizationId: unknown, allowedRoles?: Set<string>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isUuid(organizationId)) return null;
  const { data: membership } = await supabase
    .from("organization_memberships")
    .select("organization_id, role")
    .eq("organization_id", organizationId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership || (allowedRoles && !allowedRoles.has(membership.role))) return null;
  return { supabase, user, membership, organizationId };
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  const data = await context(organizationId);
  if (!data) return NextResponse.json({ error: "organization_access_required" }, { status: 403 });

  const [preinvoices, lines, customers, documents, services, catalog] = await Promise.all([
    data.supabase.from("preinvoices")
      .select("id, counterparty_id, billing_cycle_id, period_month, pricing_date, status, currency_code, net_amount, vat_amount, total_amount, notes, reviewed_at, approved_at, issued_at, issued_document_id, cancellation_reason, created_at")
      .eq("organization_id", data.organizationId)
      .order("period_month", { ascending: false })
      .order("created_at", { ascending: false }),
    data.supabase.from("preinvoice_lines")
      .select("id, preinvoice_id, customer_service_id, service_catalog_id, description, quantity, unit_price, net_amount, source_currency, source_unit_price, conversion_rate_to_clp, pricing_date, rate_source, usage_quantity, notes")
      .eq("organization_id", data.organizationId)
      .order("created_at"),
    data.supabase.from("counterparties")
      .select("id, legal_name, trade_name")
      .eq("organization_id", data.organizationId)
      .in("kind", ["customer", "both"])
      .order("legal_name"),
    data.supabase.from("issued_documents")
      .select("id, counterparty_id, document_number, issue_date, total_amount, client_name")
      .eq("organization_id", data.organizationId)
      .order("issue_date", { ascending: false })
      .limit(100),
    data.supabase.from("customer_services")
      .select("id, counterparty_id, service_catalog_id, quantity, unit_price, currency, starts_on, ends_on, billing_frequency, is_active")
      .eq("organization_id", data.organizationId)
      .eq("is_active", true)
      .order("created_at"),
    data.supabase.from("service_catalog")
      .select("id, name, category")
      .eq("organization_id", data.organizationId),
  ]);
  if (preinvoices.error || lines.error || customers.error || documents.error || services.error || catalog.error) {
    return NextResponse.json({ error: "unable_to_load_preinvoices" }, { status: 500 });
  }
  const catalogById = new Map((catalog.data ?? []).map((item) => [item.id, item]));
  return NextResponse.json({
    role: data.membership.role,
    preinvoices: preinvoices.data ?? [],
    lines: (lines.data ?? []).map((line) => {
      const catalogItem = line.service_catalog_id ? catalogById.get(line.service_catalog_id) : null;
      return { ...line, service_name: catalogItem?.name ?? null, service_category: catalogItem?.category ?? null };
    }),
    customers: customers.data ?? [],
    documents: documents.data ?? [],
    services: (services.data ?? []).map((service) => {
      const catalogItem = catalogById.get(service.service_catalog_id);
      return { ...service, service_name: catalogItem?.name ?? "Servicio contratado", service_category: catalogItem?.category ?? null };
    }),
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { organizationId?: unknown; action?: unknown; periodMonth?: unknown; pricingDate?: unknown; counterpartyId?: unknown; lines?: unknown } | null;
  const month = periodMonth(body?.periodMonth);
  const pricingDate = isIsoDate(body?.pricingDate) ? body.pricingDate : month;
  const data = await context(body?.organizationId, operatorRoles);
  if (!data) return NextResponse.json({ error: "preinvoice_write_not_authorized" }, { status: 403 });
  const counterpartyId = body?.counterpartyId;
  const requestedLines = lineDrafts(body?.lines);
  const serviceIds = requestedLines?.map((line) => line.customerServiceId) ?? [];
  if (body?.action !== "create_draft" || !month || !pricingDate || !isUuid(counterpartyId) || !requestedLines) return NextResponse.json({ error: "invalid_preinvoice_generation" }, { status: 400 });

  const [servicesResult, rulesResult, cyclesResult] = await Promise.all([
    data.supabase.from("customer_services")
      .select("id, counterparty_id, service_catalog_id, quantity, unit_price, currency, starts_on, ends_on, billing_frequency")
      .eq("organization_id", data.organizationId)
      .eq("counterparty_id", counterpartyId)
      .eq("is_active", true)
      .in("id", serviceIds),
    data.supabase.from("billing_recurrence_rules")
      .select("id, counterparty_id")
      .eq("organization_id", data.organizationId)
      .eq("status", "active"),
    data.supabase.from("billing_cycles")
      .select("id, recurrence_rule_id, currency_code")
      .eq("organization_id", data.organizationId)
      .eq("period_month", month),
  ]);
  if (servicesResult.error || rulesResult.error || cyclesResult.error) {
    return NextResponse.json({ error: "unable_to_prepare_preinvoices" }, { status: 500 });
  }

  const counterpartyByRule = new Map((rulesResult.data ?? []).map((item) => [item.id, item.counterparty_id]));
  const cycleByCustomerCurrency = new Map((cyclesResult.data ?? []).map((item) => [`${counterpartyByRule.get(item.recurrence_rule_id) ?? ""}:${item.currency_code}`, item.id]));
  const selectedServices = (servicesResult.data ?? []) as Service[];
  if (selectedServices.length !== serviceIds.length) return NextResponse.json({ error: "selected_services_not_available" }, { status: 409 });
  const draftByServiceId = new Map(requestedLines.map((line) => [line.customerServiceId, line]));
  const hasUfServices = selectedServices.some((service) => service.currency === "UF");
  let ufQuote: Awaited<ReturnType<typeof getSiiUfQuote>> | null = null;
  if (hasUfServices) {
    try {
      ufQuote = await getSiiUfQuote(pricingDate);
    } catch {
      return NextResponse.json({ error: "sii_uf_value_unavailable", pricingDate }, { status: 422 });
    }
  }
  const groups = new Map<string, Service[]>();
  for (const service of selectedServices) {
    // Las UF se valorizan y facturan en CLP para que la aprobación y el DTE
    // utilicen un total definitivo, conservando la UF de origen en la línea.
    const billingCurrency = service.currency === "UF" ? "CLP" : service.currency;
    const key = `${counterpartyId}:${billingCurrency}`;
    groups.set(key, [...(groups.get(key) ?? []), service]);
  }

  const existingByGroup = new Map<string, PreinvoiceGenerationRow | null>();
  for (const [key] of groups) {
    const [, currencyCode] = key.split(":");
    const { data: existing, error: existingError } = await data.supabase.from("preinvoices")
      .select("id, status, pricing_date")
      .eq("organization_id", data.organizationId)
      .eq("counterparty_id", counterpartyId)
      .eq("period_month", month)
      .eq("currency_code", currencyCode)
      .maybeSingle();
    if (existingError) return NextResponse.json({ error: "unable_to_read_existing_preinvoice" }, { status: 500 });
    const existingPreinvoice = existing as PreinvoiceGenerationRow | null;
    if (existingPreinvoice && existingPreinvoice.pricing_date !== pricingDate) {
      return NextResponse.json({ error: "preinvoice_already_exists_with_another_pricing_date", pricingDate: existingPreinvoice.pricing_date }, { status: 409 });
    }
    if (existingPreinvoice && existingPreinvoice.status !== "draft") {
      return NextResponse.json({ error: "preinvoice_is_not_editable", preinvoiceId: existingPreinvoice.id }, { status: 409 });
    }
    existingByGroup.set(key, existingPreinvoice);
  }

  let created = 0;
  let linesAdded = 0;
  for (const [key, services] of groups) {
    const [counterpartyId, currencyCode] = key.split(":");
    let preinvoice = existingByGroup.get(key) ?? null;
    if (!preinvoice) {
      const { data: inserted, error } = await data.supabase.from("preinvoices").insert({
        organization_id: data.organizationId,
        counterparty_id: counterpartyId,
        billing_cycle_id: cycleByCustomerCurrency.get(key) ?? null,
        period_month: month,
        pricing_date: pricingDate,
        currency_code: currencyCode,
        created_by: data.user.id,
      }).select("id, status, pricing_date").single();
      const insertedPreinvoice = inserted as PreinvoiceGenerationRow | null;
      if (error || !insertedPreinvoice) return NextResponse.json({ error: "unable_to_create_preinvoice" }, { status: 409 });
      preinvoice = insertedPreinvoice;
      created += 1;
    }
    if (!preinvoice) return NextResponse.json({ error: "unable_to_create_preinvoice" }, { status: 409 });
    const lineRows = services.map((service) => {
      const draft = draftByServiceId.get(service.id);
      if (!draft) throw new Error("missing_service_draft");
      const sourceUnitPrice = draft.unitPrice;
      const conversionRate = service.currency === "UF" ? ufQuote?.value : 1;
      if (!conversionRate) throw new Error("missing_uf_quote");
      const unitPrice = service.currency === "UF" ? roundClp(sourceUnitPrice * conversionRate) : roundDecimal(sourceUnitPrice, 2);
      return {
        organization_id: data.organizationId,
        preinvoice_id: preinvoice.id,
        customer_service_id: service.id,
        service_catalog_id: service.service_catalog_id,
        description: draft.description,
        quantity: draft.quantity,
        unit_price: unitPrice,
        net_amount: roundDecimal(draft.quantity * unitPrice, 2),
        source_currency: service.currency,
        source_unit_price: sourceUnitPrice,
        conversion_rate_to_clp: conversionRate,
        pricing_date: pricingDate,
        rate_source: service.currency === "UF" ? "sii_uf_daily" : "contract_price_clp",
        notes: draft.notes,
      };
    });
    const { error } = await data.supabase.from("preinvoice_lines")
      .upsert(lineRows, { onConflict: "preinvoice_id,customer_service_id" });
    if (error) return NextResponse.json({ error: "unable_to_add_preinvoice_lines" }, { status: 409 });
    linesAdded += lineRows.length;
  }
  return NextResponse.json({ created, linesAdded, groups: groups.size, periodMonth: month, pricingDate, ufQuote }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => null) as { organizationId?: unknown; preinvoiceId?: unknown; action?: unknown; issuedDocumentId?: unknown; reason?: unknown } | null;
  const action = body?.action;
  const requiresFinance = action === "issue" || action === "cancel" || action === "return_to_draft";
  const data = await context(body?.organizationId, requiresFinance ? financeRoles : operatorRoles);
  if (!data) return NextResponse.json({ error: "preinvoice_update_not_authorized" }, { status: 403 });
  if (!isUuid(body?.preinvoiceId) || !["submit_review", "return_to_draft", "issue", "cancel"].includes(String(action))) {
    return NextResponse.json({ error: "invalid_preinvoice_action" }, { status: 400 });
  }
  const { data: preinvoice, error: preinvoiceError } = await data.supabase.from("preinvoices")
    .select("id, counterparty_id, status")
    .eq("id", body.preinvoiceId)
    .eq("organization_id", data.organizationId)
    .maybeSingle();
  if (preinvoiceError || !preinvoice) return NextResponse.json({ error: "preinvoice_not_found" }, { status: 404 });

  const now = new Date().toISOString();
  let values: Record<string, unknown>;
  if (action === "submit_review") {
    if (preinvoice.status !== "draft") return NextResponse.json({ error: "preinvoice_not_draft" }, { status: 409 });
    values = { status: "review", reviewed_at: now, reviewed_by: data.user.id };
  } else if (action === "return_to_draft") {
    if (preinvoice.status !== "review") return NextResponse.json({ error: "preinvoice_not_in_review" }, { status: 409 });
    values = { status: "draft" };
  } else if (action === "cancel") {
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!["draft", "review", "approved"].includes(preinvoice.status) || !reason || reason.length > 1000) return NextResponse.json({ error: "invalid_preinvoice_cancellation" }, { status: 400 });
    values = { status: "cancelled", cancelled_at: now, cancelled_by: data.user.id, cancellation_reason: reason };
  } else {
    if (preinvoice.status !== "approved" || !isUuid(body.issuedDocumentId)) return NextResponse.json({ error: "approved_preinvoice_and_issued_document_required" }, { status: 409 });
    const [{ data: document, error: documentError }, { data: customer, error: customerError }] = await Promise.all([
      data.supabase.from("issued_documents").select("id, counterparty_id, client_name, recipient_name").eq("id", body.issuedDocumentId).eq("organization_id", data.organizationId).maybeSingle(),
      data.supabase.from("counterparties").select("legal_name, trade_name").eq("id", preinvoice.counterparty_id).eq("organization_id", data.organizationId).maybeSingle(),
    ]);
    if (documentError || customerError || !document || !customer) return NextResponse.json({ error: "issued_document_or_customer_not_found" }, { status: 404 });
    const customerNames = new Set([normalized(customer.legal_name), normalized(customer.trade_name)].filter(Boolean));
    if (document.counterparty_id && document.counterparty_id !== preinvoice.counterparty_id) return NextResponse.json({ error: "issued_document_belongs_to_another_customer" }, { status: 409 });
    if (!document.counterparty_id && !customerNames.has(normalized(document.client_name)) && !customerNames.has(normalized(document.recipient_name))) {
      return NextResponse.json({ error: "issued_document_customer_must_match_preinvoice" }, { status: 409 });
    }
    if (!document.counterparty_id) {
      const { error } = await data.supabase.from("issued_documents").update({ counterparty_id: preinvoice.counterparty_id }).eq("id", document.id).eq("organization_id", data.organizationId);
      if (error) return NextResponse.json({ error: "unable_to_link_issued_document" }, { status: 409 });
    }
    values = { status: "issued", issued_at: now, issued_by: data.user.id, issued_document_id: body.issuedDocumentId };
  }
  const { data: updated, error } = await data.supabase.from("preinvoices").update(values).eq("id", preinvoice.id).eq("organization_id", data.organizationId)
    .select("id, status, issued_document_id, reviewed_at, approved_at, issued_at").single();
  if (error) return NextResponse.json({ error: "unable_to_update_preinvoice" }, { status: 409 });
  if (action === "submit_review") {
    const { data: approvalRequest, error: approvalError } = await data.supabase
      .from("approval_requests")
      .select("id, status")
      .eq("organization_id", data.organizationId)
      .eq("target_type", "preinvoice")
      .eq("target_id", preinvoice.id)
      .eq("status", "submitted")
      .maybeSingle();
    if (approvalError || !approvalRequest) {
      return NextResponse.json({ error: "approval_request_not_created" }, { status: 500 });
    }
    return NextResponse.json({ preinvoice: updated, approvalRequestId: approvalRequest.id });
  }
  return NextResponse.json({ preinvoice: updated });
}
