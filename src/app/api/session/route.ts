import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type Membership = {
  organization_id: string;
  role: "administrator" | "finance" | "operations" | "auditor";
  organizations: Array<{ legal_name: string }>;
};

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const { data, error } = await supabase
    .from("organization_memberships")
    .select("organization_id, role, organizations (legal_name)")
    .eq("user_id", user.id);

  if (error) return NextResponse.json({ error: "unable_to_read_memberships" }, { status: 500 });

  const memberships = (data ?? []) as Membership[];
  if (memberships.length !== 1) {
    return NextResponse.json(
      { error: memberships.length ? "organization_selection_required" : "organization_membership_required" },
      { status: 403 },
    );
  }

  const membership = memberships[0];
  return NextResponse.json({
    user: { email: user.email ?? null },
    membership: {
      organizationId: membership.organization_id,
      organizationName: membership.organizations[0]?.legal_name ?? "Organización",
      role: membership.role,
    },
  });
}
