"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";

type Customer = { id: string; legal_name: string; trade_name: string | null; tax_id: string | null };
type Opportunity = { id: string; title: string; source: string | null };
type Match = { score: number; tier: "green" | "yellow" | "red"; capabilities: string[]; reasons: string[]; gaps: string[] };
type TenderItem = { line: number | null; productCode: string | null; category: string | null; product: string; description: string | null; unit: string | null; quantity: number | null; award: { supplierName: string | null; supplierTaxId: string | null; quantity: number | null; unitAmount: number | null } | null };
type Manifest = { category: string; title: string; sourceUrl: string };
type Critical = { contractDuration: string | null; paymentTerms: string | null; paymentMethod: string | null; guarantees: string | null; fines: string[]; evaluationCriteria: Array<{ name: string; weight: string | null }>; renewal: string | null; subcontracting: string | null; readjudication: string | null };
type Award = { relatedTenderCode: string; relationship: "current_process" | "probable_predecessor"; similarityScore: number | null; supplierName: string | null; supplierTaxId: string | null; awardedAmount: number | null; awardedQuantity: number | null; currencyCode: string | null; awardDate: string | null; awardDocumentUrl: string | null; sourceUrl: string };
type Intelligence = { match: Match; critical: Critical; documents: Manifest[]; awards: Award[]; executiveSummary: Record<string, unknown> };
type Tender = {
  code: string; name: string; statusCode: number | null; status: string; description: string | null; closeAt: string | null; publishedAt: string | null; sourceUrl: string; type: string | null; currency: string; estimatedAmount: number | null; visibleAmount: boolean; fundingSource: string | null; claims: number | null; renewable: boolean; subcontracting: boolean;
  buyer: { code: string | null; name: string | null; taxId: string | null; unitCode: string | null; unitName: string | null; address: string | null; commune: string | null; region: string | null; contactName: string | null; contactRole: string | null };
  dates: { questionsUntil: string | null; answersPublishedAt: string | null; technicalOpeningAt: string | null; awardAt: string | null; estimatedSignatureAt: string | null };
  paymentContact: { name: string | null; email: string | null };
  contractContact: { name: string | null; email: string | null; phone: string | null };
  items: TenderItem[]; match?: Match; intelligence?: Intelligence;
};
type SearchPayload = { tenders: Tender[]; counts: { source: number; evaluated: number; matched: number; returned: number; minimumScore: number }; fetchedAt: string; ticketMode: "organization" | "documentation"; source: { name: string; url: string } };
type CommercialPayload = { customers: Customer[]; opportunities: Opportunity[] };
type Filters = { keyword: string; code: string; state: string; date: string; buyerCode: string; limit: string };
type RadarTender = { external_code: string; name: string; status: string; buyer_name: string | null; closes_at: string | null; fit_score: number; fit_tier: Match["tier"]; capability_matches: string[]; fit_reasons: string[]; fit_gaps: string[]; source_url: string; enrichment_status: string; opportunity_id: string | null; first_seen_at: string };
type RadarPayload = { latestRun: { run_date: string; status: string; source_count: number; match_count: number; new_count: number; summary: string | null; completed_at: string | null; error_text: string | null } | null; settings: { enabled: boolean; run_local_hour: number; minimum_score: number; last_run_at: string | null } | null; tenders: RadarTender[]; newToday: number };
type StoredDocument = { id: string; category: string; title: string; source_url: string; signedUrl: string | null; mime_type: string | null; size_bytes: number | null; download_status: string; error_text: string | null };
type Dossier = { tender: { executive_summary: Record<string, unknown>; enrichment_status: string; fit_score: number; fit_tier: Match["tier"] } | null; documents: StoredDocument[]; awards: Array<{ id: string; related_tender_code: string; relationship: Award["relationship"]; similarity_score: number | null; supplier_name: string | null; supplier_tax_id: string | null; awarded_amount: number | null; awarded_quantity: number | null; currency_code: string | null; award_date: string | null; award_document_url: string | null; source_url: string }> };
type DetailTab = "summary" | "documents" | "history" | "items";

