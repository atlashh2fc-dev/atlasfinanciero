export type PeopleWorkConnectionState =
  | "ready"
  | "missing_base_url"
  | "missing_credentials";

export type PeopleWorkConfig = {
  state: PeopleWorkConnectionState;
  apiBaseUrl: string | null;
  authScheme: "basic" | null;
  hasCredentials: boolean;
};

function readOptional(name: string) {
  const value = process.env[name]?.trim();
  return value || null;
}

export function getPeopleWorkConfig(): PeopleWorkConfig {
  const apiBaseUrl = readOptional("PEOPLEWORK_API_BASE_URL");
  const authScheme = readOptional("PEOPLEWORK_AUTH_SCHEME")?.toLowerCase() === "basic" ? "basic" : null;
  const hasCredentials = Boolean(readOptional("PEOPLEWORK_API_KEY") && readOptional("PEOPLEWORK_SECRET_KEY"));

  if (!apiBaseUrl) return { state: "missing_base_url", apiBaseUrl, authScheme, hasCredentials };
  if (!hasCredentials || !authScheme) return { state: "missing_credentials", apiBaseUrl, authScheme, hasCredentials };

  return { state: "ready", apiBaseUrl, authScheme, hasCredentials };
}
