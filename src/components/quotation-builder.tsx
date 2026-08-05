"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import { calculateQuote, salePriceFromMargin, type QuoteBillingPeriod, type QuoteLine } from "@/lib/quotation";

type Customer = { id: string; legal_name: string; trade_name: string | null; tax_id: string | null };
type CatalogItem = { id: string; name: string; category: string; unit_name: string; billing_period: QuoteBillingPeriod; default_unit_cost: number | string; default_margin_percent: number | string; is_active: boolean };
type StoredQuote = { id: string; counterparty_id: string | null; quote_number: string; title: string; status: QuoteStatus; currency_code: Currency; valid_until: string | null; term_months: number; notes: string | null; items: QuoteLine[]; one_time_cost: number | string; one_time_sale: number | string; monthly_cost: number | string; monthly_sale: number | string; contract_value: number | string; gross_profit: number | string; updated_at: string };
type QuoteStatus = "draft" | "sent" | "accepted" | "rejected" | "expired";
type Currency = "CLP" | "UF" | "USD";
type View = "builder" | "history" | "catalog";
type Draft = { id: string | null; quoteNumber: string | null; counterpartyId: string; title: string; status: QuoteStatus; currencyCode: Currency; validUntil: string; termMonths: number; notes: string; items: QuoteLine[] };
type CatalogDraft = { id: string | null; name: string; category: string; unitName: string; billingPeriod: QuoteBillingPeriod; defaultUnitCost: string; defaultMarginPercent: string; isActive: boolean };
type Payload = { customers: Customer[]; catalog: CatalogItem[]; quotes: StoredQuote[] };

const categories = [
  ["saas", "Licencias SaaS"],
  ["infrastructure", "Infraestructura"],
  ["ai", "Inteligencia artificial"],
  ["professional_service", "Setup y consultoría"],
  ["profile", "Perfiles / célula"],
  ["bpo", "BPO"],
  ["other", "Otro"],
] as const;
const categoryLabel = Object.fromEntries(categories) as Record<string, string>;
const statusLabel: Record<QuoteStatus, string> = { draft: "Borrador", sent: "Enviada", accepted: "Aceptada", rejected: "Rechazada", expired: "Vencida" };
const statusTone: Record<QuoteStatus, string> = { draft: "neutral", sent: "info", accepted: "paid", rejected: "danger", expired: "warning" };

function futureDate(days: number) {
  const value = new Date();
  value.setDate(value.getDate() + days);
  return value.toISOString().slice(0, 10);
}

function blankQuote(): Draft {
  return { id: null, quoteNumber: null, counterpartyId: "", title: "", status: "draft", currencyCode: "CLP", validUntil: futureDate(30), termMonths: 12, notes: "", items: [] };
}

function blankCatalog(): CatalogDraft {
  return { id: null, name: "", category: "saas", unitName: "licencia", billingPeriod: "monthly", defaultUnitCost: "0", defaultMarginPercent: "35", isActive: true };
}

function asNumber(value: number | string) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function money(value: number, currency: Currency) {
  if (currency === "UF") return `UF ${new Intl.NumberFormat("es-CL", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value)}`;
  return new Intl.NumberFormat("es-CL", { style: "currency", currency, maximumFractionDigits: currency === "CLP" ? 0 : 2 }).format(value);
}

function quoteFromStored(quote: StoredQuote): Draft {
  return {
    id: quote.id,
    quoteNumber: quote.quote_number,
    counterpartyId: quote.counterparty_id ?? "",
    title: quote.title,
    status: quote.status,
    currencyCode: quote.currency_code,
    validUntil: quote.valid_until ?? "",
    termMonths: Number(quote.term_months),
    notes: quote.notes ?? "",
    items: Array.isArray(quote.items) ? quote.items.map((item) => ({ ...item, quantity: asNumber(item.quantity), unitCost: asNumber(item.unitCost), marginPercent: asNumber(item.marginPercent) })) : [],
  };
}

