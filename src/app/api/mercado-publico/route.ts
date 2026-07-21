import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { enrichTender, fetchChileCompra, numeric, scoreTender, text } from "@/lib/mercado-publico/intelligence";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const allowedStates = new Set(["activas", "publicada", "cerrada", "desierta", "adjudicada", "revocada", "suspendida", "todos"]);

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function organizationContext(organizationId: string, userId: string) {
  const supabase = await createClient();
  const [{ data: membership }, { data: settings }] = await Promise.all([
    supabase.from("organization_memberships").select("organization_id").eq("organization_id", organizationId).eq("user_id", userId).maybeSingle(),
    supabase.from("public_market_radar_settings").select("search_keywords, excluded_keywords, minimum_score").eq("organization_id", organizationId).maybeSingle(),
  ]);
  return membership ? { keywords: settings?.search_keywords ?? [], excluded: settings?.excluded_keywords ?? [], minimumScore: Math.max(0, Math.min(100, Number(settings?.minimum_score ?? 35))) } : null;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const organizationId = request.nextUrl.searchParams.get("organizationId") ?? "";
  if (!isUuid(organizationId)) return NextResponse.json({ error: "organization_access_required" }, { status: 403 });
  const context = await organizationContext(organizationId, user.id);
  if (!context) return NextResponse.json({ error: "organization_access_required" }, { status: 403 });

  const mode = request.nextUrl.searchParams.get("mode") === "detail" ? "detail" : "search";
  const code = (request.nextUrl.searchParams.get("code") ?? "").trim().toUpperCase();
  const keyword = (request.nextUrl.searchParams.get("keyword") ?? "").trim().slice(0, 120);
  const buyerCode = (request.nextUrl.searchParams.get("buyerCode") ?? "").trim();
  const publicationDate = (request.nextUrl.searchParams.get("date") ?? "").trim();
  const requestedState = (request.nextUrl.searchParams.get("state") ?? (publicationDate ? "todos" : "activas")).trim().toLowerCase();
  const limit = Math.min(100, Math.max(10, Number(request.nextUrl.searchParams.get("limit")) || 50));

  if ((code && !/^[A-Z0-9-]{3,40}$/.test(code)) || (mode === "detail" && !code)) return NextResponse.json({ error: "invalid_tender_code" }, { status: 400 });
  if (publicationDate && !/^\d{4}-\d{2}-\d{2}$/.test(publicationDate)) return NextResponse.json({ error: "invalid_publication_date" }, { status: 400 });
  if (buyerCode && (!/^\d{1,12}$/.test(buyerCode) || !publicationDate)) return NextResponse.json({ error: "buyer_code_requires_date" }, { status: 400 });
  if (!allowedStates.has(requestedState)) return NextResponse.json({ error: "invalid_tender_state" }, { status: 400 });

  try {
    const { payload, tenders } = await fetchChileCompra({ code: code || undefined, date: publicationDate || undefined, state: requestedState, buyerCode: buyerCode || undefined });
    if (mode === "detail") {
      const tender = tenders[0];
      if (!tender) return NextResponse.json({ error: "tender_not_found" }, { status: 404 });
      const intelligence = await enrichTender(tender, { customKeywords: context.keywords, excludedKeywords: context.excluded, includeProbablePredecessors: false });
      return NextResponse.json({ tender: { ...tender, intelligence }, fetchedAt: text(payload.FechaCreacion) || new Date().toISOString(), source: { name: "API Mercado Público · ChileCompra", url: "https://www.chilecompra.cl/api/" } }, { headers: { "Cache-Control": "private, max-age=180" } });
    }

    const needle = keyword.toLocaleLowerCase("es-CL");
    const matches = tenders.filter((item) => !needle || `${item.code} ${item.name}`.toLocaleLowerCase("es-CL").includes(needle)).map((item) => ({ ...item, match: scoreTender(item, undefined, context.keywords, context.excluded) })).sort((left, right) => {
      const scoreDifference = right.match.score - left.match.score;
      if (scoreDifference) return scoreDifference;
      if (!left.closeAt) return 1;
      if (!right.closeAt) return -1;
      return left.closeAt.localeCompare(right.closeAt);
    });
    const relevantMatches = matches.filter((item) => item.match.score >= context.minimumScore).length;
    return NextResponse.json({
      tenders: matches.slice(0, limit),
      counts: { source: numeric(payload.Cantidad) ?? tenders.length, evaluated: matches.length, matched: relevantMatches, returned: Math.min(matches.length, limit), minimumScore: context.minimumScore },
      fetchedAt: text(payload.FechaCreacion) || new Date().toISOString(),
      ticketMode: process.env.CHILECOMPRA_API_TICKET?.trim() ? "organization" : "documentation",
      source: { name: "API Mercado Público · ChileCompra", url: "https://www.chilecompra.cl/api/" },
    }, { headers: { "Cache-Control": "private, max-age=120" } });
  } catch {
    return NextResponse.json({ error: "mercado_publico_unavailable" }, { status: 503 });
  }
}
