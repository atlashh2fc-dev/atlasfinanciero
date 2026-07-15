"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Plan = { id: string; fiscal_year: number; name: string; status: "draft" | "active" | "archived"; notes: string | null; activated_at: string | null; created_at: string };
type BudgetLine = { id: string; plan_version_id: string; period_month: string; kind: "revenue" | "expense"; name: string; amount: number | string; cost_center_id: string | null; counterparty_id: string | null; service_catalog_id: string | null; notes: string | null };
type Adjustment = { id: string; expected_on: string; direction: "inflow" | "outflow"; amount: number | string; description: string; counterparty_id: string | null; notes: string | null };
type IssuedDocument = { id: string; counterparty_id: string | null; document_number: string | null; issue_date: string | null; due_date: string | null; payment_term_days: number | null; document_type: string | null; net_amount: number | string | null; total_amount: number | string | null; payment_status: string | null; client_name: string | null };
type ReceivedDocument = { id: string; supplier_counterparty_id: string | null; supplier_name: string; document_number: string | null; issue_date: string; due_date: string | null; payment_term_days: number | null; document_type: string; net_amount: number | string; total_amount: number | string; payment_status: string | null };
type BankAccount = { id: string; name: string; opening_balance: number | string; is_active: boolean };
type BankTransaction = { id: string; bank_account_id: string; booked_on: string; amount: number | string; balance_after: number | string | null };
type Customer = { id: string; legal_name: string; trade_name: string | null; kind: string };
type Service = { id: string; name: string; category: string | null };
type Preinvoice = { id: string; counterparty_id: string; period_month: string; status: string; issued_document_id: string | null };
type PreinvoiceLine = { id: string; preinvoice_id: string; customer_service_id: string | null; service_catalog_id: string | null; description: string; net_amount: number | string };
type Allocation = { id: string; received_document_id: string; counterparty_id: string; customer_service_id: string | null; allocated_amount: number | string; notes: string | null };
type Payload = { year: number; role: string; plans: Plan[]; budgetLines: BudgetLine[]; settings: { horizon_weeks: number; include_overdue_in_first_week: boolean }; adjustments: Adjustment[]; issuedDocuments: IssuedDocument[]; receivedDocuments: ReceivedDocument[]; bankAccounts: BankAccount[]; bankTransactions: BankTransaction[]; customers: Customer[]; services: Service[]; preinvoices: Preinvoice[]; preinvoiceLines: PreinvoiceLine[]; allocations: Allocation[] };

