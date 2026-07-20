import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const CHILECOMPRA_API_URL = "https://api.mercadopublico.cl/servicios/v1/publico/licitaciones.json";
export const CHILECOMPRA_DOCUMENTATION_TICKET = "F8537A18-6766-4DEF-9E59-426B4FEE2844";
const OCDS_BASE = "https://api.mercadopublico.cl/APISOCDS/OCDS";
const MARKET_HOST = "www.mercadopublico.cl";
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
const MAX_DOCUMENTS = 30;

type UnknownRecord = Record<string, unknown>;

export type TenderDocumentManifest = {
  category: "administrative" | "technical" | "economic" | "award" | "other";
  title: string;
  sourceUrl: string;
  sourceUpdatedAt?: string | null;
};

export type AwardIntel = {
  sourceKey: string;
  relatedTenderCode: string;
  relationship: "current_process" | "probable_predecessor";
  similarityScore: number | null;
  supplierName: string | null;
  supplierTaxId: string | null;
  awardedAmount: number | null;
  awardedQuantity: number | null;
  currencyCode: string | null;
  awardDate: string | null;
  awardDocumentUrl: string | null;
  sourceUrl: string;
  rawPayload: UnknownRecord;
};

export type TenderCritical = {
  contractDuration: string | null;
  paymentTerms: string | null;
  paymentMethod: string | null;
  guarantees: string | null;
  fines: string[];
  evaluationCriteria: Array<{ name: string; weight: string | null }>;
  renewal: string | null;
  subcontracting: string | null;
  readjudication: string | null;
};

export type MatchAnalysis = {
  score: number;
  tier: "green" | "yellow" | "red";
  capabilities: string[];
  reasons: string[];
  gaps: string[];
};

export type NormalizedTender = {
  code: string;
  name: string;
  statusCode: number | null;
  status: string;
  description: string | null;
  closeAt: string | null;
  publishedAt: string | null;
  sourceUrl: string;
  type: string | null;
  currency: string;
  estimatedAmount: number | null;
  visibleAmount: boolean;
  fundingSource: string | null;
  claims: number | null;
  renewable: boolean;
  subcontracting: boolean;
  contractDuration: { value: number | null; unit: string | null; type: string | null };
  award: { date: string | null; documentNumber: string | null; participantCount: number | null; actUrl: string | null };
  buyer: { code: string | null; name: string | null; taxId: string | null; unitCode: string | null; unitName: string | null; address: string | null; commune: string | null; region: string | null; contactName: string | null; contactRole: string | null };
  dates: { questionsUntil: string | null; answersPublishedAt: string | null; technicalOpeningAt: string | null; awardAt: string | null; estimatedSignatureAt: string | null };
  paymentContact: { name: string | null; email: string | null };
  contractContact: { name: string | null; email: string | null; phone: string | null };
  items: Array<{ line: number | null; productCode: string | null; category: string | null; product: string; description: string | null; unit: string | null; quantity: number | null; award: { supplierName: string | null; supplierTaxId: string | null; quantity: number | null; unitAmount: number | null } | null }>;
  intelligence?: { match: MatchAnalysis; critical: TenderCritical; documents: TenderDocumentManifest[]; awards: AwardIntel[]; executiveSummary: UnknownRecord };
};

export function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

export function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function numeric(value: unknown) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function isoDate(value: unknown) {
  const result = text(value);
  return result && !Number.isNaN(new Date(result).getTime()) ? result : null;
}

export function tenderUrl(code: string) {
  return `https://${MARKET_HOST}/Procurement/Modules/RFB/DetailsAcquisition.aspx?idlicitacion=${encodeURIComponent(code)}`;
}

