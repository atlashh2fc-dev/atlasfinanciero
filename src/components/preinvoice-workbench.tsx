"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Role = "administrator" | "finance" | "operations" | "auditor";
type Customer = { id: string; legal_name: string; trade_name: string | null };
type IssuedDocument = { id: string; counterparty_id: string | null; document_number: string | null; issue_date: string | null; total_amount: number | null; client_name: string | null };
type Line = { id: string; preinvoice_id: string; description: string; quantity: number; unit_price: number; net_amount: number; source_currency: string; source_unit_price: number; conversion_rate_to_clp: number; pricing_date: string; rate_source: string; usage_quantity: number | null };
type Preinvoice = {
  id: string;
  counterparty_id: string;
  billing_cycle_id: string | null;
  period_month: string;
  pricing_date: string;
  status: "draft" | "review" | "approved" | "issued" | "cancelled";
  currency_code: string;
  net_amount: number;
  vat_amount: number;
  total_amount: number;
  issued_document_id: string | null;
  cancellation_reason: string | null;
  created_at: string;
};
type Payload = { role: Role; preinvoices: Preinvoice[]; lines: Line[]; customers: Customer[]; documents: IssuedDocument[] };

const money = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 });
const currentMonth = () => new Date().toISOString().slice(0, 7);
const firstDayOfMonth = (month: string) => `${month}-01`;
const labelForStatus: Record<Preinvoice["status"], string> = { draft: "Borrador", review: "En revisión", approved: "Aprobada", issued: "Emitida", cancelled: "Anulada" };
const normalized = (value: string | null | undefined) => (value ?? "").trim().toLocaleUpperCase();

function monthName(month: string) {
  return new Intl.DateTimeFormat("es-CL", { month: "long", year: "numeric" }).format(new Date(`${month}T00:00:00`));
}

