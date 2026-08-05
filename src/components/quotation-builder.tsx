"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import { calculateCatalogUnitCost, calculateQuote, salePriceFromMargin, type QuoteBillingPeriod, type QuoteCostBreakdown, type QuoteLine } from "@/lib/quotation";

type Customer = { id: string; legal_name: string; trade_name: string | null; tax_id: string | null };
type CatalogItem = { id: string; name: string; category: string; unit_name: string; billing_period: QuoteBillingPeriod; default_unit_cost: number | string; default_margin_percent: number | string; is_active: boolean; is_sellable: boolean; is_cost_component: boolean };
type CatalogCostComponent = { id: string; product_catalog_item_id: string; cost_catalog_item_id: string; quantity: number | string; unit_cost_override: number | string | null; notes: string | null };
type StoredQuote = { id: string; counterparty_id: string | null; quote_number: string; title: string; status: QuoteStatus; currency_code: Currency; valid_until: string | null; term_months: number; notes: string | null; items: QuoteLine[]; one_time_cost: number | string; one_time_sale: number | string; monthly_cost: number | string; monthly_sale: number | string; contract_value: number | string; gross_profit: number | string; updated_at: string };
type QuoteStatus = "draft" | "sent" | "accepted" | "rejected" | "expired";
type Currency = "CLP" | "UF" | "USD";
type View = "builder" | "history" | "catalog";
type Draft = { id: string | null; quoteNumber: string | null; counterpartyId: string; title: string; status: QuoteStatus; currencyCode: Currency; validUntil: string; termMonths: number; notes: string; items: QuoteLine[] };
type CatalogDraft = { id: string | null; name: string; category: string; unitName: string; billingPeriod: QuoteBillingPeriod; defaultUnitCost: string; defaultMarginPercent: string; isActive: boolean; isSellable: boolean; isCostComponent: boolean };
type CostModelDraftEntry = { rowId: string; catalogItemId: string; quantity: string; unitCostOverride: string };
type Payload = { customers: Customer[]; catalog: CatalogItem[]; costComponents: CatalogCostComponent[]; quotes: StoredQuote[] };

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
  return { id: null, name: "", category: "saas", unitName: "licencia", billingPeriod: "monthly", defaultUnitCost: "0", defaultMarginPercent: "35", isActive: true, isSellable: true, isCostComponent: false };
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
    items: Array.isArray(quote.items) ? quote.items.map((item) => ({ ...item, quantity: asNumber(item.quantity), unitCost: asNumber(item.unitCost), marginPercent: asNumber(item.marginPercent), costBreakdown: item.costBreakdown?.map((entry) => ({ ...entry, quantity: asNumber(entry.quantity), unitCost: asNumber(entry.unitCost) })) ?? [] })) : [],
  };
}

