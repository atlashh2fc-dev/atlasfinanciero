import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationAdministrator, type OrganizationRole } from "@/lib/admin-access";

const roles = new Set<OrganizationRole>(["administrator", "finance", "operations", "auditor"]);

function organizationFromUrl(request: NextRequest) {
  return request.nextUrl.searchParams.get("organizationId");
}

export async function GET(request: NextRequest) {
  const organizationId = organizationFromUrl(request);
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_organization" }, { status: 400 });
  const context = await requireOrganizationAdministrator(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });

  const { data, error } = await context.supabase
    .from("organization_memberships")
    .select("user_id, role, created_at, profiles (email, full_name)")
    .eq("organization_id", organizationId)
    .order("created_at");
  if (error) return NextResponse.json({ error: "unable_to_load_members" }, { status: 500 });

  const members = (data ?? []).map((member) => ({
    userId: member.user_id,
    role: member.role,
    createdAt: member.created_at,
    profile: Array.isArray(member.profiles) ? member.profiles[0] ?? null : member.profiles,
  }));
  return NextResponse.json({ members });
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
