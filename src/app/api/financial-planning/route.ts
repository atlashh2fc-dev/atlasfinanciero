import { NextRequest, NextResponse } from "next/server";
import {
  isUuid,
  requireOrganizationExpenseReadAccess,
  requireOrganizationFinanceAccess,
} from "@/lib/admin-access";

const budgetKinds = new Set(["revenue", "expense"]);
const directions = new Set(["inflow", "outflow"]);
const planStatuses = new Set(["draft", "active", "archived"]);

function date(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : value;
}

function month(value: unknown) {
  const parsed = date(typeof value === "string" && value.length === 7 ? `${value}-01` : value);
  return parsed?.slice(8) === "01" ? parsed : null;
}

function positiveAmount(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 999_999_999_999_999 ? parsed : null;
}

function percentageBasisPoints(value: unknown) {
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string" || !/^\d+(\.\d{1,4})?$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) return null;
  const basisPoints = Math.round(parsed * 10_000);
  return Math.abs(parsed * 10_000 - basisPoints) < 0.000_001 ? basisPoints : null;
}

function optionalText(value: unknown, maxLength: number) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

function requiredText(value: unknown, maxLength: number) {
  return optionalText(value, maxLength);
}

function parseYear(value: string | null) {
  if (!value) return new Date().getUTCFullYear();
  const year = Number(value);
  return Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : null;
}

