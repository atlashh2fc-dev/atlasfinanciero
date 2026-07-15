"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type PurchaseRequest = { id: string; request_number: string; supplier_name: string; description: string; requested_on: string; needed_by: string | null; estimated_amount: number | string; status: string };
type PurchaseOrder = { id: string; purchase_order_number: string; supplier_name: string; ordered_on: string; expected_on: string | null; net_amount: number | string; total_amount: number | string; status: string };
type PaymentBatch = { id: string; batch_number: string; scheduled_for: string; total_amount: number | string; status: string; payment_reference: string | null };
type PaymentItem = { id: string; payment_batch_id: string; received_document_id: string; supplier_name_snapshot: string; document_number_snapshot: string | null; due_date_snapshot: string | null; amount: number | string };
type Document = { id: string; supplier_name: string; document_number: string | null; issue_date: string; due_date: string | null; total_amount: number | string; payment_status: string | null };
type Supplier = { id: string; legal_name: string; trade_name: string | null; tax_id: string | null };
type Account = { id: string; name: string; bank_name: string | null; account_number_masked: string | null };
type Payload = { purchaseRequests: PurchaseRequest[]; purchaseOrders: PurchaseOrder[]; paymentBatches: PaymentBatch[]; paymentBatchItems: PaymentItem[]; receivedDocuments: Document[]; suppliers: Supplier[]; bankAccounts: Account[] };

const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const dates = new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" });
const amount = (value: number | string) => Number(value ?? 0);
const displayDate = (value: string | null) => value ? dates.format(new Date(`${value}T00:00:00`)) : "—";
const today = () => new Date().toISOString().slice(0, 10);

function label(status: string) {
  return ({ draft: "Borrador", review: "En aprobación", approved: "Aprobado", rejected: "Rechazada", sent: "Enviada", partially_received: "Recepción parcial", received: "Recibida", processing: "En proceso", paid: "Pagado", cancelled: "Anulado" } as Record<string, string>)[status] ?? status;
}
function statusClass(status: string) { return `status ${status === "paid" || status === "approved" || status === "received" ? "paid" : status === "cancelled" || status === "rejected" ? "cancelled" : status === "review" || status === "processing" ? "pending" : "neutral"}`; }