export function PreinvoiceWorkbench({ organizationId }: { organizationId: string | null }) {
  const [data, setData] = useState<Payload | null>(null);
  const [periodMonth, setPeriodMonth] = useState(currentMonth);
  const [pricingDate, setPricingDate] = useState(firstDayOfMonth(currentMonth()));
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [documentByPreinvoice, setDocumentByPreinvoice] = useState<Record<string, string>>({});

  async function load() {
    if (!organizationId) { setData(null); setLoading(false); return; }
    setLoading(true);
    const response = await fetch(`/api/preinvoices?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as Payload | null;
    if (response.ok && payload) { setData(payload); setMessage(null); }
    else { setData(null); setMessage(response.status === 403 ? "Tu rol no tiene acceso a esta empresa." : "No fue posible cargar la prefacturación."); }
    setLoading(false);
  }

  useEffect(() => { void load(); }, [organizationId]);

  const customers = useMemo(() => new Map((data?.customers ?? []).map((customer) => [customer.id, customer])), [data]);
  const linesByPreinvoice = useMemo(() => {
    const result = new Map<string, Line[]>();
    for (const line of data?.lines ?? []) result.set(line.preinvoice_id, [...(result.get(line.preinvoice_id) ?? []), line]);
    return result;
  }, [data]);
  const selectedPeriod = useMemo(() => (data?.preinvoices ?? []).filter((item) => item.period_month.slice(0, 7) === periodMonth), [data, periodMonth]);
  const canWrite = data?.role === "administrator" || data?.role === "finance" || data?.role === "operations";
  const canApprove = data?.role === "administrator" || data?.role === "finance";

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId) return;
    setSaving(true);
    const response = await fetch("/api/preinvoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "generate", organizationId, periodMonth, pricingDate }) });
    const result = await response.json().catch(() => null) as { created?: number; linesAdded?: number; error?: string; ufQuote?: { value: number; date: string } } | null;
    setSaving(false);
    if (!response.ok) { setMessage(result?.error === "sii_uf_value_unavailable" ? "El SII no informó UF para la fecha elegida. Selecciona una fecha con valor oficial disponible." : "No fue posible generar las prefacturas del período."); return; }
    setMessage(`${result?.created ?? 0} prefactura(s) creada(s); ${result?.linesAdded ?? 0} línea(s) incorporada(s) desde servicios vigentes.${result?.ufQuote ? ` UF SII ${result.ufQuote.date}: CLP ${money.format(result.ufQuote.value)}.` : ""}`);
    await load();
  }

  async function transition(preinvoiceId: string, action: "submit_review" | "return_to_draft" | "issue" | "cancel") {
    if (!organizationId) return;
    const issuedDocumentId = documentByPreinvoice[preinvoiceId];
    const reason = action === "cancel" ? window.prompt("Indica el motivo de anulación (obligatorio):") : undefined;
    if (action === "cancel" && !reason?.trim()) return;
    if (action === "issue" && !issuedDocumentId) { setMessage("Selecciona primero la factura emitida que corresponde a esta prefactura."); return; }
    setSaving(true);
    const response = await fetch("/api/preinvoices", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, preinvoiceId, action, issuedDocumentId, reason }) });
    setSaving(false);
    if (!response.ok) { setMessage("No fue posible cambiar el estado. Revisa la secuencia, permisos y factura vinculada."); return; }
    setMessage(action === "issue" ? "Prefactura marcada como emitida y vinculada a la factura." : "Estado de prefactura actualizado.");
    await load();
  }

  function matchingDocuments(preinvoice: Preinvoice) {
    const customer = customers.get(preinvoice.counterparty_id);
    const names = new Set([normalized(customer?.legal_name), normalized(customer?.trade_name)].filter(Boolean));
    return (data?.documents ?? []).filter((document) => document.counterparty_id === preinvoice.counterparty_id || (!document.counterparty_id && names.has(normalized(document.client_name))));
  }

  return <main className="dashboard billing-dashboard">
    <section className="headline">
      <div><span className="eyebrow">PREFACURACIÓN</span><h1>Servicios contratados a emisión controlada</h1><p>Genera borradores desde los servicios vigentes, revísalos y vincula una factura real sólo después de aprobarlos.</p></div>
      <div className="headline-actions"><button type="button" className="secondary-button" onClick={() => void load()} disabled={loading || saving}>Actualizar</button></div>
    </section>

    {message && <p className="operation-message">{message}</p>}
    {loading ? <section className="panel billing-empty"><p>Cargando prefacturación…</p></section> : !data ? <section className="panel billing-empty"><p>Selecciona una empresa a la que tengas acceso para operar este módulo.</p></section> : <>
      <section className="billing-form-panel panel">
        <div className="panel-heading"><div><span className="panel-label">GENERAR PERÍODO</span><h2>Origen: servicios activos del cliente</h2></div><span className="unit">Sin emitir DTE automáticamente</span></div>
        <form className="billing-form" onSubmit={generate}>
          <label>Mes de servicio<input type="month" value={periodMonth} onChange={(event) => { setPeriodMonth(event.target.value); setPricingDate(firstDayOfMonth(event.target.value)); }} required /></label>
          <label>Fecha de valorización UF<input type="date" value={pricingDate} onChange={(event) => setPricingDate(event.target.value)} required /></label>
          <p className="form-note">Las UF se consultan en la tabla oficial del SII para esta fecha y se congelan en CLP junto con su paridad. Los precios CLP no se convierten.</p>
          <button className="primary-button" type="submit" disabled={!canWrite || saving}>Generar borradores</button>
        </form>
      </section>

      <section className="kpis billing-kpis" aria-label="Resumen de prefacturación">
        <article className="kpi-card"><span>Borradores</span><strong>{selectedPeriod.filter((item) => item.status === "draft").length}</strong><small>Se pueden completar o corregir</small></article>
        <article className="kpi-card accent"><span>En revisión</span><strong>{selectedPeriod.filter((item) => item.status === "review").length}</strong><small>Esperan decisión de Finanzas</small></article>
        <article className="kpi-card"><span>Aprobadas</span><strong>{selectedPeriod.filter((item) => item.status === "approved").length}</strong><small>Listas para vincular emisión</small></article>
        <article className="kpi-card"><span>Valor aprobado</span><strong>CLP {money.format(selectedPeriod.filter((item) => item.status === "approved").reduce((total, item) => total + Number(item.total_amount), 0))}</strong><small>Antes de IVA, si corresponde</small></article>
      </section>

      <section className="table-section">
        <div className="table-heading"><div><span className="panel-label">BANDEJA DEL PERÍODO</span><h2>{monthName(`${periodMonth}-01`)}</h2><p>Las líneas UF se convierten a CLP con su fecha y valor SII auditables. La factura emitida debe existir previamente en el registro documental.</p></div></div>
        <div className="table-scroll"><table className="billing-cycles-table"><thead><tr><th>Cliente / líneas</th><th>Moneda</th><th className="money-col">Neto</th><th>Estado</th><th>Control</th></tr></thead><tbody>{selectedPeriod.map((preinvoice) => {
          const customer = customers.get(preinvoice.counterparty_id);
          const lines = linesByPreinvoice.get(preinvoice.id) ?? [];
          const docs = matchingDocuments(preinvoice);
          return <tr key={preinvoice.id}><td><strong>{customer?.trade_name || customer?.legal_name || "Cliente"}</strong><small>{lines.length ? lines.map((line) => line.source_currency === "UF" ? `${line.description} (${line.quantity} × UF ${money.format(Number(line.source_unit_price))}; SII ${line.pricing_date} = CLP ${money.format(Number(line.conversion_rate_to_clp))})` : `${line.description} (${line.quantity} × CLP ${money.format(Number(line.unit_price))})`).join(" · ") : "Sin líneas de servicio"}</small><small>Fecha de valorización: {preinvoice.pricing_date}</small></td><td>{preinvoice.currency_code}</td><td className="money-col">{money.format(Number(preinvoice.total_amount))}</td><td><span className={`status ${preinvoice.status === "draft" ? "pending" : preinvoice.status === "review" ? "pending" : preinvoice.status === "approved" || preinvoice.status === "issued" ? "paid" : "cancelled"}`}>{labelForStatus[preinvoice.status]}</span></td><td><div className="cycle-actions">
            {preinvoice.status === "draft" && canWrite && <><button type="button" className="secondary-button" disabled={saving || !lines.length} onClick={() => void transition(preinvoice.id, "submit_review")}>Enviar a revisión</button>{canApprove && <button type="button" className="text-button" disabled={saving} onClick={() => void transition(preinvoice.id, "cancel")}>Anular</button>}</>}
            {preinvoice.status === "review" && <><small>Decisión pendiente en Aprobaciones</small>{canApprove && <><button type="button" className="text-button" disabled={saving} onClick={() => void transition(preinvoice.id, "return_to_draft")}>Devolver</button><button type="button" className="text-button" disabled={saving} onClick={() => void transition(preinvoice.id, "cancel")}>Anular</button></>}</>}
            {preinvoice.status === "approved" && canApprove && <><select aria-label="Factura emitida" value={documentByPreinvoice[preinvoice.id] ?? ""} onChange={(event) => setDocumentByPreinvoice((current) => ({ ...current, [preinvoice.id]: event.target.value }))}><option value="">Factura emitida…</option>{docs.map((document) => <option key={document.id} value={document.id}>{document.document_number || "Sin folio"} · {document.issue_date || "sin fecha"} · CLP {money.format(Number(document.total_amount ?? 0))}</option>)}</select><button type="button" className="primary-button" disabled={saving || !docs.length} onClick={() => void transition(preinvoice.id, "issue")}>Vincular emisión</button><button type="button" className="text-button" disabled={saving} onClick={() => void transition(preinvoice.id, "cancel")}>Anular</button></>}
            {preinvoice.status === "issued" && <small>Factura vinculada</small>}
            {preinvoice.status === "cancelled" && <small>{preinvoice.cancellation_reason || "Anulada"}</small>}
          </div></td></tr>;
        })}</tbody></table></div>
        {!selectedPeriod.length && <p className="billing-empty">No hay prefacturas para este período. Genera borradores desde los servicios activos.</p>}
      </section>
    </>}
  </main>;
}
