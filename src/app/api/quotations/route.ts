import { NextRequest, NextResponse } from "next/server";
import { calculateQuote, type QuoteLine } from "@/lib/quotation";
import { createClient } from "@/lib/supabase/server";

const writeRoles = new Set(["administrator", "finance", "operations"]);
const categories = new Set(["saas", "infrastructure", "ai", "professional_service", "profile", "bpo", "other"]);
const periods = new Set(["one_time", "monthly"]);
const statuses = new Set(["draft", "sent", "accepted", "rejected", "expired"]);
const currencies = new Set(["CLP", "UF", "USD"]);

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function text(value: unknown, maxLength: number, required = false) {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return (!result && required) || result.length > maxLength ? null : result || null;
}

function amount(value: unknown, maximum = 999_999_999_999) {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 && result <= maximum ? result : null;
}

function date(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime()) ? value : undefined;
}

async function context(organizationId: unknown, write = false) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isUuid(organizationId)) return null;
  const { data: membership } = await supabase.from("organization_memberships").select("organization_id, role").eq("organization_id", organizationId).eq("user_id", user.id).maybeSingle();
  if (!membership || (write && !writeRoles.has(membership.role))) return null;
  return { supabase, user, membership };
}

function parseLine(value: unknown, index: number): QuoteLine | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const name = text(input.name, 180, true);
  const unitName = text(input.unitName, 80, true);
  const category = typeof input.category === "string" && categories.has(input.category) ? input.category : null;
  const billingPeriod = typeof input.billingPeriod === "string" && periods.has(input.billingPeriod) ? input.billingPeriod as QuoteLine["billingPeriod"] : null;
  const quantity = amount(input.quantity, 1_000_000);
  const unitCost = amount(input.unitCost);
  const marginPercent = amount(input.marginPercent, 99.99);
  if (!name || !unitName || !category || !billingPeriod || quantity === null || quantity <= 0 || unitCost === null || marginPercent === null || marginPercent >= 100) return null;
  return {
    id: typeof input.id === "string" && input.id.length <= 100 ? input.id : `line-${index + 1}`,
    catalogItemId: isUuid(input.catalogItemId) ? input.catalogItemId : null,
    name,
    category,
    unitName,
    billingPeriod,
    quantity,
    unitCost,
    marginPercent,
  };
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  const data = await context(organizationId);
  if (!data || !organizationId) return NextResponse.json({ error: "organization_access_required" }, { status: 403 });

  const [customers, catalog, quotes] = await Promise.all([
    data.supabase.from("counterparties").select("id, legal_name, trade_name, tax_id").eq("organization_id", organizationId).in("kind", ["customer", "both"]).eq("is_active", true).order("legal_name"),
    data.supabase.from("quotation_catalog_items").select("id, name, category, unit_name, billing_period, default_unit_cost, default_margin_percent, is_active").eq("organization_id", organizationId).order("category").order("name"),
    data.supabase.from("sales_quotes").select("id, counterparty_id, opportunity_id, quote_number, title, status, currency_code, valid_until, term_months, notes, items, one_time_cost, one_time_sale, monthly_cost, monthly_sale, contract_value, gross_profit, created_at, updated_at").eq("organization_id", organizationId).order("updated_at", { ascending: false }).limit(100),
  ]);
  if (customers.error || catalog.error || quotes.error) return NextResponse.json({ error: "unable_to_load_quotations" }, { status: 500 });
  return NextResponse.json({ customers: customers.data ?? [], catalog: catalog.data ?? [], quotes: quotes.data ?? [] });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const organizationId = body?.organizationId;
  const data = await context(organizationId, true);
  if (!data || !isUuid(organizationId)) return NextResponse.json({ error: "organization_write_not_authorized" }, { status: 403 });

  if (body?.action === "save_catalog_item") {
    const input = body.item as Record<string, unknown> | null;
    const name = text(input?.name, 180, true);
    const unitName = text(input?.unitName, 80, true);
    const category = typeof input?.category === "string" && categories.has(input.category) ? input.category : null;
    const billingPeriod = typeof input?.billingPeriod === "string" && periods.has(input.billingPeriod) ? input.billingPeriod : null;
    const defaultUnitCost = amount(input?.defaultUnitCost);
    const defaultMarginPercent = amount(input?.defaultMarginPercent, 99.99);
    if (!name || !unitName || !category || !billingPeriod || defaultUnitCost === null || defaultMarginPercent === null || defaultMarginPercent >= 100) return NextResponse.json({ error: "invalid_catalog_item" }, { status: 400 });
    const values = { name, unit_name: unitName, category, billing_period: billingPeriod, default_unit_cost: defaultUnitCost, default_margin_percent: defaultMarginPercent, is_active: input?.isActive !== false };
    const query = isUuid(input?.id)
      ? data.supabase.from("quotation_catalog_items").update(values).eq("id", input.id).eq("organization_id", organizationId)
      : data.supabase.from("quotation_catalog_items").insert({ ...values, organization_id: organizationId, created_by: data.user.id });
    const { data: saved, error } = await query.select("id").maybeSingle();
    if (error || !saved) return NextResponse.json({ error: "unable_to_save_catalog_item" }, { status: 409 });
    return NextResponse.json({ id: saved.id });
  }

  if (body?.action === "save_quote") {
    const input = body.quote as Record<string, unknown> | null;
    const title = text(input?.title, 250, true);
    const validUntil = date(input?.validUntil);
    const termMonths = Number(input?.termMonths);
    const status = typeof input?.status === "string" && statuses.has(input.status) ? input.status : null;
    const currencyCode = typeof input?.currencyCode === "string" && currencies.has(input.currencyCode) ? input.currencyCode : null;
    const rawLines = Array.isArray(input?.items) ? input.items : [];
    const items = rawLines.map(parseLine);
    if (!title || validUntil === undefined || !Number.isInteger(termMonths) || termMonths < 1 || termMonths > 120 || !status || !currencyCode || rawLines.length < 1 || rawLines.length > 100 || items.some((item) => item === null)) return NextResponse.json({ error: "invalid_quote" }, { status: 400 });
    const lines = items as QuoteLine[];
    const counterpartyId = isUuid(input?.counterpartyId) ? input.counterpartyId : null;
    if (counterpartyId) {
      const { data: customer } = await data.supabase.from("counterparties").select("id").eq("id", counterpartyId).eq("organization_id", organizationId).in("kind", ["customer", "both"]).maybeSingle();
      if (!customer) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
    }
    const totals = calculateQuote(lines, termMonths);
    const values = {
      counterparty_id: counterpartyId,
      title,
      status,
      currency_code: currencyCode,
      valid_until: validUntil,
      term_months: termMonths,
      notes: text(input?.notes, 4000),
      items: lines,
      one_time_cost: totals.costOneTime,
      one_time_sale: totals.saleOneTime,
      monthly_cost: totals.costMonthly,
      monthly_sale: totals.saleMonthly,
      contract_value: totals.contractValue,
      gross_profit: totals.grossProfit,
    };
    const query = isUuid(input?.id)
      ? data.supabase.from("sales_quotes").update(values).eq("id", input.id).eq("organization_id", organizationId)
      : data.supabase.from("sales_quotes").insert({ ...values, organization_id: organizationId, created_by: data.user.id });
    const { data: saved, error } = await query.select("id, quote_number").maybeSingle();
    if (error || !saved) return NextResponse.json({ error: "unable_to_save_quote" }, { status: 409 });
    return NextResponse.json({ id: saved.id, quoteNumber: saved.quote_number });
  }

  if (body?.action === "delete_quote") {
    if (!isUuid(body.quoteId)) return NextResponse.json({ error: "invalid_quote" }, { status: 400 });
    const { error } = await data.supabase.from("sales_quotes").delete().eq("id", body.quoteId).eq("organization_id", organizationId);
    return error ? NextResponse.json({ error: "unable_to_delete_quote" }, { status: 409 }) : NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unsupported_quotation_action" }, { status: 400 });
}
