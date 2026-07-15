import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSiiUfQuote, isIsoDate } from "@/lib/sii-uf";

const operatorRoles = new Set(["administrator", "finance", "operations"]);
const financeRoles = new Set(["administrator", "finance"]);
const frequencies = new Set(["monthly", "quarterly", "annual", "one_time"]);

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

function dateInPeriod(service: Service, month: string) {
  const nextMonth = new Date(`${month}T00:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const periodEnd = new Date(nextMonth.getTime() - 86_400_000).toISOString().slice(0, 10);
  return (!service.starts_on || service.starts_on <= periodEnd) && (!service.ends_on || service.ends_on >= month);
}

function frequencyMatches(service: Service, month: string) {
  if (!frequencies.has(service.billing_frequency) || !dateInPeriod(service, month)) return false;
  const monthNumber = Number(month.slice(5, 7));
  if (service.billing_frequency === "monthly") return true;
  if (service.billing_frequency === "quarterly") return monthNumber % 3 === 1;
  if (service.billing_frequency === "annual") return service.starts_on ? service.starts_on.slice(5, 7) === month.slice(5, 7) : monthNumber === 1;
  return service.starts_on?.slice(0, 7) === month.slice(0, 7);
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

  const [preinvoices, lines, customers, documents] = await Promise.all([
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
  ]);
  if (preinvoices.error || lines.error || customers.error || documents.error) {
    return NextResponse.json({ error: "unable_to_load_preinvoices" }, { status: 500 });
  }
  return NextResponse.json({
    role: data.membership.role,
    preinvoices: preinvoices.data ?? [],
    lines: lines.data ?? [],
    customers: customers.data ?? [],
    documents: documents.data ?? [],
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { organizationId?: unknown; action?: unknown; periodMonth?: unknown; pricingDate?: unknown } | null;
  const month = periodMonth(body?.periodMonth);
  const pricingDate = isIsoDate(body?.pricingDate) ? body.pricingDate : month;
  const data = await context(body?.organizationId, operatorRoles);
  if (!data) return NextResponse.json({ error: "preinvoice_write_not_authorized" }, { status: 403 });
  if (body?.action !== "generate" || !month || !pricingDate) return NextResponse.json({ error: "invalid_preinvoice_generation" }, { status: 400 });

  const [servicesResult, catalogResult, rulesResult, cyclesResult] = await Promise.all([
    data.supabase.from("customer_services")
      .select("id, counterparty_id, service_catalog_id, quantity, unit_price, currency, starts_on, ends_on, billing_frequency")
      .eq("organization_id", data.organizationId)
      .eq("is_active", true),
    data.supabase.from("service_catalog")
      .select("id, name")
      .eq("organization_id", data.organizationId),
    data.supabase.from("billing_recurrence_rules")
      .select("id, counterparty_id")
      .eq("organization_id", data.organizationId)
      .eq("status", "active"),
    data.supabase.from("billing_cycles")
      .select("id, recurrence_rule_id, currency_code")
      .eq("organization_id", data.organizationId)
      .eq("period_month", month),
  ]);
  if (servicesResult.error || catalogResult.error || rulesResult.error || cyclesResult.error) {
    return NextResponse.json({ error: "unable_to_prepare_preinvoices" }, { status: 500 });
  }

  const catalogNames = new Map((catalogResult.data ?? []).map((item) => [item.id, item.name]));
  const counterpartyByRule = new Map((rulesResult.data ?? []).map((item) => [item.id, item.counterparty_id]));
  const cycleByCustomerCurrency = new Map((cyclesResult.data ?? []).map((item) => [`${counterpartyByRule.get(item.recurrence_rule_id) ?? ""}:${item.currency_code}`, item.id]));
  const activeServices = (servicesResult.data ?? []) as Service[];
  const hasUfServices = activeServices.some((service) => service.currency === "UF" && frequencyMatches(service, month));
  let ufQuote: Awaited<ReturnType<typeof getSiiUfQuote>> | null = null;
  if (hasUfServices) {
    try {
      ufQuote = await getSiiUfQuote(pricingDate);
    } catch {
      return NextResponse.json({ error: "sii_uf_value_unavailable", pricingDate }, { status: 422 });
    }
  }
  const groups = new Map<string, Service[]>();
  for (const service of activeServices) {
    if (!frequencyMatches(service, month)) continue;
    // Las UF se valorizan y facturan en CLP para que la aprobación y el DTE
    // utilicen un total definitivo, conservando la UF de origen en la línea.
    const billingCurrency = service.currency === "UF" ? "CLP" : service.currency;
    const key = `${service.counterparty_id}:${billingCurrency}`;
    groups.set(key, [...(groups.get(key) ?? []), service]);
  }

  let created = 0;
  let linesAdded = 0;
  for (const [key, services] of groups) {
    const [counterpartyId, currencyCode] = key.split(":");
    const { data: existing, error: existingError } = await data.supabase.from("preinvoices")
      .select("id, status, pricing_date")
      .eq("organization_id", data.organizationId)
      .eq("counterparty_id", counterpartyId)
      .eq("period_month", month)
      .eq("currency_code", currencyCode)
      .maybeSingle();
    if (existingError) return NextResponse.json({ error: "unable_to_read_existing_preinvoice" }, { status: 500 });
    let preinvoice = existing as PreinvoiceGenerationRow | null;
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
    if (preinvoice.pricing_date !== pricingDate) {
      return NextResponse.json({ error: "preinvoice_already_exists_with_another_pricing_date", pricingDate: preinvoice.pricing_date }, { status: 409 });
    }
    if (preinvoice.status !== "draft") continue;
    const lineRows = services.map((service) => {
      const sourceUnitPrice = Number(service.unit_price);
      const conversionRate = service.currency === "UF" ? ufQuote?.value : 1;
      if (!conversionRate) throw new Error("missing_uf_quote");
      const unitPrice = service.currency === "UF" ? roundClp(sourceUnitPrice * conversionRate) : sourceUnitPrice;
      return {
        organization_id: data.organizationId,
        preinvoice_id: preinvoice.id,
        customer_service_id: service.id,
        service_catalog_id: service.service_catalog_id,
        description: catalogNames.get(service.service_catalog_id) ?? "Servicio contratado",
        quantity: service.quantity,
        unit_price: unitPrice,
        net_amount: Number(service.quantity) * unitPrice,
        source_currency: service.currency,
        source_unit_price: sourceUnitPrice,
        conversion_rate_to_clp: conversionRate,
        pricing_date: pricingDate,
        rate_source: service.currency === "UF" ? "sii_uf_daily" : "contract_price_clp",
      };
    });
    const { error } = await data.supabase.from("preinvoice_lines")
      .upsert(lineRows, { onConflict: "preinvoice_id,customer_service_id", ignoreDuplicates: true });
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
  return NextResponse.json({ preinvoice: updated });
}
