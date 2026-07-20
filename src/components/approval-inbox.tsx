"use client";

import { useEffect, useMemo, useState } from "react";

type Membership = { organization_id: string; role: "administrator" | "finance" | "operations" | "auditor" };
type ApprovalStep = {
  id: string;
  step_number: number;
  required_role: Membership["role"];
  assigned_to: string | null;
  status: "pending" | "approved" | "rejected" | "skipped";
  decided_by: string | null;
  decided_at: string | null;
  decision_comment: string | null;
};
type ApprovalRequest = {
  id: string;
  target_type: "preinvoice" | "payment" | "purchase_order";
  target_id: string;
  title: string;
  description: string | null;
  amount: number | string;
  currency_code: "CLP" | "USD" | "UF";
  status: "submitted" | "approved" | "rejected" | "cancelled";
  requested_by_name: string;
  submitted_at: string;
  completed_at: string | null;
  metadata: Record<string, unknown>;
  approval_policies: { name: string } | null;
  approval_steps: ApprovalStep[];
};
type Payload = { requests: ApprovalRequest[]; membership: Membership };

const typeLabels: Record<ApprovalRequest["target_type"], string> = {
  preinvoice: "Prefactura",
  payment: "Pago",
  purchase_order: "Orden de compra",
};
const statusLabels: Record<ApprovalRequest["status"], string> = {
  submitted: "Pendiente",
  approved: "Aprobada",
  rejected: "Rechazada",
  cancelled: "Anulada",
};

function amount(value: number | string, currency: string) {
  return new Intl.NumberFormat("es-CL", { style: "currency", currency, maximumFractionDigits: 0 }).format(Number(value));
}

function date(value: string | null) {
  return value ? new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
}

function dateOnly(value: string | null) {
  return value ? new Intl.DateTimeFormat("es-CL", { dateStyle: "medium" }).format(new Date(`${value}T00:00:00`)) : "—";
}

type PreinvoiceLine = { description: string; quantity: number | string; unit_price: number | string; net_amount: number | string };

function preinvoiceDetails(metadata: Record<string, unknown>) {
  const items = Array.isArray(metadata.line_items) ? metadata.line_items.filter((item): item is PreinvoiceLine => Boolean(item) && typeof item === "object" && "description" in item && "quantity" in item && "unit_price" in item && "net_amount" in item) : [];
  return {
    customerName: typeof metadata.customer_name === "string" ? metadata.customer_name : "Cliente no informado",
    period: typeof metadata.period_month === "string" ? metadata.period_month : "—",
    items,
  };
}

type DirectPayableDetails = { supplierName: string; invoiceNumber: string | null; category: string | null; categoryDetail: string | null; description: string; issueDate: string | null; dueDate: string | null; notes: string | null; costCenter: { code: string; name: string } | null };

function directPayableDetails(metadata: Record<string, unknown>): DirectPayableDetails | null {
  const value = metadata.direct_payable;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const detail = value as Record<string, unknown>;
  const text = (key: string) => typeof detail[key] === "string" && detail[key].trim() ? detail[key].trim() : null;
  const center = detail.cost_center;
  const costCenter = center && typeof center === "object" && !Array.isArray(center)
    && typeof (center as Record<string, unknown>).code === "string" && typeof (center as Record<string, unknown>).name === "string"
    ? { code: (center as Record<string, string>).code, name: (center as Record<string, string>).name }
    : null;
  const description = text("description");
  return description ? { supplierName: text("supplier_name") ?? "Proveedor no informado", invoiceNumber: text("invoice_number"), category: text("category"), categoryDetail: text("category_detail"), description, issueDate: text("issue_date"), dueDate: text("due_date"), notes: text("notes"), costCenter } : null;
}

function directPayableCategory(category: string | null, detail: string | null) {
  if (category === "other") return detail ? `Otro · ${detail}` : "Otro";
  return ({ utilities: "Servicios básicos", rent: "Arriendo", taxes: "Impuestos / contribuciones", insurance: "Seguros", subscriptions: "Suscripciones" } as Record<string, string>)[category ?? ""] ?? "No informado";
}