export function ProcureToPayWorkbench({ organizationId, canManage, canManagePayments }: { organizationId: string | null; canManage: boolean; canManagePayments: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [request, setRequest] = useState({ requestNumber: "", supplierId: "", supplierName: "", description: "", requestedOn: today(), neededBy: "", estimatedAmount: "", notes: "" });
  const [order, setOrder] = useState({ purchaseOrderNumber: "", supplierId: "", supplierName: "", orderedOn: today(), expectedOn: "", description: "", quantity: "1", unitPrice: "", notes: "" });
  const [batch, setBatch] = useState({ batchNumber: "", bankAccountId: "", scheduledFor: today(), notes: "", documentIds: [] as string[] });

  async function load() {
    if (!organizationId) { setData(null); return; }
    const response = await fetch(`/api/procure-to-pay?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    if (!response.ok) { setData(null); setMessage("No fue posible cargar compras y pagos."); return; }
    setData(await response.json() as Payload);
    setMessage(null);
  }
  useEffect(() => { void load(); }, [organizationId]);

  const dueDocuments = useMemo(() => (data?.receivedDocuments ?? []).filter((document) => amount(document.total_amount) > 0), [data]);
  const totalPending = useMemo(() => dueDocuments.reduce((sum, document) => sum + amount(document.total_amount), 0), [dueDocuments]);
  const submittedBatches = useMemo(() => (data?.paymentBatches ?? []).filter((item) => ["review", "approved", "processing"].includes(item.status)), [data]);
  const selectedTotal = useMemo(() => dueDocuments.filter((document) => batch.documentIds.includes(document.id)).reduce((sum, document) => sum + amount(document.total_amount), 0), [batch.documentIds, dueDocuments]);

  function selectSupplier(target: "request" | "order", supplierId: string) {
    const supplier = data?.suppliers.find((item) => item.id === supplierId);
    const name = supplier ? supplier.trade_name || supplier.legal_name : "";
    if (target === "request") setRequest((current) => ({ ...current, supplierId, supplierName: name }));
    else setOrder((current) => ({ ...current, supplierId, supplierName: name }));
  }
  async function post(body: Record<string, unknown>) {
    setSaving(true);
    const response = await fetch("/api/procure-to-pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, ...body }) });
    setSaving(false);
    if (!response.ok) { setMessage("No fue posible guardar. Revisa los campos obligatorios, estado y permisos."); return false; }
    await load(); return true;
  }
  async function transition(id: string, action: string) {
    setSaving(true);
    const response = await fetch("/api/procure-to-pay", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, id, action, paymentReference: action === "mark_payment_batch_paid" ? "Pago ejecutado desde el lote" : undefined }) });
    setSaving(false);
    setMessage(response.ok ? "Estado actualizado." : "No fue posible cambiar el estado. Debe respetar el flujo de aprobación.");
    if (response.ok) await load();
  }
  async function createRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await post({ action: "create_purchase_request", ...request })) { setRequest({ requestNumber: "", supplierId: "", supplierName: "", description: "", requestedOn: today(), neededBy: "", estimatedAmount: "", notes: "" }); setMessage("Solicitud creada como borrador."); }
  }
  async function createOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await post({ action: "create_purchase_order", purchaseOrderNumber: order.purchaseOrderNumber, supplierId: order.supplierId || undefined, supplierName: order.supplierName, orderedOn: order.orderedOn, expectedOn: order.expectedOn || undefined, notes: order.notes, lines: [{ description: order.description, quantity: order.quantity, unitPrice: order.unitPrice }] })) { setOrder({ purchaseOrderNumber: "", supplierId: "", supplierName: "", orderedOn: today(), expectedOn: "", description: "", quantity: "1", unitPrice: "", notes: "" }); setMessage("Orden de compra creada como borrador."); }
  }
  async function createBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await post({ action: "create_payment_batch", batchNumber: batch.batchNumber, bankAccountId: batch.bankAccountId || undefined, scheduledFor: batch.scheduledFor, notes: batch.notes, documentIds: batch.documentIds })) { setBatch({ batchNumber: "", bankAccountId: "", scheduledFor: today(), notes: "", documentIds: [] }); setMessage("Lote de pago creado como borrador."); }
  }
  function toggleDocument(id: string) { setBatch((current) => ({ ...current, documentIds: current.documentIds.includes(id) ? current.documentIds.filter((item) => item !== id) : [...current.documentIds, id] })); }

  return <main className="dashboard">
    <section className="headline"><div><span className="eyebrow">COMPRAS Y CUENTAS POR PAGAR</span><h1>Procure-to-pay</h1><p>Controla la solicitud, aprobación, orden de compra, vencimiento y ejecución del pago sin perder la trazabilidad.</p></div></section>
    {message && <p className="operation-message">{message}</p>}
    <section className="kpis"><article className="kpi-card"><span>Por pagar</span><strong>{money.format(totalPending)}</strong><small>{dueDocuments.length} documentos abiertos</small></article><article className="kpi-card"><span>Solicitudes activas</span><strong>{(data?.purchaseRequests ?? []).filter((item) => !["cancelled", "rejected"].includes(item.status)).length}</strong><small>Requerimientos de compra</small></article><article className="kpi-card"><span>OC en curso</span><strong>{(data?.purchaseOrders ?? []).filter((item) => !["cancelled", "received"].includes(item.status)).length}</strong><small>Compromisos con proveedor</small></article><article className="kpi-card accent"><span>Pagos en proceso</span><strong>{money.format(submittedBatches.reduce((sum, item) => sum + amount(item.total_amount), 0))}</strong><small>En aprobación o ejecución</small></article></section>
    {canManage && <section className="admin-grid"><section className="panel"><div className="panel-heading"><div><span className="panel-label">SOLICITUD</span><h2>Nuevo requerimiento</h2></div></div><form className="admin-form" onSubmit={createRequest}><label>N° solicitud *<input value={request.requestNumber} onChange={(event) => setRequest((c) => ({ ...c, requestNumber: event.target.value }))} /></label><label>Proveedor<select value={request.supplierId} onChange={(event) => selectSupplier("request", event.target.value)}><option value="">Proveedor no registrado</option>{data?.suppliers.map((item) => <option key={item.id} value={item.id}>{item.trade_name || item.legal_name}</option>)}</select></label><label>Nombre proveedor *<input value={request.supplierName} onChange={(event) => setRequest((c) => ({ ...c, supplierName: event.target.value }))} /></label><label>Monto estimado *<input min="1" type="number" value={request.estimatedAmount} onChange={(event) => setRequest((c) => ({ ...c, estimatedAmount: event.target.value }))} /></label><label>Necesario para<input type="date" value={request.neededBy} onChange={(event) => setRequest((c) => ({ ...c, neededBy: event.target.value }))} /></label><label>Detalle *<input value={request.description} onChange={(event) => setRequest((c) => ({ ...c, description: event.target.value }))} /></label><button className="primary-button" disabled={saving} type="submit">Guardar solicitud</button></form></section><section className="panel"><div className="panel-heading"><div><span className="panel-label">ORDEN A PROVEEDOR</span><h2>Nueva orden de compra</h2></div></div><form className="admin-form" onSubmit={createOrder}><label>N° OC *<input value={order.purchaseOrderNumber} onChange={(event) => setOrder((c) => ({ ...c, purchaseOrderNumber: event.target.value }))} /></label><label>Proveedor<select value={order.supplierId} onChange={(event) => selectSupplier("order", event.target.value)}><option value="">Proveedor no registrado</option>{data?.suppliers.map((item) => <option key={item.id} value={item.id}>{item.trade_name || item.legal_name}</option>)}</select></label><label>Nombre proveedor *<input value={order.supplierName} onChange={(event) => setOrder((c) => ({ ...c, supplierName: event.target.value }))} /></label><label>Entrega estimada<input type="date" value={order.expectedOn} onChange={(event) => setOrder((c) => ({ ...c, expectedOn: event.target.value }))} /></label><label>Concepto *<input value={order.description} onChange={(event) => setOrder((c) => ({ ...c, description: event.target.value }))} /></label><label>Cantidad *<input min="0.0001" step="any" type="number" value={order.quantity} onChange={(event) => setOrder((c) => ({ ...c, quantity: event.target.value }))} /></label><label>Precio unitario *<input min="1" type="number" value={order.unitPrice} onChange={(event) => setOrder((c) => ({ ...c, unitPrice: event.target.value }))} /></label><button className="primary-button" disabled={saving} type="submit">Guardar OC</button></form></section></section>}
    {canManagePayments && <section className="panel"><div className="panel-heading"><div><span className="panel-label">PROPUESTA DE PAGO</span><h2>Preparar lote semanal</h2><p>Selecciona facturas abiertas; luego envíalo a Aprobaciones antes de ejecutarlo.</p></div><span className="unit">{money.format(selectedTotal)}</span></div><form className="admin-form" onSubmit={createBatch}><label>N° lote *<input value={batch.batchNumber} onChange={(event) => setBatch((c) => ({ ...c, batchNumber: event.target.value }))} /></label><label>Fecha de pago *<input type="date" value={batch.scheduledFor} onChange={(event) => setBatch((c) => ({ ...c, scheduledFor: event.target.value }))} /></label><label>Cuenta bancaria<select value={batch.bankAccountId} onChange={(event) => setBatch((c) => ({ ...c, bankAccountId: event.target.value }))}><option value="">Sin cuenta asignada</option>{data?.bankAccounts.map((item) => <option key={item.id} value={item.id}>{item.name}{item.account_number_masked ? ` · ${item.account_number_masked}` : ""}</option>)}</select></label><label>Nota<input value={batch.notes} onChange={(event) => setBatch((c) => ({ ...c, notes: event.target.value }))} /></label><div className="table-scroll"><table><thead><tr><th>Incluir</th><th>Proveedor / documento</th><th>Vencimiento</th><th className="money-col">Monto</th></tr></thead><tbody>{dueDocuments.map((document) => <tr key={document.id}><td><input aria-label={`Incluir ${document.supplier_name}`} type="checkbox" checked={batch.documentIds.includes(document.id)} onChange={() => toggleDocument(document.id)} /></td><td><strong>{document.supplier_name}</strong><small>{document.document_number || "Sin folio"}</small></td><td>{displayDate(document.due_date)}</td><td className="money-col">{money.format(amount(document.total_amount))}</td></tr>)}</tbody></table></div><button className="primary-button" disabled={saving || !batch.documentIds.length} type="submit">Crear lote de pago</button></form></section>}
    <section className="table-section"><div className="table-heading"><div><span className="panel-label">SEGUIMIENTO</span><h2>Solicitudes, órdenes y pagos</h2></div></div><div className="table-scroll"><table><thead><tr><th>Tipo / folio</th><th>Proveedor o detalle</th><th>Fecha</th><th className="money-col">Monto</th><th>Estado</th><th>Acción</th></tr></thead><tbody>{(data?.purchaseRequests ?? []).map((item) => <tr key={`request-${item.id}`}><td><strong>Solicitud {item.request_number}</strong></td><td>{item.supplier_name}<small>{item.description}</small></td><td>{displayDate(item.needed_by || item.requested_on)}</td><td className="money-col">{money.format(amount(item.estimated_amount))}</td><td><span className={statusClass(item.status)}>{label(item.status)}</span></td><td>{canManage && item.status === "draft" && <button className="secondary-button" disabled={saving} onClick={() => void transition(item.id, "submit_purchase_request")}>Enviar</button>}</td></tr>)}{(data?.purchaseOrders ?? []).map((item) => <tr key={`order-${item.id}`}><td><strong>OC {item.purchase_order_number}</strong></td><td>{item.supplier_name}</td><td>{displayDate(item.expected_on || item.ordered_on)}</td><td className="money-col">{money.format(amount(item.total_amount))}</td><td><span className={statusClass(item.status)}>{label(item.status)}</span></td><td>{canManage && item.status === "draft" && <button className="secondary-button" disabled={saving} onClick={() => void transition(item.id, "submit_purchase_order")}>Enviar</button>}{canManage && item.status === "approved" && <button className="secondary-button" disabled={saving} onClick={() => void transition(item.id, "send_purchase_order")}>Enviar OC</button>}{canManage && item.status === "sent" && <button className="secondary-button" disabled={saving} onClick={() => void transition(item.id, "receive_purchase_order")}>Recepcionar</button>}</td></tr>)}{(data?.paymentBatches ?? []).map((item) => <tr key={`batch-${item.id}`}><td><strong>Lote {item.batch_number}</strong><small>{(data?.paymentBatchItems ?? []).filter((line) => line.payment_batch_id === item.id).length} documentos</small></td><td>{item.payment_reference || "Pago a proveedores"}</td><td>{displayDate(item.scheduled_for)}</td><td className="money-col">{money.format(amount(item.total_amount))}</td><td><span className={statusClass(item.status)}>{label(item.status)}</span></td><td>{canManagePayments && item.status === "draft" && <button className="secondary-button" disabled={saving} onClick={() => void transition(item.id, "submit_payment_batch")}>Enviar</button>}{canManagePayments && item.status === "approved" && <button className="secondary-button" disabled={saving} onClick={() => void transition(item.id, "start_payment_batch")}>Procesar</button>}{canManagePayments && item.status === "processing" && <button className="secondary-button" disabled={saving} onClick={() => void transition(item.id, "mark_payment_batch_paid")}>Marcar pagado</button>}</td></tr>)}</tbody></table></div>{!(data?.purchaseRequests.length || data?.purchaseOrders.length || data?.paymentBatches.length) && <p className="billing-empty">Aún no hay solicitudes, órdenes de compra ni lotes de pago.</p>}</section>
  </main>;
}
