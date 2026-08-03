import { getPeopleWorkConfig } from "@/lib/peoplework/config";

type PeopleWorkEnvelope<T> = { data?: T[] };

export type PeopleWorkCostCenter = { code?: string | null; name?: string | null; percentage?: string | number | null };
export type PeopleWorkContractCostCenter = {
  cost_center_id?: number | string | null;
  name?: string | null;
  percentage?: string | number | null;
};
export type PeopleWorkLabelValue = string | number | { label?: string | null; value?: string | number | null } | null;
export type PeopleWorkEmployee = {
  id: number | string;
  active?: boolean | null;
  name?: string | null;
  first_last_name?: string | null;
  second_last_name?: string | null;
  national_identification?: string | null;
  job_management?: PeopleWorkLabelValue;
  job_title?: PeopleWorkLabelValue;
  cost_center?: PeopleWorkCostCenter[] | null;
};
export type PeopleWorkContract = {
  id: number | string;
  employee?: { id?: number | string | null; full_name?: string | null; national_identification?: string | null } | null;
  contract_type?: PeopleWorkLabelValue;
  status?: PeopleWorkLabelValue;
  contract_status?: PeopleWorkLabelValue;
  start_date?: string | null;
  end_date?: string | null;
  salary?: number | string | null;
  weekly_hours?: number | string | null;
  payment_schedule?: PeopleWorkLabelValue;
  job_management?: PeopleWorkLabelValue;
  job_title?: PeopleWorkLabelValue;
  cost_center?: PeopleWorkCostCenter[] | null;
  cost_centers?: Array<{ label?: string | null; value?: string | number | null }> | null;
  contract_cost_centers_attributes?: PeopleWorkContractCostCenter[] | null;
};
export type PeopleWorkAbsence = {
  id?: number | string | null;
  days?: number | string | null;
  start_date?: string | null;
  end_date?: string | null;
  employee?: { id?: number | string | null } | null;
};
export type PeopleWorkVacation = {
  id?: number | string | null;
  days?: number | string | null;
  start_date?: string | null;
  end_date?: string | null;
  national_identification?: string | null;
};
export type PeopleWorkAttendanceReport = {
  employee_id?: number | string | null;
  national_identification?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  totals?: {
    total_days_worked?: number | string | null;
    total_days_non_worked?: number | string | null;
    total_hours_worked?: string | null;
    total_minutes_hours_extra?: string | null;
    total_minutes_late?: string | null;
    total_minutes_early_departure?: string | null;
  } | null;
};

function credentials() {
  const apiKey = process.env.PEOPLEWORK_API_KEY?.trim();
  const secretKey = process.env.PEOPLEWORK_SECRET_KEY?.trim();
  if (!apiKey || !secretKey) throw new Error("PeopleWork no tiene credenciales configuradas.");
  return Buffer.from(`${apiKey}:${secretKey}`).toString("base64");
}

async function getData<T>(path: string, searchParams?: Record<string, string>, options?: { allowNotFound?: boolean }) {
  const config = getPeopleWorkConfig();
  if (config.state !== "ready" || !config.apiBaseUrl) throw new Error("PeopleWork no está configurado para sincronizar.");

  const url = new URL(path, `${config.apiBaseUrl.replace(/\/$/, "")}/`);
  for (const [key, value] of Object.entries(searchParams ?? {})) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Basic ${credentials()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (options?.allowNotFound && response.status === 404) return [];
  if (!response.ok) throw new Error(`PeopleWork respondió ${response.status} al consultar ${path}.`);
  const payload = await response.json() as PeopleWorkEnvelope<T>;
  return Array.isArray(payload.data) ? payload.data : [];
}

export async function fetchPeopleWorkSnapshot(year: number) {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const current = new Date();
  const lastAttendanceMonth = year === current.getFullYear() ? current.getMonth() + 1 : 12;
  const attendanceRequests = Array.from({ length: lastAttendanceMonth }, (_, index) => {
    const month = index + 1;
    const lastDay = year === current.getFullYear() && month === current.getMonth() + 1
      ? current.getDate()
      : new Date(Date.UTC(year, month, 0)).getUTCDate();
    const range = `01/${String(month).padStart(2, "0")}/${year},${String(lastDay).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
    return getData<PeopleWorkAttendanceReport>("/api/v1/public/attendance_detail_reports/generate_report", { range_date_workday: range }, { allowNotFound: true });
  });
  const [employees, contracts, absences, vacations, attendanceByMonth] = await Promise.all([
    getData<PeopleWorkEmployee>("/api/v2/public/employees", { paginate: "false" }),
    getData<PeopleWorkContract>("/api/v1/public/contracts", { paginate: "false" }),
    getData<PeopleWorkAbsence>("/api/v1/public/absences", { paginate: "false", date_from: from, date_to: to }),
    getData<PeopleWorkVacation>("/api/v1/public/vacations", { paginate: "false", date_from: from, date_to: to }),
    Promise.all(attendanceRequests),
  ]);

  return { employees, contracts, absences, vacations, attendanceReports: attendanceByMonth.flat(), periodYear: year };
}

export function normalizePeopleWorkDate(value: string | null | undefined) {
  if (!value) return null;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return value;
  const local = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return local ? `${local[3]}-${local[2]}-${local[1]}` : null;
}

export function asFiniteNumber(value: unknown, fallback = 0) {
  const normalized = typeof value === "string" ? value.replace(/\./g, "").replace(",", ".") : value;
  const number = typeof normalized === "number" ? normalized : Number(normalized);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeIdentifier(value: string | null | undefined) {
  return value?.replace(/[^0-9kK]/g, "").toUpperCase() ?? "";
}

export function peopleWorkText(value: PeopleWorkLabelValue | undefined) {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    if (typeof value.label === "string" && value.label.trim()) return value.label.trim();
    if (typeof value.value === "string" && value.value.trim()) return value.value.trim();
    if (typeof value.value === "number") return String(value.value);
  }
  return null;
}

export function employeeFullName(employee: PeopleWorkEmployee) {
  return [employee.name, employee.first_last_name, employee.second_last_name].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

export function sanitizeCostCenters(costCenters: PeopleWorkCostCenter[] | null | undefined) {
  return (costCenters ?? []).map((center) => ({
    code: center.code?.trim() || null,
    name: center.name?.trim() || null,
    percentage: asFiniteNumber(center.percentage, 0),
  })).filter((center) => center.code || center.name);
}
