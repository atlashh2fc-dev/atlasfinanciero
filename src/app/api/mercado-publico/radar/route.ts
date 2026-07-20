import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, hasSupabaseAdminKey } from "@/lib/supabase/admin";
import { captureTenderDossier, runDailyRadar } from "@/lib/mercado-publico/intelligence";

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

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "cron_authorization_required" }, { status: 401 });
  if (!hasSupabaseAdminKey()) return NextResponse.json({ error: "server_admin_key_required" }, { status: 503 });
  const body = await request.json().catch(() => null) as { action?: string; codes?: unknown } | null;
  if (body?.action !== "backfill_pipeline") return NextResponse.json({ error: "unsupported_radar_action" }, { status: 400 });
  const admin = createAdminClient();
  const { data: opportunities, error } = await admin.from("commercial_opportunities").select("id, organization_id, source, title").ilike("source", "Mercado Público%");
  if (error) return NextResponse.json({ error: "unable_to_load_public_market_pipeline" }, { status: 500 });
  const requestedCodes = new Set((Array.isArray(body.codes) ? body.codes : []).filter((code): code is string => typeof code === "string" && /^[A-Z0-9-]{3,40}$/i.test(code)).map((code) => code.toUpperCase()));
  const candidates = (opportunities ?? []).map((opportunity) => {
    const match = String(opportunity.source ?? "").match(/Mercado P[uú]blico\s*·\s*([A-Z0-9-]+)/i);
    return match ? { ...opportunity, code: match[1].toUpperCase() } : null;
  }).filter((item): item is NonNullable<typeof item> => Boolean(item)).filter((item) => !requestedCodes.size || requestedCodes.has(item.code));
  const results = [];
  for (const candidate of candidates) {
    try { results.push({ opportunityId: candidate.id, title: candidate.title, ok: true, ...(await captureTenderDossier(admin, candidate.organization_id, candidate.code, candidate.id)) }); }
    catch (captureError) { results.push({ opportunityId: candidate.id, title: candidate.title, code: candidate.code, ok: false, error: captureError instanceof Error ? captureError.message.slice(0, 500) : "unknown_error" }); }
  }
  return NextResponse.json({ executedAt: new Date().toISOString(), found: candidates.length, completed: results.filter((item) => item.ok).length, failed: results.filter((item) => !item.ok).length, results });
}