export function QuotationBuilder({ organizationId, canManage }: { organizationId: string | null; canManage: boolean }) {
  const [view, setView] = useState<View>("builder");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [costComponents, setCostComponents] = useState<CatalogCostComponent[]>([]);
  const [quotes, setQuotes] = useState<StoredQuote[]>([]);
  const [draft, setDraft] = useState<Draft>(blankQuote);
  const [selectedCatalogId, setSelectedCatalogId] = useState("");
  const [catalogDraft, setCatalogDraft] = useState<CatalogDraft | null>(null);
  const [costModelProductId, setCostModelProductId] = useState<string | null>(null);
  const [costModelDraft, setCostModelDraft] = useState<CostModelDraftEntry[]>([]);
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
      setCostComponents(payload.costComponents ?? []);
      setQuotes(payload.quotes ?? []);
      setSelectedCatalogId((current) => current || payload.catalog?.find((item) => item.is_active && item.is_sellable)?.id || "");
    } else setMessage("No fue posible cargar el cotizador. La migración de base de datos puede estar pendiente.");
    setLoading(false);
  };

  useEffect(() => { void load(); }, [organizationId]);

  const totals = useMemo(() => {
    try { return calculateQuote(draft.items, draft.termMonths); }
    catch { return { costOneTime: 0, saleOneTime: 0, costMonthly: 0, saleMonthly: 0, contractCost: 0, contractValue: 0, grossProfit: 0, grossMarginPercent: 0 }; }
  }, [draft.items, draft.termMonths]);

  const activeCatalog = catalog.filter((item) => item.is_active && item.is_sellable);
  const availableCostCatalog = catalog.filter((item) => item.is_active && item.is_cost_component);
  const selectedCustomer = customers.find((customer) => customer.id === draft.counterpartyId);

  const costBreakdownForProduct = (productId: string): QuoteCostBreakdown[] => costComponents
    .filter((entry) => entry.product_catalog_item_id === productId)
    .map((entry) => {
      const resource = catalog.find((item) => item.id === entry.cost_catalog_item_id);
      if (!resource) return null;
      return {
        catalogItemId: resource.id,
        name: resource.name,
        quantity: asNumber(entry.quantity),
        unitCost: entry.unit_cost_override === null ? asNumber(resource.default_unit_cost) : asNumber(entry.unit_cost_override),
      };
    })
    .filter((entry): entry is QuoteCostBreakdown => entry !== null);

  const catalogUnitCost = (item: CatalogItem) => calculateCatalogUnitCost(asNumber(item.default_unit_cost), costBreakdownForProduct(item.id));

  const addCatalogLine = () => {
    const item = catalog.find((candidate) => candidate.id === selectedCatalogId);
    if (!item) return;
    const costBreakdown = costBreakdownForProduct(item.id);
    setDraft((current) => ({ ...current, items: [...current.items, { id: crypto.randomUUID(), catalogItemId: item.id, name: item.name, category: item.category, unitName: item.unit_name, billingPeriod: item.billing_period, quantity: 1, unitCost: calculateCatalogUnitCost(asNumber(item.default_unit_cost), costBreakdown), marginPercent: asNumber(item.default_margin_percent), costBreakdown }] }));
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

  const openCostModel = (product: CatalogItem) => {
    setCostModelProductId(product.id);
    setCostModelDraft(costComponents.filter((entry) => entry.product_catalog_item_id === product.id).map((entry) => ({ rowId: entry.id, catalogItemId: entry.cost_catalog_item_id, quantity: String(entry.quantity), unitCostOverride: entry.unit_cost_override === null ? "" : String(entry.unit_cost_override) })));
    setMessage("");
  };

  const addCostModelRow = () => {
    const used = new Set(costModelDraft.map((entry) => entry.catalogItemId));
    const product = catalog.find((item) => item.id === costModelProductId);
    const resource = availableCostCatalog.find((item) => item.id !== costModelProductId && item.billing_period === product?.billing_period && !used.has(item.id));
    if (!resource) return setMessage("No quedan recursos de costo disponibles. Puedes crear otro en el catálogo.");
    setCostModelDraft((current) => [...current, { rowId: crypto.randomUUID(), catalogItemId: resource.id, quantity: "1", unitCostOverride: "" }]);
  };

  const updateCostModelRow = (rowId: string, changes: Partial<CostModelDraftEntry>) => setCostModelDraft((current) => current.map((entry) => entry.rowId === rowId ? { ...entry, ...changes } : entry));

  const saveCostModel = async () => {
    if (!organizationId || !costModelProductId || !canManage) return;
    if (new Set(costModelDraft.map((entry) => entry.catalogItemId)).size !== costModelDraft.length) return setMessage("Un recurso no puede repetirse dentro del mismo producto.");
    setSaving(true); setMessage("");
    const response = await fetch("/api/quotations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_cost_model", organizationId, parentCatalogItemId: costModelProductId, components: costModelDraft.map((entry) => ({ catalogItemId: entry.catalogItemId, quantity: Number(entry.quantity), unitCostOverride: entry.unitCostOverride.trim() === "" ? null : Number(entry.unitCostOverride) })) }) });
    setSaving(false);
    if (!response.ok) return setMessage("No fue posible guardar el modelo. Revisa cantidades, recursos repetidos y costos.");
    setCostModelProductId(null); setCostModelDraft([]); setMessage("Modelo de costo actualizado. Las próximas cotizaciones usarán este valor."); await load();
  };

  const deleteQuote = async (quote: StoredQuote) => {
    if (!organizationId || !canManage || !window.confirm(`¿Eliminar ${quote.quote_number}?`)) return;
    const response = await fetch("/api/quotations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete_quote", organizationId, quoteId: quote.id }) });
    if (!response.ok) return setMessage("No fue posible eliminar la cotización.");
    if (draft.id === quote.id) setDraft(blankQuote());
    setMessage("Cotización eliminada."); await load();
  };

  const costModelProduct = catalog.find((item) => item.id === costModelProductId);
  const costModelResourceTotal = costModelDraft.reduce((total, entry) => {
    const resource = catalog.find((item) => item.id === entry.catalogItemId);
    const effectiveCost = entry.unitCostOverride.trim() === "" ? asNumber(resource?.default_unit_cost ?? 0) : asNumber(entry.unitCostOverride);
    return total + asNumber(entry.quantity) * effectiveCost;
  }, 0);
  const costModelTotal = asNumber(costModelProduct?.default_unit_cost ?? 0) + costModelResourceTotal;

  if (loading) return <main className="dashboard quotation-workspace"><p className="billing-empty">Cargando cotizador…</p></main>;

  return <main className="dashboard quotation-workspace">
    <section className="headline quotation-headline">
      <div><span className="eyebrow">RENTABILIDAD COMERCIAL</span><h1>Cotizador de soluciones</h1><p>Cotiza productos y servicios usando su costo interno: hosting, IA, perfiles y otros recursos asociados.</p></div>
      <div className="headline-actions"><button type="button" className="secondary-button" onClick={() => { setDraft(blankQuote()); setView("builder"); setMessage(""); }} disabled={!canManage}>Nueva cotización</button><button type="button" className="primary-button" onClick={() => void saveQuote()} disabled={!canManage || saving || view !== "builder"}>{saving ? "Guardando…" : "Guardar cotización"}</button></div>
    </section>

    <div className="quotation-tabs" role="tablist">
      <button type="button" className={view === "builder" ? "active" : ""} onClick={() => setView("builder")}>Cotizador</button>
      <button type="button" className={view === "history" ? "active" : ""} onClick={() => setView("history")}>Cotizaciones <span>{quotes.length}</span></button>
      <button type="button" className={view === "catalog" ? "active" : ""} onClick={() => setView("catalog")}>Costeo de productos <span>{catalog.length}</span></button>
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
            <div><span className="panel-label">AGREGAR PRODUCTO VENDIBLE</span><h2>Construye la propuesta</h2></div>
            <div className="quote-add-controls"><select value={selectedCatalogId} onChange={(event) => setSelectedCatalogId(event.target.value)} disabled={!canManage}>{categories.map(([key, label]) => <optgroup key={key} label={label}>{activeCatalog.filter((item) => item.category === key).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>)}</select><button type="button" className="primary-button" onClick={addCatalogLine} disabled={!canManage || !selectedCatalogId}>Agregar</button><button type="button" className="secondary-button" onClick={addCustomLine} disabled={!canManage}>Línea personalizada</button></div>
          </section>

          <section className="panel quote-lines-panel">
            <div className="panel-heading"><div><span className="panel-label">ESTRUCTURA DE COSTOS</span><h2>{draft.items.length} componente{draft.items.length === 1 ? "" : "s"}</h2></div><span className="unit">Venta = costo ÷ (1 − margen)</span></div>
            {!draft.items.length ? <div className="quote-empty"><strong>Empieza agregando un producto o servicio</strong><span>Los Atlas traerán incorporados sus costos de Vercel/AWS, IA y otros recursos que configures en “Costeo de productos”.</span></div> : <div className="quote-line-list">{draft.items.map((line) => {
              const lineSale = salePriceFromMargin(line.unitCost, Math.min(line.marginPercent, 99.99)) * line.quantity;
              const lineCost = line.unitCost * line.quantity;
              const breakdownUnitCost = line.costBreakdown?.reduce((total, entry) => total + entry.quantity * entry.unitCost, 0) ?? 0;
              const directUnitCost = Math.max(0, line.unitCost - breakdownUnitCost);
              return <article className="quote-line-card" key={line.id}>
                <div className="quote-line-top"><div><span className="quote-category">{categoryLabel[line.category] ?? "Otro"}</span><input className="quote-line-name" value={line.name} onChange={(event) => updateLine(line.id, { name: event.target.value })} disabled={!canManage} />{Boolean(line.costBreakdown?.length) && <div className="quote-line-breakdown"><small>Costo compuesto por</small>{directUnitCost > 0 && <span>Costo directo · {money(directUnitCost, draft.currencyCode)}</span>}{line.costBreakdown?.map((entry) => <span key={`${line.id}-${entry.catalogItemId}`}>{entry.name} · {entry.quantity} × {money(entry.unitCost, draft.currencyCode)}</span>)}</div>}</div><button type="button" className="quote-remove" onClick={() => removeLine(line.id)} disabled={!canManage} aria-label={`Quitar ${line.name}`}>×</button></div>
                <div className="quote-line-fields">
                  <label>Cobro<select value={line.billingPeriod} onChange={(event) => updateLine(line.id, { billingPeriod: event.target.value as QuoteBillingPeriod })} disabled={!canManage}><option value="one_time">Una vez</option><option value="monthly">Mensual</option></select></label>
                  <label>Cantidad<input type="number" min="0.01" step="0.01" value={line.quantity} onChange={(event) => updateLine(line.id, { quantity: Math.max(0, Number(event.target.value)) })} disabled={!canManage} /></label>
                  <label>Unidad<input value={line.unitName} onChange={(event) => updateLine(line.id, { unitName: event.target.value })} disabled={!canManage} /></label>
                  <label>Costo interno<input type="number" min="0" step={draft.currencyCode === "CLP" ? "1" : "0.01"} value={line.unitCost} onChange={(event) => updateLine(line.id, { unitCost: Math.max(0, Number(event.target.value)) })} disabled={!canManage} /></label>
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

    {view === "catalog" && <div className="quote-costing-workspace">
      <section className="panel quote-product-model-panel">
        <div className="panel-heading"><div><span className="panel-label">PRODUCTOS VENDIBLES</span><h2>Costeo por producto</h2><p>Configura qué paga GEIMSER para operar cada Atlas. El costo compuesto se usará automáticamente al cotizar.</p></div>{canManage && <button type="button" className="primary-button" onClick={() => setCatalogDraft(blankCatalog())}>Agregar producto o recurso</button>}</div>
        <div className="quote-product-cost-grid">{catalog.filter((item) => item.is_sellable).map((item) => {
          const breakdown = costBreakdownForProduct(item.id);
          const totalCost = catalogUnitCost(item);
          const suggestedSale = salePriceFromMargin(totalCost, asNumber(item.default_margin_percent));
          return <article key={item.id} className={!item.is_active ? "inactive" : ""}>
            <div className="quote-product-cost-heading"><div><span className="quote-category">{categoryLabel[item.category] ?? "Otro"}</span><h3>{item.name}</h3><small>{item.billing_period === "monthly" ? "Costo mensual" : "Costo único"} · por {item.unit_name}</small></div><span className="quote-product-role">Producto</span></div>
            <div className="quote-product-resources">{breakdown.length ? breakdown.map((entry) => <span key={`${item.id}-${entry.catalogItemId}`}>{entry.name}<b>{entry.quantity} × {new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(entry.unitCost)}</b></span>) : <small>Sin infraestructura o IA asociada</small>}</div>
            <div className="quote-product-economics"><div><span>Costo interno</span><strong>{new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(totalCost)}</strong></div><div><span>Venta sugerida</span><strong>{new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(suggestedSale)}</strong><small>{asNumber(item.default_margin_percent)}% margen</small></div></div>
            {canManage && <div className="quote-product-actions"><button type="button" className="primary-button" onClick={() => openCostModel(item)}>Configurar costos</button><button type="button" className="secondary-button" onClick={() => setCatalogDraft({ id: item.id, name: item.name, category: item.category, unitName: item.unit_name, billingPeriod: item.billing_period, defaultUnitCost: String(item.default_unit_cost), defaultMarginPercent: String(item.default_margin_percent), isActive: item.is_active, isSellable: item.is_sellable, isCostComponent: item.is_cost_component })}>Editar producto</button></div>}
          </article>;
        })}</div>
      </section>

      <section className="panel quote-catalog-panel">
        <div className="panel-heading"><div><span className="panel-label">RECURSOS COMPARTIDOS</span><h2>Infraestructura, IA y costos base</h2><p>Edita una vez AWS, Vercel, GPT, Claude, Mercury o perfiles y reutilízalos dentro de varios productos.</p></div></div>
        <div className="quote-catalog-grid">{catalog.filter((item) => item.is_cost_component).map((item) => <article key={item.id} className={!item.is_active ? "inactive" : ""}><div><span className="quote-category">{categoryLabel[item.category] ?? "Otro"}</span><h3>{item.name}</h3><small>{item.billing_period === "monthly" ? "Mensual" : "Una vez"} · por {item.unit_name}</small></div><div><span>Costo base</span><strong>{new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(asNumber(item.default_unit_cost))}</strong><small>{item.is_sellable ? "También vendible" : "Solo costo interno"}</small></div>{canManage && <button type="button" className="secondary-button" onClick={() => setCatalogDraft({ id: item.id, name: item.name, category: item.category, unitName: item.unit_name, billingPeriod: item.billing_period, defaultUnitCost: String(item.default_unit_cost), defaultMarginPercent: String(item.default_margin_percent), isActive: item.is_active, isSellable: item.is_sellable, isCostComponent: item.is_cost_component })}>Editar recurso</button>}</article>)}</div>
      </section>
    </div>}

    {catalogDraft && <div className="modal-backdrop"><section className="entry-modal quote-catalog-modal" role="dialog" aria-modal="true" aria-labelledby="catalog-cost-title"><div className="modal-header"><div><span className="eyebrow">CATÁLOGO DE COSTOS</span><h2 id="catalog-cost-title">{catalogDraft.id ? "Editar producto o recurso" : "Nuevo producto o recurso"}</h2></div><button type="button" className="close-button" onClick={() => setCatalogDraft(null)} aria-label="Cerrar">×</button></div><form onSubmit={saveCatalog}><div className="form-grid"><label>Nombre *<input value={catalogDraft.name} onChange={(event) => setCatalogDraft((current) => current ? { ...current, name: event.target.value } : current)} required /></label><label>Uso<select value={catalogDraft.isSellable && catalogDraft.isCostComponent ? "both" : catalogDraft.isCostComponent ? "cost" : "sellable"} onChange={(event) => setCatalogDraft((current) => current ? { ...current, isSellable: event.target.value !== "cost", isCostComponent: event.target.value !== "sellable" } : current)}><option value="sellable">Producto vendible</option><option value="cost">Solo componente de costo</option><option value="both">Vendible y componente de costo</option></select></label><label>Categoría<select value={catalogDraft.category} onChange={(event) => setCatalogDraft((current) => current ? { ...current, category: event.target.value } : current)}>{categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Unidad<input value={catalogDraft.unitName} onChange={(event) => setCatalogDraft((current) => current ? { ...current, unitName: event.target.value } : current)} required /></label><label>Periodicidad<select value={catalogDraft.billingPeriod} onChange={(event) => setCatalogDraft((current) => current ? { ...current, billingPeriod: event.target.value as QuoteBillingPeriod } : current)}><option value="one_time">Una vez</option><option value="monthly">Mensual</option></select></label><label>Costo directo / base<input type="number" min="0" step="0.01" value={catalogDraft.defaultUnitCost} onChange={(event) => setCatalogDraft((current) => current ? { ...current, defaultUnitCost: event.target.value } : current)} required /><small>En productos, se suma a los recursos asociados.</small></label><label>Margen base %<input type="number" min="0" max="99.99" step="0.1" value={catalogDraft.defaultMarginPercent} onChange={(event) => setCatalogDraft((current) => current ? { ...current, defaultMarginPercent: event.target.value } : current)} required /></label><label>Estado<select value={catalogDraft.isActive ? "active" : "inactive"} onChange={(event) => setCatalogDraft((current) => current ? { ...current, isActive: event.target.value === "active" } : current)}><option value="active">Activo</option><option value="inactive">Inactivo</option></select></label></div><div className="form-actions"><button type="button" className="secondary-button" onClick={() => setCatalogDraft(null)}>Cancelar</button><button type="submit" className="primary-button" disabled={saving}>{saving ? "Guardando…" : "Guardar"}</button></div></form></section></div>}

    {costModelProduct && <div className="modal-backdrop"><section className="entry-modal quote-cost-model-modal" role="dialog" aria-modal="true" aria-labelledby="cost-model-title"><div className="modal-header"><div><span className="eyebrow">RECETA DE COSTOS</span><h2 id="cost-model-title">{costModelProduct.name}</h2><p>Selecciona lo que paga GEIMSER para operar una unidad de este producto.</p></div><button type="button" className="close-button" onClick={() => { setCostModelProductId(null); setCostModelDraft([]); }} aria-label="Cerrar">×</button></div>
      <div className="quote-cost-model-summary"><div><span>Costo directo</span><strong>{new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(asNumber(costModelProduct.default_unit_cost))}</strong></div><div><span>Recursos asociados</span><strong>{new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(costModelResourceTotal)}</strong></div><div className="total"><span>Costo interno total</span><strong>{new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(costModelTotal)}</strong><small>Venta sugerida {new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(salePriceFromMargin(costModelTotal, asNumber(costModelProduct.default_margin_percent)))}</small></div></div>
      <div className="quote-cost-model-heading"><div><h3>Recursos asociados</h3><p>Ejemplo: Vercel + GPT, AWS + Claude o Mercury con costo cero.</p></div><button type="button" className="secondary-button" onClick={addCostModelRow}>Agregar recurso</button></div>
      {!costModelDraft.length ? <div className="quote-empty"><strong>Este producto todavía no tiene recursos asociados</strong><span>Agrega hosting, IA, perfiles u otro costo {costModelProduct.billing_period === "monthly" ? "recurrente" : "único"}.</span></div> : <div className="quote-cost-model-list">{costModelDraft.map((entry) => { const resource = catalog.find((item) => item.id === entry.catalogItemId); const effectiveCost = entry.unitCostOverride.trim() === "" ? asNumber(resource?.default_unit_cost ?? 0) : asNumber(entry.unitCostOverride); return <article key={entry.rowId}><label>Recurso<select value={entry.catalogItemId} onChange={(event) => updateCostModelRow(entry.rowId, { catalogItemId: event.target.value })}>{availableCostCatalog.filter((item) => item.id !== costModelProduct.id && item.billing_period === costModelProduct.billing_period).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.billing_period === "monthly" ? "mensual" : "una vez"}</option>)}</select></label><label>Cantidad<input type="number" min="0.0001" step="0.0001" value={entry.quantity} onChange={(event) => updateCostModelRow(entry.rowId, { quantity: event.target.value })} /></label><label>Costo base<input value={new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(asNumber(resource?.default_unit_cost ?? 0))} disabled /></label><label>Override opcional<input type="number" min="0" step="0.01" value={entry.unitCostOverride} placeholder="Usar costo base" onChange={(event) => updateCostModelRow(entry.rowId, { unitCostOverride: event.target.value })} /></label><div className="quote-cost-model-subtotal"><span>Subtotal</span><strong>{new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(asNumber(entry.quantity) * effectiveCost)}</strong></div><button type="button" className="quote-remove" onClick={() => setCostModelDraft((current) => current.filter((item) => item.rowId !== entry.rowId))} aria-label={`Quitar ${resource?.name ?? "recurso"}`}>×</button></article>; })}</div>}
      <div className="form-actions"><button type="button" className="secondary-button" onClick={() => { setCostModelProductId(null); setCostModelDraft([]); }}>Cancelar</button><button type="button" className="primary-button" onClick={() => void saveCostModel()} disabled={saving}>{saving ? "Guardando…" : "Guardar modelo de costo"}</button></div>
    </section></div>}
  </main>;
}