export function normalizeTender(value: unknown): NormalizedTender {
  const item = record(value);
  const dates = record(item.Fechas);
  const buyer = record(item.Comprador);
  const rawItems = record(item.Items);
  const award = record(item.Adjudicacion);
  const code = text(item.CodigoExterno);
  return {
    code,
    name: text(item.Nombre) || "Licitación sin nombre",
    statusCode: numeric(item.CodigoEstado),
    status: text(item.Estado) || ({ 5: "Publicada", 6: "Cerrada", 7: "Desierta", 8: "Adjudicada", 18: "Revocada", 19: "Suspendida" } as Record<number, string>)[numeric(item.CodigoEstado) ?? 0] || "Sin estado",
    description: text(item.Descripcion) || null,
    closeAt: isoDate(dates.FechaCierre) ?? isoDate(item.FechaCierre),
    publishedAt: isoDate(dates.FechaPublicacion) ?? isoDate(dates.FechaCreacion),
    sourceUrl: tenderUrl(code),
    type: text(item.Tipo) || null,
    currency: text(item.Moneda) || "CLP",
    estimatedAmount: numeric(item.MontoEstimado),
    visibleAmount: numeric(item.VisibilidadMonto) === 1,
    fundingSource: text(item.FuenteFinanciamiento) || null,
    claims: numeric(item.CantidadReclamos),
    renewable: numeric(item.EsRenovable) === 1,
    subcontracting: String(item.SubContratacion ?? "") === "1",
    contractDuration: { value: numeric(item.TiempoDuracionContrato), unit: text(item.UnidadTiempoDuracionContrato) || null, type: text(item.TipoDuracionContrato) || null },
    award: { date: isoDate(award.Fecha), documentNumber: text(award.Numero) || null, participantCount: numeric(award.NumeroOferentes), actUrl: text(award.UrlActa) || null },
    buyer: { code: text(buyer.CodigoOrganismo) || null, name: text(buyer.NombreOrganismo) || null, taxId: text(buyer.RutUnidad) || null, unitCode: text(buyer.CodigoUnidad) || null, unitName: text(buyer.NombreUnidad) || null, address: text(buyer.DireccionUnidad) || null, commune: text(buyer.ComunaUnidad) || null, region: text(buyer.RegionUnidad) || null, contactName: text(buyer.NombreUsuario) || null, contactRole: text(buyer.CargoUsuario) || null },
    dates: { questionsUntil: isoDate(dates.FechaFinal), answersPublishedAt: isoDate(dates.FechaPubRespuestas), technicalOpeningAt: isoDate(dates.FechaActoAperturaTecnica), awardAt: isoDate(dates.FechaAdjudicacion) ?? isoDate(dates.FechaEstimadaAdjudicacion), estimatedSignatureAt: isoDate(dates.FechaEstimadaFirma) },
    paymentContact: { name: text(item.NombreResponsablePago) || null, email: text(item.EmailResponsablePago) || null },
    contractContact: { name: text(item.NombreResponsableContrato) || null, email: text(item.EmailResponsableContrato) || null, phone: text(item.FonoResponsableContrato) || null },
    items: (Array.isArray(rawItems.Listado) ? rawItems.Listado : []).slice(0, 300).map((rawItem) => {
      const product = record(rawItem);
      const itemAward = record(product.Adjudicacion);
      const supplierName = text(itemAward.NombreProveedor) || null;
      const supplierTaxId = text(itemAward.RutProveedor) || null;
      return {
        line: numeric(product.Correlativo),
        productCode: text(product.CodigoProducto) || (numeric(product.CodigoProducto)?.toString() ?? null),
        category: text(product.Categoria) || null,
        product: text(product.NombreProducto) || "Producto o servicio",
        description: text(product.Descripcion) || null,
        unit: text(product.UnidadMedida) || null,
        quantity: numeric(product.Cantidad),
        award: supplierName || supplierTaxId ? { supplierName, supplierTaxId, quantity: numeric(itemAward.CantidadAdjudicada), unitAmount: numeric(itemAward.MontoUnitario) } : null,
      };
    }),
  };
}

export function formatApiDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${day}${month}${year}`;
}

export async function fetchChileCompra(params: { code?: string; date?: string; state?: string; buyerCode?: string }, signal?: AbortSignal) {
  const upstream = new URL(CHILECOMPRA_API_URL);
  upstream.searchParams.set("ticket", process.env.CHILECOMPRA_API_TICKET?.trim() || CHILECOMPRA_DOCUMENTATION_TICKET);
  if (params.code) upstream.searchParams.set("codigo", params.code);
  else {
    if (params.date) upstream.searchParams.set("fecha", formatApiDate(params.date));
    upstream.searchParams.set("estado", params.state || "activas");
    if (params.buyerCode) upstream.searchParams.set("CodigoOrganismo", params.buyerCode);
  }
  const response = await fetch(upstream, { headers: { Accept: "application/json", "User-Agent": "Atlas-Financiero/2.0" }, cache: "no-store", signal: signal ?? AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`ChileCompra respondió ${response.status}.`);
  const payload = record(await response.json());
  const rawList = Array.isArray(payload.Listado) ? payload.Listado : [];
  return { payload, tenders: rawList.map(normalizeTender).filter((item) => item.code) };
}

const capabilityGroups = [
  { label: "Experiencia de Cliente y Contact Center", terms: ["contact center", "call center", "centro de contacto", "atencion al cliente", "mesa de ayuda", "telemarketing", "omnicanal", "cobranza", "retencion", "soporte especializado"] },
  { label: "Tecnología, Automatización e IA", terms: ["desarrollo de software", "desarrollo software", "plataforma web", "aplicacion web", "aplicacion movil", "automatizacion", "inteligencia artificial", "integracion", "crm", "chatbot", "sistema informatico"] },
  { label: "Talento, BPO y Operación", terms: ["bpo", "back office", "outsourcing", "externalizacion", "gestion administrativa", "digitacion", "procesamiento de datos", "staffing", "suministro de personal", "apoyo operativo"] },
  { label: "Seguridad Integral y Continuidad", terms: ["cctv", "videovigilancia", "vigilancia", "monitoreo 24", "seguridad fisica", "control de acceso", "guardias de seguridad"] },
  { label: "Data Intelligence y Crecimiento", terms: ["business intelligence", "inteligencia de negocios", "analitica de datos", "analisis de datos", "big data", "georreferenciacion", "scoring", "tablero de control"] },
  { label: "Eficiencia Energética y ESG", terms: ["energia solar", "planta solar", "eficiencia energetica", "consultoria energetica", "fotovoltaico", "gestion de residuos"] },
] as const;

const outOfScopeTerms = ["insumos medicos", "medicamentos", "alimentos", "vestuario", "materiales de construccion", "toner", "combustible", "vehiculos", "mobiliario", "aseo y limpieza"];

function normalized(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-CL");
}

export function scoreTender(tender: NormalizedTender, critical?: TenderCritical, customKeywords: string[] = [], excludedKeywords: string[] = []): MatchAnalysis {
  const corpus = normalized([tender.name, tender.description, ...tender.items.flatMap((item) => [item.product, item.description, item.category])].filter(Boolean).join(" "));
  const capabilities: string[] = [];
  const reasons: string[] = [];
  let score = 8;
  for (const group of capabilityGroups) {
    const hits = group.terms.filter((term) => corpus.includes(normalized(term)));
    if (hits.length) {
      capabilities.push(group.label);
      const contribution = Math.min(26, 15 + (hits.length - 1) * 4);
      score += contribution;
      reasons.push(`${group.label}: ${hits.slice(0, 3).join(", ")}.`);
    }
  }
  const customHits = customKeywords.filter((term) => term.trim() && corpus.includes(normalized(term)));
  if (customHits.length) { score += Math.min(18, customHits.length * 3); reasons.push(`Coincide con radar configurado: ${customHits.slice(0, 5).join(", ")}.`); }
  const excludedHits = [...outOfScopeTerms, ...excludedKeywords].filter((term) => term.trim() && corpus.includes(normalized(term)));
  if (excludedHits.length && !capabilities.length) { score -= 28; reasons.push(`Predominio fuera del foco GEIMSER: ${excludedHits.slice(0, 3).join(", ")}.`); }
  if (tender.visibleAmount && (tender.estimatedAmount ?? 0) > 0) score += 5;
  const daysToClose = tender.closeAt ? Math.ceil((new Date(tender.closeAt).getTime() - Date.now()) / 86_400_000) : null;
  if (daysToClose !== null && daysToClose >= 8) score += 5;
  if (critical?.evaluationCriteria.length) score += 3;
  score = Math.max(0, Math.min(100, score));
  const gaps: string[] = [];
  if (!tender.visibleAmount || tender.estimatedAmount === null) gaps.push("Presupuesto no publicado; requiere validación comercial.");
  if (daysToClose !== null && daysToClose < 5) gaps.push(`Plazo exigente: cierra en ${Math.max(0, daysToClose)} día(s).`);
  if (!capabilities.length) gaps.push("No se detectó una línea GEIMSER directa en título, descripción o ítems.");
  if (!critical?.guarantees) gaps.push("Garantías no informadas en la fuente estructurada.");
  const tier = score >= 65 ? "green" : score >= 35 ? "yellow" : "red";
  if (!reasons.length) reasons.push("Coincidencia genérica; requiere revisión humana antes de ofertar.");
  return { score, tier, capabilities, reasons, gaps };
}

function decodeHtml(value: string) {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const numericCode = code[1].toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(numericCode) ? String.fromCodePoint(numericCode) : entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

function stripHtml(value: string) {
  return decodeHtml(value.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/[\t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

function idText(html: string, id: string) {
  const match = html.match(new RegExp(`<[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i"));
  const value = match ? stripHtml(match[1]) : "";
  return value && !/^no hay informaci[oó]n$/i.test(value) ? value : null;
}

