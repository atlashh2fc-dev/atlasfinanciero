import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationExpenseReadAccess } from "@/lib/admin-access";
import { isDateRangeActiveInPeriod, periodMonth } from "@/lib/peoplework/sync-utils";
import { buildEffectivePayrollByMonth } from "@/lib/payroll-reporting";

export const dynamic = "force-dynamic";

function asNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizedType(value: string | null) {
  return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_organization" }, { status: 400 });
  const context = await requireOrganizationExpenseReadAccess(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });
  const supabase = context.supabase;
  const yearParam = Number(request.nextUrl.searchParams.get("year"));
  const year = Number.isInteger(yearParam) && yearParam >= 2000 && yearParam <= new Date().getFullYear() ? yearParam : new Date().getFullYear();
  const monthParam = Number(request.nextUrl.searchParams.get("month"));
  const defaultMonth = year === new Date().getFullYear() ? new Date().getMonth() + 1 : 12;
  const selectedMonth = Number.isInteger(monthParam) && monthParam >= 1 && monthParam <= 12 ? monthParam : defaultMonth;
  const month = periodMonth(year, selectedMonth);
  const [integrationResult, contractualSnapshotResult, peopleResult, contractsResult, metricsResult, payrollResult, provisionsResult, documentsResult, receivedExpensesResult, directPayablesResult, receivablesResult, centersResult, customerLinksResult, purchaseOrdersResult, purchaseOrderBillingsResult, recurrenceRulesResult, activePlanResult] = await Promise.all([
    supabase.from("payroll_integrations").select("is_active, last_sync_at, last_sync_status, last_period_month").eq("organization_id", organizationId).eq("provider", "peoplework").maybeSingle(),
    supabase.from("payroll_contractual_snapshots").select("current_sync_run_id").eq("organization_id", organizationId).eq("fiscal_year", year).maybeSingle(),
    supabase.from("payroll_people").select("id, full_name, national_identification, is_active, management_name, job_title").eq("organization_id", organizationId).eq("provider", "peoplework").order("full_name"),
    supabase.from("payroll_contracts").select("person_id, contract_status, contract_type, start_date, end_date, monthly_gross_salary, currency_code, weekly_hours, payment_schedule, management_name, job_title, cost_centers").eq("organization_id", organizationId).eq("provider", "peoplework"),
    supabase.from("payroll_person_period_metrics").select("person_id, absence_days, vacation_days, worked_days, non_worked_days, worked_minutes, overtime_minutes, late_minutes, early_departure_minutes").eq("organization_id", organizationId).eq("period_month", month),
    supabase.from("payroll_cost_lines").select("sync_run_id, period_month, amount, cost_center_code, cost_center_name, data_basis").eq("organization_id", organizationId).gte("period_month", `${year}-01-01`).lte("period_month", `${year}-12-01`),
    supabase.from("payroll_provisions").select("id, period_month, posted_amount").eq("organization_id", organizationId).gte("period_month", `${year}-01-01`).lte("period_month", `${year}-12-01`),
    supabase.from("issued_documents").select("issue_date, document_type, net_amount, counterparty_id, cost_center_id").eq("organization_id", organizationId).gte("issue_date", `${year}-01-01`).lte("issue_date", `${year}-12-31`),
    supabase.from("received_documents").select("issue_date, document_type, net_amount, cost_center_id").eq("organization_id", organizationId).gte("issue_date", `${year}-01-01`).lte("issue_date", `${year}-12-31`),
    supabase.from("direct_payables").select("issue_date, total_amount, cost_center_id, currency_code").eq("organization_id", organizationId).in("status", ["approved", "paid"]).is("asset_financing_installment_id", null).gte("issue_date", `${year}-01-01`).lte("issue_date", `${year}-12-31`),
    supabase.from("issued_document_receivable_balances").select("issued_document_id, issue_date, document_type, net_amount, due_date, payment_date, outstanding_amount, collection_status, is_collectible").eq("organization_id", organizationId),
    supabase.from("cost_centers").select("id, code, name").eq("organization_id", organizationId).eq("is_active", true),
    supabase.from("cost_center_customer_links").select("cost_center_id, counterparty_id, allocation_percentage, effective_from, effective_to").eq("organization_id", organizationId),
    supabase.from("customer_purchase_orders").select("id, net_amount, status").eq("organization_id", organizationId).neq("status", "cancelled"),
    supabase.from("customer_purchase_order_billings").select("purchase_order_id, allocated_net_amount").eq("organization_id", organizationId),
    supabase.from("billing_recurrence_rules").select("expected_net_amount").eq("organization_id", organizationId).eq("status", "active"),
    supabase.from("financial_plan_versions").select("id, name").eq("organization_id", organizationId).eq("fiscal_year", year).eq("status", "active").maybeSingle(),
  ]);
  if (integrationResult.error || contractualSnapshotResult.error || peopleResult.error || contractsResult.error || metricsResult.error || payrollResult.error || provisionsResult.error || documentsResult.error || receivedExpensesResult.error || directPayablesResult.error || receivablesResult.error || centersResult.error || customerLinksResult.error || purchaseOrdersResult.error || purchaseOrderBillingsResult.error || recurrenceRulesResult.error || activePlanResult.error) return NextResponse.json({ error: "unable_to_load_peoplework_summary" }, { status: 500 });
  const activePlan = activePlanResult.data;
  const budgetLinesResult = activePlan
    ? await supabase.from("financial_budget_lines").select("period_month, kind, amount").eq("organization_id", organizationId).eq("plan_version_id", activePlan.id)
    : { data: [], error: null };
  if (budgetLinesResult.error) return NextResponse.json({ error: "unable_to_load_peoplework_summary" }, { status: 500 });
  const provisionIds = (provisionsResult.data ?? []).map((provision) => provision.id);
  const revisionsResult = provisionIds.length
    ? await supabase.from("payroll_provision_revisions").select("id, provision_id, as_of_date, status").eq("organization_id", organizationId).in("provision_id", provisionIds)
    : { data: [], error: null };
  if (revisionsResult.error) return NextResponse.json({ error: "unable_to_load_peoplework_summary" }, { status: 500 });
  const revisionIds = (revisionsResult.data ?? []).map((revision) => revision.id);
  const provisionLinesResult = revisionIds.length
    ? await supabase.from("payroll_provision_lines").select("revision_id, source_type, direction, amount, cost_center_id, source_cost_center_code, source_cost_center_name").eq("organization_id", organizationId).in("revision_id", revisionIds)
    : { data: [], error: null };
  if (provisionLinesResult.error) return NextResponse.json({ error: "unable_to_load_peoplework_summary" }, { status: 500 });

  const people = peopleResult.data ?? [];
  const activePeople = people.filter((person) => person.is_active);
  const contractByPerson = new Map<string, (typeof contractsResult.data)[number]>();
  for (const contract of contractsResult.data ?? []) {
    if (!isDateRangeActiveInPeriod({ start_date: contract.start_date, end_date: contract.end_date }, month)) continue;
    const current = contractByPerson.get(contract.person_id);
    const currentStart = current?.start_date ?? "0000-01-01";
    const nextStart = contract.start_date ?? "0000-01-01";
    if (!current || nextStart >= currentStart) contractByPerson.set(contract.person_id, contract);
  }
  const contracts = [...contractByPerson.values()];
  const metricByPerson = new Map((metricsResult.data ?? []).map((metric) => [metric.person_id, metric]));
  const activeContractualSyncRunId = contractualSnapshotResult.data?.current_sync_run_id ?? null;
  const contractualCosts = (payrollResult.data ?? []).filter((line) => line.data_basis === "contractual_estimate" && line.sync_run_id === activeContractualSyncRunId);
  const officialPayrollCosts = (payrollResult.data ?? []).filter((line) => line.data_basis === "official_payroll");
  const monthlyContractualCosts = contractualCosts.filter((line) => line.period_month.slice(0, 10) === month);
  const monthlyOfficialPayroll = officialPayrollCosts.filter((line) => line.period_month.slice(0, 10) === month);
  const monthlyGrossTotal = monthlyContractualCosts.reduce((total, line) => total + asNumber(line.amount), 0);
  const officialPayrollTotal = monthlyOfficialPayroll.length ? monthlyOfficialPayroll.reduce((total, line) => total + asNumber(line.amount), 0) : null;
  const averageGross = contracts.length ? monthlyGrossTotal / contracts.length : 0;
  const absenceDays = (metricsResult.data ?? []).reduce((total, metric) => total + asNumber(metric.absence_days), 0);
  const vacationDays = (metricsResult.data ?? []).reduce((total, metric) => total + asNumber(metric.vacation_days), 0);
  const workedDays = (metricsResult.data ?? []).reduce((total, metric) => total + asNumber(metric.worked_days), 0);
  const nonWorkedDays = (metricsResult.data ?? []).reduce((total, metric) => total + asNumber(metric.non_worked_days), 0);
  const workedHours = (metricsResult.data ?? []).reduce((total, metric) => total + asNumber(metric.worked_minutes), 0) / 60;
  const overtimeHours = (metricsResult.data ?? []).reduce((total, metric) => total + asNumber(metric.overtime_minutes), 0) / 60;
  const lateMinutes = (metricsResult.data ?? []).reduce((total, metric) => total + asNumber(metric.late_minutes), 0);
  const employeesWithAttendance = (metricsResult.data ?? []).filter((metric) => asNumber(metric.worked_days) > 0 || asNumber(metric.non_worked_days) > 0).length;

  const centerTotals = new Map<string, { name: string; amount: number }>();
  for (const line of monthlyContractualCosts) {
    const key = line.cost_center_code || line.cost_center_name || "sin-centro";
    const current = centerTotals.get(key) ?? { name: line.cost_center_name || line.cost_center_code || "Sin centro asignado", amount: 0 };
    current.amount += asNumber(line.amount);
    centerTotals.set(key, current);
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
      workedDays: metrics ? asNumber(metrics.worked_days) : 0,
      nonWorkedDays: metrics ? asNumber(metrics.non_worked_days) : 0,
      workedHours: metrics ? asNumber(metrics.worked_minutes) / 60 : 0,
      overtimeHours: metrics ? asNumber(metrics.overtime_minutes) / 60 : 0,
      lateMinutes: metrics ? asNumber(metrics.late_minutes) : 0,
      earlyDepartureMinutes: metrics ? asNumber(metrics.early_departure_minutes) : 0,
    };
  });
  const months = Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, "0")}`);
  const effectivePayrollByMonth = buildEffectivePayrollByMonth({
    periods: months,
    payrollCostLines: officialPayrollCosts.map((line) => ({ ...line, data_basis: "official_payroll" as const })),
    provisions: provisionsResult.data ?? [],
    revisions: (revisionsResult.data ?? []).map((revision) => ({ ...revision, status: revision.status as "draft" | "posted" })),
    provisionLines: (provisionLinesResult.data ?? []).map((line) => ({
      ...line,
      source_type: line.source_type as "peoplework" | "manual",
      direction: line.direction as "add" | "deduct",
    })),
  });
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
  const receivedExpenseByMonth = new Map<string, number>();
  const directExpenseByMonth = new Map<string, number>();
  for (const document of receivedExpensesResult.data ?? []) {
    if (!document.issue_date) continue;
    const type = normalizedType(document.document_type);
    if (type.includes("guia de despacho")) continue;
    const net = asNumber(document.net_amount);
    const amount = type.includes("nota de credito") ? -Math.abs(net) : net;
    const key = document.issue_date.slice(0, 7);
    receivedExpenseByMonth.set(key, (receivedExpenseByMonth.get(key) ?? 0) + amount);
  }
  for (const payable of directPayablesResult.data ?? []) {
    if (!payable.issue_date || payable.currency_code !== "CLP") continue;
    const key = payable.issue_date.slice(0, 7);
    directExpenseByMonth.set(key, (directExpenseByMonth.get(key) ?? 0) + asNumber(payable.total_amount));
  }
  const planByPeriod = new Map<string, { revenue: number; expense: number }>();
  for (const line of budgetLinesResult.data ?? []) {
    const period = line.period_month.slice(0, 7);
    const current = planByPeriod.get(period) ?? { revenue: 0, expense: 0 };
    if (line.kind === "revenue") current.revenue += asNumber(line.amount);
    else current.expense += asNumber(line.amount);
    planByPeriod.set(period, current);
  }
  const currentMonthStart = new Date().toISOString().slice(0, 8) + "01";
  const incomeStatement = months.map((period) => {
    const revenue = revenueByMonth.get(period) ?? 0;
    const receivedExpenses = receivedExpenseByMonth.get(period) ?? 0;
    const directExpenses = directExpenseByMonth.get(period) ?? 0;
    const expenses = receivedExpenses + directExpenses;
    const laborCost = effectivePayrollByMonth.get(period) ?? { amount: 0, basis: "missing" as const };
    const plan = planByPeriod.get(period);
    const budgetRevenue = plan ? plan.revenue : null;
    const budgetExpense = plan ? plan.expense : null;
    const isClosedPeriod = `${period}-01` < currentMonthStart;
    const forecastRevenue = budgetRevenue === null ? null : isClosedPeriod ? revenue : budgetRevenue;
    const forecastExpense = budgetExpense === null ? null : isClosedPeriod ? expenses + laborCost.amount : budgetExpense;
    const forecastResult = forecastExpense === null || forecastRevenue === null ? null : forecastRevenue - forecastExpense;
    return {
      period,
      revenue,
      expenses,
      receivedExpenses,
      directExpenses,
      laborCost: laborCost.amount,
      laborCostBasis: laborCost.basis,
      laborCostAvailable: laborCost.basis !== "missing",
      recognizedExpenses: expenses + laborCost.amount,
      operatingResult: revenue - laborCost.amount - expenses,
      budgetRevenue,
      budgetExpense,
      budgetResult: budgetRevenue === null || budgetExpense === null ? null : budgetRevenue - budgetExpense,
      forecastRevenue,
      forecastExpense,
      forecastResult,
      isClosedPeriod,
    };
  });
  const centerById = new Map((centersResult.data ?? []).map((center) => [center.id, center]));
  const centerPerformance = new Map<string, { code: string; name: string; revenue: number; laborCost: number; expenses: number }>();
  for (const center of centersResult.data ?? []) centerPerformance.set(center.id, { code: center.code, name: center.name, revenue: 0, laborCost: 0, expenses: 0 });
  const centerByCode = new Map((centersResult.data ?? []).map((center) => [center.code.trim().toLocaleUpperCase("es-CL"), center.id]));
  for (const payroll of effectivePayrollByMonth.values()) {
    for (const allocation of payroll.allocations) {
      const centerId = allocation.costCenterId && centerById.has(allocation.costCenterId)
        ? allocation.costCenterId
        : allocation.costCenterCode ? centerByCode.get(allocation.costCenterCode.trim().toLocaleUpperCase("es-CL")) : null;
      const key = centerId ?? "__unallocated__";
      if (!centerPerformance.has(key)) centerPerformance.set(key, { code: "SIN-CENTRO", name: "Costo laboral no imputado", revenue: 0, laborCost: 0, expenses: 0 });
      const target = centerPerformance.get(key);
      if (target) target.laborCost += allocation.amount;
    }
  }
  for (const document of documentsResult.data ?? []) {
    if (!document.issue_date) continue;
    const type = normalizedType(document.document_type);
    if (type.includes("orden de compra")) continue;
    const net = type.includes("nota de credito") ? -Math.abs(asNumber(document.net_amount)) : asNumber(document.net_amount);
    if (document.cost_center_id) {
      const target = centerPerformance.get(document.cost_center_id);
      if (target) target.revenue += net;
      continue;
    }
    if (!document.counterparty_id) continue;
    for (const link of customerLinksResult.data ?? []) {
      if (link.counterparty_id !== document.counterparty_id || link.effective_from > document.issue_date || (link.effective_to && link.effective_to < document.issue_date)) continue;
      const target = centerPerformance.get(link.cost_center_id);
      if (target) target.revenue += net * asNumber(link.allocation_percentage) / 100;
    }
  }
  for (const document of receivedExpensesResult.data ?? []) {
    if (!document.issue_date || !document.cost_center_id) continue;
    const type = normalizedType(document.document_type);
    if (type.includes("orden de compra")) continue;
    const net = type.includes("nota de credito") ? -Math.abs(asNumber(document.net_amount)) : asNumber(document.net_amount);
    const target = centerPerformance.get(document.cost_center_id);
    if (target) target.expenses += net;
  }
  for (const payable of directPayablesResult.data ?? []) {
    if (!payable.cost_center_id || payable.currency_code !== "CLP") continue;
    const target = centerPerformance.get(payable.cost_center_id);
    if (target) target.expenses += asNumber(payable.total_amount);
  }
  const today = new Date().toISOString().slice(0, 10);
  const inSevenDays = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const receivables = (receivablesResult.data ?? []).filter((document) => {
    const type = normalizedType(document.document_type);
    return !type.includes("orden de compra") &&
      !type.includes("nota de credito") &&
      document.is_collectible &&
      ["Pendiente", "Abonada"].includes(document.collection_status ?? "") &&
      asNumber(document.outstanding_amount) > 0;
  });
  const totalReceivable = receivables.reduce((total, document) => total + asNumber(document.outstanding_amount), 0);
  const overdueReceivable = receivables.filter((document) => document.due_date && document.due_date < today).reduce((total, document) => total + asNumber(document.outstanding_amount), 0);
  const dueNextSevenDays = receivables.filter((document) => document.due_date && document.due_date >= today && document.due_date <= inSevenDays).reduce((total, document) => total + asNumber(document.outstanding_amount), 0);
  const observedPaymentDays = (receivablesResult.data ?? []).flatMap((document) => document.issue_date && document.payment_date ? [Math.round((new Date(`${document.payment_date}T00:00:00`).getTime() - new Date(`${document.issue_date}T00:00:00`).getTime()) / 86_400_000)] : []);
  const averageCollectionDays = observedPaymentDays.length ? observedPaymentDays.reduce((total, item) => total + item, 0) / observedPaymentDays.length : null;
  const allocationsByOrder = new Map<string, number>();
  for (const billing of purchaseOrderBillingsResult.data ?? []) allocationsByOrder.set(billing.purchase_order_id, (allocationsByOrder.get(billing.purchase_order_id) ?? 0) + asNumber(billing.allocated_net_amount));
  const openPurchaseOrderBalance = (purchaseOrdersResult.data ?? []).filter((order) => order.status === "open").reduce((total, order) => total + Math.max(0, asNumber(order.net_amount) - (allocationsByOrder.get(order.id) ?? 0)), 0);
  const recurringMonthlyCommitment = (recurrenceRulesResult.data ?? []).reduce((total, rule) => total + asNumber(rule.expected_net_amount), 0);

  return NextResponse.json({
    integration: integrationResult.data ? { active: integrationResult.data.is_active, lastSyncAt: integrationResult.data.last_sync_at, lastSyncStatus: integrationResult.data.last_sync_status, lastPeriodMonth: integrationResult.data.last_period_month } : null,
    summary: { activePeople: activePeople.length, activeContracts: contracts.length, monthlyGrossTotal, averageGross, officialPayrollTotal, officialPayrollAvailable: officialPayrollTotal !== null, officialPayrollStatus: officialPayrollTotal === null ? "peoplework_public_api_unavailable" : "official", absenceDays, vacationDays, workedDays, nonWorkedDays, workedHours, overtimeHours, lateMinutes, employeesWithAttendance, periodYear: year, periodMonth: selectedMonth },
    costCenters: [...centerTotals.values()].sort((a, b) => b.amount - a.amount),
    persons,
    incomeStatement,
    activePlan: activePlan ? { id: activePlan.id, name: activePlan.name } : null,
    centerPerformance: [...centerPerformance.values()].map((item) => ({ ...item, result: item.revenue - item.laborCost - item.expenses })).sort((a, b) => b.revenue - a.revenue),
    commercial: { totalReceivable, overdueReceivable, dueNextSevenDays, pendingDocuments: receivables.length, averageCollectionDays, openPurchaseOrderBalance, recurringMonthlyCommitment },
  });
}
