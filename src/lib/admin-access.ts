import { createClient } from "@/lib/supabase/server";

export type OrganizationRole = "administrator" | "finance" | "operations" | "auditor";

export async function requireOrganizationAdministrator(organizationId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "authentication_required" as const, status: 401, supabase: null, user: null };

  const { data: membership, error } = await supabase
    .from("organization_memberships")
    .select("organization_id, role")
    .eq("organization_id", organizationId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) return { error: "unable_to_read_membership" as const, status: 500, supabase: null, user: null };
  if (membership?.role !== "administrator") return { error: "administrator_required" as const, status: 403, supabase: null, user: null };

  return { error: null, status: 200, supabase, user };
}

export async function requireOrganizationFinanceAccess(organizationId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "authentication_required" as const, status: 401, supabase: null, user: null };

  const { data: membership, error } = await supabase
    .from("organization_memberships")
    .select("organization_id, role")
    .eq("organization_id", organizationId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) return { error: "unable_to_read_membership" as const, status: 500, supabase: null, user: null };
  if (!membership || !["administrator", "finance"].includes(membership.role)) return { error: "finance_access_required" as const, status: 403, supabase: null, user: null };

  return { error: null, status: 200, supabase, user };
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