const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const number = (value: number | string | null | undefined) => Number(value ?? 0);
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = (year: number, index: number) => `${year}-${String(index + 1).padStart(2, "0")}-01`;
const isPaid = (status: string | null) => status?.trim().toLocaleLowerCase().includes("pagada") ?? false;
const isCredit = (documentType: string | null) => documentType?.toLocaleLowerCase().includes("nota de credito") ?? false;
const dueDate = (item: { due_date: string | null; issue_date: string | null; payment_term_days: number | null }) => {
  if (item.due_date) return item.due_date;
  if (!item.issue_date) return today();
  const next = new Date(`${item.issue_date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + (item.payment_term_days ?? 0));
  return next.toISOString().slice(0, 10);
};

function weekStart(value = new Date()) {
  const result = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  result.setUTCDate(result.getUTCDate() - ((result.getUTCDay() + 6) % 7));
  return result;
}

function addDays(value: Date, days: number) {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function dateText(value: Date | string) {
  const date = typeof value === "string" ? new Date(`${value}T00:00:00Z`) : value;
  return date.toISOString().slice(0, 10);
}

function signedAmount(document: { document_type: string | null; net_amount: number | string | null }) {
  return isCredit(document.document_type) ? -number(document.net_amount) : number(document.net_amount);
}

export function FinancialPlanningDashboard({ organizationId }: { organizationId: string | null }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [planName, setPlanName] = useState("Presupuesto base");
  const [budget, setBudget] = useState({ month: monthStart(new Date().getFullYear(), new Date().getMonth()), kind: "revenue", name: "", amount: "" });
  const [cashAdjustment, setCashAdjustment] = useState({ expectedOn: today(), direction: "outflow", description: "", amount: "" });
  const [allocation, setAllocation] = useState({ receivedDocumentId: "", counterpartyId: "", amount: "" });

  const canManage = data?.role === "administrator" || data?.role === "finance";

  async function load() {
    if (!organizationId) { setData(null); setLoading(false); return; }
    setLoading(true);
    try {
      const response = await fetch(`/api/financial-planning?organizationId=${encodeURIComponent(organizationId)}&year=${year}`, { cache: "no-store" });
      const payload = response.ok ? await response.json() as Payload : null;
      if (!payload) throw new Error("unable_to_load");
      setData(payload);
      setSelectedPlanId((current) => current && payload.plans.some((plan) => plan.id === current) ? current : (payload.plans.find((plan) => plan.status === "active")?.id ?? payload.plans[0]?.id ?? ""));
      setBudget((current) => ({ ...current, month: monthStart(year, new Date().getMonth()) }));
      setMessage(null);
    } catch { setMessage("No fue posible cargar la planificación financiera."); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [organizationId, year]);

  async function post(body: Record<string, unknown>) {
    if (!organizationId) return null;
    setSaving(true);
    const response = await fetch("/api/financial-planning", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, ...body }) });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    setSaving(false);
    if (!response.ok) { setMessage("No fue posible guardar. Revisa los datos y permisos."); return null; }
    await load();
    return payload;
  }

  async function patch(body: Record<string, unknown>) {
    if (!organizationId) return;
    setSaving(true);
    const response = await fetch("/api/financial-planning", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, ...body }) });
    setSaving(false);
    if (!response.ok) { setMessage("No fue posible actualizar el registro."); return; }
    await load();
  }

  const activePlan = data?.plans.find((plan) => plan.id === selectedPlanId) ?? null;
  const activeBudgetLines = useMemo(() => data?.budgetLines.filter((line) => line.plan_version_id === selectedPlanId) ?? [], [data?.budgetLines, selectedPlanId]);
  const monthly = useMemo(() => Array.from({ length: 12 }, (_, index) => {
    const period = monthStart(year, index);
    const actualRevenue = (data?.issuedDocuments ?? []).filter((document) => document.issue_date?.startsWith(period.slice(0, 7))).reduce((sum, document) => sum + signedAmount(document), 0);
    const actualExpense = (data?.receivedDocuments ?? []).filter((document) => document.issue_date.startsWith(period.slice(0, 7))).reduce((sum, document) => sum + signedAmount(document), 0);
    const budgetRevenue = activeBudgetLines.filter((line) => line.period_month === period && line.kind === "revenue").reduce((sum, line) => sum + number(line.amount), 0);
    const budgetExpense = activeBudgetLines.filter((line) => line.period_month === period && line.kind === "expense").reduce((sum, line) => sum + number(line.amount), 0);
    return { period, actualRevenue, actualExpense, budgetRevenue, budgetExpense };
  }), [activeBudgetLines, data?.issuedDocuments, data?.receivedDocuments, year]);
  const totals = useMemo(() => monthly.reduce((total, line) => ({ actualRevenue: total.actualRevenue + line.actualRevenue, actualExpense: total.actualExpense + line.actualExpense, budgetRevenue: total.budgetRevenue + line.budgetRevenue, budgetExpense: total.budgetExpense + line.budgetExpense }), { actualRevenue: 0, actualExpense: 0, budgetRevenue: 0, budgetExpense: 0 }), [monthly]);

  const cash = useMemo(() => {
    if (!data) return { opening: 0, weeks: [] as { start: string; inflows: number; outflows: number; closing: number }[] };
    const transactionsByAccount = new Map<string, BankTransaction[]>();
    data.bankTransactions.forEach((transaction) => transactionsByAccount.set(transaction.bank_account_id, [...(transactionsByAccount.get(transaction.bank_account_id) ?? []), transaction]));
    const opening = data.bankAccounts.reduce((sum, account) => {
      const movements = transactionsByAccount.get(account.id) ?? [];
      const latestBalance = movements.find((movement) => movement.balance_after !== null)?.balance_after;
      return sum + (latestBalance === undefined ? number(account.opening_balance) + movements.reduce((subtotal, movement) => subtotal + number(movement.amount), 0) : number(latestBalance));
    }, 0);
    const start = weekStart();
    let closing = opening;
    const weeks = Array.from({ length: data.settings.horizon_weeks }, (_, index) => {
      const week = addDays(start, index * 7);
      const end = addDays(week, 6);
      const belongs = (value: string) => value >= dateText(week) && value <= dateText(end) || (data.settings.include_overdue_in_first_week && index === 0 && value < dateText(week));
      const inflows = data.issuedDocuments.filter((document) => !isPaid(document.payment_status) && belongs(dueDate(document))).reduce((sum, document) => sum + Math.max(0, number(document.total_amount)), 0)
        + data.adjustments.filter((item) => item.direction === "inflow" && belongs(item.expected_on)).reduce((sum, item) => sum + number(item.amount), 0);
      const outflows = data.receivedDocuments.filter((document) => !isPaid(document.payment_status) && belongs(dueDate(document))).reduce((sum, document) => sum + Math.max(0, number(document.total_amount)), 0)
        + data.adjustments.filter((item) => item.direction === "outflow" && belongs(item.expected_on)).reduce((sum, item) => sum + number(item.amount), 0);
      closing += inflows - outflows;
      return { start: dateText(week), inflows, outflows, closing };
    });
    return { opening, weeks };
  }, [data]);

  const profitability = useMemo(() => {
    if (!data) return [] as { id: string; name: string; revenue: number; cost: number; margin: number }[];
    const customerNames = new Map(data.customers.map((customer) => [customer.id, customer.trade_name || customer.legal_name]));
    const issuedIds = new Set(data.preinvoices.filter((preinvoice) => preinvoice.status === "issued").map((preinvoice) => preinvoice.id));
    const customerByPreinvoice = new Map(data.preinvoices.map((preinvoice) => [preinvoice.id, preinvoice.counterparty_id]));
    const totalsByCustomer = new Map<string, { id: string; name: string; revenue: number; cost: number; margin: number }>();
    data.preinvoiceLines.filter((line) => issuedIds.has(line.preinvoice_id)).forEach((line) => {
      const customerId = customerByPreinvoice.get(line.preinvoice_id);
      if (!customerId) return;
      const item = totalsByCustomer.get(customerId) ?? { id: customerId, name: customerNames.get(customerId) ?? "Cliente", revenue: 0, cost: 0, margin: 0 };
      item.revenue += number(line.net_amount); totalsByCustomer.set(customerId, item);
    });
    data.allocations.forEach((item) => {
      const current = totalsByCustomer.get(item.counterparty_id) ?? { id: item.counterparty_id, name: customerNames.get(item.counterparty_id) ?? "Cliente", revenue: 0, cost: 0, margin: 0 };
      current.cost += number(item.allocated_amount); totalsByCustomer.set(item.counterparty_id, current);
    });
    return [...totalsByCustomer.values()].map((item) => ({ ...item, margin: item.revenue - item.cost })).sort((a, b) => b.margin - a.margin);
  }, [data]);

  const allocatableDocuments = useMemo(() => (data?.receivedDocuments ?? []).filter((document) => number(document.net_amount) > 0 && !isCredit(document.document_type)), [data?.receivedDocuments]);

  if (loading) return <main className="dashboard"><p className="billing-empty">Cargando planificación financiera…</p></main>;
  return <main className="dashboard reports-dashboard">
    <section className="headline"><div><span className="eyebrow">P2 · CONTROL Y PLANIFICACIÓN</span><h1>Plan financiero y caja</h1><p>Presupuesto contra documentos reales, caja proyectada y margen de contribución por cliente. Las proyecciones nunca cambian los documentos fuente.</p></div><div className="headline-actions"><label className="period-picker">Año<select value={year} onChange={(event) => setYear(Number(event.target.value))}>{[year - 1, year, year + 1].map((item) => <option key={item} value={item}>{item}</option>)}</select></label></div></section>
    {message && <p className="operation-message">{message}</p>}
    <section className="kpis kpis-six"><article className="kpi-card"><span>Ingresos reales netos</span><strong>{money.format(totals.actualRevenue)}</strong><small>Documentos emitidos del año</small></article><article className="kpi-card"><span>Gasto real neto</span><strong>{money.format(totals.actualExpense)}</strong><small>Documentos recibidos del año</small></article><article className="kpi-card accent"><span>Resultado real</span><strong className={totals.actualRevenue - totals.actualExpense < 0 ? "is-negative" : ""}>{money.format(totals.actualRevenue - totals.actualExpense)}</strong><small>Antes de costos sin documento</small></article><article className="kpi-card"><span>Desviación de ingresos</span><strong className={totals.actualRevenue - totals.budgetRevenue < 0 ? "is-negative" : ""}>{money.format(totals.actualRevenue - totals.budgetRevenue)}</strong><small>Contra {activePlan?.name ?? "plan no seleccionado"}</small></article><article className="kpi-card"><span>Caja actual</span><strong>{money.format(cash.opening)}</strong><small>Cuentas bancarias activas</small></article><article className="kpi-card"><span>Caja semana final</span><strong className={cash.weeks.at(-1)?.closing && cash.weeks.at(-1)!.closing < 0 ? "is-negative" : ""}>{money.format(cash.weeks.at(-1)?.closing ?? cash.opening)}</strong><small>Horizonte de {data?.settings.horizon_weeks ?? 13} semanas</small></article></section>

    <section className="table-section"><div className="table-heading"><div><span className="panel-label">PRESUPUESTO Y REAL</span><h2>Versión presupuestaria</h2><p>Una sola versión puede estar activa por año; los borradores permiten preparar escenarios sin afectar la comparación oficial.</p></div></div>
      <div className="expense-filter-row"><label><span>Plan</span><select value={selectedPlanId} onChange={(event) => setSelectedPlanId(event.target.value)}><option value="">Selecciona un plan</option>{data?.plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name} · {plan.status === "active" ? "Activo" : plan.status === "draft" ? "Borrador" : "Archivado"}</option>)}</select></label>{canManage && activePlan && activePlan.status !== "active" && <button type="button" className="secondary-button" disabled={saving} onClick={() => void post({ action: "set_plan_status", planId: activePlan.id, status: "active" })}>Activar plan</button>}</div>
      {canManage && <form className="expense-filter-row" onSubmit={(event: FormEvent) => { event.preventDefault(); void post({ action: "create_plan", year, name: planName }); }}><label><span>Nuevo plan</span><input value={planName} maxLength={120} onChange={(event) => setPlanName(event.target.value)} required /></label><button className="primary-button" disabled={saving} type="submit">Crear borrador</button></form>}
      <div className="table-scroll"><table><thead><tr><th>Mes</th><th className="money-col">Ingresos reales</th><th className="money-col">Plan ingresos</th><th className="money-col">Gastos reales</th><th className="money-col">Plan gastos</th><th className="money-col">Resultado real</th><th className="money-col">Resultado plan</th></tr></thead><tbody>{monthly.map((line) => <tr key={line.period}><td>{new Intl.DateTimeFormat("es-CL", { month: "long" }).format(new Date(`${line.period}T00:00:00`))}</td><td className="money-col">{money.format(line.actualRevenue)}</td><td className="money-col">{money.format(line.budgetRevenue)}</td><td className="money-col">{money.format(line.actualExpense)}</td><td className="money-col">{money.format(line.budgetExpense)}</td><td className={`money-col ${line.actualRevenue - line.actualExpense < 0 ? "is-negative" : ""}`}>{money.format(line.actualRevenue - line.actualExpense)}</td><td className={`money-col ${line.budgetRevenue - line.budgetExpense < 0 ? "is-negative" : ""}`}>{money.format(line.budgetRevenue - line.budgetExpense)}</td></tr>)}</tbody></table></div>
      {canManage && <form className="expense-filter-row" onSubmit={(event: FormEvent) => { event.preventDefault(); if (selectedPlanId) void post({ action: "create_budget_line", planVersionId: selectedPlanId, periodMonth: budget.month, kind: budget.kind, name: budget.name, amount: budget.amount }).then((result) => result && setBudget((current) => ({ ...current, name: "", amount: "" }))); }}><label><span>Mes</span><input type="month" value={budget.month.slice(0, 7)} onChange={(event) => setBudget({ ...budget, month: `${event.target.value}-01` })} required /></label><label><span>Tipo</span><select value={budget.kind} onChange={(event) => setBudget({ ...budget, kind: event.target.value })}><option value="revenue">Ingreso</option><option value="expense">Gasto</option></select></label><label><span>Concepto</span><input value={budget.name} maxLength={180} onChange={(event) => setBudget({ ...budget, name: event.target.value })} required /></label><label><span>Monto neto</span><input type="number" min="1" value={budget.amount} onChange={(event) => setBudget({ ...budget, amount: event.target.value })} required /></label><button className="primary-button" type="submit" disabled={saving || !selectedPlanId}>Agregar línea</button></form>}
      {activeBudgetLines.length > 0 && <div className="table-scroll"><table><thead><tr><th>Plan</th><th>Concepto</th><th>Período</th><th className="money-col">Monto</th>{canManage && <th />}</tr></thead><tbody>{activeBudgetLines.map((line) => <tr key={line.id}><td>{line.kind === "revenue" ? "Ingreso" : "Gasto"}</td><td>{line.name}</td><td>{line.period_month}</td><td className="money-col">{money.format(number(line.amount))}</td>{canManage && <td><button className="text-button" type="button" onClick={() => void patch({ action: "delete_budget_line", id: line.id })}>Eliminar</button></td>}</tr>)}</tbody></table></div>}
    </section>

    <section className="table-section"><div className="table-heading"><div><span className="panel-label">FLUJO DE CAJA</span><h2>Proyección semanal de {data?.settings.horizon_weeks ?? 13} semanas</h2><p>Parte desde la última posición disponible por cuenta y agrega documentos pendientes según vencimiento más ajustes de caja declarados.</p></div>{canManage && <label className="period-picker">Semanas<select value={data?.settings.horizon_weeks ?? 13} onChange={(event) => void patch({ action: "update_cash_settings", horizonWeeks: Number(event.target.value), includeOverdueInFirstWeek: data?.settings.include_overdue_in_first_week ?? true })}>{[4, 8, 13, 16, 20, 26].map((item) => <option key={item} value={item}>{item}</option>)}</select></label>}</div>
      <div className="table-scroll"><table><thead><tr><th>Semana</th><th className="money-col">Cobros esperados</th><th className="money-col">Pagos esperados</th><th className="money-col">Flujo neto</th><th className="money-col">Caja de cierre</th></tr></thead><tbody>{cash.weeks.map((line) => <tr key={line.start}><td>Desde {line.start}</td><td className="money-col">{money.format(line.inflows)}</td><td className="money-col">{money.format(line.outflows)}</td><td className={`money-col ${line.inflows - line.outflows < 0 ? "is-negative" : ""}`}>{money.format(line.inflows - line.outflows)}</td><td className={`money-col ${line.closing < 0 ? "is-negative" : ""}`}>{money.format(line.closing)}</td></tr>)}</tbody></table></div>
      {canManage && <form className="expense-filter-row" onSubmit={(event: FormEvent) => { event.preventDefault(); void post({ action: "create_cash_adjustment", expectedOn: cashAdjustment.expectedOn, direction: cashAdjustment.direction, description: cashAdjustment.description, amount: cashAdjustment.amount }).then((result) => result && setCashAdjustment({ expectedOn: today(), direction: "outflow", description: "", amount: "" })); }}><label><span>Fecha esperada</span><input type="date" value={cashAdjustment.expectedOn} onChange={(event) => setCashAdjustment({ ...cashAdjustment, expectedOn: event.target.value })} required /></label><label><span>Flujo</span><select value={cashAdjustment.direction} onChange={(event) => setCashAdjustment({ ...cashAdjustment, direction: event.target.value })}><option value="inflow">Ingreso</option><option value="outflow">Egreso</option></select></label><label><span>Descripción</span><input value={cashAdjustment.description} maxLength={280} onChange={(event) => setCashAdjustment({ ...cashAdjustment, description: event.target.value })} required /></label><label><span>Monto</span><input type="number" min="1" value={cashAdjustment.amount} onChange={(event) => setCashAdjustment({ ...cashAdjustment, amount: event.target.value })} required /></label><button className="primary-button" disabled={saving} type="submit">Agregar ajuste</button></form>}
    </section>

    <section className="table-section"><div className="table-heading"><div><span className="panel-label">RENTABILIDAD ATRIBUIDA</span><h2>Margen por cliente</h2><p>Ingresos netos de prefacturas emitidas menos costos de documentos recibidos que Finanzas haya imputado. Los gastos no asignados no se distribuyen artificialmente.</p></div></div><div className="table-scroll"><table><thead><tr><th>Cliente</th><th className="money-col">Ingresos</th><th className="money-col">Costos atribuidos</th><th className="money-col">Margen</th><th className="money-col">Margen %</th></tr></thead><tbody>{profitability.length ? profitability.map((item) => <tr key={item.id}><td>{item.name}</td><td className="money-col">{money.format(item.revenue)}</td><td className="money-col">{money.format(item.cost)}</td><td className={`money-col ${item.margin < 0 ? "is-negative" : ""}`}>{money.format(item.margin)}</td><td className="money-col">{item.revenue ? `${((item.margin / item.revenue) * 100).toFixed(1)}%` : "—"}</td></tr>) : <tr><td colSpan={5}>Aún no hay prefacturas emitidas ni costos atribuidos en este año.</td></tr>}</tbody></table></div>
      {canManage && <form className="expense-filter-row" onSubmit={(event: FormEvent) => { event.preventDefault(); void post({ action: "create_cost_allocation", receivedDocumentId: allocation.receivedDocumentId, counterpartyId: allocation.counterpartyId, allocatedAmount: allocation.amount }).then((result) => result && setAllocation({ receivedDocumentId: "", counterpartyId: "", amount: "" })); }}><label><span>Documento de costo</span><select value={allocation.receivedDocumentId} onChange={(event) => setAllocation({ ...allocation, receivedDocumentId: event.target.value })} required><option value="">Selecciona factura</option>{allocatableDocuments.map((document) => <option key={document.id} value={document.id}>{document.supplier_name} · {document.document_number || "sin folio"} · {money.format(number(document.net_amount))}</option>)}</select></label><label><span>Cliente</span><select value={allocation.counterpartyId} onChange={(event) => setAllocation({ ...allocation, counterpartyId: event.target.value })} required><option value="">Selecciona cliente</option>{data?.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.trade_name || customer.legal_name}</option>)}</select></label><label><span>Costo neto imputado</span><input type="number" min="1" value={allocation.amount} onChange={(event) => setAllocation({ ...allocation, amount: event.target.value })} required /></label><button className="primary-button" disabled={saving} type="submit">Imputar costo</button></form>}
    </section>
  </main>;
}
