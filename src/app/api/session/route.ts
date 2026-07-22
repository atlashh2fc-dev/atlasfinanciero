import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type Membership = {
  organization_id: string;
  role: "administrator" | "finance" | "operations" | "auditor";
  organizations: { legal_name: string; tax_id: string | null } | Array<{ legal_name: string; tax_id: string | null }> | null;
};

function organizationFor(membership: Membership) {
  return Array.isArray(membership.organizations) ? membership.organizations[0] ?? null : membership.organizations;
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const [{ data, error }, { data: profile, error: profileError }, { data: platformAdministrator, error: platformAdministratorError }] = await Promise.all([
    supabase
    .from("organization_memberships")
    .select("organization_id, role, organizations (legal_name, tax_id)")
    .eq("user_id", user.id),
    supabase.from("profiles").select("active_organization_id").eq("id", user.id).maybeSingle(),
    supabase.from("platform_administrators").select("user_id").eq("user_id", user.id).maybeSingle(),
  ]);

  if (error || profileError || platformAdministratorError) return NextResponse.json({ error: "unable_to_read_memberships" }, { status: 500 });

  const memberships = (data ?? []) as Membership[];
  const membership = memberships.find((item) => item.organization_id === profile?.active_organization_id) ?? memberships[0];
  if (!membership) return NextResponse.json({ error: "organization_membership_required" }, { status: 403 });
  const activeOrganization = organizationFor(membership);

  return NextResponse.json({
    user: { email: user.email ?? null },
    isSuperAdmin: Boolean(platformAdministrator),
    membership: {
      organizationId: membership.organization_id,
      organizationName: activeOrganization?.legal_name ?? "Organización",
      organizationTaxId: activeOrganization?.tax_id ?? null,
      role: membership.role,
    },
    organizations: memberships.map((item) => ({
      id: item.organization_id,
      name: organizationFor(item)?.legal_name ?? "Organización",
      role: item.role,
    })),
  });
}