function sectionText(html: string, startId: string, endId: string, max = 2500) {
  const start = html.search(new RegExp(`id=["']${startId}["']`, "i"));
  if (start < 0) return null;
  const remaining = html.slice(start);
  const endOffset = remaining.search(new RegExp(`id=["']${endId}["']`, "i"));
  const value = stripHtml(endOffset > 0 ? remaining.slice(0, endOffset) : remaining.slice(0, 12_000));
  return value ? value.slice(0, max) : null;
}

function keywordContexts(html: string, keywords: string[]) {
  const plain = stripHtml(html).replace(/\s+/g, " ");
  const normalizedPlain = normalized(plain);
  const contexts: string[] = [];
  for (const keyword of keywords) {
    let offset = 0;
    const needle = normalized(keyword);
    while (contexts.length < 5) {
      const index = normalizedPlain.indexOf(needle, offset);
      if (index < 0) break;
      const start = Math.max(0, index - 120);
      const end = Math.min(plain.length, index + needle.length + 260);
      const context = plain.slice(start, end).trim();
      if (context && !contexts.some((item) => item.includes(context) || context.includes(item))) contexts.push(context);
      offset = index + needle.length;
    }
  }
  return contexts;
}

function parseEvaluationCriteria(html: string) {
  const names = new Map<string, string>();
  const weights = new Map<string, string>();
  for (const match of html.matchAll(/id=["']grvCriterios_ctl(\d+)_lblNombreCriterio["'][^>]*>([\s\S]*?)<\/span>/gi)) names.set(match[1], stripHtml(match[2]));
  for (const match of html.matchAll(/id=["']grvCriterios_ctl(\d+)_lblPonderacion["'][^>]*>([\s\S]*?)<\/span>/gi)) weights.set(match[1], stripHtml(match[2]));
  return [...names.entries()].map(([key, name]) => ({ name: name.slice(0, 500), weight: weights.get(key) || null })).slice(0, 20);
}

function attachmentCategory(value: string): TenderDocumentManifest["category"] {
  const key = value.toLowerCase();
  if (key === "administrativo") return "administrative";
  if (key === "tecnico") return "technical";
  if (key === "economico") return "economic";
  return "other";
}

export function parseTenderPage(html: string, sourceUrl: string) {
  const documents: TenderDocumentManifest[] = [];
  const pattern = /<span[^>]+id=["']grv(Administrativo|Tecnico|Economico)_ctl\d+_lblDescripcion["'][^>]*>([\s\S]*?)<\/span>[\s\S]{0,5000}?class=["']fancyAdjunto["'][^>]+href=["']([^"']+)["']/gi;
  for (const match of html.matchAll(pattern)) {
    const absolute = new URL(decodeHtml(match[3]), sourceUrl);
    if (absolute.hostname !== MARKET_HOST || !absolute.pathname.toLowerCase().includes("/attachment/verantecedentes.aspx")) continue;
    const title = stripHtml(match[2]).replace(/\s+/g, " ").slice(0, 600) || "Documento de licitación";
    if (!documents.some((document) => document.sourceUrl === absolute.toString())) documents.push({ category: attachmentCategory(match[1]), title, sourceUrl: absolute.toString() });
  }
  const generalAttachments = html.match(/onclick=["']open\(&#39;([\s\S]*?)&#39;,&#39;MercadoPublico/i)?.[1];
  if (generalAttachments) {
    const absolute = new URL(decodeHtml(generalAttachments), sourceUrl);
    if (absolute.hostname === MARKET_HOST && absolute.pathname.toLowerCase().includes("/attachment/viewattachment.aspx") && !documents.some((document) => document.sourceUrl === absolute.toString())) documents.push({ category: "other", title: "Anexos generales de la licitación", sourceUrl: absolute.toString() });
  }
  const durationValue = idText(html, "lblFicha7TiempoDuracionContrato");
  const durationUnit = idText(html, "lblFicha7UnidadTiempoDuracionContrato");
  const guaranteeMessage = idText(html, "lblMensajeGarantia");
  const guaranteeSection = sectionText(html, "Ficha8", "Ficha9", 3000);
  const critical: TenderCritical = {
    contractDuration: [durationValue, durationUnit].filter(Boolean).join(" ") || null,
    paymentTerms: idText(html, "lblFicha7Plazos"),
    paymentMethod: idText(html, "lblFicha7Opciones"),
    guarantees: guaranteeMessage || (guaranteeSection && !/no hay informaci[oó]n de garant/i.test(guaranteeSection) ? guaranteeSection : null),
    fines: keywordContexts(html, ["multa", "sanción", "término anticipado"]),
    evaluationCriteria: parseEvaluationCriteria(html),
    renewal: idText(html, "lblFicha7ContratoRenovacion"),
    subcontracting: idText(html, "lblFicha7Subcontratacion"),
    readjudication: idText(html, "lblFichaReadjudicacion"),
  };
  return { documents: documents.slice(0, MAX_DOCUMENTS), critical };
}

export async function fetchTenderPage(code: string) {
  const sourceUrl = tenderUrl(code);
  const response = await fetch(sourceUrl, { headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 Atlas-Financiero/2.0" }, cache: "no-store", signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`Ficha Mercado Público respondió ${response.status}.`);
  return { html: await response.text(), sourceUrl };
}

function latestRelease(payload: UnknownRecord) {
  const releases = Array.isArray(payload.releases) ? payload.releases.map(record) : [];
  return releases.at(-1) ?? releases[0] ?? {};
}

async function fetchOcds(kind: "tender" | "award", code: string) {
  const url = `${OCDS_BASE}/${kind}/${encodeURIComponent(code)}`;
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Atlas-Financiero/2.0" }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) return null;
  return { url, payload: record(await response.json()) };
}

function awardRows(code: string, relationship: AwardIntel["relationship"], similarityScore: number | null, sourceUrl: string, payload: UnknownRecord): AwardIntel[] {
  const release = latestRelease(payload);
  const parties = Array.isArray(release.parties) ? release.parties.map(record) : [];
  const awards = Array.isArray(release.awards) ? release.awards.map(record) : [];
  const releaseDate = isoDate(release.date) ?? isoDate(payload.publishedDate);
  const supplierById = new Map<string, UnknownRecord>();
  for (const party of parties) {
    const roles = Array.isArray(party.roles) ? party.roles.map(text) : [];
    if (roles.some((role) => ["supplier", "tenderer"].includes(role))) supplierById.set(text(party.id), party);
  }
  const rows: AwardIntel[] = [];
  for (const award of awards) {
    const suppliers = Array.isArray(award.suppliers) ? award.suppliers.map(record) : [];
    const value = record(award.value);
    for (const supplierRef of suppliers) {
      const party = supplierById.get(text(supplierRef.id)) ?? supplierRef;
      const identifier = record(party.identifier);
      rows.push({
        sourceKey: `${code}:${text(award.id) || "award"}:${text(party.id) || text(identifier.id) || rows.length}`,
        relatedTenderCode: code,
        relationship,
        similarityScore,
        supplierName: text(party.name) || text(identifier.legalName) || null,
        supplierTaxId: text(identifier.id) || null,
        awardedAmount: numeric(value.amount),
        awardedQuantity: null,
        currencyCode: text(value.currency) || null,
        awardDate: isoDate(award.date) ?? releaseDate,
        awardDocumentUrl: null,
        sourceUrl,
        rawPayload: award,
      });
    }
  }
  if (!rows.length) {
    const suppliers = [...supplierById.values()].filter((party) => (Array.isArray(party.roles) ? party.roles.map(text) : []).includes("supplier"));
    for (const party of suppliers) {
      const identifier = record(party.identifier);
      rows.push({ sourceKey: `${code}:party:${text(party.id) || text(identifier.id) || rows.length}`, relatedTenderCode: code, relationship, similarityScore, supplierName: text(party.name) || text(identifier.legalName) || null, supplierTaxId: text(identifier.id) || null, awardedAmount: null, awardedQuantity: null, currencyCode: null, awardDate: releaseDate, awardDocumentUrl: null, sourceUrl, rawPayload: party });
    }
  }
  return rows;
}

function tokenSimilarity(left: string, right: string) {
  const ignored = new Set(["de", "del", "la", "el", "y", "para", "por", "servicio", "servicios", "contratacion", "adquisicion"]);
  const tokens = (value: string) => new Set(normalized(value).split(/[^a-z0-9]+/).filter((token) => token.length > 2 && !ignored.has(token)));
  const a = tokens(left); const b = tokens(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return Math.round((intersection / union) * 100);
}

function probableCodes(code: string) {
  const match = code.match(/^(\d+)-(\d+)-([A-Z]+)(\d{2})$/i);
  if (!match) return [];
  const [, buyer, sequenceText, type, yearText] = match;
  const sequence = Number(sequenceText); const year = Number(yearText);
  const codes: string[] = [];
  for (let offsetYear = 1; offsetYear <= 3; offsetYear += 1) for (let delta = -2; delta <= 2; delta += 1) if (sequence + delta > 0) codes.push(`${buyer}-${sequence + delta}-${type.toUpperCase()}${String((year - offsetYear + 100) % 100).padStart(2, "0")}`);
  return codes;
}

export async function fetchAwardIntelligence(tender: NormalizedTender, includeProbablePredecessors = false) {
  const current = await fetchOcds("award", tender.code).catch(() => null);
  const rows = current ? awardRows(tender.code, "current_process", 100, current.url, current.payload) : [];
  if (!includeProbablePredecessors) return rows;
  const candidates = await Promise.all(probableCodes(tender.code).map(async (code) => {
    const result = await fetchOcds("tender", code).catch(() => null);
    if (!result) return null;
    const release = latestRelease(result.payload);
    const candidate = record(release.tender);
    const similarity = tokenSimilarity(tender.name, text(candidate.title));
    return similarity >= 45 ? { code, similarity } : null;
  }));
  const probable = candidates.filter((candidate): candidate is { code: string; similarity: number } => Boolean(candidate)).sort((a, b) => b.similarity - a.similarity).slice(0, 3);
  const historicAwards = await Promise.all(probable.map(async (candidate) => {
    const result = await fetchOcds("award", candidate.code).catch(() => null);
    return result ? awardRows(candidate.code, "probable_predecessor", candidate.similarity, result.url, result.payload) : [];
  }));
  return [...rows, ...historicAwards.flat()];
}

export function buildExecutiveSummary(tender: NormalizedTender, critical: TenderCritical, documents: TenderDocumentManifest[], awards: AwardIntel[], match: MatchAnalysis) {
  const awarded = awards.filter((item) => item.supplierName);
  return {
    objective: tender.description || tender.name,
    budget: tender.visibleAmount && tender.estimatedAmount !== null ? { amount: tender.estimatedAmount, currency: tender.currency } : null,
    closesAt: tender.closeAt,
    questionsUntil: tender.dates.questionsUntil,
    estimatedAwardAt: tender.dates.awardAt,
    contractDuration: critical.contractDuration || [tender.contractDuration.value, tender.contractDuration.unit || tender.contractDuration.type].filter(Boolean).join(" ") || null,
    paymentTerms: critical.paymentTerms,
    paymentMethod: critical.paymentMethod,
    renewable: critical.renewal || (tender.renewable ? "Sí" : "No informado como renovable"),
    guarantees: critical.guarantees,
    fines: critical.fines,
    evaluationCriteria: critical.evaluationCriteria,
    subcontracting: critical.subcontracting || (tender.subcontracting ? "Permitida" : "No informada / no permitida"),
    documentsCount: documents.length,
    suppliersPublished: awarded.map((item) => ({ name: item.supplierName, taxId: item.supplierTaxId, amount: item.awardedAmount, currency: item.currencyCode, relationship: item.relationship, tenderCode: item.relatedTenderCode })),
    fit: match,
    generatedAt: new Date().toISOString(),
    caveat: "Resumen automático sobre fuentes oficiales. Debe contrastarse con bases y anexos antes de decidir o presentar oferta.",
  };
}

export async function enrichTender(tender: NormalizedTender, options: { customKeywords?: string[]; excludedKeywords?: string[]; includeProbablePredecessors?: boolean } = {}) {
  const [pageResult, awards] = await Promise.all([
    fetchTenderPage(tender.code).then(({ html, sourceUrl }) => parseTenderPage(html, sourceUrl)).catch(() => ({ documents: [] as TenderDocumentManifest[], critical: { contractDuration: null, paymentTerms: null, paymentMethod: null, guarantees: null, fines: [], evaluationCriteria: [], renewal: null, subcontracting: null, readjudication: null } as TenderCritical })),
    fetchAwardIntelligence(tender, options.includeProbablePredecessors).catch(() => [] as AwardIntel[]),
  ]);
  if (tender.award.actUrl && !pageResult.documents.some((item) => item.sourceUrl === tender.award.actUrl)) pageResult.documents.push({ category: "award", title: `Acta de adjudicación ${tender.award.documentNumber || tender.code}`, sourceUrl: tender.award.actUrl, sourceUpdatedAt: tender.award.date });
  for (const item of tender.items) if (item.award?.supplierName || item.award?.supplierTaxId) {
    const amount = item.award.unitAmount !== null && item.award.quantity !== null ? item.award.unitAmount * item.award.quantity : item.award.unitAmount;
    awards.push({ sourceKey: `${tender.code}:line:${item.line ?? item.productCode ?? awards.length}:${item.award.supplierTaxId || item.award.supplierName}`, relatedTenderCode: tender.code, relationship: "current_process", similarityScore: 100, supplierName: item.award.supplierName, supplierTaxId: item.award.supplierTaxId, awardedAmount: amount, awardedQuantity: item.award.quantity, currencyCode: tender.currency, awardDate: tender.award.date || tender.dates.awardAt, awardDocumentUrl: tender.award.actUrl, sourceUrl: tender.sourceUrl, rawPayload: { item } });
  }
  const uniqueAwards = [...new Map(awards.map((item) => [item.sourceKey, item])).values()];
  const match = scoreTender(tender, pageResult.critical, options.customKeywords, options.excludedKeywords);
  return { ...pageResult, awards: uniqueAwards, match, executiveSummary: buildExecutiveSummary(tender, pageResult.critical, pageResult.documents, uniqueAwards, match) };
}

function hiddenFields(html: string) {
  const fields = new URLSearchParams();
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    const attribute = (name: string) => tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"))?.[1] ?? null;
    if (attribute("type")?.toLowerCase() !== "hidden") continue;
    const name = attribute("name");
    if (name) fields.set(decodeHtml(name), decodeHtml(attribute("value") || ""));
  }
  return fields;
}

function attachmentFiles(html: string) {
  const files: Array<{ name: string; action: string; description: string | null; updatedAt: string | null }> = [];
  const pattern = /<span[^>]+id=["']grdAttachment_ctl(\d+)_grdLblSourceFileName["'][^>]*>([\s\S]*?)<\/span>[\s\S]{0,2500}?<span[^>]+id=["']grdAttachment_ctl\1_grdLblFileDescription["'][^>]*>([\s\S]*?)<\/span>[\s\S]{0,1800}?<span[^>]+id=["']grdAttachment_ctl\1_grdLblFileDate["'][^>]*>([\s\S]*?)<\/span>[\s\S]{0,1800}?<input[^>]+name=["']([^"']*grdIbtnView)["']/gi;
  for (const match of html.matchAll(pattern)) files.push({ name: stripHtml(match[2]).slice(0, 240), description: stripHtml(match[3]).slice(0, 500) || null, updatedAt: stripHtml(match[4]) || null, action: decodeHtml(match[5]) });
  if (!files.length) {
    const fallback = html.match(/<span[^>]+id=["']grdAttachment_ctl(\d+)_grdLblSourceFileName["'][^>]*>([\s\S]*?)<\/span>[\s\S]{0,5000}?<input[^>]+name=["']([^"']*grdIbtnView)["']/i);
    if (fallback) files.push({ name: stripHtml(fallback[2]).slice(0, 240), description: null, updatedAt: null, action: decodeHtml(fallback[3]) });
  }
  return files;
}

function cookieHeader(response: Response) {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = headers.getSetCookie?.() ?? [];
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

function safeFileName(value: string) {
  const sanitized = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  return (sanitized || "documento-mercado-publico").slice(0, 180);
}

function contentDispositionName(value: string | null) {
  if (!value) return null;
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) try { return decodeURIComponent(encoded); } catch { /* use regular filename */ }
  return value.match(/filename=["']?([^"';]+)["']?/i)?.[1]?.trim() ?? null;
}

async function readLimited(response: Response, limit: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("El archivo supera 15 MB; se conserva el enlace oficial.");
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error("El archivo supera 15 MB; se conserva el enlace oficial."); }
    chunks.push(value);
  }
  const output = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

async function downloadFromAttachmentPage(manifest: TenderDocumentManifest) {
  const source = new URL(manifest.sourceUrl);
  if (source.hostname !== MARKET_HOST || !source.pathname.toLowerCase().includes("/attachment/verantecedentes.aspx")) return [];
  const pageResponse = await fetch(source, { headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 Atlas-Financiero/2.0", Referer: tenderUrl("ficha") }, cache: "no-store", signal: AbortSignal.timeout(25_000) });
  if (!pageResponse.ok) throw new Error(`Página de anexo respondió ${pageResponse.status}.`);
  const cookies = cookieHeader(pageResponse);
  const pageHtml = await pageResponse.text();
  const fields = hiddenFields(pageHtml);
  const files = attachmentFiles(pageHtml);
  const downloads: Array<{ bytes: Uint8Array; fileName: string; mimeType: string; sourceUpdatedAt: string | null }> = [];
  for (const file of files.slice(0, 10)) {
    const body = new URLSearchParams(fields);
    body.set(`${file.action}.x`, "1"); body.set(`${file.action}.y`, "1");
    const response = await fetch(source, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/octet-stream,*/*", "User-Agent": "Mozilla/5.0 Atlas-Financiero/2.0", Referer: source.toString(), ...(cookies ? { Cookie: cookies } : {}) }, body, cache: "no-store", signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw new Error(`Descarga de anexo respondió ${response.status}.`);
    const type = response.headers.get("content-type")?.split(";", 1)[0] || "application/octet-stream";
    if (type.includes("text/html")) throw new Error("Mercado Público no entregó el archivo del anexo.");
    downloads.push({ bytes: await readLimited(response, MAX_DOCUMENT_BYTES), fileName: contentDispositionName(response.headers.get("content-disposition")) || file.name, mimeType: type, sourceUpdatedAt: file.updatedAt });
  }
  return downloads;
}

async function downloadDirect(manifest: TenderDocumentManifest) {
  const source = new URL(manifest.sourceUrl);
  if (!source.hostname.endsWith("mercadopublico.cl")) return [];
  const response = await fetch(source, { headers: { Accept: "application/octet-stream,text/html,*/*", "User-Agent": "Mozilla/5.0 Atlas-Financiero/2.0" }, redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`Documento oficial respondió ${response.status}.`);
  const type = response.headers.get("content-type")?.split(";", 1)[0] || "application/octet-stream";
  if (type.includes("text/html")) return [];
  return [{ bytes: await readLimited(response, MAX_DOCUMENT_BYTES), fileName: contentDispositionName(response.headers.get("content-disposition")) || manifest.title, mimeType: type, sourceUpdatedAt: manifest.sourceUpdatedAt ?? null }];
}

export async function persistTenderDocuments(admin: SupabaseClient, organizationId: string, tenderId: string, manifests: TenderDocumentManifest[]) {
  const results: Array<{ title: string; status: "downloaded" | "source_only" | "failed"; storagePath: string | null; error: string | null }> = [];
  for (const manifest of manifests.slice(0, MAX_DOCUMENTS)) {
    let downloads: Awaited<ReturnType<typeof downloadFromAttachmentPage>> = [];
    let errorText: string | null = null;
    try {
      downloads = manifest.sourceUrl.toLowerCase().includes("/attachment/verantecedentes.aspx") ? await downloadFromAttachmentPage(manifest) : await downloadDirect(manifest);
    } catch (error) {
      errorText = error instanceof Error ? error.message.slice(0, 500) : "No fue posible descargar el documento.";
    }
    if (!downloads.length) {
      const status = errorText ? "failed" : "source_only";
      await admin.from("public_market_documents").upsert({ organization_id: organizationId, tender_id: tenderId, category: manifest.category, title: manifest.title, source_url: manifest.sourceUrl, storage_path: null, download_status: status, error_text: errorText, source_updated_at: manifest.sourceUpdatedAt ?? null }, { onConflict: "tender_id,source_url,title" });
      results.push({ title: manifest.title, status, storagePath: null, error: errorText });
      continue;
    }
    for (const download of downloads) {
      const hash = createHash("sha256").update(`${manifest.sourceUrl}:${download.fileName}`).digest("hex").slice(0, 16);
      const fileName = safeFileName(download.fileName);
      const storagePath = `${organizationId}/${tenderId}/${manifest.category}/${hash}-${fileName}`;
      const { error: uploadError } = await admin.storage.from("public-market-documents").upload(storagePath, download.bytes, { contentType: download.mimeType, upsert: true });
      const title = download.fileName || manifest.title;
      const status = uploadError ? "failed" : "downloaded";
      const uploadMessage = uploadError?.message?.slice(0, 500) ?? null;
      await admin.from("public_market_documents").upsert({ organization_id: organizationId, tender_id: tenderId, category: manifest.category, title, source_url: manifest.sourceUrl, storage_path: uploadError ? null : storagePath, mime_type: download.mimeType, size_bytes: download.bytes.byteLength, download_status: status, error_text: uploadMessage, source_updated_at: manifest.sourceUpdatedAt ?? null }, { onConflict: "tender_id,source_url,title" });
      results.push({ title, status, storagePath: uploadError ? null : storagePath, error: uploadMessage });
    }
  }
  return results;
}

const emptyCritical: TenderCritical = { contractDuration: null, paymentTerms: null, paymentMethod: null, guarantees: null, fines: [], evaluationCriteria: [], renewal: null, subcontracting: null, readjudication: null };

export async function persistTenderSnapshot(admin: SupabaseClient, organizationId: string, tender: NormalizedTender, intelligence: { match: MatchAnalysis; critical?: TenderCritical; documents?: TenderDocumentManifest[]; awards?: AwardIntel[]; executiveSummary?: UnknownRecord }, options: { opportunityId?: string | null; status?: "radar" | "enriching" | "ready" | "partial" | "failed" } = {}) {
  const executiveSummary = intelligence.executiveSummary ?? buildExecutiveSummary(tender, intelligence.critical ?? emptyCritical, intelligence.documents ?? [], intelligence.awards ?? [], intelligence.match);
  const values = {
    organization_id: organizationId,
    external_code: tender.code,
    name: tender.name,
    status: tender.status,
    status_code: tender.statusCode,
    buyer_code: tender.buyer.code,
    buyer_name: tender.buyer.name,
    buyer_tax_id: tender.buyer.taxId,
    published_at: tender.publishedAt,
    closes_at: tender.closeAt,
    currency_code: tender.currency,
    estimated_amount: tender.estimatedAmount,
    visible_amount: tender.visibleAmount,
    fit_score: intelligence.match.score,
    fit_tier: intelligence.match.tier,
    capability_matches: intelligence.match.capabilities,
    fit_reasons: intelligence.match.reasons,
    fit_gaps: intelligence.match.gaps,
    executive_summary: executiveSummary,
    raw_detail: { tender, critical: intelligence.critical ?? null },
    source_url: tender.sourceUrl,
    enrichment_status: options.status ?? "radar",
    ...(options.opportunityId ? { opportunity_id: options.opportunityId, selected_at: new Date().toISOString() } : {}),
    last_seen_at: new Date().toISOString(),
  };
  const { data, error } = await admin.from("public_market_tenders").upsert(values, { onConflict: "organization_id,external_code" }).select("id, first_seen_at").single();
  if (error || !data) throw new Error(error?.message || "No fue posible guardar la licitación en el radar.");
  return data as { id: string; first_seen_at: string };
}

export async function persistAwardHistory(admin: SupabaseClient, organizationId: string, tenderId: string, awards: AwardIntel[]) {
  if (!awards.length) return;
  const values = awards.map((award) => ({ organization_id: organizationId, tender_id: tenderId, source_key: award.sourceKey, related_tender_code: award.relatedTenderCode, relationship: award.relationship, similarity_score: award.similarityScore, supplier_name: award.supplierName, supplier_tax_id: award.supplierTaxId, awarded_amount: award.awardedAmount, awarded_quantity: award.awardedQuantity, currency_code: award.currencyCode, award_date: award.awardDate, award_document_url: award.awardDocumentUrl, source_url: award.sourceUrl, raw_payload: award.rawPayload }));
  const { error } = await admin.from("public_market_award_history").upsert(values, { onConflict: "tender_id,source_key" });
  if (error) throw new Error(error.message);
}

export async function captureTenderDossier(admin: SupabaseClient, organizationId: string, code: string, opportunityId: string) {
  const [{ tenders }, { data: settings }] = await Promise.all([
    fetchChileCompra({ code }),
    admin.from("public_market_radar_settings").select("search_keywords, excluded_keywords").eq("organization_id", organizationId).maybeSingle(),
  ]);
  const tender = tenders[0];
  if (!tender) throw new Error("La licitación no existe en la fuente oficial.");
  const intelligence = await enrichTender(tender, { customKeywords: settings?.search_keywords ?? [], excludedKeywords: settings?.excluded_keywords ?? [], includeProbablePredecessors: true });
  const snapshot = await persistTenderSnapshot(admin, organizationId, tender, intelligence, { opportunityId, status: "enriching" });
  await persistAwardHistory(admin, organizationId, snapshot.id, intelligence.awards);
  const files = await persistTenderDocuments(admin, organizationId, snapshot.id, intelligence.documents);
  const failed = files.filter((file) => file.status === "failed").length;
  const downloaded = files.filter((file) => file.status === "downloaded").length;
  const enrichmentStatus = failed ? (downloaded ? "partial" : "failed") : "ready";
  await admin.from("public_market_tenders").update({ enrichment_status: enrichmentStatus }).eq("organization_id", organizationId).eq("id", snapshot.id);
  return { tenderId: snapshot.id, code: tender.code, documents: { total: files.length, downloaded, failed, sourceOnly: files.filter((file) => file.status === "source_only").length }, awards: intelligence.awards.length, match: intelligence.match, enrichmentStatus };
}

function chileDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

async function mapLimit<T, R>(values: T[], limit: number, worker: (value: T) => Promise<R>) {
  const results: R[] = [];
  for (let index = 0; index < values.length; index += limit) results.push(...await Promise.all(values.slice(index, index + limit).map(worker)));
  return results;
}

export async function runDailyRadar(admin: SupabaseClient, organizationId: string, triggeredBy: "daily_robot" | "manual" = "daily_robot") {
  const runDate = chileDate();
  await admin.from("public_market_radar_settings").upsert({ organization_id: organizationId }, { onConflict: "organization_id", ignoreDuplicates: true });
  const { data: settings } = await admin.from("public_market_radar_settings").select("minimum_score, search_keywords, excluded_keywords").eq("organization_id", organizationId).maybeSingle();
  const minimumScore = Number(settings?.minimum_score ?? 35);
  const keywords = settings?.search_keywords ?? [];
  const excluded = settings?.excluded_keywords ?? [];
  await admin.from("public_market_radar_runs").upsert({ organization_id: organizationId, run_date: runDate, status: "running", source_count: 0, match_count: 0, new_count: 0, summary: null, error_text: null, started_at: new Date().toISOString(), completed_at: null, triggered_by: triggeredBy }, { onConflict: "organization_id,run_date" });
  try {
    const { payload, tenders } = await fetchChileCompra({ state: "activas" });
    const preliminaries = tenders.map((tender) => ({ tender, match: scoreTender(tender, undefined, keywords, excluded) })).filter((item) => item.match.score >= Math.max(20, minimumScore - 12)).sort((a, b) => b.match.score - a.match.score).slice(0, 80);
    const detailed = await mapLimit(preliminaries, 6, async (item) => {
      try {
        const result = await fetchChileCompra({ code: item.tender.code });
        const tender = result.tenders[0] ?? item.tender;
        return { tender, match: scoreTender(tender, undefined, keywords, excluded) };
      } catch { return item; }
    });
    const matches = detailed.filter((item) => item.match.score >= minimumScore);
    const codes = matches.map((item) => item.tender.code);
    const { data: existing } = codes.length ? await admin.from("public_market_tenders").select("external_code").eq("organization_id", organizationId).in("external_code", codes) : { data: [] as Array<{ external_code: string }> };
    const existingCodes = new Set((existing ?? []).map((item) => item.external_code));
    await mapLimit(matches, 8, async ({ tender, match }) => persistTenderSnapshot(admin, organizationId, tender, { match }, { status: "radar" }));
    const newCount = codes.filter((code) => !existingCodes.has(code)).length;
    const sourceCount = numeric(payload.Cantidad) ?? tenders.length;
    const summary = newCount ? `${newCount} oportunidad(es) nueva(s) detectada(s) para GEIMSER; ${matches.length} coincidencia(s) vigentes.` : `Sin oportunidades nuevas para GEIMSER; ${matches.length} coincidencia(s) vigentes continúan bajo seguimiento.`;
    await Promise.all([
      admin.from("public_market_radar_runs").update({ status: "completed", source_count: sourceCount, match_count: matches.length, new_count: newCount, summary, completed_at: new Date().toISOString() }).eq("organization_id", organizationId).eq("run_date", runDate),
      admin.from("public_market_radar_settings").update({ last_run_at: new Date().toISOString() }).eq("organization_id", organizationId),
    ]);
    return { runDate, sourceCount, matchCount: matches.length, newCount, summary };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : "Falló el radar diario.";
    await admin.from("public_market_radar_runs").update({ status: "failed", error_text: message, summary: "El radar no pudo completar la consulta oficial; se reintentará en la próxima ejecución.", completed_at: new Date().toISOString() }).eq("organization_id", organizationId).eq("run_date", runDate);
    throw error;
  }
}
