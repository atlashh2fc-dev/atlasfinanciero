"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Organization = { id: string; legal_name: string };
type Counterparty = { id: string; organization_id: string; legal_name: string };
type RecurrenceRule = {
  id: string;
  organization_id: string;
  counterparty_id: string;
  name: string;
  expected_net_amount: number | null;
  currency_code: string;
  deadline_day: number;
  reminder_days_before: number;
  status: "active" | "paused" | "archived";
};
type BillingCycle = {
  id: string;
  organization_id: string;
  recurrence_rule_id: string;
  period_month: string;
  due_date: string;
  expected_net_amount: number | null;
  currency_code: string;
  status: "pending" | "ready" | "issued" | "skipped";
  issued_document_id: string | null;
};
type BillingAlert = {
  id: string;
  organization_id: string;
  alert_type: "preparation_required" | "deadline_breached";
  due_date: string;
  recurrence_name: string;
  counterparty_name: string;
};
type BillingPayload = { organizations: Organization[]; counterparties: Counterparty[]; rules: RecurrenceRule[]; cycles: BillingCycle[] };

const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });

function displayDate(value: string) {
  return new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value}T00:00:00`));
}

function monthName(value: string) {
  return new Intl.DateTimeFormat("es-CL", { month: "long", year: "numeric" }).format(new Date(`${value}T00:00:00`));
}

export function BillingOperations({ organizationId: activeOrganizationId }: { organizationId: string | null }) {
  const [data, setData] = useState<BillingPayload | null>(null);
  const [alerts, setAlerts] = useState<BillingAlert[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [counterpartyId, setCounterpartyId] = useState("");
  const [name, setName] = useState("");
  const [expectedNetAmount, setExpectedNetAmount] = useState("");
  const [reminderDaysBefore, setReminderDaysBefore] = useState("3");
  const [message, setMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  async function load() {
    if (!activeOrganizationId) return;
    setIsLoading(true);
    const [response, alertsResponse] = await Promise.all([
      fetch(`/api/billing/recurrences?organizationId=${encodeURIComponent(activeOrganizationId)}`, { cache: "no-store" }),
      fetch(`/api/billing/alerts?organizationId=${encodeURIComponent(activeOrganizationId)}`, { cache: "no-store" }),
    ]);
    if (!response.ok) {
      setData(null);
      setAlerts([]);
      setMessage(response.status === 401 ? "Inicia sesión con un usuario de Finanzas para operar recurrencias." : "No fue posible cargar la operación de facturación.");
      setIsLoading(false);
      return;
    }
    const payload = await response.json() as BillingPayload;
    const alertsPayload = alertsResponse.ok ? await alertsResponse.json() as { alerts?: BillingAlert[] } : null;
    setData(payload);
    setAlerts(alertsPayload?.alerts ?? []);
    setOrganizationId(activeOrganizationId);
    setMessage(null);
    setIsLoading(false);
  }

  useEffect(() => { void load(); }, [activeOrganizationId]);

  const counterparties = useMemo(() => data?.counterparties.filter((item) => item.organization_id === organizationId) ?? [], [data, organizationId]);
  const rules = useMemo(() => data?.rules.filter((item) => item.organization_id === organizationId) ?? [], [data, organizationId]);
  const cycles = useMemo(() => data?.cycles.filter((item) => item.organization_id === organizationId) ?? [], [data, organizationId]);
  const organizationAlerts = useMemo(() => alerts.filter((item) => item.organization_id === organizationId), [alerts, organizationId]);
  const counterpartyNames = useMemo(() => new Map((data?.counterparties ?? []).map((item) => [item.id, item.legal_name])), [data]);
  const rulesById = useMemo(() => new Map(rules.map((item) => [item.id, item])), [rules]);

  useEffect(() => {
    if (!counterparties.some((item) => item.id === counterpartyId)) setCounterpartyId(counterparties[0]?.id ?? "");
  }, [counterparties, counterpartyId]);

  async function refreshAlerts() {
    if (!organizationId) return;
    setIsSaving(true);
    const response = await fetch("/api/billing/alerts/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId }) });
    setIsSaving(false);
    setMessage(response.ok ? "Ciclos y alertas actualizados." : "No fue posible actualizar las alertas.");
    if (response.ok) await load();
  }

  async function createRecurrence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || !counterpartyId || !name.trim()) {
      setMessage("Selecciona cliente e identifica el servicio recurrente.");
      return;
    }
    setIsSaving(true);
    const response = await fetch("/api/billing/recurrences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId, counterpartyId, name, expectedNetAmount, currencyCode: "CLP", reminderDaysBefore }),
    });
    setIsSaving(false);
    if (!response.ok) {
      setMessage("No fue posible crear la recurrencia. Revisa tu sesión, cliente y permisos.");
      return;
    }
    setName("");
    setExpectedNetAmount("");
    setMessage("Recurrencia creada. El ciclo mensual y sus alertas quedaron actualizados.");
    await load();
  }

  async function changeCycleStatus(cycleId: string, status: "ready" | "skipped") {
    setIsSaving(true);
    const response = await fetch(`/api/billing/cycles/${cycleId}/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    setIsSaving(false);
    setMessage(response.ok ? (status === "ready" ? "Ciclo marcado como listo." : "Ciclo omitido y alertas cerradas.") : "No fue posible actualizar el ciclo.");
    if (response.ok) await load();
  }

  return (
    <main className="dashboard billing-dashboard">
      <section className="headline">
        <div><span className="eyebrow">OPERACIÓN DE FACTURACIÓN</span><h1>Recurrentes y alertas</h1><p>Cada servicio recurrente debe quedar listo a más tardar el día 2. La alerta preventiva se abre antes del vencimiento y escala si el ciclo sigue pendiente.</p></div>
        <div className="headline-actions"><button className="secondary-button" type="button" onClick={() => void refreshAlerts()} disabled={!organizationId || isSaving}>Actualizar alertas</button></div>
      </section>

      {message && <p className="operation-message">{message}</p>}

      {isLoading ? <section className="panel billing-empty"><p>Cargando operación de facturación…</p></section> : !data ? <section className="panel billing-empty"><p>La operación requiere una sesión autenticada y rol Administrador o Finanzas.</p></section> : <>
        <section className="billing-form-panel panel">
          <div className="panel-heading"><div><span className="panel-label">NUEVA RECURRENCIA</span><h2>Control mensual de facturación</h2></div><span className="unit">Límite día 2</span></div>
          <form className="billing-form" onSubmit={createRecurrence}>
            <label>Cliente<select value={counterpartyId} onChange={(event) => setCounterpartyId(event.target.value)} disabled={!counterparties.length}><option value="">Selecciona cliente</option>{counterparties.map((counterparty) => <option key={counterparty.id} value={counterparty.id}>{counterparty.legal_name}</option>)}</select></label>
            <label>Servicio o concepto<input value={name} maxLength={180} onChange={(event) => setName(event.target.value)} placeholder="Ej. Servicio mensual" /></label>
            <label>Monto neto esperado<input value={expectedNetAmount} min="0" step="1" type="number" onChange={(event) => setExpectedNetAmount(event.target.value)} placeholder="Opcional" /></label>
            <label>Aviso previo<select value={reminderDaysBefore} onChange={(event) => setReminderDaysBefore(event.target.value)}><option value="1">1 día</option><option value="2">2 días</option><option value="3">3 días</option><option value="5">5 días</option><option value="7">7 días</option></select></label>
            <button className="primary-button" type="submit" disabled={isSaving || !counterparties.length}>Crear recurrencia</button>
          </form>
        </section>

        <section className="kpis billing-kpis" aria-label="Control de recurrencias">
          <article className="kpi-card"><span>Recurrencias activas</span><strong>{rules.filter((item) => item.status === "active").length}</strong><small>Reglas confirmadas para esta empresa</small></article>
          <article className="kpi-card accent"><span>Ciclos pendientes</span><strong>{cycles.filter((item) => item.status === "pending").length}</strong><small>Requieren preparación o emisión</small></article>
          <article className="kpi-card"><span>Ciclos listos</span><strong>{cycles.filter((item) => item.status === "ready").length}</strong><small>Preparados para su emisión</small></article>
          <article className="kpi-card"><span>Fecha máxima</span><strong>Día 2</strong><small>Regla operativa obligatoria</small></article>
        </section>

        {organizationAlerts.length > 0 && <section className="billing-alert-list" aria-label="Alertas activas de facturación"><div className="panel-heading"><div><span className="panel-label">ALERTAS ACTIVAS</span><h2>Requieren atención</h2></div><span className="unit">{organizationAlerts.length} abierta(s)</span></div><div className="billing-alert-grid">{organizationAlerts.map((alert) => <article key={alert.id} className={alert.alert_type === "deadline_breached" ? "is-overdue" : ""}><span>{alert.alert_type === "deadline_breached" ? "PLAZO VENCIDO" : "PREPARACIÓN REQUERIDA"}</span><strong>{alert.counterparty_name}</strong><p>{alert.recurrence_name} · fecha máxima {displayDate(alert.due_date)}</p></article>)}</div></section>}

        <section className="table-section">
          <div className="table-heading"><div><span className="panel-label">CICLOS MENSUALES</span><h2>Seguimiento de recurrentes</h2><p>Marcar “Listo” cierra la alerta; “Emitido” se vincula al documento real desde el flujo documental.</p></div></div>
          <div className="table-scroll"><table className="billing-cycles-table"><thead><tr><th>Cliente / concepto</th><th>Período</th><th>Vence</th><th className="money-col">Esperado</th><th>Estado</th><th>Acción</th></tr></thead><tbody>{cycles.map((cycle) => {
            const rule = rulesById.get(cycle.recurrence_rule_id);
            return <tr key={cycle.id}><td><strong>{counterpartyNames.get(rule?.counterparty_id ?? "") ?? "Cliente"}</strong><small>{rule?.name ?? "Recurrencia"}</small></td><td>{monthName(cycle.period_month)}</td><td>{displayDate(cycle.due_date)}</td><td className="money-col">{cycle.expected_net_amount === null ? "—" : money.format(cycle.expected_net_amount)}</td><td><span className={`status ${cycle.status === "pending" ? "pending" : cycle.status === "skipped" ? "cancelled" : "paid"}`}>{cycle.status === "pending" ? "Pendiente" : cycle.status === "ready" ? "Listo" : cycle.status === "issued" ? "Emitido" : "Omitido"}</span></td><td>{cycle.status === "pending" ? <div className="cycle-actions"><button type="button" className="secondary-button" disabled={isSaving} onClick={() => void changeCycleStatus(cycle.id, "ready")}>Listo</button><button type="button" className="text-button" disabled={isSaving} onClick={() => void changeCycleStatus(cycle.id, "skipped")}>Omitir</button></div> : "—"}</td></tr>;
          })}</tbody></table></div>
          {!cycles.length && <p className="billing-empty">Aún no existen ciclos para esta empresa. Crea una recurrencia confirmada para iniciar el control.</p>}
        </section>
      </>}
    </main>
  );
}
