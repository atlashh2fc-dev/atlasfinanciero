"use client";

import { useCallback, useEffect, useState } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type PayrollPerson = {
  id: string;
  name: string;
  nationalIdentification: string | null;
  active: boolean;
  management: string | null;
  jobTitle: string | null;
  contractType: string | null;
  contractStatus: string | null;
  monthlyGrossSalary: number | null;
  absenceDays: number;
  vacationDays: number;
};
type PayrollPayload = {
  integration: { active: boolean; lastSyncAt: string | null; lastSyncStatus: string; lastPeriodMonth: string | null } | null;
  summary: { activePeople: number; activeContracts: number; monthlyGrossTotal: number; averageGross: number; absenceDays: number; vacationDays: number; periodYear: number };
  costCenters: Array<{ name: string; amount: number }>;
  persons: PayrollPerson[];
  incomeStatement: Array<{ period: string; revenue: number; payroll: number; operatingResultBeforeOtherExpenses: number; payrollAvailable: boolean }>;
};

const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const amount = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 1 });

function formatDate(value: string | null) {
  if (!value) return "Aún sin sincronización";
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function maskRut(value: string | null) {
  if (!value) return "—";
  const compact = value.replace(/\s/g, "");
  return compact.length > 4 ? `${compact.slice(0, 2)}.•••.${compact.slice(-3)}` : "••••";
}

export function PayrollDashboard({ organizationId, canSynchronize }: { organizationId: string | null; canSynchronize: boolean }) {
  const [payload, setPayload] = useState<PayrollPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [year, setYear] = useState(() => new Date().getFullYear());

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    const response = await fetch(`/api/integrations/peoplework/summary?organizationId=${encodeURIComponent(organizationId)}&year=${year}`);
    if (response.ok) setPayload(await response.json() as PayrollPayload);
    else setMessage("No fue posible cargar la información de remuneraciones con tu sesión actual.");
    setLoading(false);
  }, [organizationId, year]);

  useEffect(() => { void load(); }, [load]);

  async function synchronize() {
    if (!organizationId || syncing) return;
    setSyncing(true);
    setMessage(null);
    const response = await fetch("/api/integrations/peoplework/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, year }) });
    const result = await response.json().catch(() => null) as { error?: string; detail?: string; summary?: { employees: number; contracts: number } } | null;
    if (!response.ok) setMessage(result?.detail ?? "No fue posible sincronizar PeopleWork. Revisa la configuración y vuelve a intentarlo.");
    else {
      setMessage(`Sincronización ${year} completada: ${result?.summary?.employees ?? 0} personas y ${result?.summary?.contracts ?? 0} contratos actualizados.`);
      await load();
    }
    setSyncing(false);
  }

  if (loading) return <main className="dashboard"><p className="operation-message">Cargando módulo de remuneraciones…</p></main>;
  if (!payload) return <main className="dashboard"><p className="operation-message">{message ?? "No hay información disponible."}</p></main>;

  const { summary } = payload;
  return <main className="dashboard payroll-dashboard">
    <section className="headline">
      <div><span className="eyebrow">PERSONAS · PEOPLEWORK</span><h1>Remuneraciones y dotación</h1><p>Lectura financiera de contratos, distribución de remuneración bruta contractual y resultado operacional previo a otros gastos para {summary.periodYear}.</p></div>
      <div className="headline-actions">
        <label className="period-picker">Período<select value={year} onChange={(event) => setYear(Number(event.target.value))}>{Array.from({ length: Math.min(7, new Date().getFullYear() - 2019) }, (_, index) => new Date().getFullYear() - index).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <span className="refresh">{payload.integration?.lastSyncAt ? `Actualizado ${formatDate(payload.integration.lastSyncAt)}` : "Sin datos sincronizados"}</span>
        {canSynchronize && <button className="primary-button" type="button" onClick={() => void synchronize()} disabled={syncing}>{syncing ? "Sincronizando…" : `Sincronizar ${year}`}</button>}
      </div>
    </section>

    {message && <p className="operation-message">{message}</p>}

    <section className="kpis kpis-five" aria-label="Indicadores de remuneraciones">
      <article className="kpi-card"><span>Dotación activa</span><strong>{summary.activePeople}</strong><small>Colaboradores marcados activos en PeopleWork</small></article>
      <article className="kpi-card"><span>Contratos vigentes</span><strong>{summary.activeContracts}</strong><small>Contratos sin fecha de término vencida</small></article>
      <article className="kpi-card accent"><span>Remuneración bruta contractual</span><strong>{money.format(summary.monthlyGrossTotal)}</strong><small>Base mensual vigente; no equivale a costo pagado</small></article>
      <article className="kpi-card"><span>Promedio contractual</span><strong>{money.format(summary.averageGross)}</strong><small>Bruto mensual por contrato vigente</small></article>
      <article className="kpi-card"><span>Ausencias / vacaciones</span><strong>{amount.format(summary.absenceDays)} / {amount.format(summary.vacationDays)}</strong><small>Días agregados reportados en {summary.periodYear}</small></article>
    </section>

    <section className="visual-grid">
      <article className="panel payroll-chart-panel"><div className="panel-heading"><div><span className="panel-label">DISTRIBUCIÓN</span><h2>Base contractual por centro de costo</h2></div><span className="unit">CLP / mes</span></div><div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><BarChart data={payload.costCenters.slice(0, 8)} layout="vertical" margin={{ top: 8, right: 20, left: 10, bottom: 0 }}><XAxis type="number" hide /><YAxis type="category" dataKey="name" width={120} tickLine={false} axisLine={false} tick={{ fill: "#58657a", fontSize: 11 }} /><Tooltip formatter={(value) => money.format(Number(value))} contentStyle={{ borderRadius: 10, border: "1px solid #e6e9ef" }} /><Bar dataKey="amount" radius={[0, 6, 6, 0]} fill="#20a67a" /></BarChart></ResponsiveContainer></div></article>
      <article className="panel payroll-data-scope"><div className="panel-heading"><div><span className="panel-label">ALCANCE DEL DATO</span><h2>Lectura responsable</h2></div></div><div className="payroll-scope-list"><p><strong>Incluido:</strong> personas, contratos, centros de costo y días agregados.</p><p><strong>Histórico:</strong> se reconstruye por vigencia de contrato y remuneración bruta contractual de cada período.</p><p><strong>No disponible en el API:</strong> liquidaciones, descuentos, imposiciones y costo empleador pagado.</p></div></article>
    </section>

    <section className="panel income-statement-panel"><div className="panel-heading"><div><span className="panel-label">EERR OPERACIONAL · {year}</span><h2>Ingresos netos vs. remuneración bruta contractual</h2><p>Resultado antes de gastos de proveedores, remuneraciones variables, imposiciones e impuestos. Sólo se muestra costo cuando el período fue sincronizado.</p></div><span className="unit">CLP neto/exento</span></div><div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><BarChart data={payload.incomeStatement.map((item) => ({ ...item, month: new Intl.DateTimeFormat("es-CL", { month: "short" }).format(new Date(`${item.period}-01T00:00:00`)) }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fill: "#7e8ba0", fontSize: 11 }} /><YAxis hide /><Tooltip formatter={(value) => money.format(Number(value))} contentStyle={{ borderRadius: 10, border: "1px solid #e6e9ef" }} /><Bar dataKey="revenue" name="Ingresos netos" fill="#5968df" radius={[5, 5, 0, 0]} /><Bar dataKey="payroll" name="Remuneración bruta contractual" fill="#d85f6c" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div><div className="table-scroll"><table><thead><tr><th>Período</th><th className="money-col">Ingresos netos</th><th className="money-col">Remuneración contractual</th><th className="money-col">Resultado previo a otros gastos</th><th>Base de remuneraciones</th></tr></thead><tbody>{payload.incomeStatement.map((item) => <tr key={item.period}><td>{new Intl.DateTimeFormat("es-CL", { month: "long", year: "numeric" }).format(new Date(`${item.period}-01T00:00:00`))}</td><td className="money-col">{money.format(item.revenue)}</td><td className="money-col">{item.payrollAvailable ? money.format(item.payroll) : "—"}</td><td className={`money-col ${item.payrollAvailable && item.operatingResultBeforeOtherExpenses < 0 ? "is-negative" : ""}`}>{item.payrollAvailable ? money.format(item.operatingResultBeforeOtherExpenses) : "—"}</td><td><span className={item.payrollAvailable ? "status paid" : "status neutral"}>{item.payrollAvailable ? "Contractual reconstruida" : "Pendiente de sincronizar"}</span></td></tr>)}</tbody></table></div></section>

    <section className="table-section">
      <div className="table-heading"><div><span className="panel-label">DOTACIÓN</span><h2>Detalle por persona</h2><p>{payload.persons.length} colaborador(es) sincronizados. El identificador tributario se muestra parcialmente protegido.</p></div><button type="button" className="secondary-button" onClick={() => void load()}>Actualizar</button></div>
      <div className="table-scroll"><table className="payroll-people-table"><thead><tr><th>Colaborador</th><th>Área / cargo</th><th>Contrato</th><th className="money-col">Bruto contractual</th><th className="money-col">Ausencias</th><th className="money-col">Vacaciones</th><th>Estado</th></tr></thead><tbody>{payload.persons.map((person) => <tr key={person.id}><td><strong>{person.name}</strong><small>RUT {maskRut(person.nationalIdentification)}</small></td><td><strong>{person.management ?? "—"}</strong><small>{person.jobTitle ?? "Sin cargo informado"}</small></td><td>{person.contractType ?? "—"}<small>{person.contractStatus ?? "Vigencia no informada"}</small></td><td className="money-col">{person.monthlyGrossSalary === null ? "—" : money.format(person.monthlyGrossSalary)}</td><td className="money-col">{amount.format(person.absenceDays)} días</td><td className="money-col">{amount.format(person.vacationDays)} días</td><td><span className={`status ${person.active ? "paid" : "neutral"}`}>{person.active ? "Activo" : "Inactivo"}</span></td></tr>)}</tbody></table></div>
    </section>
  </main>;
}
