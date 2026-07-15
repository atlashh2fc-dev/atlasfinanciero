"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type PurchaseRequest = { id: string; request_number: string; supplier_counterparty_id: string | null; supplier_name: string; description: string; requested_on: string; needed_by: string | null; estimated_amount: number | string; status: string; notes?: string | null };
type PurchaseOrder = { id: string; purchase_order_number: string; purchase_request_id: string | null; supplier_name: string; ordered_on: string; expected_on: string | null; net_amount: number | string; total_amount: number | string; status: string; notes?: string | null };
type PaymentBatch = { id: string; batch_number: string; scheduled_for: string; total_amount: number | string; status: string; payment_reference: string | null };
type PaymentItem = { id: string; payment_batch_id: string; received_document_id: string; supplier_name_snapshot: string; document_number_snapshot: string | null; due_date_snapshot: string | null; amount: number | string };
type Document = { id: string; supplier_counterparty_id: string | null; supplier_name: string; document_number: string | null; issue_date: string; due_date: string | null; net_amount: number | string; total_amount: number | string; payment_status: string | null; vendor_purchase_order_id: string | null; payment_eligible: boolean; payment_block_reason: string | null };
type Supplier = { id: string; legal_name: string; trade_name: string | null; tax_id: string | null };
type Account = { id: string; name: string; bank_name: string | null; account_number_masked: string | null };
type Payload = { purchaseRequests: PurchaseRequest[]; purchaseOrders: PurchaseOrder[]; paymentBatches: PaymentBatch[]; paymentBatchItems: PaymentItem[]; receivedDocuments: Document[]; suppliers: Supplier[]; bankAccounts: Account[] };

const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const dates = new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" });
const amount = (value: number | string) => Number(value ?? 0);
const displayDate = (value: string | null) => value ? dates.format(new Date(`${value}T00:00:00`)) : "Sin fecha";
const today = () => new Date().toISOString().slice(0, 10);

function label(status: string) {
  return ({ draft: "Borrador", review: "En aprobación", approved: "Aprobada", rejected: "Rechazada", sent: "Enviada", partially_received: "Recepción parcial", received: "Recibida", processing: "En ejecución", paid: "Pagado", cancelled: "Anulado" } as Record<string, string>)[status] ?? status;
}
function statusClass(status: string) { return `status ${status === "paid" || status === "approved" || status === "received" ? "paid" : status === "cancelled" || status === "rejected" ? "cancelled" : status === "review" || status === "processing" ? "pending" : "neutral"}`; }
function isOverdue(document: Document) { return Boolean(document.due_date && document.due_date < today() && !["paid", "cancelled"].includes(document.payment_status ?? "")); }
function paymentBlockLabel(reason: string | null) {
  return ({ missing_purchase_order: "No está vinculada a una orden de compra.", purchase_order_not_received: "La OC aún no está recepcionada.", supplier_mismatch: "El proveedor no coincide con la OC.", amount_mismatch: "El monto no coincide con la OC.", already_in_payment_batch: "Ya está reservada en otro lote de pago.", purchase_match_pending: "Requiere revisar y vincular la factura con una OC.", purchase_match_rejected: "El match con compra fue rechazado.", purchase_match_exception_not_approved: "La excepción de compra aún no está aprobada." } as Record<string, string>)[reason ?? ""] ?? "No cumple las condiciones para pago.";
}

