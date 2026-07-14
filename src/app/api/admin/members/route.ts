import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationAdministrator, type OrganizationRole } from "@/lib/admin-access";
import { createAdminClient, hasSupabaseAdminKey } from "@/lib/supabase/admin";

const roles = new Set<OrganizationRole>(["administrator", "finance", "operations", "auditor"]);

function organizationFromUrl(request: NextRequest) {
  return request.nextUrl.searchParams.get("organizationId");
}

export async function GET(request: NextRequest) {
  const organizationId = organizationFromUrl(request);
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_organization" }, { status: 400 });
  const context = await requireOrganizationAdministrator(organizationId);
  if (context.error || !context.user) return NextResponse.json({ error: context.error }, { status: context.status });
  if (!hasSupabaseAdminKey()) return NextResponse.json({ error: "admin_provisioning_not_configured" }, { status: 503 });

  const admin = createAdminClient();
  const [{ data: membershipData, error: membershipError }, { data: pendingData, error: pendingError }] = await Promise.all([
    admin
      .from("organization_memberships")
      .select("user_id, role, created_at")
      .eq("organization_id", organizationId)
      .order("created_at"),
    admin
      .from("user_invitations")
      .select("id, email, role, status, invited_at")
      .eq("organization_id", organizationId)
      .eq("status", "pending")
      .order("invited_at", { ascending: false }),
  ]);
  if (membershipError || pendingError) return NextResponse.json({ error: "unable_to_load_members" }, { status: 500 });

  const userIds = (membershipData ?? []).map((member) => member.user_id);
  const { data: profileData, error: profileError } = userIds.length
    ? await admin.from("profiles").select("id, email, full_name").in("id", userIds)
    : { data: [], error: null };
  if (profileError) return NextResponse.json({ error: "unable_to_load_members" }, { status: 500 });

  const profileByUserId = new Map((profileData ?? []).map((profile) => [profile.id, profile]));
  const authUsers = await Promise.all(userIds.map(async (userId) => {
    const { data: result } = await admin.auth.admin.getUserById(userId);
    return [userId, result.user] as const;
  }));
  const authUserById = new Map(authUsers);

  const members = (membershipData ?? []).map((member) => {
    const profile = profileByUserId.get(member.user_id);
    const authUser = authUserById.get(member.user_id);
    const metadataName = typeof authUser?.user_metadata?.full_name === "string" ? authUser.user_metadata.full_name : null;
    return {
      userId: member.user_id,
      role: member.role,
      createdAt: member.created_at,
      profile: {
        email: profile?.email ?? authUser?.email ?? null,
        full_name: profile?.full_name ?? metadataName,
      },
    };
  });
  const invitations = (pendingData ?? []).map((invitation) => ({
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    invitedAt: invitation.invited_at,
  }));
  return NextResponse.json({ members, invitations });
}

export async function PATCH(request: NextRequest) {
  const body: unknown = await request.json().catch(() => null);
  const organizationId = body && typeof body === "object" ? (body as { organizationId?: unknown }).organizationId : null;
  const userId = body && typeof body === "object" ? (body as { userId?: unknown }).userId : null;
  const role = body && typeof body === "object" ? (body as { role?: unknown }).role : null;
  if (!isUuid(organizationId) || !isUuid(userId) || typeof role !== "string" || !roles.has(role as OrganizationRole)) return NextResponse.json({ error: "invalid_member" }, { status: 400 });

  const context = await requireOrganizationAdministrator(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });
  const { data, error } = await context.supabase
    .from("organization_memberships")
    .update({ role })
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .select("user_id, role")
    .single();
  if (error) return NextResponse.json({ error: "unable_to_update_member" }, { status: 403 });
  return NextResponse.json({ member: data });
}

export async function DELETE(request: NextRequest) {
  const organizationId = organizationFromUrl(request);
  const userId = request.nextUrl.searchParams.get("userId");
  if (!isUuid(organizationId) || !isUuid(userId)) return NextResponse.json({ error: "invalid_member" }, { status: 400 });
  const context = await requireOrganizationAdministrator(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });

  const { error } = await context.supabase
    .from("organization_memberships")
    .delete()
    .eq("organization_id", organizationId)
    .eq("user_id", userId);
  if (error) return NextResponse.json({ error: "unable_to_remove_member" }, { status: 403 });
  return NextResponse.json({ removed: true });
}
