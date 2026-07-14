import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationFinanceAccess } from "@/lib/admin-access";
import { createAdminClient, hasSupabaseAdminKey } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type CostCenter = { code?: string | null; name?: string | null; percentage?: number | null };

function asNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isCurrentContract(contract: { end_date: string | null }) {
  return !contract.end_date || contract.end_date >= new Date().toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_organization" }, { status: 400 });
  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error) return NextResponse.json({ error: context.error }, { status: context.status });
  if (!hasSupabaseAdminKey()) return NextResponse.json({ error: "admin_provisioning_not_configured" }, { status: 503 });

  const admin = createAdminClient();
  const month = `${new Date().getFullYear()}-01-01`;
  const [integrationResult, peopleResult, contractsResult, metricsResult] = await Promise.all([
    admin.from("payroll_integrations").select("is_active, last_sync_at, last_sync_status, last_period_month").eq("organization_id", organizationId).eq("provider", "peoplework").maybeSingle(),
    admin.from("payroll_people").select("id, full_name, national_identification, is_active, management_name, job_title").eq("organization_id", organizationId).eq("provider", "peoplework").order("full_name"),
    admin.from("payroll_contracts").select("person_id, contract_status, contract_type, start_date, end_date, monthly_gross_salary, currency_code, weekly_hours, payment_schedule, management_name, job_title, cost_centers").eq("organization_id", organizationId).eq("provider", "peoplework"),
    admin.from("payroll_person_period_metrics").select("person_id, absence_days, vacation_days").eq("organization_id", organizationId).eq("period_month", month),
  ]);
  if (integrationResult.error || peopleResult.error || contractsResult.error || metricsResult.error) return NextResponse.json({ error: "unable_to_load_peoplework_summary" }, { status: 500 });

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

  return NextResponse.json({
    integration: integrationResult.data ? { active: integrationResult.data.is_active, lastSyncAt: integrationResult.data.last_sync_at, lastSyncStatus: integrationResult.data.last_sync_status, lastPeriodMonth: integrationResult.data.last_period_month } : null,
    summary: { activePeople: activePeople.length, activeContracts: contracts.length, monthlyGrossTotal, averageGross, absenceDays, vacationDays, periodYear: new Date().getFullYear() },
    costCenters: [...centerTotals.values()].sort((a, b) => b.amount - a.amount),
    persons,
  });
}