export function QuotationBuilder({ organizationId, canManage }: { organizationId: string | null; canManage: boolean }) {
  const [view, setView] = useState<View>("builder");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [quotes, setQuotes] = useState<StoredQuote[]>([]);
  const [draft, setDraft] = useState<Draft>(blankQuote);
  const [selectedCatalogId, setSelectedCatalogId] = useState("");
  const [catalogDraft, setCatalogDraft] = useState<CatalogDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const load = async () => {
    if (!organizationId) return;
    setLoading(true);
    const response = await fetch(`/api/quotations?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as Payload | null;
    if (response.ok && payload) {
      setCustomers(payload.customers ?? []);
      setCatalog(payload.catalog ?? []);
      setQuotes(payload.quotes ?? []);
      setSelectedCatalogId((current) => current || payload.catalog?.find((item) => item.is_active)?.id || "");
    } else setMessage("No fue posible cargar el cotizador. La migración de base de datos puede estar pendiente.");
    setLoading(false);
  };

  useEffect(() => { void load(); }, [organizationId]);

  const totals = useMemo(() => {
    try { return calculateQuote(draft.items, draft.termMonths); }
    catch { return { costOneTime: 0, saleOneTime: 0, costMonthly: 0, saleMonthly: 0, contractCost: 0, contractValue: 0, grossProfit: 0, grossMarginPercent: 0 }; }
  }, [draft.items, draft.termMonths]);

  const activeCatalog = catalog.filter((item) => item.is_active);
  const selectedCustomer = customers.find((customer) => customer.id === draft.counterpartyId);

  const addCatalogLine = () => {
    const item = catalog.find((candidate) => candidate.id === selectedCatalogId);
    if (!item) return;
    setDraft((current) => ({ ...current, items: [...current.items, { id: crypto.randomUUID(), catalogItemId: item.id, name: item.name, category: item.category, unitName: item.unit_name, billingPeriod: item.billing_period, quantity: 1, unitCost: asNumber(item.default_unit_cost), marginPercent: asNumber(item.default_margin_percent) }] }));
  };

  const addCustomLine = () => setDraft((current) => ({ ...current, items: [...current.items, { id: crypto.randomUUID(), catalogItemId: null, name: "Servicio personalizado", category: "other", unitName: "unidad", billingPeriod: "monthly", quantity: 1, unitCost: 0, marginPercent: 35 }] }));

  const updateLine = (id: string, changes: Partial<QuoteLine>) => setDraft((current) => ({ ...current, items: current.items.map((item) => item.id === id ? { ...item, ...changes } : item) }));
  const removeLine = (id: string) => setDraft((current) => ({ ...current, items: current.items.filter((item) => item.id !== id) }));

  const saveQuote = async () => {
    if (!organizationId || !canManage) return;
    if (!draft.title.trim()) return setMessage("Ponle un nombre a la cotización.");
    if (!draft.items.length) return setMessage("Agrega al menos un producto, servicio o perfil.");
    setSaving(true); setMessage("");
    const response = await fetch("/api/quotations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_quote", organizationId, quote: draft }) });
    const payload = await response.json().catch(() => null) as { id?: string; quoteNumber?: string } | null;
    setSaving(false);
    if (!response.ok || !payload?.id) return setMessage("No fue posible guardar. Revisa costos, cantidades y que el margen sea menor a 100%.");
    setDraft((current) => ({ ...current, id: payload.id ?? current.id, quoteNumber: payload.quoteNumber ?? current.quoteNumber }));
    setMessage(`Cotización ${payload.quoteNumber ?? ""} guardada.`);
    await load();
  };

  const saveCatalog = async (event: FormEvent) => {
    event.preventDefault();
    if (!organizationId || !catalogDraft || !canManage) return;
    setSaving(true); setMessage("");
    const response = await fetch("/api/quotations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_catalog_item", organizationId, item: catalogDraft }) });
    setSaving(false);
    if (!response.ok) return setMessage("No fue posible guardar el costo base. Verifica el nombre, costo y margen.");
    setCatalogDraft(null); setMessage("Costo base guardado en el catálogo."); await load();
  };

  const deleteQuote = async (quote: StoredQuote) => {
    if (!organizationId || !canManage || !window.confirm(`¿Eliminar ${quote.quote_number}?`)) return;
    const response = await fetch("/api/quotations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete_quote", organizationId, quoteId: quote.id }) });
    if (!response.ok) return setMessage("No fue posible eliminar la cotización.");
    if (draft.id === quote.id) setDraft(blankQuote());
    setMessage("Cotización eliminada."); await load();
  };

  if (loading) return <main className="dashboard quotation-workspace"><p className="billing-empty">Cargando cotizador…</p></main>;

  return <main className="dashboard quotation-workspace">
    <section className="headline quotation-headline">
      <div><span className="eyebrow">RENTABILIDAD COMERCIAL</span><h1>Cotizador de soluciones</h1><p>Combina SaaS, BPO, infraestructura, IA, discovery, setup y perfiles con costos reales y margen de venta.</p></div>
      <div className="headline-actions"><button type="button" className="secondary-button" onClick={() => { setDraft(blankQuote()); setView("builder"); setMessage(""); }} disabled={!canManage}>Nueva cotización</button><button type="button" className="primary-button" onClick={() => void saveQuote()} disabled={!canManage || saving || view !== "builder"}>{saving ? "Guardando…" : "Guardar cotización"}</button></div>
    </section>

    <div className="quotation-tabs" role="tablist">
      <button type="button" className={view === "builder" ? "active" : ""} onClick={() => setView("builder")}>Cotizador</button>
      <button type="button" className={view === "history" ? "active" : ""} onClick={() => setView("history")}>Cotizaciones <span>{quotes.length}</span></button>
      <button type="button" className={view === "catalog" ? "active" : ""} onClick={() => setView("catalog")}>Catálogo de costos <span>{catalog.length}</span></button>
    </div>
    {message && <p className="operation-message">{message}</p>}
    {!canManage && <p className="permission-note">Tu perfil puede revisar costos y cotizaciones, pero no modificarlos.</p>}

    {view === "builder" && <>
      <section className="panel quote-meta-panel">
        <div className="panel-heading"><div><span className="panel-label">DATOS COMERCIALES</span><h2>{draft.quoteNumber ? `${draft.quoteNumber} · ${draft.title || "Sin nombre"}` : "Nueva cotización"}</h2></div><span className={`status ${statusTone[draft.status]}`}>{statusLabel[draft.status]}</span></div>
        <div className="quote-meta-grid">
          <label>Nombre de la propuesta *<input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder="Ej. Célula digital + Atlas CRM" disabled={!canManage} /></label>
          <label>Cliente<select value={draft.counterpartyId} onChange={(event) => setDraft((current) => ({ ...current, counterpartyId: event.target.value }))} disabled={!canManage}><option value="">Prospecto por definir</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.trade_name || customer.legal_name}</option>)}</select></label>
          <label>Moneda<select value={draft.currencyCode} onChange={(event) => setDraft((current) => ({ ...current, currencyCode: event.target.value as Currency }))} disabled={!canManage}><option value="CLP">CLP</option><option value="UF">UF</option><option value="USD">USD</option></select></label>
          <label>Horizonte del contrato<input type="number" min="1" max="120" value={draft.termMonths} onChange={(event) => setDraft((current) => ({ ...current, termMonths: Math.max(1, Math.min(120, Number(event.target.value) || 1)) }))} disabled={!canManage} /><small>meses para calcular el valor total</small></label>
          <label>Válida hasta<input type="date" value={draft.validUntil} onChange={(event) => setDraft((current) => ({ ...current, validUntil: event.target.value }))} disabled={!canManage} /></label>
          <label>Estado<select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as QuoteStatus }))} disabled={!canManage}>{Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>
      </section>

      <section className="quote-layout">
        <div className="quote-main-column">
          <section className="panel quote-add-panel">
            <div><span className="panel-label">AGREGAR COMPONENTE</span><h2>Construye la solución</h2></div>
            <div className="quote-add-controls"><select value={selectedCatalogId} onChange={(event) => setSelectedCatalogId(event.target.value)} disabled={!canManage}>{categories.map(([key, label]) => <optgroup key={key} label={label}>{activeCatalog.filter((item) => item.category === key).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>)}</select><button type="button" className="primary-button" onClick={addCatalogLine} disabled={!canManage || !selectedCatalogId}>Agregar</button><button type="button" className="secondary-button" onClick={addCustomLine} disabled={!canManage}>Línea personalizada</button></div>
          </section>

          <section className="panel quote-lines-panel">
            <div className="panel-heading"><div><span className="panel-label">ESTRUCTURA DE COSTOS</span><h2>{draft.items.length} componente{draft.items.length === 1 ? "" : "s"}</h2></div><span className="unit">Venta = costo ÷ (1 − margen)</span></div>
            {!draft.items.length ? <div className="quote-empty"><strong>Empieza agregando un componente</strong><span>Puedes mezclar setup único, licencias mensuales, infraestructura, consumo de IA y horas de perfiles.</span></div> : <div className="quote-line-list">{draft.items.map((line) => {
              const lineSale = salePriceFromMargin(line.unitCost, Math.min(line.marginPercent, 99.99)) * line.quantity;
              const lineCost = line.unitCost * line.quantity;
              return <article className="quote-line-card" key={line.id}>
                <div className="quote-line-top"><div><span className="quote-category">{categoryLabel[line.category] ?? "Otro"}</span><input className="quote-line-name" value={line.name} onChange={(event) => updateLine(line.id, { name: event.target.value })} disabled={!canManage} /></div><button type="button" className="quote-remove" onClick={() => removeLine(line.id)} disabled={!canManage} aria-label={`Quitar ${line.name}`}>×</button></div>
                <div className="quote-line-fields">
                  <label>Cobro<select value={line.billingPeriod} onChange={(event) => updateLine(line.id, { billingPeriod: event.target.value as QuoteBillingPeriod })} disabled={!canManage}><option value="one_time">Una vez</option><option value="monthly">Mensual</option></select></label>
                  <label>Cantidad<input type="number" min="0.01" step="0.01" value={line.quantity} onChange={(event) => updateLine(line.id, { quantity: Math.max(0, Number(event.target.value)) })} disabled={!canManage} /></label>
                  <label>Unidad<input value={line.unitName} onChange={(event) => updateLine(line.id, { unitName: event.target.value })} disabled={!canManage} /></label>
                  <label>Costo unitario<input type="number" min="0" step={draft.currencyCode === "CLP" ? "1" : "0.01"} value={line.unitCost} onChange={(event) => updateLine(line.id, { unitCost: Math.max(0, Number(event.target.value)) })} disabled={!canManage} /></label>
                  <label>Margen %<input type="number" min="0" max="99.99" step="0.1" value={line.marginPercent} onChange={(event) => updateLine(line.id, { marginPercent: Math.max(0, Math.min(99.99, Number(event.target.value))) })} disabled={!canManage} /></label>
                </div>
                <div className="quote-line-result"><span>Costo <b>{money(lineCost, draft.currencyCode)}</b></span><span>Venta <strong>{money(lineSale, draft.currencyCode)}</strong></span><small>{line.billingPeriod === "monthly" ? "por mes" : "pago único"}</small></div>
              </article>;
            })}</div>}
          </section>

          <section className="panel quote-notes-panel"><label>Alcance, supuestos y observaciones<textarea value={draft.notes} maxLength={4000} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} placeholder="Incluye supuestos de consumo, horas, exclusiones y condiciones comerciales…" disabled={!canManage} /></label></section>
        </div>

        <aside className="quote-summary-card">
          <span className="panel-label">RESUMEN DE VENTA</span><h2>{selectedCustomer ? selectedCustomer.trade_name || selectedCustomer.legal_name : "Propuesta sin cliente"}</h2>
          <div className="quote-summary-section"><span>Implementación / una vez</span><div><small>Costo</small><b>{money(totals.costOneTime, draft.currencyCode)}</b></div><div className="sale"><small>Venta</small><strong>{money(totals.saleOneTime, draft.currencyCode)}</strong></div></div>
          <div className="quote-summary-section"><span>Operación mensual</span><div><small>Costo</small><b>{money(totals.costMonthly, draft.currencyCode)}</b></div><div className="sale"><small>Venta</small><strong>{money(totals.saleMonthly, draft.currencyCode)}</strong></div></div>
          <div className="quote-contract-total"><span>Valor contrato · {draft.termMonths} meses</span><strong>{money(totals.contractValue, draft.currencyCode)}</strong><small>Costo total {money(totals.contractCost, draft.currencyCode)}</small></div>
          <div className="quote-profit"><div><span>Utilidad bruta</span><strong>{money(totals.grossProfit, draft.currencyCode)}</strong></div><b>{new Intl.NumberFormat("es-CL", { maximumFractionDigits: 1 }).format(totals.grossMarginPercent)}% margen</b></div>
        </aside>
      </section>
    </>}

    {view === "history" && <section className="panel quote-history-panel"><div className="panel-heading"><div><span className="panel-label">HISTORIAL</span><h2>Cotizaciones guardadas</h2><p>Abre una cotización para ajustar costos, alcance o margen.</p></div></div>{!quotes.length ? <p className="billing-empty">Todavía no hay cotizaciones guardadas.</p> : <div className="table-scroll"><table><thead><tr><th>Número</th><th>Propuesta / cliente</th><th>Estado</th><th>Setup</th><th>Mensual</th><th>Contrato</th><th>Utilidad</th><th /></tr></thead><tbody>{quotes.map((quote) => { const customer = customers.find((item) => item.id === quote.counterparty_id); return <tr key={quote.id}><td><strong>{quote.quote_number}</strong><small>{new Date(quote.updated_at).toLocaleDateString("es-CL")}</small></td><td><strong>{quote.title}</strong><small>{customer ? customer.trade_name || customer.legal_name : "Sin cliente"}</small></td><td><span className={`status ${statusTone[quote.status]}`}>{statusLabel[quote.status]}</span></td><td>{money(asNumber(quote.one_time_sale), quote.currency_code)}</td><td>{money(asNumber(quote.monthly_sale), quote.currency_code)}</td><td><strong>{money(asNumber(quote.contract_value), quote.currency_code)}</strong></td><td>{money(asNumber(quote.gross_profit), quote.currency_code)}</td><td><div className="member-actions"><button type="button" className="text-button" onClick={() => { setDraft(quoteFromStored(quote)); setView("builder"); setMessage(""); }}>Abrir</button>{canManage && <button type="button" className="text-button" onClick={() => void deleteQuote(quote)}>Eliminar</button>}</div></td></tr>; })}</tbody></table></div>}</section>}

    {view === "catalog" && <section className="panel quote-catalog-panel"><div className="panel-heading"><div><span className="panel-label">COSTOS REUTILIZABLES</span><h2>Catálogo de productos y recursos</h2><p>Deja configurados tus costos y márgenes base. Siempre podrás ajustarlos dentro de cada cotización.</p></div>{canManage && <button type="button" className="primary-button" onClick={() => setCatalogDraft(blankCatalog())}>Agregar costo</button>}</div><div className="quote-catalog-grid">{catalog.map((item) => <article key={item.id} className={!item.is_active ? "inactive" : ""}><div><span className="quote-category">{categoryLabel[item.category] ?? "Otro"}</span><h3>{item.name}</h3><small>{item.billing_period === "monthly" ? "Mensual" : "Una vez"} · por {item.unit_name}</small></div><div><span>Costo base</span><strong>{new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(asNumber(item.default_unit_cost))}</strong><small>Margen {asNumber(item.default_margin_percent)}%</small></div>{canManage && <button type="button" className="secondary-button" onClick={() => setCatalogDraft({ id: item.id, name: item.name, category: item.category, unitName: item.unit_name, billingPeriod: item.billing_period, defaultUnitCost: String(item.default_unit_cost), defaultMarginPercent: String(item.default_margin_percent), isActive: item.is_active })}>Editar</button>}</article>)}</div></section>}

    {catalogDraft && <div className="modal-backdrop"><section className="entry-modal quote-catalog-modal" role="dialog" aria-modal="true" aria-labelledby="catalog-cost-title"><div className="modal-header"><div><span className="eyebrow">CATÁLOGO DE COSTOS</span><h2 id="catalog-cost-title">{catalogDraft.id ? "Editar componente" : "Nuevo componente"}</h2></div><button type="button" className="close-button" onClick={() => setCatalogDraft(null)} aria-label="Cerrar">×</button></div><form onSubmit={saveCatalog}><div className="form-grid"><label>Nombre *<input value={catalogDraft.name} onChange={(event) => setCatalogDraft((current) => current ? { ...current, name: event.target.value } : current)} required /></label><label>Categoría<select value={catalogDraft.category} onChange={(event) => setCatalogDraft((current) => current ? { ...current, category: event.target.value } : current)}>{categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Unidad<input value={catalogDraft.unitName} onChange={(event) => setCatalogDraft((current) => current ? { ...current, unitName: event.target.value } : current)} required /></label><label>Periodicidad<select value={catalogDraft.billingPeriod} onChange={(event) => setCatalogDraft((current) => current ? { ...current, billingPeriod: event.target.value as QuoteBillingPeriod } : current)}><option value="one_time">Una vez</option><option value="monthly">Mensual</option></select></label><label>Costo unitario<input type="number" min="0" step="0.01" value={catalogDraft.defaultUnitCost} onChange={(event) => setCatalogDraft((current) => current ? { ...current, defaultUnitCost: event.target.value } : current)} required /></label><label>Margen base %<input type="number" min="0" max="99.99" step="0.1" value={catalogDraft.defaultMarginPercent} onChange={(event) => setCatalogDraft((current) => current ? { ...current, defaultMarginPercent: event.target.value } : current)} required /></label><label>Estado<select value={catalogDraft.isActive ? "active" : "inactive"} onChange={(event) => setCatalogDraft((current) => current ? { ...current, isActive: event.target.value === "active" } : current)}><option value="active">Activo</option><option value="inactive">Inactivo</option></select></label></div><div className="form-actions"><button type="button" className="secondary-button" onClick={() => setCatalogDraft(null)}>Cancelar</button><button type="submit" className="primary-button" disabled={saving}>{saving ? "Guardando…" : "Guardar costo"}</button></div></form></section></div>}
  </main>;
}
