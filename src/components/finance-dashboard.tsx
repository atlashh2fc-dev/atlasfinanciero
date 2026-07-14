"use client";

import { FormEvent, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { facturasEmitidas2026, type InvoiceRecord } from "@/data/facturas-emitidas-2026";
import { forecastMonthly2026 } from "@/data/forecast-2026";

const calendarMonths = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const pieColors = ["#18a877", "#eeb34d", "#5968df", "#d85f6c", "#8b97aa", "#2a8aa6", "#9d72d7"];

type Role = "Administrador" | "Finanzas" | "Operación" | "Auditor";
type Module = "Inicio" | "Facturas" | "Proyecciones" | "Clientes" | "Cuentas por cobrar" | "Gastos y proveedores" | "Remuneraciones";

type InvoiceDraft = {
  invoiceNumber: string;
  issueDate: string;
  documentType: string;
  issuer: string;
  issuerRut: string;
  client: string;
  recipient: string;
  recipientRut: string;
  netAmount: string;
  vatAmount: string;
  totalAmount: string;
  status: string;
};

const blankDraft: InvoiceDraft = {
  invoiceNumber: "",
  issueDate: "",
  documentType: "",
  issuer: "",
  issuerRut: "",
  client: "",
  recipient: "",
  recipientRut: "",
  netAmount: "",
  vatAmount: "",
  totalAmount: "",
  status: "",
};

const money = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "CLP",
  maximumFractionDigits: 0,
});

const number = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 });

function formatMoney(value: number) {
  return money.format(value);
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" }).format(
    new Date(`${value}T00:00:00`),
  );
}

function monthFromDate(value: string) {
  return calendarMonths[new Date(`${value}T00:00:00`).getMonth()] ?? null;
}

function sum(records: InvoiceRecord[], field: "netAmount" | "totalAmount") {
  return records.reduce((total, record) => total + (record[field] ?? 0), 0);
}

function statusClass(status: string | null) {
  const normalized = status?.toLowerCase() ?? "";
  if (normalized.includes("pagada")) return "status paid";
  if (normalized.includes("pendiente")) return "status pending";
  if (normalized.includes("anulada") || normalized.includes("credito")) return "status cancelled";
  return "status neutral";
}

function EmptyModule({ module }: { module: Exclude<Module, "Inicio" | "Facturas" | "Proyecciones" | "Clientes"> }) {
  const detail: Record<typeof module, string> = {
    "Cuentas por cobrar": "Este módulo usará las fechas de vencimiento y pago de facturas, sin inferir saldos ni reglas de cobranza que no estén definidas.",
    "Gastos y proveedores": "Preparado para documentos recibidos, órdenes de compra, centros de costo y proveedores. Requiere fuente de gastos aprobada.",
    Remuneraciones: "Integración futura para costo de personal. Los datos de remuneraciones no están en el archivo analizado, por lo que esta vista aún no muestra montos.",
  };

  return (
    <main className="module-placeholder">
      <span className="eyebrow">Módulo en preparación</span>
      <h1>{module}</h1>
      <p>{detail[module]}</p>
      <div className="placeholder-grid">
        <article><strong>Fuente requerida</strong><span>Importación validada o registro autorizado</span></article>
        <article><strong>Responsable</strong><span>Definido en la matriz de permisos</span></article>
        <article><strong>Salida</strong><span>Tablas, trazabilidad y KPI sin datos inventados</span></article>
      </div>
    </main>
  );
}

type CustomerEvolution = {
  client: string;
  total: number;
  documents: number;
  withPaymentDate: number;
  pendingNet: number;
  byMonth: Record<string, number>;
};

function buildCustomerEvolution(records: InvoiceRecord[]) {
  const result = records.reduce<Record<string, CustomerEvolution>>((accumulator, record) => {
    const client = record.client || record.recipient || "No informado";
    accumulator[client] ??= { client, total: 0, documents: 0, withPaymentDate: 0, pendingNet: 0, byMonth: {} };
    const current = accumulator[client];
    const amount = record.netAmount ?? 0;
    current.total += amount;
    current.documents += 1;
    if (record.paymentDate) current.withPaymentDate += 1;
    if (record.status === "Pendiente") current.pendingNet += amount;
    if (record.month) current.byMonth[record.month] = (current.byMonth[record.month] ?? 0) + amount;
    return accumulator;
  }, {});
  return Object.values(result).sort((first, second) => second.total - first.total);
}

