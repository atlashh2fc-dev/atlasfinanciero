import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, hasSupabaseAdminKey } from "@/lib/supabase/admin";
import { isUuid, requireOrganizationAdministrator } from "@/lib/admin-access";

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_organization" }, { status: 400 });

  const context = await requireOrganizationAdministrator(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });

  const { data: events, error } = await context.supabase
    .from("audit_log")
    .select("id, actor_id, entity_type, entity_id, action, before_state, after_state, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(250);
  if (error) return NextResponse.json({ error: "unable_to_load_audit_log" }, { status: 500 });

  const actorIds = [...new Set((events ?? []).map((event) => event.actor_id).filter((actorId): actorId is string => Boolean(actorId)))];
  let actors = new Map<string, { full_name: string | null; email: string | null }>();
  if (actorIds.length && hasSupabaseAdminKey()) {
    const { data: profiles } = await createAdminClient().from("profiles").select("id, full_name, email").in("id", actorIds);
    actors = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
  }

  return NextResponse.json({
    events: (events ?? []).map((event) => ({
      ...event,
      actor: event.actor_id ? actors.get(event.actor_id) ?? null : null,
    })),
  });
}
