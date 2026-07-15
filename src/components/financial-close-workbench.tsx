"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Role = "administrator" | "finance" | "operations" | "auditor";
type PeriodStatus = "open" | "soft_closed" | "closed" | "locked";
type TaskStatus = "pending" | "completed" | "not_applicable";
type Period = { id: string; period_start: string; period_end: string; status: PeriodStatus; closed_at: string | null; notes: string | null };
type CloseTask = { id: string; financial_period_id: string; task_code: string; title: string; description: string | null; status: TaskStatus; evidence_note: string | null; completed_at: string | null; completed_by: string | null; updated_at: string };
type CloseEvent = { id: number; financial_period_id: string; from_status: PeriodStatus | null; to_status: PeriodStatus; reason: string | null; actor_id: string | null; created_at: string };
type AccountingEntry = { id: string; financial_period_id: string; status: "draft" | "posted" | "reversed" };
type DatedDocument = { id: string; issue_date: string | null; total_amount: number | string | null };
type BankTransaction = { id: string; booked_on: string; reconciliation_status: "pending" | "partially_reconciled" | "reconciled" };
type Payload = { role: Role | null; periods: Period[]; tasks: CloseTask[]; events: CloseEvent[]; entries: AccountingEntry[]; issuedDocuments: DatedDocument[]; receivedDocuments: DatedDocument[]; bankTransactions: BankTransaction[] };

const labels: Record<PeriodStatus, string> = { open: "Abierto", soft_closed: "Pre-cierre", closed: "Cerrado", locked: "Bloqueado" };
const taskLabels: Record<TaskStatus, string> = { pending: "Pendiente", completed: "Completado", not_applicable: "No aplica" };
const formatDate = new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" });

function inPeriod(date: string | null, period: Period) {
  return !!date && date >= period.period_start && date <= period.period_end;
}

function periodName(period: Period) {
  return new Intl.DateTimeFormat("es-CL", { month: "long", year: "numeric" }).format(new Date(`${period.period_start}T00:00:00`));
}

