"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Role = "administrator" | "finance" | "operations" | "auditor";
type Customer = { id: string; legal_name: string; trade_name: string | null };
type CustomerService = { id: string; counterparty_id: string; service_catalog_id: string; service_name: string; service_category: string | null; quantity: number; unit_price: number; currency: string; starts_on: string | null; ends_on: string | null; billing_frequency: "monthly" | "quarterly" | "annual" | "one_time" };
type ServiceDraft = { customerServiceId: string; description: string; quantity: string; unitPrice: string; notes: string };
type IssuedDocument = { id: string; counterparty_id: string | null; document_number: string | null; issue_date: string | null; total_amount: number | null; client_name: string | null; recipient_name: string | null };
type Line = { id: string; preinvoice_id: string; description: string; quantity: number; unit_price: number; net_amount: number; source_currency: string; source_unit_price: number; conversion_rate_to_clp: number; pricing_date: string; rate_source: string; usage_quantity: number | null; notes: string | null; service_name: string | null; service_category: string | null };
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
type Payload = { role: Role; preinvoices: Preinvoice[]; lines: Line[]; customers: Customer[]; documents: IssuedDocument[]; services: CustomerService[] };

const money = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 });
const currentMonth = () => new Date().toISOString().slice(0, 7);
const firstDayOfMonth = (month: string) => `${month}-01`;
const labelForStatus: Record<Preinvoice["status"], string> = { draft: "Borrador", review: "En revisión", approved: "Aprobada", issued: "Emitida", cancelled: "Anulada" };
const normalized = (value: string | null | undefined) => (value ?? "").trim().toLocaleUpperCase();
const frequencyLabel: Record<CustomerService["billing_frequency"], string> = { monthly: "Mensual", quarterly: "Trimestral", annual: "Anual", one_time: "Spot / única vez" };
const numberInput = (value: number | string) => String(value);

function monthName(month: string) {
  return new Intl.DateTimeFormat("es-CL", { month: "long", year: "numeric" }).format(new Date(`${month}T00:00:00`));
}

function lineLabel(line: Line) {
  const service = [line.service_category, line.service_name].filter(Boolean).join(" · ");
  return service && line.description !== line.service_name && line.description !== service ? `${service} — ${line.description}` : service || line.description;
}

