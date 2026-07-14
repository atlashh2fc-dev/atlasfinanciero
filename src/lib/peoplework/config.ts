export type PeopleWorkConnectionState =
  | "ready_for_mapping"
  | "missing_base_url"
  | "missing_credentials"
  | "missing_contract";

export type PeopleWorkConfig = {
  state: PeopleWorkConnectionState;
  apiBaseUrl: string | null;
  payrollCostsPath: string | null;
  authScheme: string | null;
  hasCredentials: boolean;
};

function readOptional(name: string) {
  const value = process.env[name]?.trim();
  return value || null;
}

export function getPeopleWorkConfig(): PeopleWorkConfig {
  const apiBaseUrl = readOptional("PEOPLEWORK_API_BASE_URL");
  const payrollCostsPath = readOptional("PEOPLEWORK_PAYROLL_COSTS_PATH");
  const authScheme = readOptional("PEOPLEWORK_AUTH_SCHEME");
  const hasCredentials = Boolean(readOptional("PEOPLEWORK_API_KEY") && readOptional("PEOPLEWORK_SECRET_KEY"));

  if (!apiBaseUrl) return { state: "missing_base_url", apiBaseUrl, payrollCostsPath, authScheme, hasCredentials };
  if (!hasCredentials) return { state: "missing_credentials", apiBaseUrl, payrollCostsPath, authScheme, hasCredentials };
  if (!payrollCostsPath || !authScheme) return { state: "missing_contract", apiBaseUrl, payrollCostsPath, authScheme, hasCredentials };

  return { state: "ready_for_mapping", apiBaseUrl, payrollCostsPath, authScheme, hasCredentials };
}