export function FinancialCloseWorkbench({ organizationId }: { organizationId: string | null }) {
  const [data, setData] = useState<Payload | null>(null);
  const [periodId, setPeriodId] = useState<string>("");
  const [periodStart, setPeriodStart] = useState(new Date().toISOString().slice(0, 7));
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function load() {
    if (!organizationId) { setData(null); setLoading(false); return; }
    setLoading(true);
    const response = await fetch(`/api/financial-close?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as Payload | null;
    if (response.ok && payload) {
      setData(payload);
      setPeriodId((current) => current && payload.periods.some((period) => period.id === current) ? current : payload.periods[0]?.id ?? "");
      setMessage(null);
    } else {
      setData(null);
      setMessage(response.status === 403 ? "Tu rol no puede acceder al cierre financiero." : "No fue posible cargar los períodos financieros.");
    }
    setLoading(false);
  }

  useEffect(() => { void load(); }, [organizationId]);

  const period = useMemo(() => data?.periods.find((item) => item.id === periodId) ?? null, [data, periodId]);
  const tasks = useMemo(() => data?.tasks.filter((task) => task.financial_period_id === period?.id) ?? [], [data, period]);
  const events = useMemo(() => data?.events.filter((event) => event.financial_period_id === period?.id) ?? [], [data, period]);
  const metrics = useMemo(() => {
    if (!period || !data) return { pendingTasks: 0, draftEntries: 0, unreconciled: 0, documents: 0 };
    return {
      pendingTasks: tasks.filter((task) => task.status === "pending").length,
      draftEntries: data.entries.filter((entry) => entry.financial_period_id === period.id && entry.status === "draft").length,
      unreconciled: data.bankTransactions.filter((item) => inPeriod(item.booked_on, period) && item.reconciliation_status !== "reconciled").length,
      documents: data.issuedDocuments.filter((item) => inPeriod(item.issue_date, period)).length + data.receivedDocuments.filter((item) => inPeriod(item.issue_date, period)).length,
    };
  }, [data, period, tasks]);
  const canManage = data?.role === "administrator" || data?.role === "finance";
  const isAdmin = data?.role === "administrator";

  async function request(body: Record<string, unknown>) {
    if (!organizationId) return false;
    setSaving(true);
    const response = await fetch("/api/financial-close", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, ...body }) });
    const payload = await response.json().catch(() => null) as { error?: string; detail?: string } | null;
    setSaving(false);
    if (!response.ok) {
      setMessage(payload?.detail || "No fue posible completar la operación. Revisa el checklist y los permisos.");
      return false;
    }
    await load();
    return true;
  }

  async function createPeriod(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await request({ action: "create_period", periodStart: `${periodStart}-01` })) setMessage("Período creado con su checklist de cierre.");
  }

  async function setTask(task: CloseTask, status: TaskStatus) {
    const evidenceNote = status === "pending" ? "" : window.prompt("Evidencia o comentario de revisión (opcional):", task.evidence_note ?? "") ?? null;
    if (evidenceNote === null) return;
    if (await request({ action: "update_task", taskId: task.id, status, evidenceNote })) setMessage(`Checklist actualizado: ${taskLabels[status]}.`);
  }

  async function transition(targetStatus: PeriodStatus) {
    if (!period) return;
    let reason: string | undefined;
    if (targetStatus === "open") {
      reason = window.prompt("Motivo obligatorio para reabrir este período:")?.trim();
      if (!reason) return;
    }
    if (targetStatus === "closed" || targetStatus === "locked") {
      const verb = targetStatus === "locked" ? "bloquear definitivamente" : "cerrar";
      if (!window.confirm(`¿Confirmas ${verb} ${periodName(period)}? Los asientos y su checklist quedarán sin edición.`)) return;
    }
    if (await request({ action: "transition", periodId: period.id, targetStatus, reason })) setMessage(`Período ${labels[targetStatus].toLocaleLowerCase()} correctamente.`);
  }

  return <main className="dashboard billing-dashboard">
    <section className="headline">
      <div><span className="eyebrow">CIERRE FINANCIERO</span><h1>Control de período, evidencia y bloqueo</h1><p>Centraliza las revisiones antes de cerrar. El cierre protege los asientos contables y deja una bitácora de cada transición.</p></div>
      <div className="headline-actions"><button type="button" className="secondary-button" onClick={() => void load()} disabled={loading || saving}>Actualizar</button></div>
    </section>
    {message && <p className="operation-message">{message}</p>}
    {loading ? <section className="panel billing-empty"><p>Cargando control de cierre…</p></section> : !data ? <section className="panel billing-empty"><p>Selecciona una empresa para consultar sus cierres financieros.</p></section> : <>
      <section className="billing-form-panel panel">
        <div className="panel-heading"><div><span className="panel-label">NUEVO PERÍODO</span><h2>Crear un mes de control</h2></div><span className="unit">Finanzas y administración</span></div>
        <form className="billing-form" onSubmit={createPeriod}><label>Mes<input type="month" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} required /></label><p className="form-note">Se crean cinco verificaciones estándar: documentos, bancos, aging, asientos y revisión de gestión.</p><button className="primary-button" disabled={!canManage || saving} type="submit">Crear período</button></form>
      </section>

      {!period ? <section className="panel billing-empty"><p>No hay períodos todavía. Crea el primer mes para iniciar el control de cierre.</p></section> : <>
        <section className="table-section"><div className="table-heading"><div><span className="panel-label">PERÍODO ACTIVO</span><h2>{periodName(period)}</h2><p>{formatDate.format(new Date(`${period.period_start}T00:00:00`))} al {formatDate.format(new Date(`${period.period_end}T00:00:00`))} · <span className={`status ${period.status === "open" ? "pending" : period.status === "soft_closed" ? "pending" : "paid"}`}>{labels[period.status]}</span></p></div><label>Seleccionar período<select value={period.id} onChange={(event) => setPeriodId(event.target.value)}>{data.periods.map((item) => <option key={item.id} value={item.id}>{periodName(item)} · {labels[item.status]}</option>)}</select></label></div></section>
        <section className="kpis billing-kpis" aria-label="Controles de cierre"><article className="kpi-card"><span>Checklist pendiente</span><strong>{metrics.pendingTasks}</strong><small>Debe estar resuelto al cerrar</small></article><article className="kpi-card"><span>Asientos borrador</span><strong>{metrics.draftEntries}</strong><small>Bloquean el cierre formal</small></article><article className="kpi-card accent"><span>Banco sin conciliar</span><strong>{metrics.unreconciled}</strong><small>Control operativo del período</small></article><article className="kpi-card"><span>Documentos revisables</span><strong>{metrics.documents}</strong><small>Ventas y gastos del mes</small></article></section>
        <section className="table-section"><div className="table-heading"><div><span className="panel-label">CHECKLIST</span><h2>Preparar y evidenciar el cierre</h2><p>Un período cerrado o bloqueado no permite cambiar estas evidencias. Los movimientos bancarios pendientes se muestran como alerta, pero la decisión queda documentada en el checklist.</p></div></div><div className="table-scroll"><table className="billing-cycles-table"><thead><tr><th>Control</th><th>Estado</th><th>Evidencia</th><th>Acción</th></tr></thead><tbody>{tasks.map((task) => <tr key={task.id}><td><strong>{task.title}</strong><small>{task.description}</small></td><td><span className={`status ${task.status === "pending" ? "pending" : "paid"}`}>{taskLabels[task.status]}</span></td><td><small>{task.evidence_note || "Sin comentario"}{task.completed_at ? ` · ${formatDate.format(new Date(task.completed_at))}` : ""}</small></td><td><div className="cycle-actions">{period.status === "open" || period.status === "soft_closed" ? <><button className="secondary-button" type="button" disabled={!canManage || saving} onClick={() => void setTask(task, "completed")}>Completar</button><button className="text-button" type="button" disabled={!canManage || saving} onClick={() => void setTask(task, "not_applicable")}>No aplica</button>{task.status !== "pending" && <button className="text-button" type="button" disabled={!canManage || saving} onClick={() => void setTask(task, "pending")}>Reabrir</button>}</> : <small>Checklist bloqueado</small>}</div></td></tr>)}</tbody></table></div></section>
        <section className="billing-form-panel panel"><div className="panel-heading"><div><span className="panel-label">TRANSICIÓN CONTROLADA</span><h2>Estado del período</h2></div></div><div className="headline-actions">{period.status === "open" && <button className="secondary-button" disabled={!canManage || saving} type="button" onClick={() => void transition("soft_closed")}>Iniciar pre-cierre</button>}{(period.status === "open" || period.status === "soft_closed") && <button className="primary-button" disabled={!canManage || saving || metrics.pendingTasks > 0 || metrics.draftEntries > 0} type="button" onClick={() => void transition("closed")}>Cerrar período</button>}{period.status === "closed" && <button className="primary-button" disabled={!canManage || saving} type="button" onClick={() => void transition("locked")}>Bloquear período</button>}{(period.status === "soft_closed" || period.status === "closed" || period.status === "locked") && <button className="text-button" disabled={!isAdmin || saving} type="button" onClick={() => void transition("open")}>Reabrir (administrador)</button>}</div>{(metrics.pendingTasks > 0 || metrics.draftEntries > 0) && (period.status === "open" || period.status === "soft_closed") && <p className="form-note">Para cerrar faltan {metrics.pendingTasks} control(es) y {metrics.draftEntries} asiento(s) en borrador.</p>}</section>
        <section className="table-section"><div className="table-heading"><div><span className="panel-label">AUDITORÍA</span><h2>Bitácora de transiciones</h2></div></div><div className="table-scroll"><table className="billing-cycles-table"><thead><tr><th>Fecha</th><th>Transición</th><th>Motivo</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}><td>{formatDate.format(new Date(event.created_at))}</td><td>{event.from_status ? `${labels[event.from_status]} → ` : ""}<strong>{labels[event.to_status]}</strong></td><td>{event.reason || "—"}</td></tr>)}</tbody></table></div>{!events.length && <p className="billing-empty">Aún no hay cambios de estado para este período.</p>}</section>
      </>}
    </>}
  </main>;
}
