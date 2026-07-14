import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationAdministrator } from "@/lib/admin-access";
import { createAdminClient, hasSupabaseAdminKey } from "@/lib/supabase/admin";
import { asFiniteNumber, employeeFullName, fetchPeopleWorkSnapshot, normalizeIdentifier, normalizePeopleWorkDate, sanitizeCostCenters } from "@/lib/peoplework/client";
import { getPeopleWorkConfig } from "@/lib/peoplework/config";

export const dynamic = "force-dynamic";

type SyncedPerson = { id: string; external_employee_id: string; national_identification: string | null };

function periodMonth(year: number) {
  return `${year}-01-01`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 500) : "No fue posible sincronizar PeopleWork.";
}

export async function POST(request: NextRequest) {
  const body: unknown = await request.json().catch(() => null);
  const organizationId = body && typeof body === "object" ? (body as { organizationId?: unknown }).organizationId : null;
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_organization" }, { status: 400 });

  const context = await requireOrganizationAdministrator(organizationId);
  if (context.error || !context.user) return NextResponse.json({ error: context.error }, { status: context.status });
  if (!hasSupabaseAdminKey()) return NextResponse.json({ error: "admin_provisioning_not_configured" }, { status: 503 });

  const config = getPeopleWorkConfig();
  if (config.state !== "ready" || !config.apiBaseUrl) return NextResponse.json({ error: "peoplework_not_configured" }, { status: 503 });

  const admin = createAdminClient();
  const year = new Date().getFullYear();
  const month = periodMonth(year);
  const { data: integration, error: integrationError } = await admin
    .from("payroll_integrations")
    .upsert({ organization_id: organizationId, provider: "peoplework", api_base_url: config.apiBaseUrl, is_active: true, last_sync_status: "running", configured_by: context.user.id }, { onConflict: "organization_id,provider" })
    .select("id")
    .single();
  if (integrationError || !integration) return NextResponse.json({ error: "unable_to_prepare_peoplework_sync" }, { status: 500 });

  const { data: syncRun, error: runError } = await admin
    .from("payroll_sync_runs")
    .insert({ organization_id: organizationId, integration_id: integration.id, period_month: month, status: "running", started_at: new Date().toISOString(), source_reference: "PeopleWork API v1/v2" , initiated_by: context.user.id })
    .select("id")
    .single();
  if (runError || !syncRun) return NextResponse.json({ error: "unable_to_start_peoplework_sync" }, { status: 500 });

  try {
    const snapshot = await fetchPeopleWorkSnapshot(year);
    const now = new Date().toISOString();
    const peopleRows = snapshot.employees
      .map((employee) => ({
        organization_id: organizationId,
        provider: "peoplework",
        external_employee_id: String(employee.id),
        national_identification: employee.national_identification?.trim() || null,
        full_name: employeeFullName(employee) || `Colaborador ${employee.id}`,
        is_active: employee.active !== false,
        management_name: employee.job_management?.trim() || null,
        job_title: employee.job_title?.trim() || null,
        source_updated_at: now,
      }));

    if (peopleRows.length) {
      const { error } = await admin.from("payroll_people").upsert(peopleRows, { onConflict: "organization_id,provider,external_employee_id" });
      if (error) throw new Error("No fue posible guardar los colaboradores de PeopleWork.");
    }

    const externalIds = peopleRows.map((person) => person.external_employee_id);
    const { data: people, error: peopleError } = externalIds.length
      ? await admin.from("payroll_people").select("id, external_employee_id, national_identification").eq("organization_id", organizationId).eq("provider", "peoplework").in("external_employee_id", externalIds)
      : { data: [], error: null };
    if (peopleError) throw new Error("No fue posible resolver los colaboradores sincronizados.");
    const syncedPeople = (people ?? []) as SyncedPerson[];
    const peopleByExternalId = new Map<string, SyncedPerson>(syncedPeople.map((person) => [person.external_employee_id, person]));
    const peopleByNationalId = new Map<string, SyncedPerson>();
    for (const person of syncedPeople) {
      const identifier = normalizeIdentifier(person.national_identification);
      if (identifier) peopleByNationalId.set(identifier, person);
    }

    const contractRows = snapshot.contracts.flatMap((contract) => {
      const person = contract.employee?.id === undefined || contract.employee?.id === null ? null : peopleByExternalId.get(String(contract.employee.id));
      if (!person || contract.id === undefined || contract.id === null) return [];
      return [{
        organization_id: organizationId,
        person_id: person.id,
        provider: "peoplework",
        external_contract_id: String(contract.id),
        contract_status: contract.contract_status?.trim() || contract.status?.trim() || null,
        contract_type: contract.contract_type?.trim() || null,
        start_date: normalizePeopleWorkDate(contract.start_date),
        end_date: normalizePeopleWorkDate(contract.end_date),
        monthly_gross_salary: asFiniteNumber(contract.salary),
        currency_code: "CLP",
        weekly_hours: asFiniteNumber(contract.weekly_hours),
        payment_schedule: contract.payment_schedule?.trim() || null,
        management_name: contract.job_management?.trim() || null,
        job_title: contract.job_title?.trim() || null,
        cost_centers: sanitizeCostCenters(contract.cost_center),
        source_updated_at: now,
      }];
    });
    if (contractRows.length) {
      const { error } = await admin.from("payroll_contracts").upsert(contractRows, { onConflict: "organization_id,provider,external_contract_id" });
      if (error) throw new Error("No fue posible guardar los contratos de PeopleWork.");
    }

    const metrics = new Map<string, { personId: string; absenceDays: number; vacationDays: number }>();
    const accumulate = (personId: string | undefined, field: "absenceDays" | "vacationDays", amount: unknown) => {
      if (!personId) return;
      const current = metrics.get(personId) ?? { personId, absenceDays: 0, vacationDays: 0 };
      current[field] += Math.max(0, asFiniteNumber(amount));
      metrics.set(personId, current);
    };
    for (const absence of snapshot.absences) accumulate(absence.employee?.id === undefined || absence.employee?.id === null ? undefined : peopleByExternalId.get(String(absence.employee.id))?.id, "absenceDays", absence.days);
    for (const vacation of snapshot.vacations) accumulate(peopleByNationalId.get(normalizeIdentifier(vacation.national_identification))?.id, "vacationDays", vacation.days);
    const metricRows = [...metrics.values()].map((metric) => ({ organization_id: organizationId, person_id: metric.personId, period_month: month, absence_days: metric.absenceDays, vacation_days: metric.vacationDays, source_updated_at: now }));
    if (metricRows.length) {
      const { error } = await admin.from("payroll_person_period_metrics").upsert(metricRows, { onConflict: "organization_id,person_id,period_month" });
      if (error) throw new Error("No fue posible guardar las métricas de dotación de PeopleWork.");
    }

    const received = snapshot.employees.length + snapshot.contracts.length + snapshot.absences.length + snapshot.vacations.length;
    await Promise.all([
      admin.from("payroll_sync_runs").update({ status: "succeeded", finished_at: new Date().toISOString(), records_received: received, records_accepted: peopleRows.length + contractRows.length + metricRows.length, records_rejected: snapshot.contracts.length - contractRows.length }).eq("id", syncRun.id),
      admin.from("payroll_integrations").update({ is_active: true, last_sync_at: new Date().toISOString(), last_sync_status: "succeeded", last_period_month: month }).eq("id", integration.id),
    ]);
    return NextResponse.json({ synced: true, summary: { employees: peopleRows.length, contracts: contractRows.length, absenceEvents: snapshot.absences.length, vacationEvents: snapshot.vacations.length, periodYear: year } });
  } catch (error) {
    const message = errorMessage(error);
    await Promise.all([
      admin.from("payroll_sync_runs").update({ status: "failed", finished_at: new Date().toISOString(), error_summary: message }).eq("id", syncRun.id),
      admin.from("payroll_integrations").update({ last_sync_status: "failed" }).eq("id", integration.id),
    ]);
    return NextResponse.json({ error: "peoplework_sync_failed", detail: message }, { status: 502 });
  }
}