function CustomerModule({ records }: { records: InvoiceRecord[] }) {
  const [isEvolutionExpanded, setIsEvolutionExpanded] = useState(false);
  const customers = buildCustomerEvolution(records);
  const totalNet = sum(records, "netAmount");
  const topClient = customers[0];
  const pendingNet = customers.reduce((total, client) => total + client.pendingNet, 0);
  const paymentDateCount = customers.reduce((total, client) => total + client.withPaymentDate, 0);

  return (
    <main className="dashboard customer-dashboard">
      <section className="headline">
        <div><span className="eyebrow">ANÁLISIS COMERCIAL · 2026</span><h1>Clientes y evolución</h1><p>Cada importe proviene de un documento emitido. Las notas de crédito y estados se mantienen tal como fueron cargados, sin compensaciones automáticas.</p></div>
        <div className="headline-actions"><span className="refresh">● {number.format(records.length)} documentos trazables</span></div>
      </section>

      <section className="kpis" aria-label="Indicadores de clientes">
        <article className="kpi-card"><span>Clientes con documentos</span><strong>{number.format(customers.length)}</strong><small>Clientes o destinatarios informados</small></article>
        <article className="kpi-card"><span>Mayor cliente documentado</span><strong className="kpi-name">{topClient?.client ?? "—"}</strong><small>{topClient ? formatMoney(topClient.total) : "Sin datos"}</small></article>
        <article className="kpi-card accent"><span>Monto con estado “Pendiente”</span><strong>{formatMoney(pendingNet)}</strong><small>Valor literal del estado en la fuente</small></article>
        <article className="kpi-card"><span>Con fecha de pago registrada</span><strong>{number.format(paymentDateCount)}</strong><small>De {number.format(records.length)} documentos · no equivale a caja conciliada</small></article>
      </section>

      <section className="table-section evolution-matrix-section">
        <div className="table-heading"><div><span className="panel-label">CLIENTES</span><h2>{isEvolutionExpanded ? "Evolución mensual por cliente" : "Resumen de clientes"}</h2><p>{isEvolutionExpanded ? "Meses en columnas para revisar trayectoria y estacionalidad." : "Despliega los meses sólo cuando necesites revisar el evolutivo."}</p></div><div className="table-actions"><span className="unit">CLP neto</span><button type="button" className="secondary-button matrix-toggle" aria-expanded={isEvolutionExpanded} onClick={() => setIsEvolutionExpanded((current) => !current)}>{isEvolutionExpanded ? "Ocultar meses" : "Ver evolución mensual"}</button></div></div>
        {isEvolutionExpanded ? <div className="table-scroll"><table className="evolution-matrix customer-matrix"><thead><tr><th>Cliente</th>{calendarMonths.map((month) => <th className="money-col" key={month}>{month.slice(0, 3)}</th>)}<th className="money-col total-column">Total</th><th className="money-col">Docs.</th><th>Seguimiento</th></tr></thead><tbody>{customers.map((customer) => <tr key={customer.client}><td><strong>{customer.client}</strong><small>{customer.pendingNet ? `Pendiente: ${formatMoney(customer.pendingNet)}` : "Sin pendiente exacto"}</small></td>{calendarMonths.map((month) => <td className="money-col matrix-value" key={month}>{customer.byMonth[month] ? formatMoney(customer.byMonth[month]) : "—"}</td>)}<td className="money-col total-column"><strong>{formatMoney(customer.total)}</strong></td><td className="money-col">{number.format(customer.documents)}</td><td><span className={customer.pendingNet ? "status pending" : "status paid"}>{customer.pendingNet ? "Revisar pendiente" : "Sin pendiente exacto"}</span></td></tr>)}</tbody><tfoot><tr><td><strong>Total documentado</strong></td>{calendarMonths.map((month) => <td className="money-col" key={month}>{formatMoney(records.filter((record) => record.month === month).reduce((total, record) => total + (record.netAmount ?? 0), 0))}</td>)}<td className="money-col total-column"><strong>{formatMoney(totalNet)}</strong></td><td className="money-col"><strong>{number.format(records.length)}</strong></td><td>2026</td></tr></tfoot></table></div> : <div className="table-scroll"><table className="customer-summary"><thead><tr><th>Cliente</th><th className="money-col">Monto neto</th><th className="money-col">Documentos</th><th className="money-col">Pendiente exacto</th><th className="money-col">Fecha de pago registrada</th><th>Seguimiento</th></tr></thead><tbody>{customers.map((customer) => <tr key={customer.client}><td><strong>{customer.client}</strong></td><td className="money-col"><strong>{formatMoney(customer.total)}</strong></td><td className="money-col">{number.format(customer.documents)}</td><td className="money-col">{customer.pendingNet ? formatMoney(customer.pendingNet) : "—"}</td><td className="money-col">{number.format(customer.withPaymentDate)}</td><td><span className={customer.pendingNet ? "status pending" : "status paid"}>{customer.pendingNet ? "Revisar pendiente" : "Sin pendiente exacto"}</span></td></tr>)}</tbody><tfoot><tr><td><strong>Total documentado</strong></td><td className="money-col"><strong>{formatMoney(totalNet)}</strong></td><td className="money-col"><strong>{number.format(records.length)}</strong></td><td className="money-col">{formatMoney(pendingNet)}</td><td className="money-col">{number.format(paymentDateCount)}</td><td>2026</td></tr></tfoot></table></div>}
      </section>
    </main>
  );
}