function dateRangeForYear(year: number) {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  const year = parseYear(request.nextUrl.searchParams.get("year"));
  if (!isUuid(organizationId) || year === null)
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const context = await requireOrganizationExpenseReadAccess(organizationId);
  if (context.error || !context.supabase)
    return NextResponse.json({ error: context.error }, { status: context.status });

  const range = dateRangeForYear(year);
  const [membership, plans, budgetLines, settings, adjustments, issued, received, accounts, transactions, customers, services, customerServices, preinvoices, preinvoiceLines, allocations] = await Promise.all([
    context.supabase
      .from("organization_memberships")
      .select("role")
      .eq("organization_id", organizationId)
      .eq("user_id", context.user?.id ?? "")
      .maybeSingle(),
    context.supabase
      .from("financial_plan_versions")
      .select("id, fiscal_year, name, status, notes, activated_at, created_at")
      .eq("organization_id", organizationId)
      .eq("fiscal_year", year)
      .order("created_at"),
    context.supabase
      .from("financial_budget_lines")
      .select("id, plan_version_id, period_month, kind, name, amount, cost_center_id, counterparty_id, service_catalog_id, notes")
      .eq("organization_id", organizationId)
      .gte("period_month", range.from)
      .lte("period_month", range.to)
      .order("period_month"),
    context.supabase
      .from("cash_forecast_settings")
      .select("horizon_weeks, include_overdue_in_first_week")
      .eq("organization_id", organizationId)
      .maybeSingle(),
    context.supabase
      .from("cash_forecast_adjustments")
      .select("id, expected_on, direction, amount, description, counterparty_id, notes")
      .eq("organization_id", organizationId)
      .order("expected_on"),
    context.supabase
      .from("issued_documents")
      .select("id, counterparty_id, document_number, issue_date, due_date, payment_term_days, document_type, net_amount, total_amount, payment_status, client_name")
      .eq("organization_id", organizationId)
      .order("issue_date", { ascending: false })
      .limit(1500),
    context.supabase
      .from("received_documents")
      .select("id, supplier_counterparty_id, supplier_name, document_number, issue_date, due_date, payment_term_days, document_type, net_amount, total_amount, payment_status")
      .eq("organization_id", organizationId)
      .order("issue_date", { ascending: false })
      .limit(1500),
    context.supabase
      .from("bank_accounts")
      .select("id, name, opening_balance, is_active")
      .eq("organization_id", organizationId)
      .eq("is_active", true),
    context.supabase
      .from("bank_transactions")
      .select("id, bank_account_id, booked_on, amount, balance_after")
      .eq("organization_id", organizationId)
      .order("booked_on", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(2500),
    context.supabase
      .from("counterparties")
      .select("id, legal_name, trade_name, kind")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .order("legal_name"),
    context.supabase
      .from("service_catalog")
      .select("id, name, category")
      .eq("organization_id", organizationId)
      .order("name"),
    context.supabase
      .from("customer_services")
      .select("id, counterparty_id, service_catalog_id, is_active")
      .eq("organization_id", organizationId)
      .eq("is_active", true),
    context.supabase
      .from("preinvoices")
      .select("id, counterparty_id, period_month, status, issued_document_id")
      .eq("organization_id", organizationId)
      .gte("period_month", range.from)
      .lte("period_month", range.to)
      .in("status", ["issued", "approved"]),
    context.supabase
      .from("preinvoice_lines")
      .select("id, preinvoice_id, customer_service_id, service_catalog_id, description, net_amount")
      .eq("organization_id", organizationId),
    context.supabase
      .from("profitability_cost_allocations")
      .select("id, received_document_id, counterparty_id, customer_service_id, allocation_percentage, allocated_amount, notes")
      .eq("organization_id", organizationId),
  ]);

  const results = [plans, budgetLines, settings, adjustments, issued, received, accounts, transactions, customers, services, customerServices, preinvoices, preinvoiceLines, allocations];
  if (results.some((result) => result.error))
    return NextResponse.json({ error: "unable_to_load_financial_planning" }, { status: 500 });

  return NextResponse.json({
    year,
    role: membership.data?.role ?? "auditor",
    plans: plans.data ?? [],
    budgetLines: budgetLines.data ?? [],
    settings: settings.data ?? { horizon_weeks: 13, include_overdue_in_first_week: true },
    adjustments: adjustments.data ?? [],
    issuedDocuments: issued.data ?? [],
    receivedDocuments: received.data ?? [],
    bankAccounts: accounts.data ?? [],
    bankTransactions: transactions.data ?? [],
    customers: (customers.data ?? []).filter((item) => item.kind === "customer" || item.kind === "both"),
    services: services.data ?? [],
    customerServices: customerServices.data ?? [],
    preinvoices: preinvoices.data ?? [],
    preinvoiceLines: preinvoiceLines.data ?? [],
    allocations: allocations.data ?? [],
  });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const organizationId = body?.organizationId;
  if (!body || !isUuid(organizationId))
    return NextResponse.json({ error: "invalid_organization" }, { status: 400 });

  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase || !context.user)
    return NextResponse.json({ error: context.error }, { status: context.status });

  const action = body?.action;
  if (action === "create_plan") {
    const fiscalYear = parseYear(typeof body.year === "number" ? String(body.year) : typeof body.year === "string" ? body.year : null);
    const name = requiredText(body.name, 120);
    const notes = optionalText(body.notes, 2_000);
    if (fiscalYear === null || !name)
      return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
    const { data, error } = await context.supabase.from("financial_plan_versions").insert({
      organization_id: organizationId,
      fiscal_year: fiscalYear,
      name,
      notes,
      created_by: context.user.id,
    }).select("id, fiscal_year, name, status, notes, activated_at, created_at").single();
    return error || !data
      ? NextResponse.json({ error: "unable_to_create_plan" }, { status: 409 })
      : NextResponse.json({ plan: data }, { status: 201 });
  }

  if (action === "set_plan_status") {
    const planId = body.planId;
    const status = body.status;
    if (!isUuid(planId) || typeof status !== "string" || !planStatuses.has(status))
      return NextResponse.json({ error: "invalid_plan_status" }, { status: 400 });
    const { data, error } = await context.supabase.from("financial_plan_versions")
      .update({ status })
      .eq("id", planId).eq("organization_id", organizationId)
      .select("id, fiscal_year, name, status, notes, activated_at, created_at").maybeSingle();
    return error || !data
      ? NextResponse.json({ error: "unable_to_update_plan" }, { status: 409 })
      : NextResponse.json({ plan: data });
  }

  if (action === "create_budget_line") {
    const planVersionId = body.planVersionId;
    const periodMonth = month(body.periodMonth);
    const kind = body.kind;
    const name = requiredText(body.name, 180);
    const amount = positiveAmount(body.amount);
    const notes = optionalText(body.notes, 2_000);
    const optionalId = (value: unknown) => value === undefined || value === null || value === "" ? null : isUuid(value) ? value : undefined;
    const costCenterId = optionalId(body.costCenterId);
    const counterpartyId = optionalId(body.counterpartyId);
    const serviceCatalogId = optionalId(body.serviceCatalogId);
    if (!isUuid(planVersionId) || !periodMonth || typeof kind !== "string" || !budgetKinds.has(kind) || !name || !amount || costCenterId === undefined || counterpartyId === undefined || serviceCatalogId === undefined)
      return NextResponse.json({ error: "invalid_budget_line" }, { status: 400 });
    const { data, error } = await context.supabase.from("financial_budget_lines").insert({
      organization_id: organizationId, plan_version_id: planVersionId, period_month: periodMonth,
      kind, name, amount, cost_center_id: costCenterId, counterparty_id: counterpartyId,
      service_catalog_id: serviceCatalogId, notes, created_by: context.user.id,
    }).select("id, plan_version_id, period_month, kind, name, amount, cost_center_id, counterparty_id, service_catalog_id, notes").single();
    return error || !data
      ? NextResponse.json({ error: "unable_to_create_budget_line" }, { status: 409 })
      : NextResponse.json({ budgetLine: data }, { status: 201 });
  }

  if (action === "create_cash_adjustment") {
    const expectedOn = date(body.expectedOn);
    const direction = body.direction;
    const amount = positiveAmount(body.amount);
    const description = requiredText(body.description, 280);
    const notes = optionalText(body.notes, 2_000);
    const counterpartyId = body.counterpartyId === undefined || body.counterpartyId === null || body.counterpartyId === "" ? null : isUuid(body.counterpartyId) ? body.counterpartyId : undefined;
    if (!expectedOn || typeof direction !== "string" || !directions.has(direction) || !amount || !description || counterpartyId === undefined)
      return NextResponse.json({ error: "invalid_cash_adjustment" }, { status: 400 });
    const { data, error } = await context.supabase.from("cash_forecast_adjustments").insert({
      organization_id: organizationId, expected_on: expectedOn, direction, amount, description,
      counterparty_id: counterpartyId, notes, created_by: context.user.id,
    }).select("id, expected_on, direction, amount, description, counterparty_id, notes").single();
    return error || !data
      ? NextResponse.json({ error: "unable_to_create_cash_adjustment" }, { status: 409 })
      : NextResponse.json({ adjustment: data }, { status: 201 });
  }

  if (action === "replace_cost_allocations") {
    const receivedDocumentId = body.receivedDocumentId;
    const lines = body.allocations;
    if (!isUuid(receivedDocumentId) || !Array.isArray(lines) || lines.length < 1 || lines.length > 100)
      return NextResponse.json({ error: "invalid_cost_allocation" }, { status: 400 });
    const allocations = lines.map((line) => {
      if (!line || typeof line !== "object") return null;
      const item = line as Record<string, unknown>;
      const customerServiceId = item.customerServiceId === undefined || item.customerServiceId === null || item.customerServiceId === "" ? null : item.customerServiceId;
      const percentage = percentageBasisPoints(item.percentage);
      const notes = optionalText(item.notes, 2_000);
      if (!isUuid(item.counterpartyId) || (customerServiceId !== null && !isUuid(customerServiceId)) || percentage === null)
        return null;
      return {
        counterpartyId: item.counterpartyId,
        customerServiceId,
        percentage: (percentage / 10_000).toFixed(4),
        notes,
        basisPoints: percentage,
      };
    });
    const validAllocations = allocations.filter((line): line is NonNullable<typeof line> => line !== null);
    if (validAllocations.length !== allocations.length || validAllocations.reduce((total, line) => total + line.basisPoints, 0) !== 1_000_000)
      return NextResponse.json({ error: "allocation_percentages_must_equal_100" }, { status: 400 });

    const { data, error } = await context.supabase.rpc("replace_profitability_cost_allocations", {
      p_organization_id: organizationId,
      p_received_document_id: receivedDocumentId,
      p_allocations: validAllocations.map(({ basisPoints: _basisPoints, ...line }) => line),
    });
    return error
      ? NextResponse.json({ error: "unable_to_replace_cost_allocations" }, { status: 409 })
      : NextResponse.json({ allocations: data ?? [] });
  }

  return NextResponse.json({ error: "unsupported_action" }, { status: 400 });
}

