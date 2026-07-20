import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const API_URL = "https://api.mercadopublico.cl/servicios/v1/publico/licitaciones.json";
// Ticket publicado por ChileCompra en su documentación oficial. En producción
// se puede reemplazar por el ticket propio mediante CHILECOMPRA_API_TICKET.
const DOCUMENTATION_TICKET = "F8537A18-6766-4DEF-9E59-426B4FEE2844";
const allowedStates = new Set(["activas", "publicada", "cerrada", "desierta", "adjudicada", "revocada", "suspendida", "todos"]);

type UnknownRecord = Record<string, unknown>;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function isoDate(value: unknown) {
  const result = text(value);
  return result && !Number.isNaN(new Date(result).getTime()) ? result : null;
}

function tenderUrl(code: string) {
  return `https://www.mercadopublico.cl/Procurement/Modules/RFB/DetailsAcquisition.aspx?idlicitacion=${encodeURIComponent(code)}`;
}

function normalizeTender(value: unknown) {
  const item = record(value);
  const dates = record(item.Fechas);
  const buyer = record(item.Comprador);
  const rawItems = record(item.Items);
  const code = text(item.CodigoExterno);
  const closeAt = isoDate(dates.FechaCierre) ?? isoDate(item.FechaCierre);
  const publishedAt = isoDate(dates.FechaPublicacion) ?? isoDate(dates.FechaCreacion);
  return {
    code,
    name: text(item.Nombre) || "Licitación sin nombre",
    statusCode: number(item.CodigoEstado),
    status: text(item.Estado) || ({ 5: "Publicada", 6: "Cerrada", 7: "Desierta", 8: "Adjudicada", 18: "Revocada", 19: "Suspendida" } as Record<number, string>)[number(item.CodigoEstado) ?? 0] || "Sin estado",
    description: text(item.Descripcion) || null,
    closeAt,
    publishedAt,
    sourceUrl: tenderUrl(code),
    type: text(item.Tipo) || null,
    currency: text(item.Moneda) || "CLP",
    estimatedAmount: number(item.MontoEstimado),
    visibleAmount: number(item.VisibilidadMonto) === 1,
    fundingSource: text(item.FuenteFinanciamiento) || null,
    claims: number(item.CantidadReclamos),
    renewable: number(item.EsRenovable) === 1,
    subcontracting: text(item.SubContratacion) === "1",
    buyer: {
      code: text(buyer.CodigoOrganismo) || null,
      name: text(buyer.NombreOrganismo) || null,
      taxId: text(buyer.RutUnidad) || null,
      unitCode: text(buyer.CodigoUnidad) || null,
      unitName: text(buyer.NombreUnidad) || null,
      address: text(buyer.DireccionUnidad) || null,
      commune: text(buyer.ComunaUnidad) || null,
      region: text(buyer.RegionUnidad) || null,
      contactName: text(buyer.NombreUsuario) || null,
      contactRole: text(buyer.CargoUsuario) || null,
    },
    dates: {
      questionsUntil: isoDate(dates.FechaFinal),
      answersPublishedAt: isoDate(dates.FechaPubRespuestas),
      technicalOpeningAt: isoDate(dates.FechaActoAperturaTecnica),
      awardAt: isoDate(dates.FechaAdjudicacion) ?? isoDate(dates.FechaEstimadaAdjudicacion),
      estimatedSignatureAt: isoDate(dates.FechaEstimadaFirma),
    },
    paymentContact: {
      name: text(item.NombreResponsablePago) || null,
      email: text(item.EmailResponsablePago) || null,
    },
    contractContact: {
      name: text(item.NombreResponsableContrato) || null,
      email: text(item.EmailResponsableContrato) || null,
      phone: text(item.FonoResponsableContrato) || null,
    },
    items: (Array.isArray(rawItems.Listado) ? rawItems.Listado : []).slice(0, 200).map((rawItem) => {
      const product = record(rawItem);
      return {
        line: number(product.Correlativo),
        productCode: text(product.CodigoProducto) || (number(product.CodigoProducto)?.toString() ?? null),
        category: text(product.Categoria) || null,
        product: text(product.NombreProducto) || "Producto o servicio",
        description: text(product.Descripcion) || null,
        unit: text(product.UnidadMedida) || null,
        quantity: number(product.Cantidad),
      };
    }),
  };
}