function ForecastModule() {
  const rows = forecastMonthly2026.map((item) => ({
    ...item,
    month: calendarMonths[new Date(`${item.period}T00:00:00`).getMonth()] ?? item.period,
    projectedMargin: item.projectedRevenue - item.projectedExpense,
  }));
  const totals = rows.reduce((total, item) => ({
    projectedRevenue: total.projectedRevenue + item.projectedRevenue,
    actualRevenue: total.actualRevenue + item.actualRevenue,
    projectedExpense: total.projectedExpense + item.projectedExpense,
    projectedMargin: total.projectedMargin + item.projectedMargin,
  }), { projectedRevenue: 0, actualRevenue: 0, projectedExpense: 0, projectedMargin: 0 });
  const negativeMonths = rows.filter((item) => item.projectedMargin < 0);
  const largestExpenseMonth = rows.reduce((current, item) => item.projectedExpense > current.projectedExpense ? item : current, rows[0]);
  const largestRevenueMonth = rows.reduce((current, item) => item.projectedRevenue > current.projectedRevenue ? item : current, rows[0]);
  const matrixRows = [
    { label: "Ingresos proyectados", values: rows.map((row) => row.projectedRevenue), total: totals.projectedRevenue, tone: "income" },
    { label: "Gastos proyectados", values: rows.map((row) => row.projectedExpense), total: totals.projectedExpense, tone: "expense" },
    { label: "Resultado simple proyectado", values: rows.map((row) => row.projectedMargin), total: totals.projectedMargin, tone: "result" },
    { label: "Bloque “Real 2026”", values: rows.map((row) => row.actualRevenue), total: totals.actualRevenue, tone: "actual" },
    { label: "Desviación bloque Real vs. proyección", values: rows.map((row) => row.actualRevenue - row.projectedRevenue), total: totals.actualRevenue - totals.projectedRevenue, tone: "variance" },
  ];

  return (
    <main className="dashboard forecast-dashboard">
      <section className="headline">
        <div><span className="eyebrow">PRESUPUESTO Y FORECAST · 2026</span><h1>Proyecciones</h1><p>Visualización literal de las hojas “Presupuesto 2026” y “Gastos Proyectados 2026”. No se completan meses ni se aplican probabilidades.</p></div>
        <div className="headline-actions"><span className="refresh">● 501 líneas normalizadas en Supabase</span></div>
      </section>

      <section className="kpis" aria-label="Indicadores de proyección">
        <article className="kpi-card"><span>Ingresos proyectados</span><strong>{formatMoney(totals.projectedRevenue)}</strong><small>Presupuesto 2026 · monto neto</small></article>
        <article className="kpi-card"><span>Gastos proyectados</span><strong>{formatMoney(totals.projectedExpense)}</strong><small>Gastos Proyectados 2026</small></article>
        <article className="kpi-card accent"><span>Diferencia simple proyectada</span><strong>{formatMoney(totals.projectedMargin)}</strong><small>Ingresos proyectados menos gastos proyectados</small></article>
        <article className="kpi-card"><span>Bloque “Real 2026”</span><strong>{formatMoney(totals.actualRevenue)}</strong><small>Tal como está registrado en el libro</small></article>
      </section>

      <section className="analysis-strip" aria-label="Lecturas del forecast">
        <article><span>ALERTA DE PLAN</span><strong>{negativeMonths.length ? `${negativeMonths.length} mes con resultado negativo` : "Sin meses negativos"}</strong><p>{negativeMonths.length ? `${negativeMonths.map((item) => item.month).join(", ")}: ${formatMoney(negativeMonths[0].projectedMargin)}.` : "Ingresos proyectados superan gastos proyectados en todos los meses."}</p></article>
        <article><span>PICO DE INGRESOS</span><strong>{largestRevenueMonth.month}</strong><p>{formatMoney(largestRevenueMonth.projectedRevenue)} de ingresos proyectados en la hoja fuente.</p></article>
        <article><span>PICO DE GASTOS</span><strong>{largestExpenseMonth.month}</strong><p>{formatMoney(largestExpenseMonth.projectedExpense)} de gastos proyectados en la hoja fuente.</p></article>
        <article><span>CONCENTRACIÓN</span><strong>GRUPO LS SPA</strong><p>25,5% del ingreso proyectado anual fuente. No es una probabilidad ni ajuste.</p></article>
      </section>

      <section className="panel forecast-chart-panel">
        <div className="panel-heading"><div><span className="panel-label">COMPARATIVO MENSUAL</span><h2>Forecast de ingresos y gastos</h2></div><span className="unit">CLP neto</span></div>
        <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><LineChart data={rows} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}><XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fill: "#7e8ba0", fontSize: 12 }} /><YAxis hide /><Tooltip formatter={(value) => formatMoney(Number(value))} contentStyle={{ borderRadius: 12, border: "1px solid #e6e9ef" }} /><Line type="monotone" dataKey="projectedRevenue" name="Ingresos proyectados" stroke="#5968df" strokeWidth={2.5} dot={false} /><Line type="monotone" dataKey="projectedExpense" name="Gastos proyectados" stroke="#d85f6c" strokeWidth={2.5} dot={false} /><Line type="monotone" dataKey="actualRevenue" name="Bloque Real 2026" stroke="#20a67a" strokeWidth={2.5} strokeDasharray="5 4" dot={false} /></LineChart></ResponsiveContainer></div>
      </section>

      <section className="table-section evolution-matrix-section">
        <div className="table-heading"><div><span className="panel-label">EVOLUCIÓN MENSUAL</span><h2>Resultados y desviaciones</h2><p>Meses en columnas. “Bloque Real 2026” es el nombre de la fuente; no se declara caja conciliada ni resultado contable cerrado.</p></div><span className="unit">CLP neto</span></div>
        <div className="table-scroll"><table className="evolution-matrix"><thead><tr><th>Línea de análisis</th>{rows.map((row) => <th className="money-col" key={row.period}>{row.month.slice(0, 3)}</th>)}<th className="money-col total-column">Total 2026</th></tr></thead><tbody>{matrixRows.map((line) => <tr key={line.label} className={`matrix-row ${line.tone}`}><td><strong>{line.label}</strong></td>{line.values.map((value, index) => <td className={`money-col matrix-value ${value < 0 ? "is-negative" : ""}`} key={`${line.label}-${rows[index].period}`}>{formatMoney(value)}</td>)}<td className={`money-col total-column ${line.total < 0 ? "is-negative" : ""}`}><strong>{formatMoney(line.total)}</strong></td></tr>)}</tbody></table></div>
      </section>
    </main>
  );
}

