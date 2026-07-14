import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, hasSupabaseAdminKey } from "@/lib/supabase/admin";
import { isUuid, requireOrganizationAdministrator } from "@/lib/admin-access";

function recoveryOrigin(request: NextRequest) {
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
  const userId = body && typeof body === "object" ? (body as { userId?: unknown }).userId : null;
  if (!isUuid(organizationId) || !isUuid(userId)) return NextResponse.json({ error: "invalid_recovery_request" }, { status: 400 });

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

  const { data: authUser, error: authUserError } = await admin.auth.admin.getUserById(userId);
  if (authUserError || !authUser.user?.email) return NextResponse.json({ error: "member_not_found" }, { status: 404 });

  const redirectTo = new URL("/auth/complete-invitation", recoveryOrigin(request)).toString();
  const { data, error } = await admin.auth.admin.generateLink({
    type: "recovery",
    email: authUser.user.email,
    options: { redirectTo },
  });
  const recoveryLink = data?.properties?.action_link;
  if (error || !recoveryLink) return NextResponse.json({ error: "unable_to_generate_recovery_link" }, { status: 422 });

  return NextResponse.json(
    { email: authUser.user.email, recoveryLink },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
