import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, hasSupabaseAdminKey } from "@/lib/supabase/admin";
import { isUuid, requireOrganizationAdministrator, type OrganizationRole } from "@/lib/admin-access";

const roles = new Set<OrganizationRole>(["administrator", "finance", "operations", "auditor"]);

function invitationOrigin(request: NextRequest) {
  const configuredOrigin = process.env.APP_URL?.trim();
  if (!configuredOrigin) return request.nextUrl.origin;

  try {
    return new URL(configuredOrigin).origin;
  } catch {
    return request.nextUrl.origin;
  }
}

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
  // The invitation must return to Atlas (never to the recipient's localhost).
  // Supabase only accepts this URL because it is explicitly allow-listed in Auth.
  const redirectTo = new URL("/auth/complete-invitation", invitationOrigin(request)).toString();
  const { data: invitation, error: invitationError } = await admin.auth.admin.inviteUserByEmail(email.trim(), { redirectTo });
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

export async function PATCH(request: NextRequest) {
  const body: unknown = await request.json().catch(() => null);
  const organizationId = body && typeof body === "object" ? (body as { organizationId?: unknown }).organizationId : null;
  const invitationId = body && typeof body === "object" ? (body as { invitationId?: unknown }).invitationId : null;
  if (!isUuid(organizationId) || !isUuid(invitationId)) return NextResponse.json({ error: "invalid_invitation" }, { status: 400 });

  const context = await requireOrganizationAdministrator(organizationId);
  if (context.error || !context.user) return NextResponse.json({ error: context.error }, { status: context.status });
  if (!hasSupabaseAdminKey()) return NextResponse.json({ error: "admin_provisioning_not_configured" }, { status: 503 });

  const admin = createAdminClient();
  const { data: existing, error: existingError } = await admin
    .from("user_invitations")
    .select("id, auth_user_id, email, role, status")
    .eq("id", invitationId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (existingError || !existing) return NextResponse.json({ error: "invitation_not_found" }, { status: 404 });
  if (existing.status !== "pending") return NextResponse.json({ error: "invitation_not_pending" }, { status: 409 });

  const { data: authUser, error: authUserError } = await admin.auth.admin.getUserById(existing.auth_user_id);
  if (authUserError || !authUser.user) return NextResponse.json({ error: "invitation_not_found" }, { status: 404 });
  if (authUser.user.email_confirmed_at || authUser.user.last_sign_in_at) {
    return NextResponse.json({ error: "invitation_already_activated" }, { status: 409 });
  }

  // Auth invitations are one-time tokens. For a still-pending account, recreating
  // the provisional Auth user safely invalidates the old link before issuing a new one.
  const { error: deletionError } = await admin.auth.admin.deleteUser(existing.auth_user_id);
  if (deletionError) return NextResponse.json({ error: "unable_to_renew_invitation" }, { status: 422 });

  const redirectTo = new URL("/auth/complete-invitation", invitationOrigin(request)).toString();
  const { data: invitation, error: invitationError } = await admin.auth.admin.inviteUserByEmail(existing.email, { redirectTo });
  if (invitationError || !invitation.user) return NextResponse.json({ error: "unable_to_send_invitation" }, { status: 422 });

  const { error: registrationError } = await admin
    .from("user_invitations")
    .upsert({
      organization_id: organizationId,
      auth_user_id: invitation.user.id,
      email: existing.email,
      role: existing.role,
      status: "pending",
      invited_by: context.user.id,
      invited_at: new Date().toISOString(),
      activated_at: null,
    }, { onConflict: "organization_id,email_normalized" });
  if (registrationError) return NextResponse.json({ error: "invitation_sent_but_registration_failed" }, { status: 500 });

  return NextResponse.json({ invited: true, status: "pending" });
}
