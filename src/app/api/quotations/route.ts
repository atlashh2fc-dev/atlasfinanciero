import { NextRequest, NextResponse } from "next/server";
import { calculateQuote, type QuoteCostBreakdown, type QuoteLine } from "@/lib/quotation";
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
  const rawBreakdown = input.costBreakdown === undefined ? [] : Array.isArray(input.costBreakdown) ? input.costBreakdown : null;
  if (!name || !unitName || !category || !billingPeriod || quantity === null || quantity <= 0 || unitCost === null || marginPercent === null || marginPercent >= 100 || rawBreakdown === null || rawBreakdown.length > 50) return null;
  const costBreakdown = rawBreakdown.map((entry) => {
    if (!entry || typeof entry !== "object") return null;
    const component = entry as Record<string, unknown>;
    const catalogItemId = isUuid(component.catalogItemId) ? component.catalogItemId : null;
    const componentName = text(component.name, 180, true);
    const componentQuantity = amount(component.quantity, 1_000_000);
    const componentUnitCost = amount(component.unitCost);
    return catalogItemId && componentName && componentQuantity !== null && componentQuantity > 0 && componentUnitCost !== null
      ? { catalogItemId, name: componentName, quantity: componentQuantity, unitCost: componentUnitCost } satisfies QuoteCostBreakdown
      : null;
  });
  if (costBreakdown.some((entry) => entry === null)) return null;
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
    costBreakdown: costBreakdown as QuoteCostBreakdown[],
  };
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  const data = await context(organizationId);
  if (!data || !organizationId) return NextResponse.json({ error: "organization_access_required" }, { status: 403 });

  const [customers, catalog, costComponents, quotes] = await Promise.all([
    data.supabase.from("counterparties").select("id, legal_name, trade_name, tax_id").eq("organization_id", organizationId).in("kind", ["customer", "both"]).eq("is_active", true).order("legal_name"),
    data.supabase.from("quotation_catalog_items").select("id, name, category, unit_name, billing_period, default_unit_cost, default_margin_percent, is_active, is_sellable, is_cost_component").eq("organization_id", organizationId).order("category").order("name"),
    data.supabase.from("quotation_catalog_cost_components").select("id, product_catalog_item_id, cost_catalog_item_id, quantity, unit_cost_override, notes").eq("organization_id", organizationId).order("created_at"),
    data.supabase.from("sales_quotes").select("id, counterparty_id, opportunity_id, quote_number, title, status, currency_code, valid_until, term_months, notes, items, one_time_cost, one_time_sale, monthly_cost, monthly_sale, contract_value, gross_profit, created_at, updated_at").eq("organization_id", organizationId).order("updated_at", { ascending: false }).limit(100),
  ]);
  if (customers.error || catalog.error || costComponents.error || quotes.error) return NextResponse.json({ error: "unable_to_load_quotations" }, { status: 500 });
  return NextResponse.json({ customers: customers.data ?? [], catalog: catalog.data ?? [], costComponents: costComponents.data ?? [], quotes: quotes.data ?? [] });
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
    const isSellable = input?.isSellable !== false;
    const isCostComponent = input?.isCostComponent === true;
    if (!isSellable && !isCostComponent) return NextResponse.json({ error: "catalog_item_without_usage" }, { status: 400 });
    const values = { name, unit_name: unitName, category, billing_period: billingPeriod, default_unit_cost: defaultUnitCost, default_margin_percent: defaultMarginPercent, is_active: input?.isActive !== false, is_sellable: isSellable, is_cost_component: isCostComponent };
    const query = isUuid(input?.id)
      ? data.supabase.from("quotation_catalog_items").update(values).eq("id", input.id).eq("organization_id", organizationId)
      : data.supabase.from("quotation_catalog_items").insert({ ...values, organization_id: organizationId, created_by: data.user.id });
    const { data: saved, error } = await query.select("id").maybeSingle();
    if (error || !saved) return NextResponse.json({ error: "unable_to_save_catalog_item" }, { status: 409 });
    return NextResponse.json({ id: saved.id });
  }

  if (body?.action === "save_cost_model") {
    const parentCatalogItemId = body.parentCatalogItemId;
    const rawComponents = Array.isArray(body.components) ? body.components : null;
    if (!isUuid(parentCatalogItemId) || !rawComponents || rawComponents.length > 50) return NextResponse.json({ error: "invalid_cost_model" }, { status: 400 });
    const components = rawComponents.map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const input = entry as Record<string, unknown>;
      const catalogItemId = isUuid(input.catalogItemId) ? input.catalogItemId : null;
      const quantity = amount(input.quantity, 1_000_000);
      const overrideInput = input.unitCostOverride;
      const parsedOverride = overrideInput === null || overrideInput === undefined || overrideInput === "" ? null : amount(overrideInput);
      const unitCostOverride = overrideInput !== null && overrideInput !== undefined && overrideInput !== "" && parsedOverride === null ? undefined : parsedOverride;
      return catalogItemId && catalogItemId !== parentCatalogItemId && quantity !== null && quantity > 0 && unitCostOverride !== undefined
        ? { catalogItemId, quantity, unitCostOverride }
        : null;
    });
    if (components.some((entry) => entry === null)) return NextResponse.json({ error: "invalid_cost_component" }, { status: 400 });
    const parsedComponents = components as Array<{ catalogItemId: string; quantity: number; unitCostOverride: number | null }>;
    const componentIds = parsedComponents.map((entry) => entry.catalogItemId);
    if (new Set(componentIds).size !== componentIds.length) return NextResponse.json({ error: "duplicate_cost_component" }, { status: 400 });
    const requestedIds = [parentCatalogItemId, ...componentIds];
    const { data: catalogRows, error: catalogError } = await data.supabase.from("quotation_catalog_items").select("id, is_sellable, is_cost_component, billing_period").eq("organization_id", organizationId).in("id", requestedIds);
    const parent = catalogRows?.find((item) => item.id === parentCatalogItemId);
    const availableComponents = new Set((catalogRows ?? []).filter((item) => item.is_cost_component).map((item) => item.id));
    if (catalogError || !parent?.is_sellable || componentIds.some((id) => !availableComponents.has(id) || catalogRows?.find((item) => item.id === id)?.billing_period !== parent.billing_period)) return NextResponse.json({ error: "cost_model_catalog_mismatch" }, { status: 400 });

    const { data: existing, error: existingError } = await data.supabase.from("quotation_catalog_cost_components").select("id, cost_catalog_item_id").eq("organization_id", organizationId).eq("product_catalog_item_id", parentCatalogItemId);
    if (existingError) return NextResponse.json({ error: "unable_to_load_cost_model" }, { status: 409 });
    if (parsedComponents.length) {
      const { error: upsertError } = await data.supabase.from("quotation_catalog_cost_components").upsert(parsedComponents.map((component) => ({ organization_id: organizationId, product_catalog_item_id: parentCatalogItemId, cost_catalog_item_id: component.catalogItemId, quantity: component.quantity, unit_cost_override: component.unitCostOverride, created_by: data.user.id })), { onConflict: "organization_id,product_catalog_item_id,cost_catalog_item_id" });
      if (upsertError) return NextResponse.json({ error: "unable_to_save_cost_model" }, { status: 409 });
    }
    const removedIds = (existing ?? []).filter((entry) => !componentIds.includes(entry.cost_catalog_item_id)).map((entry) => entry.id);
    if (removedIds.length) {
      const { error: deleteError } = await data.supabase.from("quotation_catalog_cost_components").delete().eq("organization_id", organizationId).in("id", removedIds);
      if (deleteError) return NextResponse.json({ error: "unable_to_remove_cost_components" }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
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