export async function PATCH(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const organizationId = body?.organizationId;
  if (!body || !isUuid(organizationId))
    return NextResponse.json({ error: "invalid_organization" }, { status: 400 });
  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase || !context.user)
    return NextResponse.json({ error: context.error }, { status: context.status });

  if (body?.action === "update_cash_settings") {
    const horizonWeeks = Number(body.horizonWeeks);
    const includeOverdueInFirstWeek = body.includeOverdueInFirstWeek;
    if (!Number.isInteger(horizonWeeks) || horizonWeeks < 4 || horizonWeeks > 26 || typeof includeOverdueInFirstWeek !== "boolean")
      return NextResponse.json({ error: "invalid_cash_settings" }, { status: 400 });
    const { data, error } = await context.supabase.from("cash_forecast_settings").upsert({
      organization_id: organizationId, horizon_weeks: horizonWeeks,
      include_overdue_in_first_week: includeOverdueInFirstWeek, updated_by: context.user.id,
    }, { onConflict: "organization_id" }).select("horizon_weeks, include_overdue_in_first_week").single();
    return error || !data
      ? NextResponse.json({ error: "unable_to_update_cash_settings" }, { status: 409 })
      : NextResponse.json({ settings: data });
  }

  if (body?.action === "delete_budget_line" || body?.action === "delete_cash_adjustment" || body?.action === "delete_cost_allocation") {
    const id = body.id;
    if (!isUuid(id)) return NextResponse.json({ error: "invalid_record" }, { status: 400 });
    const table = body.action === "delete_budget_line" ? "financial_budget_lines" : body.action === "delete_cash_adjustment" ? "cash_forecast_adjustments" : "profitability_cost_allocations";
    const { error } = await context.supabase.from(table).delete().eq("id", id).eq("organization_id", organizationId);
    return error
      ? NextResponse.json({ error: "unable_to_delete_record" }, { status: 409 })
      : NextResponse.json({ deleted: id });
  }

  return NextResponse.json({ error: "unsupported_action" }, { status: 400 });
}
