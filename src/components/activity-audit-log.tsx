"use client";

import { useEffect, useMemo, useState } from "react";

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
  const [filters, setFilters] = useState({ actorId: "", from: "", to: "", entityType: "", action: "", search: "" });

  async function load() {
    if (!organizationId) { setPayload(null); setLoading(false); return; }
    setLoading(true);
    const query = new URLSearchParams({ organizationId });
    if (filters.actorId) query.set("actorId", filters.actorId);
    if (filters.from) query.set("from", filters.from);
    if (filters.to) query.set("to", filters.to);
    if (filters.entityType) query.set("entityType", filters.entityType);
    if (filters.action) query.set("action", filters.action);
    const response = await fetch(`/api/audit-log?${query.toString()}`, { cache: "no-store" });
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

  useEffect(() => { void load(); }, [organizationId, filters.actorId, filters.from, filters.to, filters.entityType, filters.action]);

  const actors = useMemo(() => {
    const values = new Map<string, string>();
    for (const event of payload?.events ?? []) if (event.actor_id) values.set(event.actor_id, actor(event));
    return [...values.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  }, [payload]);
  const entityTypes = useMemo(() => [...new Set((payload?.events ?? []).map((event) => event.entity_type))].sort(), [payload]);
  const actions = useMemo(() => [...new Set((payload?.events ?? []).map((event) => event.action))].sort(), [payload]);
  const visibleEvents = useMemo(() => {
    const search = filters.search.trim().toLocaleLowerCase();
    if (!search) return payload?.events ?? [];
    return (payload?.events ?? []).filter((event) => `${actor(event)} ${changeSummary(event)} ${event.entity_type} ${event.action}`.toLocaleLowerCase().includes(search));
  }, [filters.search, payload]);

  function clearFilters() {
    setFilters({ actorId: "", from: "", to: "", entityType: "", action: "", search: "" });
  }

  return <main className="dashboard">
    <section className="headline"><div><span className="eyebrow">ADMINISTRACIÓN · AUDITORÍA</span><h1>Bitácora de actividad</h1><p>Registro inalterable de cambios por usuario: qué se modificó, quién lo hizo y cuándo ocurrió.</p></div><button className="secondary-button" type="button" disabled={loading} onClick={() => void load()}>{loading ? "Actualizando…" : "Actualizar"}</button></section>
    {message && <p className="operation-message">{message}</p>}
    <section className="table-section"><div className="table-heading"><div><span className="panel-label">TRAZABILIDAD FILTRABLE</span><h2>Quién hizo qué y cuándo</h2><p>Los eventos se registran desde la base de datos y no se pueden editar desde esta vista.</p></div><button type="button" className="secondary-button" onClick={clearFilters}>Limpiar filtros</button></div>
      <div className="expense-filter-row audit-filter-row"><label><span>Usuario</span><select value={filters.actorId} onChange={(event) => setFilters((current) => ({ ...current, actorId: event.target.value }))}><option value="">Todos los usuarios</option><option value="system">Sistema automático</option>{actors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><label><span>Desde</span><input type="date" value={filters.from} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} /></label><label><span>Hasta</span><input type="date" value={filters.to} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} /></label><label><span>Objeto</span><select value={filters.entityType} onChange={(event) => setFilters((current) => ({ ...current, entityType: event.target.value }))}><option value="">Todos los objetos</option>{entityTypes.map((item) => <option key={item} value={item}>{entityLabels[item] ?? item.replaceAll("_", " ")}</option>)}</select></label><label><span>Acción</span><select value={filters.action} onChange={(event) => setFilters((current) => ({ ...current, action: event.target.value }))}><option value="">Todas las acciones</option>{actions.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label><span>Buscar</span><input value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Usuario, cambio o acción" /></label></div>
      {!loading && <p className="table-count">{visibleEvents.length} evento(s) encontrado(s)</p>}
      {loading ? <p className="billing-empty">Cargando bitácora…</p> : <div className="table-scroll"><table><thead><tr><th>Usuario</th><th>Acción / cambio</th><th>Fecha y hora</th></tr></thead><tbody>{visibleEvents.map((event) => <tr key={event.id}><td><strong>{actor(event)}</strong><small>{event.actor?.email && event.actor.full_name ? event.actor.email : event.actor_id ? "Usuario registrado" : "Proceso automático"}</small></td><td>{changeSummary(event)}</td><td>{when(event.created_at)}</td></tr>)}</tbody></table></div>}{!loading && !visibleEvents.length && <p className="billing-empty">No hay eventos para los filtros seleccionados.</p>}</section>
  </main>;
}
