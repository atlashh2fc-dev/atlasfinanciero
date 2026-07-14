import { getPeopleWorkConfig } from "@/lib/peoplework/config";

type PeopleWorkEnvelope<T> = { data?: T[] };

export type PeopleWorkCostCenter = { code?: string | null; name?: string | null; percentage?: string | number | null };
export type PeopleWorkEmployee = {
  id: number | string;
  active?: boolean | null;
  name?: string | null;
  first_last_name?: string | null;
  second_last_name?: string | null;
  national_identification?: string | null;
  job_management?: string | null;
  job_title?: string | null;
  cost_center?: PeopleWorkCostCenter[] | null;
};
export type PeopleWorkContract = {
  id: number | string;
  employee?: { id?: number | string | null; full_name?: string | null; national_identification?: string | null } | null;
  contract_type?: string | null;
  status?: string | null;
  contract_status?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  salary?: number | string | null;
  weekly_hours?: number | string | null;
  payment_schedule?: string | null;
  job_management?: string | null;
  job_title?: string | null;
  cost_center?: PeopleWorkCostCenter[] | null;
};
export type PeopleWorkAbsence = {
  days?: number | string | null;
  start_date?: string | null;
  employee?: { id?: number | string | null } | null;
};
export type PeopleWorkVacation = {
  days?: number | string | null;
  start_date?: string | null;
  national_identification?: string | null;
};

function credentials() {
  const apiKey = process.env.PEOPLEWORK_API_KEY?.trim();
  const secretKey = process.env.PEOPLEWORK_SECRET_KEY?.trim();
  if (!apiKey || !secretKey) throw new Error("PeopleWork no tiene credenciales configuradas.");
  return Buffer.from(`${apiKey}:${secretKey}`).toString("base64");
}

async function getData<T>(path: string, searchParams?: Record<string, string>) {
  const config = getPeopleWorkConfig();
  if (config.state !== "ready" || !config.apiBaseUrl) throw new Error("PeopleWork no está configurado para sincronizar.");

  const url = new URL(path, `${config.apiBaseUrl.replace(/\/$/, "")}/`);
  for (const [key, value] of Object.entries(searchParams ?? {})) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Basic ${credentials()}` },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`PeopleWork respondió ${response.status} al consultar ${path}.`);
  const payload = await response.json() as PeopleWorkEnvelope<T>;
  return Array.isArray(payload.data) ? payload.data : [];
}

export async function fetchPeopleWorkSnapshot(year: number) {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const [employees, contracts, absences, vacations] = await Promise.all([
    getData<PeopleWorkEmployee>("/api/v2/public/employees", { paginate: "false" }),
    getData<PeopleWorkContract>("/api/v1/public/contracts", { paginate: "false" }),
    getData<PeopleWorkAbsence>("/api/v1/public/absences", { paginate: "false", date_from: from, date_to: to }),
    getData<PeopleWorkVacation>("/api/v1/public/vacations", { paginate: "false", date_from: from, date_to: to }),
  ]);

  return { employees, contracts, absences, vacations, periodYear: year };
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
