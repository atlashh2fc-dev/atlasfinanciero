"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { InvoiceRecord } from "@/data/facturas-emitidas-2026";
import { isActiveIssuedInvoice } from "@/lib/document-revenue";

type PurchaseOrder = { id: string; purchase_order_number: string; customer_counterparty_id: string | null; customer_name: string; customer_tax_id: string | null; received_date: string; valid_until: string | null; net_amount: number | string; currency_code: string; notes: string | null; status: "open" | "closed" | "cancelled" };
type Allocation = { id: string; purchase_order_id: string; issued_document_id: string; allocated_net_amount: number | string; created_at: string };
type Customer = { id: string; legal_name: string; trade_name: string | null; tax_id: string | null };
type Payload = { purchaseOrders: PurchaseOrder[]; allocations: Allocation[]; customers: Customer[] };

const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });

function displayDate(value: string | null) {
  return value ? new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value}T00:00:00`)) : "—";
}

export function CustomerPurchaseOrders({ organizationId, records, canManage }: { organizationId: string | null; records: InvoiceRecord[]; canManage: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [order, setOrder] = useState({ purchaseOrderNumber: "", customerId: "", receivedDate: "", validUntil: "", netAmount: "", notes: "" });
  const [newCustomer, setNewCustomer] = useState({ legalName: "", taxId: "" });
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [allocation, setAllocation] = useState({ purchaseOrderId: "", issuedDocumentId: "", allocatedNetAmount: "" });

  async function load() {
    if (!organizationId) return;
    const response = await fetch(`/api/customer-purchase-orders?organizationId=${organizationId}`, { cache: "no-store" });
    if (!response.ok) { setData(null); setMessage("No fue posible cargar las órdenes de compra recibidas."); return; }
    setData(await response.json() as Payload);
    setMessage(null);
  }

  useEffect(() => { void load(); }, [organizationId]);

  const summaries = useMemo(() => (data?.purchaseOrders ?? []).map((purchaseOrder) => {
    const allocated = (data?.allocations ?? []).filter((item) => item.purchase_order_id === purchaseOrder.id).reduce((total, item) => total + Number(item.allocated_net_amount), 0);
    return { ...purchaseOrder, netAmount: Number(purchaseOrder.net_amount), allocated, remaining: Number(purchaseOrder.net_amount) - allocated };
  }), [data]);
  const allocatableInvoices = useMemo(() => records.filter(isActiveIssuedInvoice), [records]);
  const allocatedDocumentIds = useMemo(() => new Set((data?.allocations ?? []).map((item) => item.issued_document_id)), [data]);
  const unallocatedInvoices = allocatableInvoices.filter((item) => !allocatedDocumentIds.has(item.id));
  const availableOrders = summaries.filter((item) => item.status === "open" && item.remaining > 0);
  const totalCommitted = summaries.filter((item) => item.status !== "cancelled").reduce((total, item) => total + item.netAmount, 0);
  const totalRemaining = summaries.filter((item) => item.status === "open").reduce((total, item) => total + item.remaining, 0);

  async function createOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId) return;
    setSaving(true);
    const response = await fetch("/api/customer-purchase-orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "purchase_order", organizationId, ...order }) });
    setSaving(false);
    if (!response.ok) { setMessage("No fue posible registrar la OC. Revisa número, cliente, fecha y monto neto/exento."); return; }
    setOrder({ purchaseOrderNumber: "", customerId: "", receivedDate: "", validUntil: "", netAmount: "", notes: "" });
    setMessage("OC recibida registrada. Su saldo se descontará sólo al asociar una factura emitida.");
    await load();
  }

  async function createCustomer() {
    if (!organizationId || !newCustomer.legalName.trim()) return;
    setCreatingCustomer(true);
    const response = await fetch("/api/customer-profiles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_profile", organizationId, profile: { legalName: newCustomer.legalName, taxId: newCustomer.taxId, isActive: true }, contacts: [] }) });
    const payload = await response.json().catch(() => null) as { id?: string } | null;
    setCreatingCustomer(false);
    if (!response.ok || !payload?.id) { setMessage("No fue posible crear el cliente. Revisa la razón social y el RUT; si ya existe, selecciónalo desde la lista."); return; }
    const customerId = payload.id;
    setOrder((current) => ({ ...current, customerId }));
    setNewCustomer({ legalName: "", taxId: "" });
    setMessage("Cliente creado y seleccionado. Puedes continuar con la OC.");
    await load();
  }

  async function createAllocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId) return;
    setSaving(true);
    const response = await fetch("/api/customer-purchase-orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "allocation", organizationId, ...allocation }) });
    setSaving(false);
    if (!response.ok) { setMessage("No fue posible imputar la factura. El monto no puede exceder el saldo de la OC ni el neto/exento de la factura."); return; }
    setAllocation({ purchaseOrderId: "", issuedDocumentId: "", allocatedNetAmount: "" });
    setMessage("Facturación parcial imputada: el saldo disponible de la OC fue actualizado.");
    await load();
  }

  return <main className="dashboard">
    <section className="headline"><div><span className="eyebrow">CONTROL COMERCIAL</span><h1>Órdenes de compra recibidas</h1><p>Compromisos netos/exentos del cliente. No forman parte de la facturación hasta que exista una factura emitida e imputada.</p></div></section>
    {message && <p className="operation-message">{message}</p>}
    <section className="kpis">
      <article className="kpi-card"><span>OC vigentes</span><strong>{availableOrders.length}</strong><small>Con saldo disponible por facturar</small></article>
      <article className="kpi-card"><span>Compromiso neto/exento</span><strong>{money.format(totalCommitted)}</strong><small>OC no anuladas</small></article>
      <article className="kpi-card accent"><span>Saldo por facturar</span><strong>{money.format(totalRemaining)}</strong><small>Después de imputaciones parciales</small></article>
      <article className="kpi-card"><span>Facturas sin imputar</span><strong>{unallocatedInvoices.length}</strong><small>Disponibles para asociar a una OC</small></article>
    </section>
    {canManage && <section className="admin-grid">
      <section className="panel"><div className="panel-heading"><div><span className="panel-label">NUEVA OC</span><h2>Registrar OC recibida</h2></div><span className="unit">CLP neto/exento</span></div><form className="admin-form" onSubmit={createOrder}>
        <label>Número de OC *<input value={order.purchaseOrderNumber} onChange={(event) => setOrder((current) => ({ ...current, purchaseOrderNumber: event.target.value }))} /></label><label>Cliente vigente *<select value={order.customerId} onChange={(event) => setOrder((current) => ({ ...current, customerId: event.target.value }))}><option value="">Selecciona un cliente</option>{data?.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.trade_name || customer.legal_name}{customer.tax_id ? ` · ${customer.tax_id}` : ""}</option>)}<option value="__new__">＋ Crear nuevo cliente</option></select></label>{order.customerId === "__new__" && <section className="inline-customer-create"><span>ALTA RÁPIDA DE CLIENTE</span><p>Crea la ficha mínima ahora; luego podrás completar sus datos en Clientes.</p><div><label>Razón social *<input value={newCustomer.legalName} onChange={(event) => setNewCustomer((current) => ({ ...current, legalName: event.target.value }))} /></label><label>RUT<input value={newCustomer.taxId} onChange={(event) => setNewCustomer((current) => ({ ...current, taxId: event.target.value }))} /></label><button className="secondary-button" type="button" onClick={() => void createCustomer()} disabled={creatingCustomer}>{creatingCustomer ? "Creando…" : "Crear y seleccionar"}</button></div></section>}<label>Fecha recepción *<input type="date" value={order.receivedDate} onChange={(event) => setOrder((current) => ({ ...current, receivedDate: event.target.value }))} /></label><label>Vigencia<input type="date" value={order.validUntil} onChange={(event) => setOrder((current) => ({ ...current, validUntil: event.target.value }))} /></label><label>Monto neto/exento *<input min="1" type="number" value={order.netAmount} onChange={(event) => setOrder((current) => ({ ...current, netAmount: event.target.value }))} /></label><label>Observación<input value={order.notes} onChange={(event) => setOrder((current) => ({ ...current, notes: event.target.value }))} /></label><button className="primary-button" disabled={saving || !order.customerId || order.customerId === "__new__"} type="submit">Registrar OC</button>
      </form></section>
      <section className="panel"><div className="panel-heading"><div><span className="panel-label">IMPUTACIÓN PARCIAL</span><h2>Descontar facturación emitida</h2></div><span className="unit">Control de saldo</span></div><form className="admin-form" onSubmit={createAllocation}>
        <label>OC con saldo *<select value={allocation.purchaseOrderId} onChange={(event) => setAllocation((current) => ({ ...current, purchaseOrderId: event.target.value }))}><option value="">Selecciona OC</option>{availableOrders.map((item) => <option key={item.id} value={item.id}>{item.purchase_order_number} · saldo {money.format(item.remaining)}</option>)}</select></label><label>Factura emitida *<select value={allocation.issuedDocumentId} onChange={(event) => setAllocation((current) => ({ ...current, issuedDocumentId: event.target.value }))}><option value="">Selecciona factura</option>{unallocatedInvoices.map((item) => <option key={item.id} value={item.id}>N° {item.invoiceNumber ?? "—"} · {item.client ?? "Cliente"} · {money.format(item.netAmount ?? 0)}</option>)}</select></label><label>Monto neto/exento imputado *<input min="1" type="number" value={allocation.allocatedNetAmount} onChange={(event) => setAllocation((current) => ({ ...current, allocatedNetAmount: event.target.value }))} /></label><button className="primary-button" disabled={saving || !availableOrders.length || !unallocatedInvoices.length} type="submit">Imputar factura</button>
      </form></section>
    </section>}
    <section className="table-section"><div className="table-heading"><div><span className="panel-label">SALDOS DE OC</span><h2>Compromiso versus facturación imputada</h2><p>Una factura se asocia a una OC; la imputación parcial nunca puede exceder el saldo disponible.</p></div></div><div className="table-scroll"><table><thead><tr><th>OC / cliente</th><th>Recepción</th><th className="money-col">Neto/exento</th><th className="money-col">Facturado imputado</th><th className="money-col">Saldo</th><th>Estado</th></tr></thead><tbody>{summaries.map((item) => <tr key={item.id}><td><strong>{item.purchase_order_number}</strong><small>{item.customer_name}</small></td><td>{displayDate(item.received_date)}<small>Vigencia: {displayDate(item.valid_until)}</small></td><td className="money-col">{money.format(item.netAmount)}</td><td className="money-col">{money.format(item.allocated)}</td><td className="money-col">{money.format(item.remaining)}</td><td><span className={`status ${item.status === "open" ? "pending" : item.status === "cancelled" ? "cancelled" : "paid"}`}>{item.status === "open" ? "Vigente" : item.status === "closed" ? "Cerrada" : "Anulada"}</span></td></tr>)}</tbody></table></div>{!summaries.length && <p className="billing-empty">Aún no hay OCs recibidas registradas.</p>}</section>
  </main>;
}