const defaultFilters: Filters = { keyword: "", code: "", state: "activas", date: "", buyerCode: "", limit: "50" };
const currency = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const integer = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 });

function formatDate(value: string | null, withTime = false) {
  if (!value) return "Sin informar";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Sin informar";
  return new Intl.DateTimeFormat("es-CL", withTime ? { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "short", year: "numeric" }).format(parsed);
}

function amount(tender: Tender) {
  if (tender.estimatedAmount === null || !tender.visibleAmount) return "Monto no publicado";
  return tender.currency === "CLP" ? currency.format(tender.estimatedAmount) : `${tender.currency} ${integer.format(tender.estimatedAmount)}`;
}

function moneyValue(value: number | null, code: string | null) {
  if (value === null) return "Monto no informado";
  return code === "CLP" || !code ? currency.format(value) : `${code} ${integer.format(value)}`;
}

function normalize(value: string | null | undefined) { return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase(); }
function customerName(customer: Customer) { return customer.trade_name || customer.legal_name; }
function nextActionDate(closeAt: string | null) { if (!closeAt) return ""; const value = new Date(closeAt); value.setDate(value.getDate() - 2); return value.toISOString().slice(0, 10); }
function fitLabel(tier: Match["tier"]) { return tier === "green" ? "Alta afinidad" : tier === "yellow" ? "Revisar" : "Baja afinidad"; }
function categoryLabel(value: string) { return value === "administrative" ? "Administrativo" : value === "technical" ? "Técnico" : value === "economic" ? "Económico" : value === "award" ? "Adjudicación" : "Otro"; }
function humanBytes(value: number | null) { if (!value) return "—"; if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`; return `${(value / 1024 / 1024).toFixed(1)} MB`; }

export function PublicMarketCrm({ organizationId, canManage }: { organizationId: string | null; canManage: boolean }) {
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [results, setResults] = useState<SearchPayload | null>(null);
  const [commercial, setCommercial] = useState<CommercialPayload>({ customers: [], opportunities: [] });
  const [radar, setRadar] = useState<RadarPayload | null>(null);
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [selected, setSelected] = useState<Tender | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [detailTab, setDetailTab] = useState<DetailTab>("summary");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [radarRunning, setRadarRunning] = useState(false);
  const [message, setMessage] = useState("");

  async function loadCommercial() {
    if (!organizationId) return;
    const response = await fetch(`/api/commercial-control?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as CommercialPayload | null;
    if (response.ok && payload) setCommercial({ customers: payload.customers ?? [], opportunities: payload.opportunities ?? [] });
  }

  async function loadRadar() {
    if (!organizationId) return;
    const response = await fetch(`/api/mercado-publico/intelligence?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as RadarPayload | null;
    if (response.ok && payload) setRadar(payload);
  }

  async function loadDossier(code: string) {
    if (!organizationId) return null;
    const response = await fetch(`/api/mercado-publico/intelligence?organizationId=${encodeURIComponent(organizationId)}&code=${encodeURIComponent(code)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as Dossier | null;
    if (response.ok && payload) { setDossier(payload); return payload; }
    return null;
  }

  async function runSearch(nextFilters: Filters = filters) {
    if (!organizationId) return;
    if (nextFilters.buyerCode && !nextFilters.date) { setMessage("Para filtrar por organismo, selecciona también la fecha de publicación exigida por la API oficial."); return; }
    setLoading(true); setMessage("");
    const params = new URLSearchParams({ organizationId, keyword: nextFilters.keyword, code: nextFilters.code, state: nextFilters.state, date: nextFilters.date, buyerCode: nextFilters.buyerCode, limit: nextFilters.limit });
    const response = await fetch(`/api/mercado-publico?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as SearchPayload | { error?: string } | null;
    setLoading(false);
    if (!response.ok || !payload || !("tenders" in payload)) { setResults(null); setMessage(response.status >= 502 ? "Mercado Público no respondió a tiempo. Intenta nuevamente en unos minutos." : "No fue posible ejecutar la búsqueda. Revisa los parámetros ingresados."); return; }
    setResults(payload);
    if (!payload.tenders.length) setMessage("No se encontraron licitaciones para esos parámetros.");
  }

  useEffect(() => { if (organizationId) void Promise.all([runSearch(defaultFilters), loadCommercial(), loadRadar()]); }, [organizationId]);

  const closingSoon = useMemo(() => { const limit = Date.now() + 7 * 86_400_000; return (results?.tenders ?? []).filter((item) => item.closeAt && new Date(item.closeAt).getTime() >= Date.now() && new Date(item.closeAt).getTime() <= limit).length; }, [results]);
  const published = (results?.tenders ?? []).filter((item) => item.status.toLowerCase() === "publicada").length;
  const alreadyInPipeline = selected ? commercial.opportunities.find((item) => item.source?.includes(selected.code)) : undefined;
  const match = selected?.intelligence?.match ?? selected?.match;
  const critical = selected?.intelligence?.critical;
  const executive = (dossier?.tender?.executive_summary ?? selected?.intelligence?.executiveSummary ?? {}) as Record<string, unknown>;
  const displayDocuments = dossier?.documents.length ? dossier.documents : (selected?.intelligence?.documents ?? []).map((item, index) => ({ id: `manifest-${index}`, category: item.category, title: item.title, source_url: item.sourceUrl, signedUrl: null, mime_type: null, size_bytes: null, download_status: "pending", error_text: null }));
  const displayAwards = dossier?.awards ?? (selected?.intelligence?.awards ?? []).map((item, index) => ({ id: `award-${index}`, related_tender_code: item.relatedTenderCode, relationship: item.relationship, similarity_score: item.similarityScore, supplier_name: item.supplierName, supplier_tax_id: item.supplierTaxId, awarded_amount: item.awardedAmount, awarded_quantity: item.awardedQuantity, currency_code: item.currencyCode, award_date: item.awardDate, award_document_url: item.awardDocumentUrl, source_url: item.sourceUrl }));

  function submitSearch(event: FormEvent) { event.preventDefault(); void runSearch(); }

  async function runRadarNow() {
    if (!organizationId || !canManage) return;
    setRadarRunning(true); setMessage("");
    const response = await fetch("/api/mercado-publico/intelligence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run_radar", organizationId }) });
    const payload = await response.json().catch(() => null) as { summary?: string } | null;
    setRadarRunning(false);
    if (!response.ok) { setMessage("El radar no pudo completar la consulta oficial. Intenta nuevamente más tarde."); return; }
    await loadRadar(); setMessage(payload?.summary || "Radar actualizado correctamente.");
  }

  async function openTender(tender: Tender) {
    if (!organizationId) return;
    setSelected(null); setDossier(null); setDetailTab("summary"); setDetailLoading(true); setMessage("");
    const params = new URLSearchParams({ organizationId, mode: "detail", code: tender.code });
    const [response] = await Promise.all([fetch(`/api/mercado-publico?${params.toString()}`, { cache: "no-store" }), loadDossier(tender.code)]);
    const payload = await response.json().catch(() => null) as { tender?: Tender } | null;
    setDetailLoading(false);
    if (!response.ok || !payload?.tender) { setMessage("No fue posible abrir la ficha completa de la licitación."); return; }
    const detail = payload.tender;
    const buyerTaxId = normalize(detail.buyer.taxId); const buyerName = normalize(detail.buyer.name);
    const customer = commercial.customers.find((item) => (buyerTaxId && normalize(item.tax_id) === buyerTaxId) || (buyerName && normalize(item.legal_name) === buyerName));
    setSelectedCustomerId(customer?.id ?? ""); setSelected(detail);
  }

  async function createBuyerCustomer() {
    if (!organizationId || !selected?.buyer.name || !canManage) return;
    setSaving(true); setMessage("");
    const response = await fetch("/api/customer-profiles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_profile", organizationId, profile: { legalName: selected.buyer.name, tradeName: selected.buyer.unitName, taxId: selected.buyer.taxId, businessActivity: "Organismo comprador · Mercado Público", addressLine1: selected.buyer.address, commune: selected.buyer.commune, city: selected.buyer.region, website: "https://www.mercadopublico.cl", email: null, phone: null, paymentTermDays: null, billingEmail: null, billingPhone: null, legalRepresentativeName: null, legalRepresentativeTaxId: null, legalRepresentativeAddress: null, legalRepresentativePhone: null, legalRepresentativeEmail: null, isActive: true }, contacts: selected.buyer.contactName ? [{ contactArea: "commercial", jobTitle: selected.buyer.contactRole, fullName: selected.buyer.contactName, phone: null, email: null, isPrimary: true }] : [] }) });
    const payload = await response.json().catch(() => null) as { id?: string } | null;
    setSaving(false);
    if (!response.ok || !payload?.id) { setMessage("No fue posible crear la ficha del organismo. Puede que ya exista con otro nombre o RUT."); return; }
    await loadCommercial(); setSelectedCustomerId(payload.id); setMessage("Organismo incorporado al maestro de clientes.");
  }

  async function createOpportunity() {
    if (!organizationId || !selected || !selectedCustomerId || !canManage) return;
    setSaving(true); setMessage("Creando oportunidad y preparando expediente documental…");
    const description = [`Licitación ${selected.code} de ${selected.buyer.name || "organismo no informado"}.`, selected.description, match ? `Afinidad GEIMSER ${match.score}/100 (${fitLabel(match.tier)}). ${match.reasons.join(" ")}` : null, `Fuente oficial: ${selected.sourceUrl}`].filter(Boolean).join("\n\n").slice(0, 4000);
    const response = await fetch("/api/commercial-control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_opportunity", organizationId, record: { counterpartyId: selectedCustomerId, title: `${selected.code} · ${selected.name}`.slice(0, 250), stage: "qualified", expectedAmount: selected.visibleAmount ? selected.estimatedAmount ?? 0 : 0, currencyCode: ["CLP", "UF", "USD"].includes(selected.currency) ? selected.currency : "CLP", probability: match ? Math.max(20, Math.min(75, match.score)) : 25, expectedCloseOn: selected.closeAt?.slice(0, 10) ?? "", nextActionOn: nextActionDate(selected.closeAt), source: `Mercado Público · ${selected.code}`.slice(0, 120), lostReason: null, description } }) });
    const opportunity = await response.json().catch(() => null) as { id?: string } | null;
    if (!response.ok || !opportunity?.id) { setSaving(false); setMessage("No fue posible crear la oportunidad. Revisa el cliente asociado y las fechas."); return; }
    const capture = await fetch("/api/mercado-publico/intelligence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "capture_tender", organizationId, code: selected.code, opportunityId: opportunity.id }) });
    const capturePayload = await capture.json().catch(() => null) as { documents?: { total: number; downloaded: number; failed: number; sourceOnly: number }; awards?: number; enrichmentStatus?: string } | null;
    setSaving(false); await Promise.all([loadCommercial(), loadRadar(), loadDossier(selected.code)]);
    if (!capture.ok) { setMessage(`La oportunidad ${selected.code} fue creada, pero el expediente quedó pendiente de reintento.`); return; }
    setMessage(`${selected.code} incorporada al pipeline: ${capturePayload?.documents?.downloaded ?? 0} documento(s) descargado(s), ${capturePayload?.awards ?? 0} antecedente(s) comercial(es).`); setDetailTab("documents");
  }

  async function captureExistingOpportunity() {
    if (!organizationId || !selected || !alreadyInPipeline || !canManage) return;
    setSaving(true); setMessage("Preparando expediente documental y antecedentes comerciales…");
    const response = await fetch("/api/mercado-publico/intelligence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "capture_tender", organizationId, code: selected.code, opportunityId: alreadyInPipeline.id }) });
    const payload = await response.json().catch(() => null) as { documents?: { total: number; downloaded: number; failed: number; sourceOnly: number }; awards?: number; enrichmentStatus?: string } | null;
    setSaving(false);
    if (!response.ok) { setMessage(`No fue posible completar el expediente de ${selected.code}. La oportunidad existente no fue modificada.`); return; }
    await Promise.all([loadRadar(), loadDossier(selected.code)]);
    setMessage(`Expediente actualizado: ${payload?.documents?.downloaded ?? 0} documento(s) guardado(s), ${payload?.awards ?? 0} antecedente(s) comercial(es).`);
    setDetailTab("documents");
  }

  return <main className="dashboard public-market-crm">
    <section className="headline"><div><span className="eyebrow">CRM · MERCADO PÚBLICO</span><h1>Radar de licitaciones y oportunidades</h1><p>Detección diaria, evaluación GEIMSER, expediente documental y continuidad directa al pipeline.</p></div><a className="secondary-button" href="https://www.chilecompra.cl/api/" target="_blank" rel="noreferrer">Fuente oficial</a></section>

    <section className={`panel public-market-radar ${radar?.latestRun?.new_count ? "has-news" : ""}`}><div><span className="panel-label">ROBOT COMERCIAL · CADA MAÑANA</span><h2>{radar?.latestRun?.summary || "Radar diario preparado"}</h2><p>{radar?.latestRun ? `Última ejecución ${formatDate(radar.latestRun.completed_at, true)} · ${integer.format(radar.latestRun.source_count)} procesos revisados.` : "La primera ejecución consolidará oportunidades nuevas y vigentes según las capacidades publicadas por GEIMSER."}</p></div><div className="public-market-radar-stats"><span><strong>{radar?.latestRun?.new_count ?? 0}</strong><small>Nuevas hoy</small></span><span><strong>{radar?.latestRun?.match_count ?? 0}</strong><small>En seguimiento</small></span><span><strong>{radar?.settings?.minimum_score ?? 35}+</strong><small>Puntaje mínimo</small></span>{canManage && <button type="button" className="primary-button" onClick={() => void runRadarNow()} disabled={radarRunning}>{radarRunning ? "Robot revisando…" : "Ejecutar ahora"}</button>}</div></section>

    <section className="kpis public-market-kpis"><article className="kpi-card accent"><span>Coincidencias relevantes</span><strong>{results ? integer.format(results.counts.matched) : "—"}</strong><small>{results ? `Puntaje GEIMSER ≥ ${results.counts.minimumScore}` : "Según umbral del radar"}</small></article><article className="kpi-card"><span>Cierran en 7 días</span><strong className={closingSoon ? "is-negative" : ""}>{closingSoon}</strong><small>Dentro de las priorizadas</small></article><article className="kpi-card"><span>Publicadas</span><strong>{published}</strong><small>Dentro de las priorizadas</small></article><article className="kpi-card"><span>En pipeline</span><strong>{commercial.opportunities.filter((item) => item.source?.startsWith("Mercado Público")).length}</strong><small>Con expediente comercial</small></article></section>

    <section className="panel public-market-search"><div className="panel-heading"><div><span className="panel-label">BÚSQUEDA PARAMETRIZADA</span><h2>Explorar licitaciones</h2><p>Código, estado y fecha consultan ChileCompra; el semáforo cruza cada proceso con las capacidades GEIMSER.</p></div></div><form onSubmit={submitSearch} className="public-market-filter-grid"><label>Palabra clave<input value={filters.keyword} onChange={(event) => setFilters({ ...filters, keyword: event.target.value })} maxLength={120} placeholder="Ej. contact center, BPO, desarrollo" /></label><label>Código de licitación<input value={filters.code} onChange={(event) => setFilters({ ...filters, code: event.target.value.toUpperCase() })} maxLength={40} placeholder="Ej. 1234-56-LE26" /></label><label>Estado<select value={filters.state} onChange={(event) => setFilters({ ...filters, state: event.target.value })}><option value="activas">Activas</option><option value="todos">Todos</option><option value="publicada">Publicadas</option><option value="cerrada">Cerradas</option><option value="adjudicada">Adjudicadas</option><option value="desierta">Desiertas</option><option value="revocada">Revocadas</option><option value="suspendida">Suspendidas</option></select></label><label>Fecha de publicación<input type="date" value={filters.date} onChange={(event) => setFilters({ ...filters, date: event.target.value })} /></label><label>Código organismo<input inputMode="numeric" value={filters.buyerCode} onChange={(event) => setFilters({ ...filters, buyerCode: event.target.value.replace(/\D/g, "") })} placeholder="Requiere fecha" /></label><label>Máximo<select value={filters.limit} onChange={(event) => setFilters({ ...filters, limit: event.target.value })}><option value="25">25 resultados</option><option value="50">50 resultados</option><option value="100">100 resultados</option></select></label><div className="public-market-filter-actions"><button type="button" className="secondary-button" onClick={() => { setFilters(defaultFilters); void runSearch(defaultFilters); }}>Limpiar</button><button type="submit" className="primary-button" disabled={loading}>{loading ? "Consultando…" : "Buscar licitaciones"}</button></div></form></section>
    {message && <p className="operation-message" role="status" aria-live="polite">{message}</p>}

    <section className="table-section public-market-results"><div className="table-heading"><div><span className="panel-label">OPORTUNIDADES PRIORIZADAS</span><h2>{results ? `${integer.format(results.counts.returned)} procesos ordenados por afinidad` : "Esperando consulta"}</h2><p>{results ? `${integer.format(results.counts.matched)} coincidencia(s) con puntaje ≥ ${results.counts.minimumScore} · ${integer.format(results.counts.evaluated)} evaluadas · actualización ${formatDate(results.fetchedAt, true)}` : "Resultados en tiempo real desde ChileCompra."}</p></div>{results?.counts.source !== undefined && <span className="status neutral">{integer.format(results.counts.source)} en fuente</span>}</div><div className="table-scroll"><table><thead><tr><th>Código / licitación</th><th aria-sort="descending">Match GEIMSER ↓</th><th>Estado</th><th>Cierre</th><th>Acción</th></tr></thead><tbody>{(results?.tenders ?? []).map((tender) => <tr key={tender.code}><td><strong>{tender.code}</strong><small>{tender.name}</small></td><td>{tender.match ? <span className={`public-market-fit is-${tender.match.tier}`}><i />{tender.match.score}/100 · {fitLabel(tender.match.tier)}</span> : "—"}</td><td><span className={`status ${tender.status.toLowerCase() === "publicada" ? "paid" : tender.status.toLowerCase() === "suspendida" ? "cancelled" : "pending"}`}>{tender.status}</span></td><td>{formatDate(tender.closeAt, true)}</td><td><button type="button" className="text-button" onClick={() => void openTender(tender)}>Evaluar oportunidad</button></td></tr>)}{!loading && !results?.tenders.length && <tr><td colSpan={5}>Sin licitaciones para mostrar.</td></tr>}</tbody></table></div></section>

    {detailLoading && <div className="modal-backdrop public-market-backdrop" role="presentation"><section className="entry-modal public-market-modal"><p className="billing-empty">Analizando ficha, anexos y antecedentes oficiales…</p></section></div>}
    {selected && <div className="modal-backdrop public-market-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setSelected(null); }}><section className="entry-modal public-market-modal public-market-intelligence-modal" role="dialog" aria-modal="true" aria-labelledby="public-tender-title"><div className="modal-header"><div><span className="eyebrow">{selected.code} · {selected.status}</span><h2 id="public-tender-title">{selected.name}</h2><p>{selected.buyer.name || "Organismo no informado"} · cierre {formatDate(selected.closeAt, true)}</p></div><div className="public-market-modal-status">{match && <span className={`public-market-fit is-${match.tier}`}><i />{match.score}/100 · {fitLabel(match.tier)}</span>}<button className="close-button" type="button" onClick={() => setSelected(null)} aria-label="Cerrar">×</button></div></div>
      <nav className="public-market-detail-tabs" aria-label="Expediente de licitación">{(["summary", "documents", "history", "items"] as DetailTab[]).map((tab) => <button key={tab} type="button" className={detailTab === tab ? "is-active" : ""} onClick={() => setDetailTab(tab)}>{tab === "summary" ? "Resumen ejecutivo" : tab === "documents" ? `Documentos (${displayDocuments.length})` : tab === "history" ? `Antecedentes (${displayAwards.length})` : `Ítems (${selected.items.length})`}</button>)}</nav>
      {detailTab === "summary" && <div className="public-market-tab-content"><div className="public-market-detail-summary"><span><small>Presupuesto</small><strong>{amount(selected)}</strong></span><span><small>Duración</small><strong>{critical?.contractDuration || String(executive.contractDuration || "No informada")}</strong></span><span><small>Garantías</small><strong>{critical?.guarantees ? "Informadas" : "No informadas"}</strong></span><span><small>Cierre</small><strong>{formatDate(selected.closeAt)}</strong></span></div><section className="public-market-executive-grid"><article><span className="panel-label">DECISIÓN COMERCIAL</span><h3>{match ? `${fitLabel(match.tier)} · ${match.score}/100` : "Revisión requerida"}</h3><p>{selected.description || selected.name}</p>{match && <><h4>Por qué encaja</h4><ul>{match.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><h4>Brechas y riesgos</h4><ul>{match.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul></>}</article><article><span className="panel-label">CONDICIONES CRÍTICAS</span><dl><div><dt>Presupuesto</dt><dd>{amount(selected)}</dd></div><div><dt>Duración</dt><dd>{critical?.contractDuration || "No informada"}</dd></div><div><dt>Pago</dt><dd>{[critical?.paymentTerms, critical?.paymentMethod].filter(Boolean).join(" · ") || "No informado"}</dd></div><div><dt>Renovación</dt><dd>{critical?.renewal || (selected.renewable ? "Sí" : "No informada")}</dd></div><div><dt>Subcontratación</dt><dd>{critical?.subcontracting || (selected.subcontracting ? "Permitida" : "No informada")}</dd></div><div><dt>Garantías</dt><dd>{critical?.guarantees || "No informadas en la ficha"}</dd></div></dl></article></section>{critical?.evaluationCriteria.length ? <section className="public-market-criteria"><div><span className="panel-label">CRITERIOS DE EVALUACIÓN</span><h3>Cómo se define la adjudicación</h3></div><div>{critical.evaluationCriteria.map((criterion, index) => <span key={`${criterion.name}-${index}`}><strong>{criterion.weight || "—"}</strong>{criterion.name}</span>)}</div></section> : null}{critical?.fines.length ? <section className="public-market-risk-note"><span className="panel-label">MULTAS Y TÉRMINO ANTICIPADO</span>{critical.fines.map((fine, index) => <p key={index}>{fine}</p>)}</section> : null}</div>}
      {detailTab === "documents" && <div className="public-market-tab-content"><section className="public-market-file-header"><div><span className="panel-label">EXPEDIENTE DOCUMENTAL</span><h3>{alreadyInPipeline ? "Documentos vinculados a la oportunidad" : "Anexos disponibles al incorporar al pipeline"}</h3><p>{dossier?.tender ? `Estado: ${dossier.tender.enrichment_status}.` : "Al crear la oportunidad, Atlas descargará automáticamente cada archivo disponible y conservará el enlace oficial como respaldo."}</p></div></section><div className="public-market-files">{displayDocuments.map((document) => <article key={document.id}><span className={`public-market-file-icon is-${document.category}`}>DOC</span><div><strong>{document.title}</strong><small>{categoryLabel(document.category)} · {humanBytes(document.size_bytes)} · {document.download_status === "downloaded" ? "Copia segura en Atlas" : document.download_status === "failed" ? "Descarga pendiente" : "Fuente oficial"}</small>{document.error_text && <small>{document.error_text}</small>}</div><a className="text-button" href={document.signedUrl || document.source_url} target="_blank" rel="noreferrer">{document.signedUrl ? "Abrir copia" : "Abrir fuente"}</a></article>)}{!displayDocuments.length && <p className="control-empty">La ficha no publicó anexos descargables. Se conserva el acceso oficial.</p>}</div></div>}
      {detailTab === "history" && <div className="public-market-tab-content"><section className="public-market-file-header"><div><span className="panel-label">INTELIGENCIA DE ADJUDICACIÓN</span><h3>Proveedores, montos y procesos comparables</h3><p>“Predecesor probable” es una coincidencia por organismo, código cercano y similitud de objeto; debe validarse antes de usarla comercialmente.</p></div></section><div className="public-market-history">{displayAwards.map((award) => <article key={award.id}><div><span className={`status ${award.relationship === "current_process" ? "paid" : "pending"}`}>{award.relationship === "current_process" ? "Proceso actual" : `Predecesor probable · ${award.similarity_score ?? 0}%`}</span><h3>{award.supplier_name || "Proveedor no publicado"}</h3><p>{award.supplier_tax_id || "RUT no informado"} · licitación {award.related_tender_code}</p></div><div><strong>{moneyValue(award.awarded_amount, award.currency_code)}</strong><small>{award.awarded_quantity !== null ? `Cantidad ${integer.format(award.awarded_quantity)}` : "Cantidad no informada"} · {formatDate(award.award_date)}</small><a className="text-button" href={award.award_document_url || award.source_url} target="_blank" rel="noreferrer">Ver fuente oficial</a></div></article>)}{!displayAwards.length && <p className="control-empty">No hay un adjudicatario publicado ni un proceso histórico suficientemente similar en la fuente oficial.</p>}</div></div>}
      {detailTab === "items" && <div className="public-market-tab-content"><section className="public-market-items"><div><span className="panel-label">PRODUCTOS Y SERVICIOS</span><h3>{selected.items.length} línea(s) informada(s)</h3></div><div className="table-scroll"><table><thead><tr><th>Producto / servicio</th><th>Categoría</th><th>Cantidad</th><th>Adjudicación publicada</th></tr></thead><tbody>{selected.items.map((item, index) => <tr key={`${item.line}-${item.productCode}-${index}`}><td><strong>{item.product}</strong><small>{item.description || item.productCode || "Sin detalle"}</small></td><td>{item.category || "Sin categoría"}</td><td>{item.quantity === null ? "—" : `${integer.format(item.quantity)} ${item.unit || ""}`}</td><td>{item.award ? <><strong>{item.award.supplierName || item.award.supplierTaxId}</strong><small>{moneyValue(item.award.unitAmount, selected.currency)} unitario</small></> : "—"}</td></tr>)}</tbody></table></div></section></div>}
      <section className="public-market-crm-link"><div><span className="panel-label">CONEXIÓN CON EL PIPELINE</span><h3>{alreadyInPipeline ? "Oportunidad y expediente vinculados" : "Incorporar oportunidad completa"}</h3><p>Al incorporar se guarda el resumen, se descargan anexos, se asocia el organismo y se conserva la trazabilidad oficial.</p></div>{alreadyInPipeline ? <div className="public-market-existing-link"><span className="status paid">{alreadyInPipeline.title}</span>{canManage && dossier?.tender?.enrichment_status !== "ready" && <button type="button" className="primary-button" disabled={saving} onClick={() => void captureExistingOpportunity()}>{saving ? "Preparando expediente…" : dossier?.tender ? "Reintentar expediente" : "Preparar expediente"}</button>}</div> : <div className="public-market-customer-link"><label>Cliente / organismo<select value={selectedCustomerId} onChange={(event) => setSelectedCustomerId(event.target.value)}><option value="">Selecciona una ficha existente</option>{commercial.customers.map((customer) => <option key={customer.id} value={customer.id}>{customerName(customer)}{customer.tax_id ? ` · ${customer.tax_id}` : ""}</option>)}</select></label>{canManage && selected.buyer.name && !selectedCustomerId && <button type="button" className="secondary-button" disabled={saving} onClick={() => void createBuyerCustomer()}>Crear organismo</button>}{canManage && <button type="button" className="primary-button" disabled={saving || !selectedCustomerId} onClick={() => void createOpportunity()}>{saving ? "Preparando expediente…" : "Incorporar al pipeline"}</button>}</div>}</section><div className="form-actions"><a className="secondary-button" href={selected.sourceUrl} target="_blank" rel="noreferrer">Abrir ficha oficial ↗</a><button type="button" className="secondary-button" onClick={() => setSelected(null)}>Cerrar</button></div>
    </section></div>}
  </main>;
}
