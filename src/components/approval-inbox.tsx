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
  submitted_at: string;
  completed_at: string | null;
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

export function ApprovalInbox({ organizationId }: { organizationId: string | null }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [savingStepId, setSavingStepId] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});

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
        const mayDecide = Boolean(pendingStep && request.status === "submitted" && (pendingStep.required_role === payload.membership.role || payload.membership.role === "administrator") && !pendingStep.assigned_to);
        return <article className="panel approval-request" key={request.id}>
          <div className="panel-heading"><div><span className="panel-label">{typeLabels[request.target_type]} · {request.approval_policies?.name ?? "Política"}</span><h2>{request.title}</h2><p>{request.description || "Sin detalle adicional."}</p></div><span className={`status ${request.status === "approved" ? "paid" : request.status === "rejected" ? "cancelled" : request.status === "submitted" ? "pending" : "neutral"}`}>{statusLabels[request.status]}</span></div>
          <div className="approval-request-meta"><span><strong>{amount(request.amount, request.currency_code)}</strong><small>Monto sujeto a aprobación</small></span><span><strong>{date(request.submitted_at)}</strong><small>Enviada</small></span><span><strong>{pendingStep ? `Paso ${pendingStep.step_number}` : "Completada"}</strong><small>{pendingStep ? `Requiere ${pendingStep.required_role}` : "Flujo finalizado"}</small></span></div>
          {request.approval_steps.map((step) => <div className="approval-step" key={step.id}><div><strong>Paso {step.step_number}: {step.required_role}</strong><small>{step.status === "pending" ? "Pendiente de decisión" : `${step.status === "approved" ? "Aprobado" : step.status === "rejected" ? "Rechazado" : "Omitido"} · ${date(step.decided_at)}`}{step.decision_comment ? ` · ${step.decision_comment}` : ""}</small></div>{mayDecide && step.id === pendingStep?.id && <div className="approval-decision"><textarea aria-label={`Comentario para ${request.title}`} maxLength={2000} value={comments[step.id] ?? ""} onChange={(event) => setComments((current) => ({ ...current, [step.id]: event.target.value }))} placeholder="Comentario (opcional)" /><div><button className="secondary-button" type="button" disabled={savingStepId === step.id} onClick={() => void decide(step, "rejected")}>Rechazar</button><button className="primary-button" type="button" disabled={savingStepId === step.id} onClick={() => void decide(step, "approved")}>{savingStepId === step.id ? "Guardando…" : "Aprobar"}</button></div></div>}</div>)}
        </article>;
      })}</div>}
      {!loading && !payload?.requests.length && <p className="billing-empty">No hay solicitudes de aprobación para esta organización.</p>}
    </section>
  </main>;
}