export function ProcureToPayWorkbench({ organizationId, canManage, canManagePayments }: { organizationId: string | null; canManage: boolean; canManagePayments: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [showBatchForm, setShowBatchForm] = useState(false);
  const [request, setRequest] = useState({ requestNumber: "", supplierId: "", supplierName: "", description: "", requestedOn: today(), neededBy: "", estimatedAmount: "", notes: "" });
  const [orderDraft, setOrderDraft] = useState({ requestId: "", purchaseOrderNumber: "", expectedOn: "", notes: "" });
  const [documentToLink, setDocumentToLink] = useState<Record<string, string>>({});
  const [batch, setBatch] = useState({ batchNumber: "", bankAccountId: "", scheduledFor: today(), notes: "", documentIds: [] as string[] });

  async function load() {
    if (!organizationId) { setData(null); return; }
    const response = await fetch(`/api/procure-to-pay?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    if (!response.ok) { setData(null); setMessage("No fue posible cargar compras y pagos."); return; }
    setData(await response.json() as Payload);
    setMessage(null);
  }
  useEffect(() => { void load(); }, [organizationId]);

  const dueDocuments = useMemo(() => (data?.receivedDocuments ?? []).filter((document) => amount(document.total_amount) > 0 && !["paid", "cancelled"].includes(document.payment_status ?? "")), [data]);
  const totalPending = useMemo(() => dueDocuments.reduce((sum, document) => sum + amount(document.total_amount), 0), [dueDocuments]);
  const submittedBatches = useMemo(() => (data?.paymentBatches ?? []).filter((item) => ["review", "approved", "processing"].includes(item.status)), [data]);
  const paymentEligibleDocuments = useMemo(() => dueDocuments.filter((document) => document.payment_eligible), [dueDocuments]);
  const paymentBlockedDocuments = useMemo(() => dueDocuments.filter((document) => !document.payment_eligible), [dueDocuments]);
  const selectedTotal = useMemo(() => paymentEligibleDocuments.filter((document) => batch.documentIds.includes(document.id)).reduce((sum, document) => sum + amount(document.total_amount), 0), [batch.documentIds, paymentEligibleDocuments]);
  const requestsNeedingAction = useMemo(() => (data?.purchaseRequests ?? []).filter((item) => ["draft", "approved"].includes(item.status)), [data]);
  const ordersNeedingAction = useMemo(() => (data?.purchaseOrders ?? []).filter((item) => ["draft", "approved", "sent"].includes(item.status)), [data]);
  const unlinkedDocuments = useMemo(() => dueDocuments.filter((item) => !item.vendor_purchase_order_id), [dueDocuments]);
  const overdueDocuments = useMemo(() => dueDocuments.filter(isOverdue), [dueDocuments]);

  function selectSupplier(supplierId: string) {
    const supplier = data?.suppliers.find((item) => item.id === supplierId);
    setRequest((current) => ({ ...current, supplierId, supplierName: supplier ? supplier.trade_name || supplier.legal_name : "" }));
  }
  async function post(body: Record<string, unknown>) {
    setSaving(true);
    const response = await fetch("/api/procure-to-pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, ...body }) });
    setSaving(false);
    if (!response.ok) { setMessage("No fue posible guardar. Revisa los datos, el estado del flujo y tus permisos."); return false; }
    await load(); return true;
  }
  async function transition(id: string, action: string) {
    setSaving(true);
    const response = await fetch("/api/procure-to-pay", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, id, action, paymentReference: action === "mark_payment_batch_paid" ? "Pago ejecutado desde el lote" : undefined }) });
    setSaving(false);
    setMessage(response.ok ? "Estado actualizado." : "No fue posible avanzar: el flujo exige la aprobación o condición previa correspondiente.");
    if (response.ok) await load();
  }
  async function createRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await post({ action: "create_purchase_request", ...request })) {
      setRequest({ requestNumber: "", supplierId: "", supplierName: "", description: "", requestedOn: today(), neededBy: "", estimatedAmount: "", notes: "" });
      setShowRequestForm(false); setMessage("Solicitud creada como borrador. Envíala desde su expediente para iniciar aprobación.");
    }
  }
  async function createOrderFromRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await post({ action: "create_purchase_order_from_request", purchaseRequestId: orderDraft.requestId, purchaseOrderNumber: orderDraft.purchaseOrderNumber, expectedOn: orderDraft.expectedOn || undefined, notes: orderDraft.notes || undefined })) {
      setOrderDraft({ requestId: "", purchaseOrderNumber: "", expectedOn: "", notes: "" }); setMessage("OC creada desde la solicitud aprobada. Ahora envíala a aprobación.");
    }
  }
  async function linkDocumentToOrder(orderId: string) {
    const receivedDocumentId = documentToLink[orderId];
    if (!receivedDocumentId) return;
    if (await post({ action: "link_received_document_to_purchase_order", purchaseOrderId: orderId, receivedDocumentId })) {
      setDocumentToLink((current) => ({ ...current, [orderId]: "" })); setMessage("Factura vinculada a la OC. Quedó disponible para el ciclo de pago.");
    }
  }
  async function createBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await post({ action: "create_payment_batch", batchNumber: batch.batchNumber, bankAccountId: batch.bankAccountId || undefined, scheduledFor: batch.scheduledFor, notes: batch.notes, documentIds: batch.documentIds })) {
      setBatch({ batchNumber: "", bankAccountId: "", scheduledFor: today(), notes: "", documentIds: [] }); setShowBatchForm(false); setMessage("Lote creado como borrador. Envíalo desde la bandeja para aprobación.");
    }
  }
  function toggleDocument(id: string) { setBatch((current) => ({ ...current, documentIds: current.documentIds.includes(id) ? current.documentIds.filter((item) => item !== id) : [...current.documentIds, id] })); }
  function beginOrder(requestId: string) { setOrderDraft({ requestId, purchaseOrderNumber: "", expectedOn: "", notes: "" }); document.getElementById("p2p-create-order")?.scrollIntoView({ behavior: "smooth", block: "center" }); }

  return <main className="dashboard p2p-workbench">
    <section className="headline p2p-headline"><div><span className="eyebrow">COMPRAS Y CUENTAS POR PAGAR</span><h1>Procure-to-pay</h1><p>Una compra avanza por un expediente único: necesidad, aprobación, OC, factura recibida y pago. Sin volver a capturar información.</p></div><div className="p2p-header-actions">{canManage && <button className="primary-button" onClick={() => setShowRequestForm((current) => !current)}>{showRequestForm ? "Cerrar alta" : "Nueva solicitud"}</button>}{canManagePayments && <button className="secondary-button" onClick={() => setShowBatchForm((current) => !current)}>{showBatchForm ? "Cerrar lote" : "Preparar pagos"}</button>}</div></section>
    {message && <p className="operation-message">{message}</p>}

    <section className="p2p-flow" aria-label="Ciclo procure to pay"><div className="p2p-flow-step"><strong>1</strong><span>Solicitud</span><small>Necesidad y presupuesto</small></div><div className="p2p-flow-step"><strong>2</strong><span>Aprobación</span><small>Decisión trazable</small></div><div className="p2p-flow-step"><strong>3</strong><span>Orden de compra</span><small>Compromiso con proveedor</small></div><div className="p2p-flow-step"><strong>4</strong><span>Factura recibida</span><small>Validación contra OC</small></div><div className="p2p-flow-step"><strong>5</strong><span>Pago</span><small>Lote, banco y conciliación</small></div></section>

    <section className="kpis"><article className="kpi-card"><span>Por pagar</span><strong>{money.format(totalPending)}</strong><small>{dueDocuments.length} factura(s) abierta(s)</small></article><article className="kpi-card"><span>Por resolver</span><strong>{requestsNeedingAction.length + ordersNeedingAction.length}</strong><small>Solicitudes u OCs esperan acción</small></article><article className="kpi-card"><span>Facturas bloqueadas</span><strong>{paymentBlockedDocuments.length}</strong><small>Requieren resolver su condición</small></article><article className="kpi-card accent"><span>Pagos en proceso</span><strong>{money.format(submittedBatches.reduce((sum, item) => sum + amount(item.total_amount), 0))}</strong><small>En aprobación o ejecución</small></article></section>

    <section className="p2p-attention"><div className="panel-heading"><div><span className="panel-label">ATENCIÓN REQUERIDA</span><h2>Lo que puede bloquear caja, operación o control</h2></div></div><div className="p2p-attention-grid"><article><strong>{overdueDocuments.length}</strong><span>factura(s) vencida(s)</span><small>{overdueDocuments.length ? "Prioriza su pago o documenta la retención." : "No hay vencimientos pendientes."}</small></article><article><strong>{paymentBlockedDocuments.length}</strong><span>factura(s) bloqueada(s)</span><small>{paymentBlockedDocuments.length ? "Revisa el motivo antes de proponer un pago." : "No hay bloqueos de pago."}</small></article><article><strong>{requestsNeedingAction.length}</strong><span>solicitud(es) activas</span><small>{requestsNeedingAction.length ? "Envía borradores o crea la OC tras aprobación." : "No hay solicitudes pendientes."}</small></article></div></section>

    {showRequestForm && canManage && <section className="panel p2p-create-panel"><div className="panel-heading"><div><span className="panel-label">PASO 1 · NUEVO EXPEDIENTE</span><h2>Registrar necesidad de compra</h2><p>La solicitud se convierte luego en OC; proveedor, detalle y monto se heredan.</p></div></div><form className="admin-form p2p-compact-form" onSubmit={createRequest}><label>N° solicitud *<input required value={request.requestNumber} onChange={(event) => setRequest((current) => ({ ...current, requestNumber: event.target.value }))} /></label><label>Proveedor<select value={request.supplierId} onChange={(event) => selectSupplier(event.target.value)}><option value="">Proveedor no registrado</option>{data?.suppliers.map((item) => <option key={item.id} value={item.id}>{item.trade_name || item.legal_name}</option>)}</select></label><label>Nombre proveedor *<input required value={request.supplierName} onChange={(event) => setRequest((current) => ({ ...current, supplierName: event.target.value }))} /></label><label>Monto estimado *<input required min="1" type="number" value={request.estimatedAmount} onChange={(event) => setRequest((current) => ({ ...current, estimatedAmount: event.target.value }))} /></label><label>Necesario para<input type="date" value={request.neededBy} onChange={(event) => setRequest((current) => ({ ...current, neededBy: event.target.value }))} /></label><label>Detalle *<input required value={request.description} onChange={(event) => setRequest((current) => ({ ...current, description: event.target.value }))} /></label><label className="p2p-form-wide">Justificación / nota<input value={request.notes} onChange={(event) => setRequest((current) => ({ ...current, notes: event.target.value }))} /></label><button className="primary-button" disabled={saving} type="submit">Crear solicitud</button></form></section>}

    {orderDraft.requestId && canManage && <section className="panel p2p-create-panel" id="p2p-create-order"><div className="panel-heading"><div><span className="panel-label">PASO 3 · DESDE SOLICITUD APROBADA</span><h2>Emitir orden de compra</h2><p>La OC conserva la trazabilidad de la solicitud origen.</p></div></div><form className="admin-form p2p-compact-form" onSubmit={createOrderFromRequest}><label>N° OC *<input required value={orderDraft.purchaseOrderNumber} onChange={(event) => setOrderDraft((current) => ({ ...current, purchaseOrderNumber: event.target.value }))} /></label><label>Entrega estimada<input type="date" value={orderDraft.expectedOn} onChange={(event) => setOrderDraft((current) => ({ ...current, expectedOn: event.target.value }))} /></label><label className="p2p-form-wide">Nota para proveedor<input value={orderDraft.notes} onChange={(event) => setOrderDraft((current) => ({ ...current, notes: event.target.value }))} /></label><button className="primary-button" disabled={saving} type="submit">Crear OC desde solicitud</button><button className="secondary-button" type="button" onClick={() => setOrderDraft({ requestId: "", purchaseOrderNumber: "", expectedOn: "", notes: "" })}>Cancelar</button></form></section>}

    <section className="p2p-board"><div className="table-heading"><div><span className="panel-label">BANDEJA OPERATIVA</span><h2>Expedientes y siguiente acción</h2><p>Cada tarjeta conserva el vínculo con el paso anterior y muestra solo la acción que corresponde ahora.</p></div></div><div className="p2p-lanes">
      <section className="p2p-lane"><div className="p2p-lane-heading"><span>01</span><div><h3>Solicitudes</h3><small>{data?.purchaseRequests.length ?? 0} registradas</small></div></div>{data?.purchaseRequests.map((item) => <article className="p2p-case" key={`request-${item.id}`}><div className="p2p-case-top"><strong>{item.request_number}</strong><span className={statusClass(item.status)}>{label(item.status)}</span></div><h4>{item.supplier_name}</h4><p>{item.description}</p><dl><div><dt>Monto estimado</dt><dd>{money.format(amount(item.estimated_amount))}</dd></div><div><dt>Necesario para</dt><dd>{displayDate(item.needed_by || item.requested_on)}</dd></div></dl><div className="p2p-case-action">{canManage && item.status === "draft" && <button className="secondary-button" disabled={saving} onClick={() => void transition(item.id, "submit_purchase_request")}>Enviar a aprobación</button>}{canManage && item.status === "approved" && <button className="primary-button" disabled={saving} onClick={() => beginOrder(item.id)}>Crear OC</button>}{item.status === "review" && <small>Esperando decisión en Aprobaciones.</small>}{["rejected", "cancelled"].includes(item.status) && <small>Expediente sin continuidad.</small>}</div></article>)}{!data?.purchaseRequests.length && <p className="billing-empty">Aún no hay solicitudes. Inicia el ciclo con una necesidad de compra.</p>}</section>
      <section className="p2p-lane"><div className="p2p-lane-heading"><span>02</span><div><h3>Órdenes y recepción</h3><small>{data?.purchaseOrders.length ?? 0} registradas</small></div></div>{data?.purchaseOrders.map((item) => { const linked = dueDocuments.filter((document) => document.vendor_purchase_order_id === item.id); return <article className="p2p-case" key={`order-${item.id}`}><div className="p2p-case-top"><strong>{item.purchase_order_number}</strong><span className={statusClass(item.status)}>{label(item.status)}</span></div><h4>{item.supplier_name}</h4><p>{item.purchase_request_id ? "Originada en una solicitud aprobada." : "OC registrada sin solicitud origen."}</p><dl><div><dt>Total comprometido</dt><dd>{money.format(amount(item.total_amount))}</dd></div><div><dt>Entrega estimada</dt><dd>{displayDate(item.expected_on || item.ordered_on)}</dd></div></dl>{linked.length > 0 && <small className="p2p-link-state">{linked.length} factura(s) vinculada(s)</small>}<div className="p2p-case-action">{canManage && item.status === "draft" && <button className="secondary-button" disabled={saving} onClick={() => void transition(item.id, "submit_purchase_order")}>Enviar a aprobación</button>}{canManage && item.status === "approved" && <button className="secondary-button" disabled={saving} onClick={() => void transition(item.id, "send_purchase_order")}>Enviar al proveedor</button>}{canManage && item.status === "sent" && <button className="secondary-button" disabled={saving} onClick={() => void transition(item.id, "receive_purchase_order")}>Confirmar recepción</button>}</div>{canManage && ["received", "partially_received"].includes(item.status) && unlinkedDocuments.length > 0 && <div className="p2p-link-control"><label>Vincular factura recibida<select value={documentToLink[item.id] ?? ""} onChange={(event) => setDocumentToLink((current) => ({ ...current, [item.id]: event.target.value }))}><option value="">Selecciona factura</option>{unlinkedDocuments.filter((document) => document.supplier_name === item.supplier_name).concat(unlinkedDocuments.filter((document) => document.supplier_name !== item.supplier_name)).map((document) => <option key={document.id} value={document.id}>{document.supplier_name} · {document.document_number || "Sin folio"} · {money.format(amount(document.total_amount))}</option>)}</select></label><button className="secondary-button" disabled={saving || !documentToLink[item.id]} onClick={() => void linkDocumentToOrder(item.id)}>Vincular</button></div>}</article>; })}{!data?.purchaseOrders.length && <p className="billing-empty">Las OCs aparecerán aquí al aprobar una solicitud.</p>}</section>
      <section className="p2p-lane"><div className="p2p-lane-heading"><span>03</span><div><h3>Facturas y pagos</h3><small>{dueDocuments.length} por gestionar</small></div></div>{dueDocuments.slice(0, 8).map((item) => <article className="p2p-case p2p-document-case" key={`document-${item.id}`}><div className="p2p-case-top"><strong>{item.document_number || "Sin folio"}</strong><span className={!item.payment_eligible ? "status cancelled" : isOverdue(item) ? "status pending" : "status paid"}>{!item.payment_eligible ? "Bloqueada" : isOverdue(item) ? "Vencida" : "Elegible"}</span></div><h4>{item.supplier_name}</h4><dl><div><dt>Vencimiento</dt><dd>{displayDate(item.due_date)}</dd></div><div><dt>Total</dt><dd>{money.format(amount(item.total_amount))}</dd></div></dl><small>{!item.payment_eligible ? paymentBlockLabel(item.payment_block_reason) : "Lista para incluirse en un lote de pago."}</small></article>)}{(data?.paymentBatches ?? []).map((item) => <article className="p2p-case p2p-payment-case" key={`batch-${item.id}`}><div className="p2p-case-top"><strong>Lote {item.batch_number}</strong><span className={statusClass(item.status)}>{label(item.status)}</span></div><dl><div><dt>Programado</dt><dd>{displayDate(item.scheduled_for)}</dd></div><div><dt>Total</dt><dd>{money.format(amount(item.total_amount))}</dd></div></dl><small>{(data?.paymentBatchItems ?? []).filter((line) => line.payment_batch_id === item.id).length} documento(s) incluidos</small><div className="p2p-case-action">{canManagePayments && item.status === "draft" && <button className="secondary-button" disabled={saving} onClick={() => void transition(item.id, "submit_payment_batch")}>Enviar a aprobación</button>}{canManagePayments && item.status === "approved" && <button className="secondary-button" disabled={saving} onClick={() => void transition(item.id, "start_payment_batch")}>Ejecutar pago</button>}{canManagePayments && item.status === "processing" && <button className="primary-button" disabled={saving} onClick={() => void transition(item.id, "mark_payment_batch_paid")}>Confirmar pago</button>}</div></article>)}{!(dueDocuments.length || data?.paymentBatches.length) && <p className="billing-empty">No hay facturas ni lotes de pago pendientes.</p>}</section>
    </div></section>

    {showBatchForm && canManagePayments && <section className="panel p2p-create-panel"><div className="panel-heading"><div><span className="panel-label">PASO 5 · PROPUESTA DE PAGO</span><h2>Preparar lote de pago</h2><p>Solo se incluyen documentos elegibles; los bloqueados muestran su causa en la bandeja.</p></div><span className="unit">{money.format(selectedTotal)}</span></div><form className="admin-form p2p-compact-form" onSubmit={createBatch}><label>N° lote *<input required value={batch.batchNumber} onChange={(event) => setBatch((current) => ({ ...current, batchNumber: event.target.value }))} /></label><label>Fecha de pago *<input required type="date" value={batch.scheduledFor} onChange={(event) => setBatch((current) => ({ ...current, scheduledFor: event.target.value }))} /></label><label>Cuenta bancaria<select value={batch.bankAccountId} onChange={(event) => setBatch((current) => ({ ...current, bankAccountId: event.target.value }))}><option value="">Sin cuenta asignada</option>{data?.bankAccounts.map((item) => <option key={item.id} value={item.id}>{item.name}{item.account_number_masked ? ` · ${item.account_number_masked}` : ""}</option>)}</select></label><label>Nota<input value={batch.notes} onChange={(event) => setBatch((current) => ({ ...current, notes: event.target.value }))} /></label><div className="table-scroll p2p-form-wide"><table><thead><tr><th>Incluir</th><th>Proveedor / documento</th><th>Vencimiento</th><th className="money-col">Monto</th></tr></thead><tbody>{paymentEligibleDocuments.map((document) => <tr key={document.id}><td><input aria-label={`Incluir ${document.supplier_name}`} type="checkbox" checked={batch.documentIds.includes(document.id)} onChange={() => toggleDocument(document.id)} /></td><td><strong>{document.supplier_name}</strong><small>{document.document_number || "Sin folio"}</small></td><td>{displayDate(document.due_date)}</td><td className="money-col">{money.format(amount(document.total_amount))}</td></tr>)}</tbody></table></div>{paymentBlockedDocuments.length > 0 && <div className="p2p-payment-blocked p2p-form-wide"><strong>No elegibles para este lote</strong>{paymentBlockedDocuments.map((document) => <p key={document.id}>{document.supplier_name} · {document.document_number || "Sin folio"}: {paymentBlockLabel(document.payment_block_reason)}</p>)}</div>}<button className="primary-button" disabled={saving || !batch.documentIds.length} type="submit">Crear lote de pago</button></form></section>}
  </main>;
}
