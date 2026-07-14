import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, hasSupabaseAdminKey } from "@/lib/supabase/admin";
import { isUuid, requireOrganizationAdministrator, type OrganizationRole } from "@/lib/admin-access";

const roles = new Set<OrganizationRole>(["administrator", "finance", "operations", "auditor"]);

export async function POST(request: NextRequest) {
  const body: unknown = await request.json().catch(() => null);
  const organizationId = body && typeof body === "object" ? (body as { organizationId?: unknown }).organizationId : null;
  const email = body && typeof body === "object" ? (body as { email?: unknown }).email : null;
  const role = body && typeof body === "object" ? (body as { role?: unknown }).role : null;
  if (!isUuid(organizationId) || typeof email !== "string" || email.trim().length > 320 || !/^\S+@\S+\.\S+$/.test(email.trim()) || typeof role !== "string" || !roles.has(role as OrganizationRole)) {
    return NextResponse.json({ error: "invalid_invitation" }, { status: 400 });
  }

  const context = await requireOrganizationAdministrator(organizationId);
  if (context.error || !context.user) return NextResponse.json({ error: context.error }, { status: context.status });
  if (!hasSupabaseAdminKey()) return NextResponse.json({ error: "admin_provisioning_not_configured" }, { status: 503 });

  const admin = createAdminClient();
  const { data: invitation, error: invitationError } = await admin.auth.admin.inviteUserByEmail(email.trim());
  if (invitationError || !invitation.user) return NextResponse.json({ error: "unable_to_send_invitation" }, { status: 422 });

  const { error: membershipError } = await admin
    .from("organization_memberships")
    .upsert({ organization_id: organizationId, user_id: invitation.user.id, role }, { onConflict: "organization_id,user_id" });
  if (membershipError) return NextResponse.json({ error: "invitation_sent_but_membership_failed" }, { status: 500 });

  return NextResponse.json({ invited: true }, { status: 201 });
}