export function PreinvoiceWorkbench({ organizationId, onOpenApprovals }: { organizationId: string | null; onOpenApprovals?: () => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [periodMonth, setPeriodMonth] = useState(currentMonth);
  const [pricingDate, setPricingDate] = useState(firstDayOfMonth(currentMonth()));
  const [counterpartyId, setCounterpartyId] = useState("");
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>([]);
  const [serviceDrafts, setServiceDrafts] = useState<Record<string, ServiceDraft>>({});
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
  const documents = useMemo(() => new Map((data?.documents ?? []).map((document) => [document.id, document])), [data]);
  const linesByPreinvoice = useMemo(() => {
    const result = new Map<string, Line[]>();
    for (const line of data?.lines ?? []) result.set(line.preinvoice_id, [...(result.get(line.preinvoice_id) ?? []), line]);
    return result;
  }, [data]);
  const selectedPeriod = useMemo(() => (data?.preinvoices ?? []).filter((item) => item.period_month.slice(0, 7) === periodMonth), [data, periodMonth]);
  const servicesForCustomer = useMemo(() => (data?.services ?? []).filter((service) => service.counterparty_id === counterpartyId), [data, counterpartyId]);
  const canWrite = data?.role === "administrator" || data?.role === "finance" || data?.role === "operations";
  const canApprove = data?.role === "administrator" || data?.role === "finance";

  function toggleService(serviceId: string) {
    const service = servicesForCustomer.find((item) => item.id === serviceId);
    if (!service) return;
    if (selectedServiceIds.includes(serviceId)) {
      setSelectedServiceIds((current) => current.filter((id) => id !== serviceId));
      setServiceDrafts((drafts) => { const next = { ...drafts }; delete next[serviceId]; return next; });
      return;
    }
    setSelectedServiceIds((current) => [...current, serviceId]);
    const defaultGloss = service.service_category ? `${service.service_category} · ${service.service_name}` : service.service_name;
    setServiceDrafts((drafts) => ({ ...drafts, [serviceId]: { customerServiceId: serviceId, description: defaultGloss, quantity: numberInput(service.quantity), unitPrice: numberInput(service.unit_price), notes: "" } }));
  }

  function updateServiceDraft(serviceId: string, values: Partial<ServiceDraft>) {
    setServiceDrafts((current) => ({ ...current, [serviceId]: { ...current[serviceId], ...values } }));
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || !counterpartyId || !selectedServiceIds.length) {
      setMessage("Selecciona un cliente y al menos un servicio contratado.");
      return;
    }
    setSaving(true);
    const lines = selectedServiceIds.map((serviceId) => serviceDrafts[serviceId]).filter(Boolean);
    const response = await fetch("/api/preinvoices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create_draft", organizationId, counterpartyId, lines, periodMonth, pricingDate }) });
    const result = await response.json().catch(() => null) as { created?: number; linesAdded?: number; error?: string; ufQuote?: { value: number; date: string } } | null;
    setSaving(false);
    if (!response.ok) { setMessage(result?.error === "sii_uf_value_unavailable" ? "El SII no informó UF para la fecha elegida. Selecciona una fecha con valor oficial disponible." : result?.error === "preinvoice_is_not_editable" ? "Ya existe una prefactura de este cliente en revisión, aprobada o emitida para esta moneda y período." : "No fue posible construir la prefactura seleccionada."); return; }
    setMessage(`${result?.created ?? 0} prefactura(s) creada(s); ${result?.linesAdded ?? 0} línea(s) incorporada(s) o actualizada(s).${result?.ufQuote ? ` UF SII ${result.ufQuote.date}: CLP ${money.format(result.ufQuote.value)}.` : ""}`);
    setSelectedServiceIds([]);
    setServiceDrafts({});
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
    const result = await response.json().catch(() => null) as { error?: string; approvalRequestId?: string } | null;
    setSaving(false);
    if (!response.ok) {
      setMessage(result?.error === "approval_request_not_created" ? "La prefactura quedó en revisión, pero no se creó su solicitud. Devuélvela a borrador y vuelve a enviarla." : "No fue posible cambiar el estado. Revisa la secuencia, permisos y factura vinculada.");
      return;
    }
    const issuedDocument = issuedDocumentId ? documents.get(issuedDocumentId) : null;
    const issuedLabel = issuedDocument ? `Folio ${issuedDocument.document_number || "sin folio"} · ${issuedDocument.issue_date || "sin fecha"} · CLP ${money.format(Number(issuedDocument.total_amount ?? 0))}` : "factura emitida";
    setMessage(action === "submit_review" && result?.approvalRequestId ? "Prefactura enviada correctamente a Aprobaciones." : action === "issue" ? `Prefactura emitida y vinculada a ${issuedLabel}.` : "Estado de prefactura actualizado.");
    await load();
  }

  function matchingDocuments(preinvoice: Preinvoice) {
    const customer = customers.get(preinvoice.counterparty_id);
    const names = new Set([normalized(customer?.legal_name), normalized(customer?.trade_name)].filter(Boolean));
    return (data?.documents ?? []).filter((document) =>
      Boolean(document.document_number?.trim()) &&
      (document.counterparty_id === preinvoice.counterparty_id ||
        (!document.counterparty_id &&
          [document.client_name, document.recipient_name].some((name) =>
            names.has(normalized(name)),
          ))),
    );
  }

  return <main className="dashboard billing-dashboard">
    <section className="headline">
      <div><span className="eyebrow">PREFACURACIÓN</span><h1>Construcción controlada de prefacturas</h1><p>La ficha del cliente conserva lo contratado; aquí eliges qué servicios cobrar en cada período antes de enviarlos a aprobación.</p></div>
      <div className="headline-actions"><button type="button" className="secondary-button" onClick={() => void load()} disabled={loading || saving}>Actualizar</button></div>
    </section>

    {message && <p className="operation-message">{message}</p>}
    {loading ? <section className="panel billing-empty"><p>Cargando prefacturación…</p></section> : !data ? <section className="panel billing-empty"><p>Selecciona una empresa a la que tengas acceso para operar este módulo.</p></section> : <>
      <section className="billing-form-panel panel">
        <div className="panel-heading"><div><span className="panel-label">NUEVA PREFACTURA</span><h2>Elige el cliente y los servicios a cobrar</h2></div><span className="unit">Sin emitir DTE automáticamente</span></div>
        <form className="billing-form" onSubmit={generate}>
          <label>Mes de servicio<input type="month" value={periodMonth} onChange={(event) => { setPeriodMonth(event.target.value); setPricingDate(firstDayOfMonth(event.target.value)); }} required /></label>
          <label>Fecha de valorización UF<input type="date" value={pricingDate} onChange={(event) => setPricingDate(event.target.value)} required /></label>
          <label>Cliente<select value={counterpartyId} onChange={(event) => { setCounterpartyId(event.target.value); setSelectedServiceIds([]); setServiceDrafts({}); }} required><option value="">Selecciona cliente</option>{data.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.trade_name || customer.legal_name}</option>)}</select></label>
          <div className="form-field-wide"><span className="form-label">Servicios contratados a incorporar</span>{!counterpartyId ? <p className="form-note">Selecciona primero un cliente.</p> : servicesForCustomer.length ? <div className="preinvoice-service-list">{servicesForCustomer.map((service) => {
            const selected = selectedServiceIds.includes(service.id);
            const draft = serviceDrafts[service.id];
            return <article className={`preinvoice-service-card${selected ? " is-selected" : ""}`} key={service.id}>
              <label className="preinvoice-service-toggle"><input type="checkbox" checked={selected} onChange={() => toggleService(service.id)} /><span><strong>{service.service_category ? `${service.service_category} · ` : ""}{service.service_name}</strong><small>{frequencyLabel[service.billing_frequency]} · Contratado: {service.quantity} × {service.currency} {money.format(Number(service.unit_price))}</small></span></label>
              {selected && draft && <div className="preinvoice-service-editors">
                <label className="preinvoice-gloss">Glosa<input value={draft.description} maxLength={500} onChange={(event) => updateServiceDraft(service.id, { description: event.target.value })} required /></label>
                <label>Cantidad<input type="number" min="0.0001" step="0.0001" value={draft.quantity} onChange={(event) => updateServiceDraft(service.id, { quantity: event.target.value })} required /></label>
                <label>Valor unitario ({service.currency})<input type="number" min="0" step={service.currency === "UF" ? "0.0001" : "0.01"} value={draft.unitPrice} onChange={(event) => updateServiceDraft(service.id, { unitPrice: event.target.value })} required /></label>
                <label className="preinvoice-notes">Observación / nota<textarea value={draft.notes} maxLength={2000} onChange={(event) => updateServiceDraft(service.id, { notes: event.target.value })} placeholder="Opcional" /></label>
              </div>}
            </article>;
          })}</div> : <p className="form-note">Este cliente no tiene servicios contratados activos.</p>}</div>
          <p className="form-note">La condición mensual, trimestral, anual o spot queda en la ficha comercial. Aquí puedes ajustar cantidad, valor y glosa sólo para esta prefactura. Las UF se valorizan con el valor oficial del SII.</p>
          <button className="primary-button" type="submit" disabled={!canWrite || saving || !counterpartyId || !selectedServiceIds.length}>Construir prefactura</button>
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
          const linkedDocument = preinvoice.issued_document_id ? documents.get(preinvoice.issued_document_id) : null;
          return <tr key={preinvoice.id}><td><strong>{customer?.trade_name || customer?.legal_name || "Cliente"}</strong><small>{lines.length ? lines.map((line) => `${line.source_currency === "UF" ? `${lineLabel(line)} (${line.quantity} × UF ${money.format(Number(line.source_unit_price))}; SII ${line.pricing_date} = CLP ${money.format(Number(line.conversion_rate_to_clp))})` : `${lineLabel(line)} (${line.quantity} × CLP ${money.format(Number(line.unit_price))})`}${line.notes ? ` — ${line.notes}` : ""}`).join(" · ") : "Sin líneas de servicio"}</small><small>Fecha de valorización: {preinvoice.pricing_date}</small></td><td>{preinvoice.currency_code}</td><td className="money-col">{money.format(Number(preinvoice.total_amount))}</td><td><span className={`status ${preinvoice.status === "draft" ? "pending" : preinvoice.status === "review" ? "pending" : preinvoice.status === "approved" || preinvoice.status === "issued" ? "paid" : "cancelled"}`}>{labelForStatus[preinvoice.status]}</span></td><td><div className="cycle-actions">
            {preinvoice.status === "draft" && canWrite && <><button type="button" className="secondary-button" disabled={saving || !lines.length} onClick={() => void transition(preinvoice.id, "submit_review")}>Enviar a revisión</button>{canApprove && <button type="button" className="text-button" disabled={saving} onClick={() => void transition(preinvoice.id, "cancel")}>Anular</button>}</>}
            {preinvoice.status === "review" && <><small>Decisión pendiente en Aprobaciones</small>{onOpenApprovals && <button type="button" className="secondary-button" disabled={saving} onClick={onOpenApprovals}>Ver aprobación</button>}{canApprove && <><button type="button" className="text-button" disabled={saving} onClick={() => void transition(preinvoice.id, "return_to_draft")}>Devolver</button><button type="button" className="text-button" disabled={saving} onClick={() => void transition(preinvoice.id, "cancel")}>Anular</button></>}</>}
            {preinvoice.status === "approved" && canApprove && <>{docs.length ? <><select aria-label="Factura emitida" value={documentByPreinvoice[preinvoice.id] ?? ""} onChange={(event) => setDocumentByPreinvoice((current) => ({ ...current, [preinvoice.id]: event.target.value }))}><option value="">Selecciona la factura emitida…</option>{docs.map((document) => <option key={document.id} value={document.id}>{document.document_number || "Sin folio"} · {document.issue_date || "sin fecha"} · CLP {money.format(Number(document.total_amount ?? 0))}</option>)}</select><button type="button" className="primary-button" disabled={saving || !documentByPreinvoice[preinvoice.id]} onClick={() => void transition(preinvoice.id, "issue")}>Confirmar vínculo</button></> : <small>No hay factura emitida registrada para este cliente.</small>}<button type="button" className="text-button" disabled={saving} onClick={() => void transition(preinvoice.id, "cancel")}>Anular</button></>}
            {preinvoice.status === "issued" && <small>{linkedDocument ? `Emitida · Folio ${linkedDocument.document_number || "sin folio"} · ${linkedDocument.issue_date || "sin fecha"} · CLP ${money.format(Number(linkedDocument.total_amount ?? 0))}` : "Emitida · Factura vinculada"}</small>}
            {preinvoice.status === "cancelled" && <small>{preinvoice.cancellation_reason || "Anulada"}</small>}
          </div></td></tr>;
        })}</tbody></table></div>
        {!selectedPeriod.length && <p className="billing-empty">No hay prefacturas para este período. Selecciona un cliente y sus servicios contratados para construir una.</p>}
      </section>
    </>}
  </main>;
}
