"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Customer = { id: string; legal_name: string; trade_name: string | null; tax_id: string | null };
type Opportunity = { id: string; title: string; source: string | null };
type TenderItem = { line: number | null; productCode: string | null; category: string | null; product: string; description: string | null; unit: string | null; quantity: number | null };
type Tender = {
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
  buyer: { code: string | null; name: string | null; taxId: string | null; unitCode: string | null; unitName: string | null; address: string | null; commune: string | null; region: string | null; contactName: string | null; contactRole: string | null };
  dates: { questionsUntil: string | null; answersPublishedAt: string | null; technicalOpeningAt: string | null; awardAt: string | null; estimatedSignatureAt: string | null };
  paymentContact: { name: string | null; email: string | null };
  contractContact: { name: string | null; email: string | null; phone: string | null };
  items: TenderItem[];
};
type SearchPayload = { tenders: Tender[]; counts: { source: number; matched: number; returned: number }; fetchedAt: string; ticketMode: "organization" | "documentation"; source: { name: string; url: string } };
type CommercialPayload = { customers: Customer[]; opportunities: Opportunity[] };
type Filters = { keyword: string; code: string; state: string; date: string; buyerCode: string; limit: string };

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

function normalize(value: string | null | undefined) {
  return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function customerName(customer: Customer) {
  return customer.trade_name || customer.legal_name;
}

function nextActionDate(closeAt: string | null) {
  if (!closeAt) return "";
  const date = new Date(closeAt);
  date.setDate(date.getDate() - 2);
  return date.toISOString().slice(0, 10);
}

export function PublicMarketCrm({ organizationId, canManage }: { organizationId: string | null; canManage: boolean }) {
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [results, setResults] = useState<SearchPayload | null>(null);
  const [commercial, setCommercial] = useState<CommercialPayload>({ customers: [], opportunities: [] });
  const [selected, setSelected] = useState<Tender | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function loadCommercial() {
    if (!organizationId) return;
    const response = await fetch(`/api/commercial-control?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as CommercialPayload | null;
    if (response.ok && payload) setCommercial({ customers: payload.customers ?? [], opportunities: payload.opportunities ?? [] });
  }

  async function runSearch(nextFilters: Filters = filters) {
    if (!organizationId) return;
    if (nextFilters.buyerCode && !nextFilters.date) { setMessage("Para filtrar por organismo, selecciona también la fecha de publicación exigida por la API oficial."); return; }
    setLoading(true); setMessage("");
    const params = new URLSearchParams({ organizationId, keyword: nextFilters.keyword, code: nextFilters.code, state: nextFilters.state, date: nextFilters.date, buyerCode: nextFilters.buyerCode, limit: nextFilters.limit });
    const response = await fetch(`/api/mercado-publico?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as SearchPayload | { error?: string } | null;
    setLoading(false);
    if (!response.ok || !payload || !("tenders" in payload)) {
      setResults(null);
      setMessage(response.status === 503 || response.status === 502 ? "Mercado Público no respondió a tiempo. Intenta nuevamente en unos minutos." : "No fue posible ejecutar la búsqueda. Revisa los parámetros ingresados.");
      return;
    }
    setResults(payload);
    if (!payload.tenders.length) setMessage("No se encontraron licitaciones para esos parámetros.");
  }

  useEffect(() => {
    if (!organizationId) return;
    void Promise.all([runSearch(defaultFilters), loadCommercial()]);
  }, [organizationId]);

  const closingSoon = useMemo(() => {
    const inSevenDays = Date.now() + 7 * 86_400_000;
    return (results?.tenders ?? []).filter((item) => item.closeAt && new Date(item.closeAt).getTime() >= Date.now() && new Date(item.closeAt).getTime() <= inSevenDays).length;
  }, [results]);
  const published = (results?.tenders ?? []).filter((item) => item.status.toLowerCase() === "publicada").length;
  const alreadyInPipeline = selected ? commercial.opportunities.find((item) => item.source?.includes(selected.code)) : undefined;

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    void runSearch();
  }

  async function openTender(tender: Tender) {
    if (!organizationId) return;
    setSelected(null); setDetailLoading(true); setMessage("");
    const params = new URLSearchParams({ organizationId, mode: "detail", code: tender.code });
    const response = await fetch(`/api/mercado-publico?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as { tender?: Tender } | null;
    setDetailLoading(false);
    if (!response.ok || !payload?.tender) { setMessage("No fue posible abrir la ficha completa de la licitación."); return; }
    const detail = payload.tender;
    const buyerTaxId = normalize(detail.buyer.taxId);
    const buyerName = normalize(detail.buyer.name);
    const match = commercial.customers.find((customer) => (buyerTaxId && normalize(customer.tax_id) === buyerTaxId) || (buyerName && normalize(customer.legal_name) === buyerName));
    setSelectedCustomerId(match?.id ?? "");
    setSelected(detail);
  }

  async function createBuyerCustomer() {
    if (!organizationId || !selected?.buyer.name || !canManage) return;
    setSaving(true); setMessage("");
    const response = await fetch("/api/customer-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "save_profile",
        organizationId,
        profile: { legalName: selected.buyer.name, tradeName: selected.buyer.unitName, taxId: selected.buyer.taxId, businessActivity: "Organismo comprador · Mercado Público", addressLine1: selected.buyer.address, commune: selected.buyer.commune, city: selected.buyer.region, website: "https://www.mercadopublico.cl", email: null, phone: null, paymentTermDays: null, billingEmail: null, billingPhone: null, legalRepresentativeName: null, legalRepresentativeTaxId: null, legalRepresentativeAddress: null, legalRepresentativePhone: null, legalRepresentativeEmail: null, isActive: true },
        contacts: selected.buyer.contactName ? [{ contactArea: "commercial", jobTitle: selected.buyer.contactRole, fullName: selected.buyer.contactName, phone: null, email: null, isPrimary: true }] : [],
      }),
    });
    const payload = await response.json().catch(() => null) as { id?: string } | null;
    setSaving(false);
    if (!response.ok || !payload?.id) { setMessage("No fue posible crear la ficha del organismo. Puede que ya exista con otro nombre o RUT."); return; }
    await loadCommercial(); setSelectedCustomerId(payload.id); setMessage("Organismo incorporado al maestro de clientes y seleccionado para esta oportunidad.");
  }

  async function createOpportunity() {
    if (!organizationId || !selected || !selectedCustomerId || !canManage) return;
    setSaving(true); setMessage("");
    const closeOn = selected.closeAt?.slice(0, 10) ?? "";
    const description = [`Licitación ${selected.code} de ${selected.buyer.name || "organismo no informado"}.`, selected.description, `Fuente oficial: ${selected.sourceUrl}`].filter(Boolean).join("\n\n").slice(0, 4000);
    const response = await fetch("/api/commercial-control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save_opportunity", organizationId, record: { counterpartyId: selectedCustomerId, title: `${selected.code} · ${selected.name}`.slice(0, 250), stage: "qualified", expectedAmount: selected.visibleAmount ? selected.estimatedAmount ?? 0 : 0, currencyCode: ["CLP", "UF", "USD"].includes(selected.currency) ? selected.currency : "CLP", probability: 25, expectedCloseOn: closeOn, nextActionOn: nextActionDate(selected.closeAt), source: `Mercado Público · ${selected.code}`.slice(0, 120), lostReason: null, description } }),
    });
    setSaving(false);
    if (!response.ok) { setMessage("No fue posible crear la oportunidad. Revisa el cliente asociado y las fechas de la licitación."); return; }
    await loadCommercial(); setMessage(`La licitación ${selected.code} quedó en Oportunidades como calificada, con cierre y próxima acción trazables.`);
  }

  return <main className="dashboard public-market-crm">
    <section className="headline"><div><span className="eyebrow">CRM · MERCADO PÚBLICO</span><h1>Licitaciones y oportunidades públicas</h1><p>Consulta la API oficial de ChileCompra y convierte procesos relevantes en oportunidades del pipeline comercial.</p></div><a className="secondary-button" href="https://www.chilecompra.cl/api/" target="_blank" rel="noreferrer">Documentación oficial</a></section>
    <section className="kpis public-market-kpis"><article className="kpi-card accent"><span>Coincidencias</span><strong>{results ? integer.format(results.counts.matched) : "—"}</strong><small>Según los parámetros aplicados</small></article><article className="kpi-card"><span>Cierran en 7 días</span><strong className={closingSoon ? "is-negative" : ""}>{closingSoon}</strong><small>Dentro de los resultados visibles</small></article><article className="kpi-card"><span>Publicadas</span><strong>{published}</strong><small>Procesos actualmente abiertos</small></article><article className="kpi-card"><span>En pipeline</span><strong>{commercial.opportunities.filter((item) => item.source?.startsWith("Mercado Público")).length}</strong><small>Oportunidades originadas aquí</small></article></section>
    <section className="panel public-market-search"><div className="panel-heading"><div><span className="panel-label">BÚSQUEDA PARAMETRIZADA</span><h2>Explorar licitaciones</h2><p>Código exacto, estado y fecha se consultan en ChileCompra; la palabra clave filtra código y nombre en la respuesta oficial.</p></div></div><form onSubmit={submitSearch} className="public-market-filter-grid"><label>Palabra clave<input value={filters.keyword} onChange={(event) => setFilters({ ...filters, keyword: event.target.value })} maxLength={120} placeholder="Ej. contact center, soporte, seguridad" /></label><label>Código de licitación<input value={filters.code} onChange={(event) => setFilters({ ...filters, code: event.target.value.toUpperCase() })} maxLength={40} placeholder="Ej. 1234-56-LE26" /></label><label>Estado<select value={filters.state} onChange={(event) => setFilters({ ...filters, state: event.target.value })}><option value="activas">Activas</option><option value="todos">Todos</option><option value="publicada">Publicadas</option><option value="cerrada">Cerradas</option><option value="adjudicada">Adjudicadas</option><option value="desierta">Desiertas</option><option value="revocada">Revocadas</option><option value="suspendida">Suspendidas</option></select></label><label>Fecha de publicación<input type="date" value={filters.date} onChange={(event) => setFilters({ ...filters, date: event.target.value })} /></label><label>Código organismo<input inputMode="numeric" value={filters.buyerCode} onChange={(event) => setFilters({ ...filters, buyerCode: event.target.value.replace(/\D/g, "") })} placeholder="Requiere fecha" /></label><label>Máximo<select value={filters.limit} onChange={(event) => setFilters({ ...filters, limit: event.target.value })}><option value="25">25 resultados</option><option value="50">50 resultados</option><option value="100">100 resultados</option></select></label><div className="public-market-filter-actions"><button type="button" className="secondary-button" onClick={() => { setFilters(defaultFilters); void runSearch(defaultFilters); }}>Limpiar</button><button type="submit" className="primary-button" disabled={loading}>{loading ? "Consultando…" : "Buscar licitaciones"}</button></div></form></section>
    {message && <p className="operation-message">{message}</p>}
    <section className="table-section public-market-results"><div className="table-heading"><div><span className="panel-label">RESULTADOS OFICIALES</span><h2>{results ? `${integer.format(results.counts.returned)} de ${integer.format(results.counts.matched)} coincidencia(s)` : "Esperando consulta"}</h2><p>{results ? `Fuente: ${results.source.name} · actualización ${formatDate(results.fetchedAt, true)}` : "Los resultados se obtienen en tiempo real desde ChileCompra."}</p></div>{results?.counts.source !== undefined && <span className="status neutral">{integer.format(results.counts.source)} en respuesta fuente</span>}</div><div className="table-scroll"><table><thead><tr><th>Código / licitación</th><th>Estado</th><th>Cierre</th><th>Acción</th></tr></thead><tbody>{(results?.tenders ?? []).map((tender) => <tr key={tender.code}><td><strong>{tender.code}</strong><small>{tender.name}</small></td><td><span className={`status ${tender.status.toLowerCase() === "publicada" ? "paid" : tender.status.toLowerCase() === "suspendida" ? "cancelled" : "pending"}`}>{tender.status}</span></td><td>{formatDate(tender.closeAt, true)}</td><td><button type="button" className="text-button" onClick={() => void openTender(tender)}>Ver ficha y gestionar</button></td></tr>)}{!loading && !results?.tenders.length && <tr><td colSpan={4}>Sin licitaciones para mostrar.</td></tr>}</tbody></table></div></section>
    {detailLoading && <div className="modal-backdrop public-market-backdrop" role="presentation"><section className="entry-modal public-market-modal"><p className="billing-empty">Cargando ficha completa desde Mercado Público…</p></section></div>}
    {selected && <div className="modal-backdrop public-market-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setSelected(null); }}><section className="entry-modal public-market-modal" role="dialog" aria-modal="true" aria-labelledby="public-tender-title"><div className="modal-header"><div><span className="eyebrow">{selected.code} · {selected.status}</span><h2 id="public-tender-title">{selected.name}</h2><p>{selected.buyer.name || "Organismo no informado"} · cierre {formatDate(selected.closeAt, true)}</p></div><button className="close-button" type="button" onClick={() => setSelected(null)} aria-label="Cerrar">×</button></div><div className="public-market-detail-summary"><span><small>Monto estimado</small><strong>{amount(selected)}</strong></span><span><small>Tipo / moneda</small><strong>{selected.type || "—"} · {selected.currency}</strong></span><span><small>Región</small><strong>{selected.buyer.region || "Sin informar"}</strong></span><span><small>Ítems</small><strong>{selected.items.length}</strong></span></div><section className="public-market-detail-grid"><article><span className="panel-label">OBJETO DE LA CONTRATACIÓN</span><p>{selected.description || "Sin descripción adicional."}</p><dl><div><dt>Publicación</dt><dd>{formatDate(selected.publishedAt, true)}</dd></div><div><dt>Preguntas hasta</dt><dd>{formatDate(selected.dates.questionsUntil, true)}</dd></div><div><dt>Respuestas</dt><dd>{formatDate(selected.dates.answersPublishedAt, true)}</dd></div><div><dt>Adjudicación estimada</dt><dd>{formatDate(selected.dates.awardAt, true)}</dd></div><div><dt>Fuente de financiamiento</dt><dd>{selected.fundingSource || "Sin informar"}</dd></div></dl></article><article><span className="panel-label">ORGANISMO COMPRADOR</span><h3>{selected.buyer.unitName || selected.buyer.name || "Sin informar"}</h3><p>{[selected.buyer.taxId, selected.buyer.address, selected.buyer.commune].filter(Boolean).join(" · ") || "Sin antecedentes de ubicación."}</p><dl><div><dt>Código organismo</dt><dd>{selected.buyer.code || "—"}</dd></div><div><dt>Contacto</dt><dd>{[selected.buyer.contactName, selected.buyer.contactRole].filter(Boolean).join(" · ") || "Sin informar"}</dd></div><div><dt>Responsable contrato</dt><dd>{[selected.contractContact.name, selected.contractContact.email, selected.contractContact.phone].filter(Boolean).join(" · ") || "Sin informar"}</dd></div></dl></article></section><section className="public-market-items"><div><span className="panel-label">PRODUCTOS Y SERVICIOS</span><h3>{selected.items.length} línea(s) informada(s)</h3></div><div className="table-scroll"><table><thead><tr><th>Producto / servicio</th><th>Categoría</th><th>Cantidad</th></tr></thead><tbody>{selected.items.map((item, index) => <tr key={`${item.line}-${item.productCode}-${index}`}><td><strong>{item.product}</strong><small>{item.description || item.productCode || "Sin detalle"}</small></td><td>{item.category || "Sin categoría"}</td><td>{item.quantity === null ? "—" : `${integer.format(item.quantity)} ${item.unit || ""}`}</td></tr>)}</tbody></table></div></section><section className="public-market-crm-link"><div><span className="panel-label">CONEXIÓN CON EL PIPELINE</span><h3>{alreadyInPipeline ? "Esta licitación ya está en oportunidades" : "Convertir en oportunidad CRM"}</h3><p>Se conserva el código, fuente oficial, monto, cierre, organismo y detalle de la contratación.</p></div>{alreadyInPipeline ? <span className="status paid">{alreadyInPipeline.title}</span> : <div className="public-market-customer-link"><label>Cliente / organismo<select value={selectedCustomerId} onChange={(event) => setSelectedCustomerId(event.target.value)}><option value="">Selecciona una ficha existente</option>{commercial.customers.map((customer) => <option key={customer.id} value={customer.id}>{customerName(customer)}{customer.tax_id ? ` · ${customer.tax_id}` : ""}</option>)}</select></label>{canManage && selected.buyer.name && !selectedCustomerId && <button type="button" className="secondary-button" disabled={saving} onClick={() => void createBuyerCustomer()}>Crear organismo como cliente</button>}{canManage && <button type="button" className="primary-button" disabled={saving || !selectedCustomerId} onClick={() => void createOpportunity()}>{saving ? "Guardando…" : "Crear oportunidad"}</button>}</div>}</section><div className="form-actions"><a className="secondary-button" href={selected.sourceUrl} target="_blank" rel="noreferrer">Abrir ficha oficial ↗</a><button type="button" className="secondary-button" onClick={() => setSelected(null)}>Cerrar</button></div></section></div>}
  </main>;
}
