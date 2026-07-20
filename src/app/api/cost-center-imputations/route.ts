import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationFinanceAccess } from "@/lib/admin-access";

const sources = new Set(["issued_document", "received_document", "direct_payable", "budget_line", "financing_plan"]);
type Source = "issued_document" | "received_document" | "direct_payable" | "budget_line" | "financing_plan";

function number(value: number | string | null) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_organization" }, { status: 400 });
  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });

  const [centers, issued, received, directPayables, budgetLines, financingPlans] = await Promise.all([
    context.supabase.from("cost_centers").select("id, code, name").eq("organization_id", organizationId).eq("is_active", true).order("code"),
    context.supabase.from("issued_documents").select("id, document_number, issue_date, document_type, client_name, net_amount, total_amount").eq("organization_id", organizationId).is("cost_center_id", null).order("issue_date", { ascending: false }).limit(1000),
    context.supabase.from("received_documents").select("id, document_number, issue_date, document_type, supplier_name, net_amount, total_amount").eq("organization_id", organizationId).is("cost_center_id", null).order("issue_date", { ascending: false }).limit(1000),
    context.supabase.from("direct_payables").select("id, payable_number, supplier_name, description, issue_date, due_date, total_amount, currency_code, status").eq("organization_id", organizationId).is("cost_center_id", null).neq("status", "cancelled").order("issue_date", { ascending: false }).limit(1000),
    context.supabase.from("financial_budget_lines").select("id, period_month, kind, name, amount, financial_plan_versions(name, status)").eq("organization_id", organizationId).is("cost_center_id", null).order("period_month", { ascending: false }).limit(1000),
    context.supabase.from("asset_financing_plans").select("id, plan_number, plan_kind, supplier_name, asset_name, first_due_date, financing_total_amount, currency_code, status").eq("organization_id", organizationId).is("cost_center_id", null).neq("status", "cancelled").order("first_due_date", { ascending: false }).limit(500),
  ]);
  if ([centers, issued, received, directPayables, budgetLines, financingPlans].some((result) => result.error)) return NextResponse.json({ error: "unable_to_load_cost_center_imputations" }, { status: 500 });

  const rows = [
    ...(issued.data ?? []).map((item) => ({ id: item.id, source: "issued_document" as const, kind: "income" as const, reference: item.document_number || "Sin folio", title: item.document_type || "Documento emitido", counterparty: item.client_name || "Cliente no informado", date: item.issue_date, amount: number(item.net_amount ?? item.total_amount), currency: "CLP", status: null })),
    ...(received.data ?? []).map((item) => ({ id: item.id, source: "received_document" as const, kind: "expense" as const, reference: item.document_number || "Sin folio", title: item.document_type || "Documento recibido", counterparty: item.supplier_name, date: item.issue_date, amount: number(item.net_amount ?? item.total_amount), currency: "CLP", status: null })),
    ...(directPayables.data ?? []).map((item) => ({ id: item.id, source: "direct_payable" as const, kind: "expense" as const, reference: item.payable_number, title: item.description, counterparty: item.supplier_name, date: item.due_date ?? item.issue_date, amount: number(item.total_amount), currency: item.currency_code, status: item.status })),
    ...(budgetLines.data ?? []).map((item) => ({ id: item.id, source: "budget_line" as const, kind: item.kind === "revenue" ? "planned_income" as const : "planned_expense" as const, reference: "Presupuesto", title: item.name, counterparty: item.financial_plan_versions?.[0]?.name ?? "Plan financiero", date: item.period_month, amount: number(item.amount), currency: "CLP", status: item.financial_plan_versions?.[0]?.status ?? null })),
    ...(financingPlans.data ?? []).map((item) => ({ id: item.id, source: "financing_plan" as const, kind: "commitment" as const, reference: item.plan_number, title: item.asset_name || (item.plan_kind === "credit" ? "Crédito / préstamo" : "Deuda con proveedor"), counterparty: item.supplier_name, date: item.first_due_date, amount: number(item.financing_total_amount), currency: item.currency_code, status: item.status })),
  ].sort((left, right) => (right.date ?? "").localeCompare(left.date ?? ""));

  return NextResponse.json({ centers: centers.data ?? [], rows });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const organizationId = body?.organizationId;
  const source = body?.source;
  const costCenterId = body?.costCenterId;
  const recordIds = body?.recordIds;
  if (!isUuid(organizationId) || typeof source !== "string" || !sources.has(source) || !isUuid(costCenterId) || !Array.isArray(recordIds) || !recordIds.length || recordIds.length > 250 || !recordIds.every(isUuid)) return NextResponse.json({ error: "invalid_imputation_request" }, { status: 400 });
  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });

  const { data: center } = await context.supabase.from("cost_centers").select("id").eq("id", costCenterId).eq("organization_id", organizationId).eq("is_active", true).maybeSingle();
  if (!center) return NextResponse.json({ error: "cost_center_not_found" }, { status: 404 });

  const tableBySource: Record<Source, string> = {
    issued_document: "issued_documents",
    received_document: "received_documents",
    direct_payable: "direct_payables",
    budget_line: "financial_budget_lines",
    financing_plan: "asset_financing_plans",
  };
  const { data, error } = await context.supabase
    .from(tableBySource[source as Source])
    .update({ cost_center_id: costCenterId })
    .eq("organization_id", organizationId)
    .is("cost_center_id", null)
    .in("id", recordIds as string[])
    .select("id");
  if (error) return NextResponse.json({ error: "unable_to_assign_cost_center" }, { status: 422 });
  return NextResponse.json({ assigned: data?.length ?? 0 });
}
