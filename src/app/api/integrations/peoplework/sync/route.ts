import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { isUuid, requireOrganizationAdministrator } from "@/lib/admin-access";
import { asFiniteNumber, employeeFullName, fetchPeopleWorkSnapshot, normalizeIdentifier, normalizePeopleWorkDate, peopleWorkText, sanitizeCostCenters } from "@/lib/peoplework/client";
import { getPeopleWorkConfig } from "@/lib/peoplework/config";

export const dynamic = "force-dynamic";

type SyncedPerson = { id: string; external_employee_id: string; national_identification: string | null };
type ManualAssignment = { person_id: string; cost_center_id: string; allocation_percentage: number; effective_from: string; effective_to: string | null };
type CostCenter = { id: string; code: string; name: string };

function periodMonth(year: number) {
  return `${year}-01-01`;
}

function monthsForYear(year: number) {
  return Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, "0")}-01`);
}

function isContractActiveInPeriod(contract: { start_date?: string | null; end_date?: string | null }, period: string) {
  const periodEnd = `${period.slice(0, 7)}-31`;
  return (!contract.start_date || contract.start_date <= periodEnd) && (!contract.end_date || contract.end_date >= period);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 500) : "No fue posible sincronizar PeopleWork.";
}

export async function POST(request: NextRequest) {
  const body: unknown = await request.json().catch(() => null);
  const organizationId = body && typeof body === "object" ? (body as { organizationId?: unknown }).organizationId : null;
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_organization" }, { status: 400 });

  const context = await requireOrganizationAdministrator(organizationId);
  if (context.error || !context.user || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });

  const config = getPeopleWorkConfig();
  if (config.state !== "ready" || !config.apiBaseUrl) return NextResponse.json({ error: "peoplework_not_configured" }, { status: 503 });

  // La escritura se ejecuta con la sesión del administrador que gatilla la
  // sincronización. Las políticas RLS mantienen el aislamiento organizacional
  // y evitan depender de una service key para esta operación interactiva.
  const admin = context.supabase;
  const requestedYear = body && typeof body === "object" ? Number((body as { year?: unknown }).year) : new Date().getFullYear();
  const year = Number.isInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= new Date().getFullYear() ? requestedYear : new Date().getFullYear();
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
        management_name: peopleWorkText(employee.job_management),
        job_title: peopleWorkText(employee.job_title),
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

    const { data: manualAssignmentData, error: manualAssignmentError } = await admin
      .from("payroll_person_cost_center_assignments")
      .select("person_id, cost_center_id, allocation_percentage, effective_from, effective_to")
      .eq("organization_id", organizationId);
    if (manualAssignmentError) throw new Error("No fue posible leer las asignaciones manuales de centros de costo.");
    const manualAssignments = (manualAssignmentData ?? []) as ManualAssignment[];
    const centerIds = [...new Set(manualAssignments.map((item) => item.cost_center_id))];
    const { data: manualCenterData, error: manualCenterError } = centerIds.length
      ? await admin.from("cost_centers").select("id, code, name").eq("organization_id", organizationId).in("id", centerIds)
      : { data: [], error: null };
    if (manualCenterError) throw new Error("No fue posible resolver los centros de costo asignados.");
    const manualCenterById = new Map((manualCenterData ?? [] as CostCenter[]).map((center) => [center.id, center]));

    const contractRows = snapshot.contracts.flatMap((contract) => {
      const person = contract.employee?.id === undefined || contract.employee?.id === null ? null : peopleByExternalId.get(String(contract.employee.id));
      if (!person || contract.id === undefined || contract.id === null) return [];
      return [{
        organization_id: organizationId,
        person_id: person.id,
        provider: "peoplework",
        external_contract_id: String(contract.id),
        contract_status: peopleWorkText(contract.contract_status) ?? peopleWorkText(contract.status),
        contract_type: peopleWorkText(contract.contract_type),
        start_date: normalizePeopleWorkDate(contract.start_date),
        end_date: normalizePeopleWorkDate(contract.end_date),
        monthly_gross_salary: asFiniteNumber(contract.salary),
        currency_code: "CLP",
        weekly_hours: asFiniteNumber(contract.weekly_hours),
        payment_schedule: peopleWorkText(contract.payment_schedule),
        management_name: peopleWorkText(contract.job_management),
        job_title: peopleWorkText(contract.job_title),
        cost_centers: sanitizeCostCenters(contract.cost_center),
        source_updated_at: now,
      }];
    });
    if (contractRows.length) {
      const { error } = await admin.from("payroll_contracts").upsert(contractRows, { onConflict: "organization_id,provider,external_contract_id" });
      if (error) throw new Error("No fue posible guardar los contratos de PeopleWork.");
    }

    // PeopleWork publica contratos (también finalizados), pero no liquidaciones ni costo
    // empleador histórico. Esta base mensual se reconstruye según vigencia contractual y
    // se identifica explícitamente como remuneración bruta contractual, no como pago real.
    const periods = monthsForYear(year);
    const { error: removeCostError } = await admin.from("payroll_cost_lines").delete().eq("organization_id", organizationId).gte("period_month", `${year}-01-01`).lte("period_month", `${year}-12-01`);
    if (removeCostError) throw new Error("No fue posible reemplazar la base histórica de remuneraciones.");
    const payrollCosts = periods.flatMap((period) => snapshot.contracts.filter((contract) => isContractActiveInPeriod({ start_date: normalizePeopleWorkDate(contract.start_date), end_date: normalizePeopleWorkDate(contract.end_date) }, period)).flatMap((contract) => {
      const gross = Math.max(0, asFiniteNumber(contract.salary));
      if (!gross) return [];
      const person = contract.employee?.id === undefined || contract.employee?.id === null ? null : peopleByExternalId.get(String(contract.employee.id));
      const effectiveManual = person ? manualAssignments.filter((assignment) => assignment.person_id === person.id && assignment.effective_from <= period && (!assignment.effective_to || assignment.effective_to >= period)) : [];
      const manualDistributions = effectiveManual.flatMap((assignment) => {
        const center = manualCenterById.get(assignment.cost_center_id);
        return center ? [{ code: center.code, name: center.name, percentage: asFiniteNumber(assignment.allocation_percentage) }] : [];
      });
      const centers = sanitizeCostCenters(contract.cost_center);
      const distributions = manualDistributions.length ? manualDistributions : centers.length ? centers : [{ code: null, name: "Sin centro asignado", percentage: 100 }];
      return distributions.map((center) => ({
        organization_id: organizationId,
        sync_run_id: syncRun.id,
        period_month: period,
        cost_category: "remuneracion_bruta_contractual",
        cost_center_code: center.code,
        cost_center_name: center.name,
        amount: gross * ((center.percentage || 100) / 100),
        currency_code: "CLP",
        source_record_sha256: createHash("sha256").update(`${period}|${contract.id}|${center.code ?? center.name ?? "sin-centro"}|${gross}`).digest("hex"),
      }));
    }));
    if (payrollCosts.length) {
      const { error } = await admin.from("payroll_cost_lines").insert(payrollCosts);
      if (error) throw new Error("No fue posible guardar la base mensual de remuneraciones.");
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
      admin.from("payroll_sync_runs").update({ status: "succeeded", finished_at: new Date().toISOString(), records_received: received, records_accepted: peopleRows.length + contractRows.length + metricRows.length + payrollCosts.length, records_rejected: snapshot.contracts.length - contractRows.length }).eq("id", syncRun.id),
      admin.from("payroll_integrations").update({ is_active: true, last_sync_at: new Date().toISOString(), last_sync_status: "succeeded", last_period_month: month }).eq("id", integration.id),
    ]);
    return NextResponse.json({ synced: true, summary: { employees: peopleRows.length, contracts: contractRows.length, payrollCostLines: payrollCosts.length, absenceEvents: snapshot.absences.length, vacationEvents: snapshot.vacations.length, periodYear: year } });
  } catch (error) {
    const message = errorMessage(error);
    await Promise.all([
      admin.from("payroll_sync_runs").update({ status: "failed", finished_at: new Date().toISOString(), error_summary: message }).eq("id", syncRun.id),
      admin.from("payroll_integrations").update({ last_sync_status: "failed" }).eq("id", integration.id),
    ]);
    return NextResponse.json({ error: "peoplework_sync_failed", detail: message }, { status: 502 });
  }
}
