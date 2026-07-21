import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, hasSupabaseAdminKey } from "@/lib/supabase/admin";
import { isUuid, requireOrganizationAdministrator, type OrganizationRole } from "@/lib/admin-access";

const roles = new Set<OrganizationRole>(["administrator", "finance", "operations", "auditor"]);

export async function POST(request: NextRequest) {
  const body: unknown = await request.json().catch(() => null);
  const values = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const organizationId = values.organizationId;
  const email = values.email;
  const password = values.password;
  const fullName = values.fullName;
  const role = values.role;

  if (!isUuid(organizationId) || typeof email !== "string" || email.trim().length > 320 || !/^\S+@\S+\.\S+$/.test(email.trim()) || typeof password !== "string" || password.length < 12 || password.length > 256 || typeof fullName !== "string" || fullName.trim().length > 160 || typeof role !== "string" || !roles.has(role as OrganizationRole)) {
    return NextResponse.json({ error: "invalid_user" }, { status: 400 });
  }

  const context = await requireOrganizationAdministrator(organizationId);
  if (context.error || !context.user) return NextResponse.json({ error: context.error }, { status: context.status });
  if (!hasSupabaseAdminKey()) return NextResponse.json({ error: "admin_provisioning_not_configured" }, { status: 503 });

  const admin = createAdminClient();
  const normalizedEmail = email.trim().toLowerCase();
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: normalizedEmail,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName.trim() },
  });
  if (createError || !created.user) return NextResponse.json({ error: "unable_to_create_user" }, { status: 422 });

  const userId = created.user.id;
  const { error: profileError } = await admin.from("profiles").upsert({ id: userId, email: normalizedEmail, full_name: fullName.trim() });
  const { error: membershipError } = profileError
    ? { error: profileError }
    : await admin.from("organization_memberships").upsert({ organization_id: organizationId, user_id: userId, role }, { onConflict: "organization_id,user_id" });
  if (membershipError) {
    await admin.auth.admin.deleteUser(userId);
    return NextResponse.json({ error: "unable_to_assign_user" }, { status: 500 });
  }

  return NextResponse.json({ user: { id: userId, email: normalizedEmail, fullName: fullName.trim(), role } }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const body: unknown = await request.json().catch(() => null);
  const values = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const organizationId = values.organizationId;
  const userId = values.userId;
  const password = values.password;

  if (!isUuid(organizationId) || !isUuid(userId) || typeof password !== "string" || password.length < 12 || password.length > 256) {
    return NextResponse.json({ error: "invalid_password_update" }, { status: 400 });
  }

  const context = await requireOrganizationAdministrator(organizationId);
  if (context.error || !context.user) return NextResponse.json({ error: context.error }, { status: context.status });
  if (!hasSupabaseAdminKey()) return NextResponse.json({ error: "admin_provisioning_not_configured" }, { status: 503 });

  const admin = createAdminClient();
  const { data: membership, error: membershipError } = await admin
    .from("organization_memberships")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (membershipError) return NextResponse.json({ error: "unable_to_read_membership" }, { status: 500 });
  if (!membership) return NextResponse.json({ error: "member_not_found" }, { status: 404 });

  const { error } = await admin.auth.admin.updateUserById(userId, { password });
  if (error) return NextResponse.json({ error: "unable_to_update_password" }, { status: 422 });

  return NextResponse.json({ updated: true }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