export function ApprovalInbox({ organizationId }: { organizationId: string | null }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [savingStepId, setSavingStepId] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);

  async function load() {
    if (!organizationId) { setPayload(null); return; }
    setLoading(true);
    const response = await fetch(`/api/approvals?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    const next = await response.json().catch(() => null) as Payload | null;
    if (!response.ok || !next) {
      setPayload(null);
      setMessage("No fue posible cargar las aprobaciones.");
    } else {
      setPayload(next);
      setMessage("");
    }
    setLoading(false);
  }

  useEffect(() => { void load(); }, [organizationId]);

  const pendingCount = useMemo(() => payload?.requests.filter((request) => request.status === "submitted").length ?? 0, [payload]);
  const actionableCount = useMemo(() => payload?.requests.reduce((count, request) => count + request.approval_steps.filter((step) => request.status === "submitted" && step.status === "pending" && (step.required_role === payload.membership.role || payload.membership.role === "administrator") && !step.assigned_to).length, 0) ?? 0, [payload]);
  const selectedRequest = payload?.requests.find((request) => request.id === selectedRequestId) ?? null;

  async function decide(step: ApprovalStep, decision: "approved" | "rejected") {
    if (!organizationId) return;
    setSavingStepId(step.id);
    setMessage("");
    const response = await fetch("/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "decide", organizationId, stepId: step.id, decision, comment: comments[step.id] ?? "" }),
    });
    setSavingStepId(null);
    if (!response.ok) {
      setMessage("No fue posible registrar la decisión. Verifica que tu rol permita aprobar esta solicitud.");
      return;
    }
    setComments((current) => ({ ...current, [step.id]: "" }));
    setMessage(decision === "approved" ? "Aprobación registrada." : "Solicitud rechazada y registrada en la bitácora.");
    await load();
    setSelectedRequestId(null);
  }

  return <main className="dashboard">
    <section className="headline"><div><span className="eyebrow">GOBIERNO FINANCIERO</span><h1>Bandeja de aprobaciones</h1><p>Revisa y resuelve excepciones de prefacturas, pagos y órdenes de compra. Cada decisión queda trazada con fecha, rol y comentario.</p></div><button className="secondary-button" type="button" onClick={() => void load()} disabled={loading}>{loading ? "Actualizando…" : "Actualizar"}</button></section>
    {message && <p className="operation-message">{message}</p>}
    <section className="kpis">
      <article className="kpi-card accent"><span>Pendientes</span><strong>{pendingCount}</strong><small>Solicitudes aún sin resolución</small></article>
      <article className="kpi-card"><span>Para mi rol</span><strong>{actionableCount}</strong><small>Acciones disponibles ahora</small></article>
      <article className="kpi-card"><span>Rol activo</span><strong>{payload?.membership.role === "administrator" ? "Admin." : payload?.membership.role === "finance" ? "Finanzas" : payload?.membership.role === "operations" ? "Operaciones" : "Auditoría"}</strong><small>Determina los pasos que puedes resolver</small></article>
    </section>
    <section className="table-section"><div className="table-heading"><div><span className="panel-label">SOLICITUDES</span><h2>Decisiones y trazabilidad</h2><p>Una solicitud aprobada o rechazada no puede editarse desde esta bandeja.</p></div></div>
      {loading ? <p className="billing-empty">Cargando aprobaciones…</p> : <div className="approval-inbox-list">{payload?.requests.map((request) => {
        const pendingStep = request.approval_steps.find((step) => step.status === "pending") ?? null;
        const details = request.target_type === "preinvoice" ? preinvoiceDetails(request.metadata) : null;
        return <button className="approval-card" key={request.id} type="button" onClick={() => setSelectedRequestId(request.id)} aria-label={`Abrir solicitud ${request.title}`}>
          <span className="approval-card-top"><span className="panel-label">{typeLabels[request.target_type]} · {request.approval_policies?.name ?? "Política"}</span><span className={`status ${request.status === "approved" ? "paid" : request.status === "rejected" ? "cancelled" : request.status === "submitted" ? "pending" : "neutral"}`}>{statusLabels[request.status]}</span></span>
          <span className="approval-card-title">{request.title}</span><span className="approval-card-description">{request.description || "Sin detalle adicional."}</span>
          <span className="approval-card-amount"><strong>{amount(request.amount, request.currency_code)}</strong><small>Monto sujeto a aprobación</small></span>
          <span className="approval-card-footer"><span>{pendingStep ? `Paso ${pendingStep.step_number} · ${pendingStep.required_role}` : "Flujo finalizado"}</span><span>Abrir detalle →</span></span>
          {details && <span className="approval-card-hint">{details.customerName} · {details.items.length} línea(s)</span>}
        </button>;
      })}</div>}
      {!loading && !payload?.requests.length && <p className="billing-empty">No hay solicitudes de aprobación para esta organización.</p>}
    </section>
    {selectedRequest && (() => {
      const pendingStep = selectedRequest.approval_steps.find((step) => step.status === "pending") ?? null;
      const mayDecide = Boolean(pendingStep && selectedRequest.status === "submitted" && (pendingStep.required_role === payload?.membership.role || payload?.membership.role === "administrator") && !pendingStep.assigned_to);
      const details = selectedRequest.target_type === "preinvoice" ? preinvoiceDetails(selectedRequest.metadata) : null;
      const directDetails = directPayableDetails(selectedRequest.metadata);
      return <div className="modal-backdrop approval-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setSelectedRequestId(null); }}><section className="entry-modal approval-modal" role="dialog" aria-modal="true" aria-labelledby="approval-modal-title"><div className="modal-header"><div><span className="panel-label">{typeLabels[selectedRequest.target_type]} · {selectedRequest.approval_policies?.name ?? "Política"}</span><h2 id="approval-modal-title">{selectedRequest.title}</h2><p>{selectedRequest.description || "Sin detalle adicional."}</p></div><div className="approval-modal-header-actions"><span className={`status ${selectedRequest.status === "approved" ? "paid" : selectedRequest.status === "rejected" ? "cancelled" : selectedRequest.status === "submitted" ? "pending" : "neutral"}`}>{statusLabels[selectedRequest.status]}</span><button type="button" className="close-button" onClick={() => setSelectedRequestId(null)} aria-label="Cerrar detalle">×</button></div></div><div className="approval-request-meta"><span><strong>{amount(selectedRequest.amount, selectedRequest.currency_code)}</strong><small>Monto sujeto a aprobación</small></span><span><strong>{selectedRequest.requested_by_name}</strong><small>Solicitada por</small></span><span><strong>{date(selectedRequest.submitted_at)}</strong><small>Enviada</small></span><span><strong>{pendingStep ? `Paso ${pendingStep.step_number}` : "Completada"}</strong><small>{pendingStep ? `Requiere ${pendingStep.required_role}` : "Flujo finalizado"}</small></span></div>{directDetails && <section className="approval-preinvoice-detail"><div><span className="panel-label">DETALLE DEL GASTO</span><h3>{directDetails.description}</h3></div><div className="table-scroll"><table><tbody><tr><th>Proveedor</th><td>{directDetails.supplierName}</td><th>Folio</th><td>{directDetails.invoiceNumber ?? "Sin folio"}</td></tr><tr><th>Tipo</th><td>{directPayableCategory(directDetails.category, directDetails.categoryDetail)}</td><th>Centro de costo</th><td>{directDetails.costCenter ? `${directDetails.costCenter.code} · ${directDetails.costCenter.name}` : "Sin centro asignado"}</td></tr><tr><th>Fecha documento</th><td>{dateOnly(directDetails.issueDate)}</td><th>Vencimiento</th><td>{dateOnly(directDetails.dueDate)}</td></tr><tr><th>Nota / respaldo</th><td colSpan={3}>{directDetails.notes ?? "Sin respaldo adicional."}</td></tr></tbody></table></div></section>}{details && <section className="approval-preinvoice-detail"><div><span className="panel-label">DETALLE A APROBAR</span><h3>{details.customerName} · período {details.period}</h3></div>{details.items.length ? <div className="table-scroll"><table><thead><tr><th>Servicio / producto</th><th className="money-col">Cantidad</th><th className="money-col">Precio unitario</th><th className="money-col">Neto</th></tr></thead><tbody>{details.items.map((item, index) => <tr key={`${item.description}-${index}`}><td>{item.description}</td><td className="money-col">{item.quantity}</td><td className="money-col">{amount(item.unit_price, selectedRequest.currency_code)}</td><td className="money-col">{amount(item.net_amount, selectedRequest.currency_code)}</td></tr>)}</tbody></table></div> : <p className="billing-empty">No se encontraron líneas en esta solicitud.</p>}</section>}{selectedRequest.approval_steps.map((step) => <div className="approval-step" key={step.id}><div><strong>Paso {step.step_number}: {step.required_role}</strong><small>{step.status === "pending" ? "Pendiente de decisión" : `${step.status === "approved" ? "Aprobado" : step.status === "rejected" ? "Rechazado" : "Omitido"} · ${date(step.decided_at)}`}{step.decision_comment ? ` · ${step.decision_comment}` : ""}</small></div>{mayDecide && step.id === pendingStep?.id && <div className="approval-decision"><textarea aria-label={`Comentario para ${selectedRequest.title}`} maxLength={2000} value={comments[step.id] ?? ""} onChange={(event) => setComments((current) => ({ ...current, [step.id]: event.target.value }))} placeholder="Comentario (opcional)" /><div><button className="secondary-button" type="button" disabled={savingStepId === step.id} onClick={() => void decide(step, "rejected")}>Rechazar</button><button className="primary-button" type="button" disabled={savingStepId === step.id} onClick={() => void decide(step, "approved")}>{savingStepId === step.id ? "Guardando…" : "Aprobar"}</button></div></div>}</div>)}</section></div>;
    })()}
  </main>;
}
