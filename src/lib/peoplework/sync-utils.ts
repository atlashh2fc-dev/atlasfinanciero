import type {
  PeopleWorkAbsence,
  PeopleWorkAttendanceReport,
  PeopleWorkContract,
  PeopleWorkCostCenter,
  PeopleWorkEmployee,
  PeopleWorkVacation,
} from "./client";

export type NormalizedCostCenter = { code: string | null; name: string | null; percentage: number };

function normalizePeopleWorkDate(value: string | null | undefined) {
  if (!value) return null;
  if (/^(\d{4})-(\d{2})-(\d{2})$/.test(value)) return value;
  const local = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return local ? `${local[3]}-${local[2]}-${local[1]}` : null;
}

function asFiniteNumber(value: unknown, fallback = 0) {
  const normalized = typeof value === "string" ? value.replace(/\./g, "").replace(",", ".") : value;
  const number = typeof normalized === "number" ? normalized : Number(normalized);
  return Number.isFinite(number) ? number : fallback;
}

function sanitizeCostCenters(costCenters: PeopleWorkCostCenter[] | null | undefined) {
  return (costCenters ?? []).map((center) => ({
    code: center.code?.trim() || null,
    name: center.name?.trim() || null,
    percentage: asFiniteNumber(center.percentage, 0),
  })).filter((center) => center.code || center.name);
}