async function hasOrganizationAccess(organizationId: string, userId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.from("organization_memberships").select("organization_id").eq("organization_id", organizationId).eq("user_id", userId).maybeSingle();
  return !error && Boolean(data);
}

function formatApiDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${day}${month}${year}`;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const organizationId = request.nextUrl.searchParams.get("organizationId") ?? "";
  if (!isUuid(organizationId) || !(await hasOrganizationAccess(organizationId, user.id))) return NextResponse.json({ error: "organization_access_required" }, { status: 403 });

  const mode = request.nextUrl.searchParams.get("mode") === "detail" ? "detail" : "search";
  const code = (request.nextUrl.searchParams.get("code") ?? "").trim().toUpperCase();
  const keyword = (request.nextUrl.searchParams.get("keyword") ?? "").trim().slice(0, 120);
  const buyerCode = (request.nextUrl.searchParams.get("buyerCode") ?? "").trim();
  const date = (request.nextUrl.searchParams.get("date") ?? "").trim();
  const requestedState = (request.nextUrl.searchParams.get("state") ?? (date ? "todos" : "activas")).trim().toLowerCase();
  const limit = Math.min(100, Math.max(10, Number(request.nextUrl.searchParams.get("limit")) || 50));

  if ((code && !/^[A-Z0-9-]{3,40}$/.test(code)) || (mode === "detail" && !code)) return NextResponse.json({ error: "invalid_tender_code" }, { status: 400 });
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "invalid_publication_date" }, { status: 400 });
  if (buyerCode && (!/^\d{1,12}$/.test(buyerCode) || !date)) return NextResponse.json({ error: "buyer_code_requires_date" }, { status: 400 });
  if (!allowedStates.has(requestedState)) return NextResponse.json({ error: "invalid_tender_state" }, { status: 400 });

  const upstream = new URL(API_URL);
  upstream.searchParams.set("ticket", process.env.CHILECOMPRA_API_TICKET?.trim() || DOCUMENTATION_TICKET);
  if (code) upstream.searchParams.set("codigo", code);
  else {
    if (date) upstream.searchParams.set("fecha", formatApiDate(date));
    upstream.searchParams.set("estado", requestedState);
    if (buyerCode) upstream.searchParams.set("CodigoOrganismo", buyerCode);
  }

  try {
    const response = await fetch(upstream, {
      headers: { Accept: "application/json", "User-Agent": "Atlas-Financiero/1.0" },
      next: { revalidate: mode === "detail" ? 600 : 300 },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return NextResponse.json({ error: "mercado_publico_unavailable", upstreamStatus: response.status }, { status: 502 });
    const payload = record(await response.json());
    const rawList = Array.isArray(payload.Listado) ? payload.Listado : [];
    const normalized = rawList.map(normalizeTender).filter((item) => item.code);

    if (mode === "detail") {
      if (!normalized[0]) return NextResponse.json({ error: "tender_not_found" }, { status: 404 });
      return NextResponse.json({ tender: normalized[0], fetchedAt: text(payload.FechaCreacion) || new Date().toISOString(), source: { name: "API Mercado Público · ChileCompra", url: "https://www.chilecompra.cl/api/" } }, { headers: { "Cache-Control": "private, max-age=300" } });
    }

    const needle = keyword.toLocaleLowerCase("es-CL");
    const matches = normalized.filter((item) => !needle || `${item.code} ${item.name}`.toLocaleLowerCase("es-CL").includes(needle)).sort((left, right) => {
      if (!left.closeAt) return 1;
      if (!right.closeAt) return -1;
      return left.closeAt.localeCompare(right.closeAt);
    });
    return NextResponse.json({
      tenders: matches.slice(0, limit),
      counts: { source: number(payload.Cantidad) ?? normalized.length, matched: matches.length, returned: Math.min(matches.length, limit) },
      fetchedAt: text(payload.FechaCreacion) || new Date().toISOString(),
      ticketMode: process.env.CHILECOMPRA_API_TICKET?.trim() ? "organization" : "documentation",
      source: { name: "API Mercado Público · ChileCompra", url: "https://www.chilecompra.cl/api/" },
    }, { headers: { "Cache-Control": "private, max-age=120" } });
  } catch {
    return NextResponse.json({ error: "mercado_publico_unavailable" }, { status: 503 });
  }
}
