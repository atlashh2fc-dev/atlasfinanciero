import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, hasSupabaseAdminKey } from "@/lib/supabase/admin";
import { runDailyRadar } from "@/lib/mercado-publico/intelligence";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "cron_authorization_required" }, { status: 401 });
  if (!hasSupabaseAdminKey()) return NextResponse.json({ error: "server_admin_key_required" }, { status: 503 });
  const admin = createAdminClient();
  const { data: settings, error } = await admin.from("public_market_radar_settings").select("organization_id").eq("enabled", true);
  if (error) return NextResponse.json({ error: "unable_to_load_radar_settings" }, { status: 500 });
  const results = [];
  for (const setting of settings ?? []) {
    try { results.push({ organizationId: setting.organization_id, ok: true, ...(await runDailyRadar(admin, setting.organization_id, "daily_robot")) }); }
    catch (radarError) { results.push({ organizationId: setting.organization_id, ok: false, error: radarError instanceof Error ? radarError.message.slice(0, 500) : "unknown_error" }); }
  }
  return NextResponse.json({ executedAt: new Date().toISOString(), organizations: results.length, results });
}
