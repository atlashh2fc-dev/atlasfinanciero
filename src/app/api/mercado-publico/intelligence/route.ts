import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, hasSupabaseAdminKey } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { enrichTender, fetchChileCompra, persistAwardHistory, persistTenderDocuments, persistTenderSnapshot, runDailyRadar } from "@/lib/mercado-publico/intelligence";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const writeRoles = new Set(["administrator", "finance", "operations"]);

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function context(organizationId: unknown, write = false) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isUuid(organizationId)) return null;
  const { data } = await supabase.from("organization_memberships").select("organization_id, role").eq("organization_id", organizationId).eq("user_id", user.id).maybeSingle();
  if (!data || (write && !writeRoles.has(data.role))) return null;
  return { supabase, user, organizationId: data.organization_id as string };
}

async function signedDocuments(supabase: Awaited<ReturnType<typeof createClient>>, documents: Array<Record<string, unknown>>) {
  return Promise.all(documents.map(async (document) => {
    const path = typeof document.storage_path === "string" ? document.storage_path : null;
    if (!path) return { ...document, signedUrl: null };
    const { data } = await supabase.storage.from("public-market-documents").createSignedUrl(path, 900);
    return { ...document, signedUrl: data?.signedUrl ?? null };
  }));
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  const access = await context(organizationId);
  if (!access) return NextResponse.json({ error: "organization_access_required" }, { status: 403 });
  const code = (request.nextUrl.searchParams.get("code") ?? "").trim().toUpperCase();
  if (code && !/^[A-Z0-9-]{3,40}$/.test(code)) return NextResponse.json({ error: "invalid_tender_code" }, { status: 400 });

  if (code) {
    const { data: tender } = await access.supabase.from("public_market_tenders").select("*").eq("organization_id", access.organizationId).eq("external_code", code).maybeSingle();
    if (!tender) return NextResponse.json({ tender: null, documents: [], awards: [] });
    const [{ data: documents }, { data: awards }] = await Promise.all([
      access.supabase.from("public_market_documents").select("id, category, title, source_url, storage_path, mime_type, size_bytes, download_status, error_text, source_updated_at, created_at").eq("organization_id", access.organizationId).eq("tender_id", tender.id).order("category").order("title"),
      access.supabase.from("public_market_award_history").select("id, related_tender_code, relationship, similarity_score, supplier_name, supplier_tax_id, awarded_amount, awarded_quantity, currency_code, award_date, award_document_url, source_url").eq("organization_id", access.organizationId).eq("tender_id", tender.id).order("relationship").order("award_date", { ascending: false, nullsFirst: false }),
    ]);
    return NextResponse.json({ tender, documents: await signedDocuments(access.supabase, documents ?? []), awards: awards ?? [] });
  }

  const [{ data: latestRun }, { data: settings }, { data: tenders }] = await Promise.all([
    access.supabase.from("public_market_radar_runs").select("*").eq("organization_id", access.organizationId).order("run_date", { ascending: false }).limit(1).maybeSingle(),
    access.supabase.from("public_market_radar_settings").select("enabled, run_local_hour, minimum_score, last_run_at").eq("organization_id", access.organizationId).maybeSingle(),
    access.supabase.from("public_market_tenders").select("id, external_code, name, status, buyer_name, published_at, closes_at, currency_code, estimated_amount, visible_amount, fit_score, fit_tier, capability_matches, fit_reasons, fit_gaps, source_url, enrichment_status, opportunity_id, first_seen_at, last_seen_at").eq("organization_id", access.organizationId).order("fit_score", { ascending: false }).order("closes_at", { ascending: true, nullsFirst: false }).limit(200),
  ]);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return NextResponse.json({ latestRun, settings, tenders: tenders ?? [], newToday: (tenders ?? []).filter((item) => item.first_seen_at?.slice(0, 10) === today).length });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const access = await context(body?.organizationId, true);
  if (!access) return NextResponse.json({ error: "organization_write_not_authorized" }, { status: 403 });
  if (!hasSupabaseAdminKey()) return NextResponse.json({ error: "server_admin_key_required" }, { status: 503 });
  const admin = createAdminClient();

  if (body?.action === "run_radar") {
    try { return NextResponse.json(await runDailyRadar(admin, access.organizationId, "manual")); }
    catch { return NextResponse.json({ error: "radar_run_failed" }, { status: 502 }); }
  }

  if (body?.action === "capture_tender") {
    const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
    const opportunityId = isUuid(body.opportunityId) ? body.opportunityId : null;
    if (!/^[A-Z0-9-]{3,40}$/.test(code) || !opportunityId) return NextResponse.json({ error: "invalid_capture_request" }, { status: 400 });
    const { data: opportunity } = await access.supabase.from("commercial_opportunities").select("id").eq("organization_id", access.organizationId).eq("id", opportunityId).maybeSingle();
    if (!opportunity) return NextResponse.json({ error: "opportunity_not_found" }, { status: 404 });
    try {
      const [{ tenders }, { data: settings }] = await Promise.all([
        fetchChileCompra({ code }),
        access.supabase.from("public_market_radar_settings").select("search_keywords, excluded_keywords").eq("organization_id", access.organizationId).maybeSingle(),
      ]);
      const tender = tenders[0];
      if (!tender) return NextResponse.json({ error: "tender_not_found" }, { status: 404 });
      const intelligence = await enrichTender(tender, { customKeywords: settings?.search_keywords ?? [], excludedKeywords: settings?.excluded_keywords ?? [], includeProbablePredecessors: true });
      const snapshot = await persistTenderSnapshot(admin, access.organizationId, tender, intelligence, { opportunityId, status: "enriching" });
      await persistAwardHistory(admin, access.organizationId, snapshot.id, intelligence.awards);
      const files = await persistTenderDocuments(admin, access.organizationId, snapshot.id, intelligence.documents);
      const failed = files.filter((file) => file.status === "failed").length;
      const downloaded = files.filter((file) => file.status === "downloaded").length;
      const enrichmentStatus = failed ? (downloaded ? "partial" : "failed") : "ready";
      await admin.from("public_market_tenders").update({ enrichment_status: enrichmentStatus }).eq("organization_id", access.organizationId).eq("id", snapshot.id);
      return NextResponse.json({ tenderId: snapshot.id, documents: { total: files.length, downloaded, failed, sourceOnly: files.filter((file) => file.status === "source_only").length }, awards: intelligence.awards.length, match: intelligence.match, enrichmentStatus });
    } catch (error) {
      return NextResponse.json({ error: "tender_capture_failed", detail: error instanceof Error ? error.message.slice(0, 500) : undefined }, { status: 502 });
    }
  }

  return NextResponse.json({ error: "unsupported_intelligence_action" }, { status: 400 });
}
