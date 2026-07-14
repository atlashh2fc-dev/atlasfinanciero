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

  const { error: registrationError } = await admin
    .from("user_invitations")
    .upsert({
      organization_id: organizationId,
      auth_user_id: invitation.user.id,
      email: email.trim(),
      role,
      status: "pending",
      invited_by: context.user.id,
      invited_at: new Date().toISOString(),
      activated_at: null,
    }, { onConflict: "organization_id,email_normalized" });
  if (registrationError) return NextResponse.json({ error: "invitation_sent_but_registration_failed" }, { status: 500 });

  return NextResponse.json({ invited: true, status: "pending" }, { status: 201 });
}
