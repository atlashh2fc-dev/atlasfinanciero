"use client";

import { useEffect, useState } from "react";

type JsonRecord = Record<string, unknown> | null;
type AuditEvent = {
  id: number;
  actor_id: string | null;
  actor: { full_name: string | null; email: string | null } | null;
  entity_type: string;
  entity_id: string | null;
  action: string;
  before_state: JsonRecord;
  after_state: JsonRecord;
  created_at: string;
};
type Payload = { events: AuditEvent[] };

const entityLabels: Record<string, string> = {
  approval_request: "solicitud de aprobación",
  approval_step: "paso de aprobación",
  financial_plan_version: "versión de presupuesto",
  financial_budget_line: "línea de presupuesto",
  cash_forecast_adjustment: "ajuste de caja",
  profitability_cost_allocation: "asignación de costo",
  issued_document: "documento emitido",
  forecast_line: "línea de proyección",
};
const fieldLabels: Record<string, string> = {
  status: "estado",
  total_amount: "monto total",
  net_amount: "monto neto",
  vat_amount: "IVA",
  role: "rol",
  required_role: "rol aprobador",
  amount: "monto",
  title: "título",
  description: "descripción",
  notes: "notas",
  payment_status: "estado de pago",
};

function actor(event: AuditEvent) {
  return event.actor?.full_name || event.actor?.email || (event.actor_id ? "Usuario eliminado o sin perfil" : "Sistema");
}

function changedFields(before: JsonRecord, after: JsonRecord) {
  if (!before || !after) return [];
  return Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]) && !["updated_at", "created_at"].includes(key)).slice(0, 4);
}

function changeSummary(event: AuditEvent) {
  const entity = entityLabels[event.entity_type] ?? event.entity_type.replaceAll("_", " ");
  if (event.action === "insert") return `Creó ${entity}`;
  if (event.action === "delete") return `Eliminó ${entity}`;
  const fields = changedFields(event.before_state, event.after_state).map((field) => fieldLabels[field] ?? field.replaceAll("_", " "));
  return fields.length ? `Actualizó ${entity}: ${fields.join(", ")}` : `Actualizó ${entity}`;
}

function when(value: string) {
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function ActivityAuditLog({ organizationId }: { organizationId: string | null }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    if (!organizationId) { setPayload(null); setLoading(false); return; }
    setLoading(true);
    const response = await fetch(`/api/audit-log?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    const next = await response.json().catch(() => null) as Payload | null;
    if (!response.ok || !next) {
      setPayload(null);
      setMessage(response.status === 403 ? "Sólo los administradores pueden consultar esta bitácora." : "No fue posible cargar la bitácora.");
    } else {
      setPayload(next);
      setMessage(null);
    }
    setLoading(false);
  }

  useEffect(() => { void load(); }, [organizationId]);

  return <main className="dashboard">
    <section className="headline"><div><span className="eyebrow">ADMINISTRACIÓN · AUDITORÍA</span><h1>Bitácora de actividad</h1><p>Registro inalterable de cambios por usuario: qué se modificó, quién lo hizo y cuándo ocurrió.</p></div><button className="secondary-button" type="button" disabled={loading} onClick={() => void load()}>{loading ? "Actualizando…" : "Actualizar"}</button></section>
    {message && <p className="operation-message">{message}</p>}
    <section className="table-section"><div className="table-heading"><div><span className="panel-label">ÚLTIMOS 250 EVENTOS</span><h2>Trazabilidad operativa</h2><p>Los eventos se registran desde la base de datos y no se pueden editar desde esta vista.</p></div></div>{loading ? <p className="billing-empty">Cargando bitácora…</p> : <div className="table-scroll"><table><thead><tr><th>Usuario</th><th>Acción / cambio</th><th>Fecha y hora</th></tr></thead><tbody>{payload?.events.map((event) => <tr key={event.id}><td><strong>{actor(event)}</strong><small>{event.actor?.email && event.actor.full_name ? event.actor.email : event.actor_id ? "Usuario registrado" : "Proceso automático"}</small></td><td>{changeSummary(event)}</td><td>{when(event.created_at)}</td></tr>)}</tbody></table></div>}{!loading && !payload?.events.length && <p className="billing-empty">Aún no hay eventos auditables para esta organización.</p>}</section>
  </main>;
}
