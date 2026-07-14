import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationFinanceAccess } from "@/lib/admin-access";
import { forecastMonthly2026 } from "@/data/forecast-2026";

export const dynamic = "force-dynamic";

type CostCenter = { code?: string | null; name?: string | null; percentage?: number | null };

function asNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isCurrentContract(contract: { end_date: string | null }) {
  return !contract.end_date || contract.end_date >= new Date().toISOString().slice(0, 10);
}

function normalizedType(value: string | null) {
  return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_organization" }, { status: 400 });
  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });
  const supabase = context.supabase;
  const yearParam = Number(request.nextUrl.searchParams.get("year"));
  const year = Number.isInteger(yearParam) && yearParam >= 2000 && yearParam <= new Date().getFullYear() ? yearParam : new Date().getFullYear();
  const month = `${year}-01-01`;
  const [integrationResult, peopleResult, contractsResult, metricsResult, payrollResult, documentsResult, receivablesResult, centersResult, customerLinksResult, purchaseOrdersResult, purchaseOrderBillingsResult, recurrenceRulesResult] = await Promise.all([
    supabase.from("payroll_integrations").select("is_active, last_sync_at, last_sync_status, last_period_month").eq("organization_id", organizationId).eq("provider", "peoplework").maybeSingle(),
    supabase.from("payroll_people").select("id, full_name, national_identification, is_active, management_name, job_title").eq("organization_id", organizationId).eq("provider", "peoplework").order("full_name"),
    supabase.from("payroll_contracts").select("person_id, contract_status, contract_type, start_date, end_date, monthly_gross_salary, currency_code, weekly_hours, payment_schedule, management_name, job_title, cost_centers").eq("organization_id", organizationId).eq("provider", "peoplework"),
    supabase.from("payroll_person_period_metrics").select("person_id, absence_days, vacation_days").eq("organization_id", organizationId).eq("period_month", month),
    supabase.from("payroll_cost_lines").select("period_month, amount, cost_center_code").eq("organization_id", organizationId).gte("period_month", `${year}-01-01`).lte("period_month", `${year}-12-01`),
    supabase.from("issued_documents").select("issue_date, document_type, net_amount, counterparty_id").eq("organization_id", organizationId).gte("issue_date", `${year}-01-01`).lte("issue_date", `${year}-12-31`),
    supabase.from("issued_documents").select("issue_date, document_type, net_amount, payment_status, due_date, payment_date").eq("organization_id", organizationId),
    supabase.from("cost_centers").select("id, code, name").eq("organization_id", organizationId).eq("is_active", true),
    supabase.from("cost_center_customer_links").select("cost_center_id, counterparty_id, allocation_percentage, effective_from, effective_to").eq("organization_id", organizationId),
    supabase.from("customer_purchase_orders").select("id, net_amount, status").eq("organization_id", organizationId).neq("status", "cancelled"),
    supabase.from("customer_purchase_order_billings").select("purchase_order_id, allocated_net_amount").eq("organization_id", organizationId),
    supabase.from("billing_recurrence_rules").select("expected_net_amount").eq("organization_id", organizationId).eq("status", "active"),
  ]);
  if (integrationResult.error || peopleResult.error || contractsResult.error || metricsResult.error || payrollResult.error || documentsResult.error || receivablesResult.error || centersResult.error || customerLinksResult.error || purchaseOrdersResult.error || purchaseOrderBillingsResult.error || recurrenceRulesResult.error) return NextResponse.json({ error: "unable_to_load_peoplework_summary" }, { status: 500 });

  const people = peopleResult.data ?? [];
  const activePeople = people.filter((person) => person.is_active);
  const contracts = (contractsResult.data ?? []).filter(isCurrentContract);
  const contractByPerson = new Map<string, typeof contracts[number]>();
  for (const contract of contracts) contractByPerson.set(contract.person_id, contract);
  const metricByPerson = new Map((metricsResult.data ?? []).map((metric) => [metric.person_id, metric]));
  const monthlyGrossTotal = contracts.reduce((total, contract) => total + asNumber(contract.monthly_gross_salary), 0);
  const averageGross = contracts.length ? monthlyGrossTotal / contracts.length : 0;
  const absenceDays = (metricsResult.data ?? []).reduce((total, metric) => total + asNumber(metric.absence_days), 0);
  const vacationDays = (metricsResult.data ?? []).reduce((total, metric) => total + asNumber(metric.vacation_days), 0);

  const centerTotals = new Map<string, { name: string; amount: number }>();
  for (const contract of contracts) {
    const centers = Array.isArray(contract.cost_centers) ? contract.cost_centers as CostCenter[] : [];
    if (!centers.length) {
      const key = "sin-centro";
      const current = centerTotals.get(key) ?? { name: "Sin centro asignado", amount: 0 };
      current.amount += asNumber(contract.monthly_gross_salary);
      centerTotals.set(key, current);
      continue;
    }
    for (const center of centers) {
      const key = center.code || center.name || "sin-centro";
      const current = centerTotals.get(key) ?? { name: center.name || center.code || "Sin centro asignado", amount: 0 };
      current.amount += asNumber(contract.monthly_gross_salary) * (asNumber(center.percentage) || 100) / 100;
      centerTotals.set(key, current);
    }
  }

  const persons = people.map((person) => {
    const contract = contractByPerson.get(person.id);
    const metrics = metricByPerson.get(person.id);
    return {
      id: person.id,
      name: person.full_name,
      nationalIdentification: person.national_identification,
      active: person.is_active,
      management: contract?.management_name ?? person.management_name,
      jobTitle: contract?.job_title ?? person.job_title,
      contractType: contract?.contract_type ?? null,
      contractStatus: contract?.contract_status ?? null,
      monthlyGrossSalary: contract ? asNumber(contract.monthly_gross_salary) : null,
      absenceDays: metrics ? asNumber(metrics.absence_days) : 0,
      vacationDays: metrics ? asNumber(metrics.vacation_days) : 0,
    };
  });
  const months = Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, "0")}`);
  const payrollByMonth = new Map<string, number>();
  for (const item of payrollResult.data ?? []) payrollByMonth.set(item.period_month.slice(0, 7), (payrollByMonth.get(item.period_month.slice(0, 7)) ?? 0) + asNumber(item.amount));
  const revenueByMonth = new Map<string, number>();
  for (const document of documentsResult.data ?? []) {
    if (!document.issue_date) continue;
    const type = normalizedType(document.document_type);
    if (type.includes("orden de compra")) continue;
    const net = asNumber(document.net_amount);
    const amount = type.includes("nota de credito") ? -Math.abs(net) : net;
    const key = document.issue_date.slice(0, 7);
    revenueByMonth.set(key, (revenueByMonth.get(key) ?? 0) + amount);
  }
  const planByPeriod = new Map(year === 2026 ? forecastMonthly2026.map((item) => [item.period.slice(0, 7), item]) : []);
  const currentMonthStart = new Date().toISOString().slice(0, 8) + "01";
  const incomeStatement = months.map((period) => {
    const revenue = revenueByMonth.get(period) ?? 0;
    const payroll = payrollByMonth.get(period) ?? 0;
    const plan = planByPeriod.get(period);
    const budgetRevenue = plan?.projectedRevenue ?? null;
    const budgetExpense = plan?.projectedExpense ?? null;
    const isClosedPeriod = `${period}-01` < currentMonthStart;
    const forecastRevenue = budgetRevenue === null ? null : isClosedPeriod ? revenue : budgetRevenue;
    const forecastResult = budgetExpense === null || forecastRevenue === null ? null : forecastRevenue - budgetExpense;
    return { period, revenue, payroll, operatingResultBeforeOtherExpenses: revenue - payroll, payrollAvailable: payrollByMonth.has(period), budgetRevenue, budgetExpense, budgetResult: budgetRevenue === null || budgetExpense === null ? null : budgetRevenue - budgetExpense, forecastRevenue, forecastResult, isClosedPeriod };
  });
  const centerById = new Map((centersResult.data ?? []).map((center) => [center.id, center]));
  const centerPerformance = new Map<string, { code: string; name: string; revenue: number; payroll: number }>();
  for (const center of centersResult.data ?? []) centerPerformance.set(center.id, { code: center.code, name: center.name, revenue: 0, payroll: 0 });
  const centerByCode = new Map((centersResult.data ?? []).map((center) => [center.code, center.id]));
  for (const line of payrollResult.data ?? []) {
    if (!line.cost_center_code) continue;
    const centerId = centerByCode.get(line.cost_center_code);
    const target = centerId ? centerPerformance.get(centerId) : null;
    if (target) target.payroll += asNumber(line.amount);
  }
  for (const document of documentsResult.data ?? []) {
    if (!document.issue_date || !document.counterparty_id) continue;
    const type = normalizedType(document.document_type);
    if (type.includes("orden de compra")) continue;
    const net = type.includes("nota de credito") ? -Math.abs(asNumber(document.net_amount)) : asNumber(document.net_amount);
    for (const link of customerLinksResult.data ?? []) {
      if (link.counterparty_id !== document.counterparty_id || link.effective_from > document.issue_date || (link.effective_to && link.effective_to < document.issue_date)) continue;
      const target = centerPerformance.get(link.cost_center_id);
      if (target) target.revenue += net * asNumber(link.allocation_percentage) / 100;
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const inSevenDays = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const isPending = (status: string | null) => normalizedType(status).includes("pendiente");
  const receivables = (receivablesResult.data ?? []).filter((document) => {
    const type = normalizedType(document.document_type);
    return !type.includes("orden de compra") && !type.includes("nota de credito") && isPending(document.payment_status);
  });
  const totalReceivable = receivables.reduce((total, document) => total + asNumber(document.net_amount), 0);
  const overdueReceivable = receivables.filter((document) => document.due_date && document.due_date < today).reduce((total, document) => total + asNumber(document.net_amount), 0);
  const dueNextSevenDays = receivables.filter((document) => document.due_date && document.due_date >= today && document.due_date <= inSevenDays).reduce((total, document) => total + asNumber(document.net_amount), 0);
  const observedPaymentDays = (receivablesResult.data ?? []).flatMap((document) => document.issue_date && document.payment_date ? [Math.round((new Date(`${document.payment_date}T00:00:00`).getTime() - new Date(`${document.issue_date}T00:00:00`).getTime()) / 86_400_000)] : []);
  const averageCollectionDays = observedPaymentDays.length ? observedPaymentDays.reduce((total, item) => total + item, 0) / observedPaymentDays.length : null;
  const allocationsByOrder = new Map<string, number>();
  for (const billing of purchaseOrderBillingsResult.data ?? []) allocationsByOrder.set(billing.purchase_order_id, (allocationsByOrder.get(billing.purchase_order_id) ?? 0) + asNumber(billing.allocated_net_amount));
  const openPurchaseOrderBalance = (purchaseOrdersResult.data ?? []).filter((order) => order.status === "open").reduce((total, order) => total + Math.max(0, asNumber(order.net_amount) - (allocationsByOrder.get(order.id) ?? 0)), 0);
  const recurringMonthlyCommitment = (recurrenceRulesResult.data ?? []).reduce((total, rule) => total + asNumber(rule.expected_net_amount), 0);

  return NextResponse.json({
    integration: integrationResult.data ? { active: integrationResult.data.is_active, lastSyncAt: integrationResult.data.last_sync_at, lastSyncStatus: integrationResult.data.last_sync_status, lastPeriodMonth: integrationResult.data.last_period_month } : null,
    summary: { activePeople: activePeople.length, activeContracts: contracts.length, monthlyGrossTotal, averageGross, absenceDays, vacationDays, periodYear: year },
    costCenters: [...centerTotals.values()].sort((a, b) => b.amount - a.amount),
    persons,
    incomeStatement,
    centerPerformance: [...centerPerformance.values()].map((item) => ({ ...item, result: item.revenue - item.payroll })).sort((a, b) => b.revenue - a.revenue),
    commercial: { totalReceivable, overdueReceivable, dueNextSevenDays, pendingDocuments: receivables.length, averageCollectionDays, openPurchaseOrderBalance, recurringMonthlyCommitment },
  });
}