export function FinanceDashboard() {
  const [activeModule, setActiveModule] = useState<Module>("Inicio");
  const [role, setRole] = useState<Role>("Administrador");
  const [month, setMonth] = useState("Todos");
  const [status, setStatus] = useState("Todos");
  const [showEntry, setShowEntry] = useState(false);
  const [draft, setDraft] = useState<InvoiceDraft>(blankDraft);
  const [formError, setFormError] = useState("");
  const [sessionRecords, setSessionRecords] = useState<InvoiceRecord[]>([]);

  const records = useMemo(() => [...facturasEmitidas2026, ...sessionRecords], [sessionRecords]);
  const months = useMemo(
    () => calendarMonths.filter((item) => records.some((record) => record.month === item)),
    [records],
  );
  const statuses = useMemo(() => {
    const values = records.map((record) => record.status).filter((item): item is string => Boolean(item));
    return Array.from(new Set(values)).sort();
  }, [records]);
  const filtered = useMemo(
    () => records.filter((record) => (month === "Todos" || record.month === month) && (status === "Todos" || record.status === status)),
    [records, month, status],
  );

  const monthly = useMemo(
    () => months.map((item) => {
      const matching = records.filter((record) => record.month === item);
      return { month: item.slice(0, 3), montoNeto: sum(matching, "netAmount"), documentos: matching.length };
    }),
    [months, records],
  );
  const statusesChart = useMemo(() => statuses.map((item) => ({
    name: item,
    value: records.filter((record) => record.status === item).length,
  })), [records, statuses]);
  const clientRanking = useMemo(() => Object.values(records.reduce<Record<string, { client: string; montoNeto: number }>>((accumulator, record) => {
    const client = record.client || "No informado";
    accumulator[client] ??= { client, montoNeto: 0 };
    accumulator[client].montoNeto += record.netAmount ?? 0;
    return accumulator;
  }, {})).sort((a, b) => b.montoNeto - a.montoNeto).slice(0, 6), [records]);

  const pendingCount = records.filter((record) => record.status === "Pendiente").length;
  const currentDate = new Date().toISOString().slice(0, 10);
  const overdueRecords = records.filter((record) => record.status === "Pendiente" && Boolean(record.dueDate) && record.dueDate! < currentDate);
  const overdueAmount = sum(overdueRecords, "netAmount");
  const hasEditPermission = role === "Administrador" || role === "Finanzas" || role === "Operación";

  function updateDraft(field: keyof InvoiceDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function submitEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.issueDate || !draft.documentType || !draft.issuer || !draft.client || !draft.netAmount || !draft.totalAmount || !draft.status) {
      setFormError("Completa fecha, tipo, emisor, cliente, montos y estado. No se crearán valores de relleno.");
      return;
    }
    const created: InvoiceRecord = {
      id: `manual-${crypto.randomUUID()}`,
      invoiceNumber: draft.invoiceNumber || null,
      year: Number(draft.issueDate.slice(0, 4)),
      month: monthFromDate(draft.issueDate),
      issueDate: draft.issueDate,
      documentType: draft.documentType,
      issuer: draft.issuer,
      issuerRut: draft.issuerRut || null,
      client: draft.client,
      recipient: draft.recipient || null,
      recipientRut: draft.recipientRut || null,
      netAmount: Number(draft.netAmount),
      vatAmount: draft.vatAmount ? Number(draft.vatAmount) : null,
      totalAmount: Number(draft.totalAmount),
      notes: null,
      paymentTermDays: null,
      dueDate: null,
      dueMonth: null,
      status: draft.status,
      paymentDate: null,
      paymentMethod: null,
      originAccountRut: null,
      destinationBank: null,
      destinationAccount: null,
      source: { file: "Registro manual en sesión", sheet: "No persistido", row: 0 },
    };
    setSessionRecords((current) => [created, ...current]);
    setDraft(blankDraft);
    setFormError("");
    setShowEntry(false);
    setActiveModule("Facturas");
  }

  const navigation: Module[] = ["Inicio", "Facturas", "Proyecciones", "Clientes", "Cuentas por cobrar", "Gastos y proveedores", "Remuneraciones"];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">A</span><span>Atlas <b>Financiero</b></span></div>
        <div className="workspace-label">ESPACIO DE TRABAJO</div>
        <button className="workspace-switcher" type="button">GEIMSER <span>⌄</span></button>
        <nav aria-label="Navegación principal">
          {navigation.map((item) => (
            <button key={item} type="button" className={`nav-item ${activeModule === item ? "active" : ""}`} onClick={() => setActiveModule(item)}>
              <span className="nav-icon">{item === "Inicio" ? "⌂" : item === "Facturas" ? "▤" : item === "Proyecciones" ? "⌁" : item === "Clientes" ? "◉" : item === "Cuentas por cobrar" ? "◷" : item === "Gastos y proveedores" ? "▣" : "◫"}</span>{item}
              {item === "Facturas" && <span className="nav-count">{records.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="settings-button" type="button">⚙ Configuración</button>
          <p>v0.2</p>
        </div>
      </aside>

      <section className="content-area">
        <header className="topbar">
          <div className="breadcrumb">Finanzas <span>/</span> {activeModule}</div>
          <div className="topbar-actions">
            <label className="role-picker">Vista de rol
              <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
                <option>Administrador</option><option>Finanzas</option><option>Operación</option><option>Auditor</option>
              </select>
            </label>
            <button className="avatar" type="button" aria-label="Perfil">GF</button>
          </div>
        </header>

        {activeModule === "Proyecciones" ? <ForecastModule /> : activeModule === "Clientes" ? <CustomerModule records={records} /> : activeModule !== "Inicio" && activeModule !== "Facturas" ? <EmptyModule module={activeModule} /> : (
          <main className="dashboard">
            <section className="headline">
              <div><span className="eyebrow">CONTROL FINANCIERO · 2026</span><h1>{activeModule === "Facturas" ? "Facturas emitidas" : "Panorama financiero"}</h1><p>Vista calculada desde la hoja fuente. Los importes no aplican ajustes ni clasificaciones adicionales.</p></div>
              <div className="headline-actions">
                <span className="refresh">● Datos importados del libro</span>
                {hasEditPermission ? <button className="primary-button" type="button" onClick={() => setShowEntry(true)}>＋ Registrar documento</button> : <span className="permission-note">El rol Auditor no registra documentos</span>}
              </div>
            </section>

            <section className="kpis kpis-five" aria-label="Indicadores principales">
              <article className="kpi-card"><span>Documentos emitidos</span><strong>{number.format(records.length)}</strong><small>{sessionRecords.length ? `${sessionRecords.length} registro(s) de esta sesión` : "Año 2026"}</small></article>
              <article className="kpi-card"><span>Monto neto documentado</span><strong>{formatMoney(sum(records, "netAmount"))}</strong><small>Suma literal de “Monto Neto”</small></article>
              <article className="kpi-card"><span>Monto total documentado</span><strong>{formatMoney(sum(records, "totalAmount"))}</strong><small>Suma literal de “Monto total Facturado”</small></article>
              <article className="kpi-card accent"><span>Estado “Pendiente”</span><strong>{number.format(pendingCount)}</strong><small>Documentos con ese estado exacto</small></article>
              <article className="kpi-card"><span>Cartera vencida</span><strong>{formatMoney(overdueAmount)}</strong><small>{number.format(overdueRecords.length)} pendiente(s) vencido(s) a la fecha</small></article>
            </section>

            <section className="visual-grid">
              <article className="panel trend-panel"><div className="panel-heading"><div><span className="panel-label">EVOLUCIÓN</span><h2>Monto neto por mes</h2></div><span className="unit">CLP</span></div><div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><AreaChart data={monthly} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><defs><linearGradient id="netFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#5968df" stopOpacity={0.26} /><stop offset="100%" stopColor="#5968df" stopOpacity={0.01} /></linearGradient></defs><XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fill: "#7e8ba0", fontSize: 12 }} /><YAxis hide /><Tooltip formatter={(value) => formatMoney(Number(value))} contentStyle={{ borderRadius: 12, border: "1px solid #e6e9ef" }} /><Area type="monotone" dataKey="montoNeto" stroke="#5968df" strokeWidth={2.5} fill="url(#netFill)" /></AreaChart></ResponsiveContainer></div></article>
              <article className="panel status-panel"><div className="panel-heading"><div><span className="panel-label">DISTRIBUCIÓN</span><h2>Documentos por estado</h2></div></div><div className="donut-row"><div className="donut"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={statusesChart} dataKey="value" nameKey="name" innerRadius={57} outerRadius={78} paddingAngle={3} stroke="none">{statusesChart.map((entry, index) => <Cell key={entry.name} fill={pieColors[index % pieColors.length]} />)}</Pie><Tooltip formatter={(value) => `${value} documento(s)`} /></PieChart></ResponsiveContainer><div className="donut-center"><strong>{records.length}</strong><span>documentos</span></div></div><div className="legend">{statusesChart.map((item, index) => <div key={item.name}><i style={{ backgroundColor: pieColors[index % pieColors.length] }} /><span>{item.name}</span><b>{item.value}</b></div>)}</div></div></article>
            </section>

            <section className="panel ranking-panel"><div className="panel-heading"><div><span className="panel-label">CLIENTES</span><h2>Mayor monto neto documentado</h2></div><span className="unit">Top 6</span></div><div className="ranking-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={clientRanking} layout="vertical" margin={{ left: 0, right: 24 }}><XAxis type="number" hide /><YAxis type="category" dataKey="client" width={145} tickLine={false} axisLine={false} tick={{ fill: "#58657a", fontSize: 12 }} /><Tooltip formatter={(value) => formatMoney(Number(value))} cursor={{ fill: "#f6f7fb" }} contentStyle={{ borderRadius: 12, border: "1px solid #e6e9ef" }} /><Bar dataKey="montoNeto" radius={[0, 6, 6, 0]} fill="#20a67a" /></BarChart></ResponsiveContainer></div></section>

            <section className="table-section" id="facturas">
              <div className="table-heading"><div><span className="panel-label">REGISTRO TRAZABLE</span><h2>Documentos emitidos</h2><p>{filtered.length} resultado(s) con los filtros actuales</p></div><div className="filters"><label>Mes<select value={month} onChange={(event) => setMonth(event.target.value)}><option>Todos</option>{months.map((item) => <option key={item}>{item}</option>)}</select></label><label>Estado<select value={status} onChange={(event) => setStatus(event.target.value)}><option>Todos</option>{statuses.map((item) => <option key={item}>{item}</option>)}</select></label></div></div>
              <div className="table-scroll"><table><thead><tr><th>Documento</th><th>Emisión</th><th>Cliente</th><th>Tipo</th><th className="money-col">Neto</th><th className="money-col">Total</th><th>Estado</th><th>Origen</th></tr></thead><tbody>{filtered.map((record) => <tr key={record.id}><td><strong>N° {record.invoiceNumber ?? "—"}</strong><small>{record.issuer}</small></td><td>{formatDate(record.issueDate)}<small>{record.month ?? "—"}</small></td><td><strong>{record.client ?? "No informado"}</strong><small>{record.recipient ?? "—"}</small></td><td>{record.documentType ?? "—"}</td><td className="money-col">{formatMoney(record.netAmount ?? 0)}</td><td className="money-col">{formatMoney(record.totalAmount ?? 0)}</td><td><span className={statusClass(record.status)}>{record.status ?? "No informado"}</span></td><td><span className="origin">{record.source.sheet}<b>fila {record.source.row || "sesión"}</b></span></td></tr>)}</tbody></table></div>
            </section>
          </main>
        )}
      </section>

      {showEntry && <div className="modal-backdrop" role="presentation"><section className="entry-modal" role="dialog" aria-modal="true" aria-labelledby="entry-title"><div className="modal-header"><div><span className="eyebrow">REGISTRO MANUAL</span><h2 id="entry-title">Agregar documento a la sesión</h2><p>No se guardará en Excel ni en una base de datos hasta integrar persistencia.</p></div><button type="button" className="close-button" onClick={() => setShowEntry(false)} aria-label="Cerrar">×</button></div><form onSubmit={submitEntry}><div className="form-grid"><label>N° documento<input value={draft.invoiceNumber} onChange={(event) => updateDraft("invoiceNumber", event.target.value)} /></label><label>Fecha emisión *<input type="date" value={draft.issueDate} onChange={(event) => updateDraft("issueDate", event.target.value)} /></label><label>Tipo documento *<input value={draft.documentType} onChange={(event) => updateDraft("documentType", event.target.value)} placeholder="Ej. Factura" /></label><label>Estado *<input value={draft.status} onChange={(event) => updateDraft("status", event.target.value)} placeholder="Valor definido por el usuario" /></label><label>Empresa emisora *<input value={draft.issuer} onChange={(event) => updateDraft("issuer", event.target.value)} /></label><label>RUT emisor<input value={draft.issuerRut} onChange={(event) => updateDraft("issuerRut", event.target.value)} /></label><label>Cliente *<input value={draft.client} onChange={(event) => updateDraft("client", event.target.value)} /></label><label>Destinatario<input value={draft.recipient} onChange={(event) => updateDraft("recipient", event.target.value)} /></label><label>RUT destinatario<input value={draft.recipientRut} onChange={(event) => updateDraft("recipientRut", event.target.value)} /></label><label>Monto neto *<input type="number" min="0" value={draft.netAmount} onChange={(event) => updateDraft("netAmount", event.target.value)} /></label><label>IVA<input type="number" min="0" value={draft.vatAmount} onChange={(event) => updateDraft("vatAmount", event.target.value)} /></label><label>Monto total *<input type="number" min="0" value={draft.totalAmount} onChange={(event) => updateDraft("totalAmount", event.target.value)} /></label></div>{formError && <p className="form-error">{formError}</p>}<div className="form-actions"><button type="button" className="secondary-button" onClick={() => setShowEntry(false)}>Cancelar</button><button type="submit" className="primary-button">Agregar a esta sesión</button></div></form></section></div>}
    </div>
  );
}