export function periodMonth(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

export function monthsForYear(year: number) {
  return Array.from({ length: 12 }, (_, index) => periodMonth(year, index + 1));
}

export function periodEnd(period: string) {
  const [year, month] = period.split("-").map(Number);
  return `${year}-${String(month).padStart(2, "0")}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
}

export function isDateRangeActiveInPeriod(range: { start_date?: string | null; end_date?: string | null }, period: string) {
  return (!range.start_date || range.start_date <= periodEnd(period)) && (!range.end_date || range.end_date >= period);
}

export function selectContractsForPeriod(contracts: PeopleWorkContract[], period: string) {
  const selected = new Map<string, PeopleWorkContract>();
  const unlinked: PeopleWorkContract[] = [];
  for (const contract of contracts) {
    const normalized = {
      start_date: normalizePeopleWorkDate(contract.start_date),
      end_date: normalizePeopleWorkDate(contract.end_date),
    };
    if (!isDateRangeActiveInPeriod(normalized, period)) continue;
    const employeeId = contract.employee?.id;
    if (employeeId === undefined || employeeId === null) {
      unlinked.push(contract);
      continue;
    }
    const key = String(employeeId);
    const current = selected.get(key);
    const currentStart = normalizePeopleWorkDate(current?.start_date) ?? "0000-01-01";
    const nextStart = normalized.start_date ?? "0000-01-01";
    if (!current || nextStart > currentStart || (nextStart === currentStart && String(contract.id) > String(current.id))) selected.set(key, contract);
  }
  return [...selected.values(), ...unlinked];
}

function normalizeCenterName(value: string | null | undefined) {
  return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

export function normalizeDistribution(centers: Array<{ code?: string | null; name?: string | null; percentage?: string | number | null }>): NormalizedCostCenter[] {
  const sanitized = sanitizeCostCenters(centers);
  if (!sanitized.length) return [];
  const total = sanitized.reduce((sum, center) => sum + Math.max(0, center.percentage), 0);
  if (total <= 0) {
    const percentage = 100 / sanitized.length;
    return sanitized.map((center) => ({ ...center, percentage }));
  }
  return sanitized.map((center) => ({ ...center, percentage: Math.max(0, center.percentage) * 100 / total }));
}

export function resolveContractCostCenters(contract: PeopleWorkContract, employee?: PeopleWorkEmployee): NormalizedCostCenter[] {
  const employeeCenters = sanitizeCostCenters(employee?.cost_center);
  const employeeCenterByName = new Map(employeeCenters.map((center) => [normalizeCenterName(center.name), center]));
  const contractCenters = (contract.contract_cost_centers_attributes ?? []).map((center) => {
    const employeeCenter = employeeCenterByName.get(normalizeCenterName(center.name));
    return {
      code: employeeCenter?.code ?? null,
      name: center.name?.trim() || employeeCenter?.name || null,
      percentage: center.percentage,
    };
  });
  return normalizeDistribution(
    contractCenters.length
      ? contractCenters
      : employeeCenters.length
        ? employeeCenters
        : (contract.cost_center ?? []) as PeopleWorkCostCenter[],
  );
}

export type AttendanceMetric = {
  personId: string;
  periodMonth: string;
  absenceDays: number;
  vacationDays: number;
  workedDays: number;
  nonWorkedDays: number;
  workedMinutes: number;
  overtimeMinutes: number;
  lateMinutes: number;
  earlyDepartureMinutes: number;
};

export function durationToMinutes(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const match = value.trim().match(/^(\d+):(\d{2}):(\d{2})$/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 60;
}

export function buildAttendanceMetrics({
  year,
  absences,
  vacations,
  attendanceReports = [],
  personByEmployeeId,
  personByNationalId,
}: {
  year: number;
  absences: PeopleWorkAbsence[];
  vacations: PeopleWorkVacation[];
  attendanceReports?: PeopleWorkAttendanceReport[];
  personByEmployeeId: Map<string, string>;
  personByNationalId: Map<string, string>;
}) {
  const metrics = new Map<string, AttendanceMetric>();
  let rejected = 0;
  const accumulate = (personId: string | undefined, rawDate: string | null | undefined, field: "absenceDays" | "vacationDays", amount: unknown) => {
    const date = normalizePeopleWorkDate(rawDate);
    if (!personId || !date || !date.startsWith(`${year}-`)) {
      rejected += 1;
      return;
    }
    const month = `${date.slice(0, 7)}-01`;
    const key = `${personId}|${month}`;
    const current = metrics.get(key) ?? { personId, periodMonth: month, absenceDays: 0, vacationDays: 0, workedDays: 0, nonWorkedDays: 0, workedMinutes: 0, overtimeMinutes: 0, lateMinutes: 0, earlyDepartureMinutes: 0 };
    current[field] += Math.max(0, asFiniteNumber(amount));
    metrics.set(key, current);
  };
  for (const absence of absences) {
    const employeeId = absence.employee?.id;
    accumulate(employeeId === undefined || employeeId === null ? undefined : personByEmployeeId.get(String(employeeId)), absence.start_date, "absenceDays", absence.days);
  }
  for (const vacation of vacations) {
    const nationalId = vacation.national_identification?.replace(/[^0-9kK]/g, "").toUpperCase() ?? "";
    accumulate(personByNationalId.get(nationalId), vacation.start_date, "vacationDays", vacation.days);
  }
  for (const attendance of attendanceReports) {
    const nationalId = attendance.national_identification?.replace(/[^0-9kK]/g, "").toUpperCase() ?? "";
    const employeeId = attendance.employee_id;
    const personId = employeeId === undefined || employeeId === null ? personByNationalId.get(nationalId) : personByEmployeeId.get(String(employeeId)) ?? personByNationalId.get(nationalId);
    const date = normalizePeopleWorkDate(attendance.date_from);
    if (!personId || !date || !date.startsWith(`${year}-`)) {
      rejected += 1;
      continue;
    }
    const month = `${date.slice(0, 7)}-01`;
    const key = `${personId}|${month}`;
    const current = metrics.get(key) ?? { personId, periodMonth: month, absenceDays: 0, vacationDays: 0, workedDays: 0, nonWorkedDays: 0, workedMinutes: 0, overtimeMinutes: 0, lateMinutes: 0, earlyDepartureMinutes: 0 };
    const totals = attendance.totals ?? {};
    current.workedDays += Math.max(0, asFiniteNumber(totals.total_days_worked));
    current.nonWorkedDays += Math.max(0, asFiniteNumber(totals.total_days_non_worked));
    current.workedMinutes += Math.max(0, durationToMinutes(totals.total_hours_worked));
    current.overtimeMinutes += Math.max(0, durationToMinutes(totals.total_minutes_hours_extra));
    current.lateMinutes += Math.max(0, durationToMinutes(totals.total_minutes_late));
    current.earlyDepartureMinutes += Math.max(0, durationToMinutes(totals.total_minutes_early_departure));
    metrics.set(key, current);
  }
  return { metrics: [...metrics.values()], rejected };
}
