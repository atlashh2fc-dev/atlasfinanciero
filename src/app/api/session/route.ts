import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type Membership = {
  organization_id: string;
  role: "administrator" | "finance" | "operations" | "auditor";
  organizations: Array<{ legal_name: string; tax_id: string | null }>;
};

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const [{ data, error }, { data: profile, error: profileError }] = await Promise.all([
    supabase
    .from("organization_memberships")
    .select("organization_id, role, organizations (legal_name)")
    .eq("user_id", user.id),
    supabase.from("profiles").select("active_organization_id").eq("id", user.id).maybeSingle(),
  ]);

  if (error || profileError) return NextResponse.json({ error: "unable_to_read_memberships" }, { status: 500 });

  const memberships = (data ?? []) as Membership[];
  const membership = memberships.find((item) => item.organization_id === profile?.active_organization_id) ?? memberships[0];
  if (!membership) return NextResponse.json({ error: "organization_membership_required" }, { status: 403 });

  return NextResponse.json({
    user: { email: user.email ?? null },
    membership: {
      organizationId: membership.organization_id,
      organizationName: membership.organizations[0]?.legal_name ?? "Organización",
      organizationTaxId: membership.organizations[0]?.tax_id ?? null,
      role: membership.role,
    },
    organizations: memberships.map((item) => ({
      id: item.organization_id,
      name: item.organizations[0]?.legal_name ?? "Organización",
      role: item.role,
    })),
  });
}
