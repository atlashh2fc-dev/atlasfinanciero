"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Role = "administrator" | "finance" | "operations" | "auditor";
type PeriodStatus = "open" | "soft_closed" | "closed" | "locked";
type Period = { id: string; period_start: string; period_end: string; status: PeriodStatus; notes: string | null };
type Account = { id: string; account_code: string; account_name: string; nature: string; normal_balance: string; statement_area: string; presentation_group: string | null; is_postable: boolean; is_active: boolean };
type EntryLine = { entry_id: string; account_id: string; line_number: number; description: string | null; currency_code: string; functional_debit: number | string; functional_credit: number | string; account: Account | null };
type Entry = { id: string; financial_period_id: string; entry_date: string; status: "draft" | "posted" | "reversed"; description: string; external_reference: string | null; posted_at: string | null; created_at: string; lines: EntryLine[] };
type TrialLine = Account & { debit: number; credit: number; debitBalance: number; creditBalance: number };
type LedgerLine = EntryLine & { entryId: string; entryDate: string; entryDescription: string; externalReference: string | null };
type Payload = { role: Role | null; year: number; periods: Period[]; selectedPeriodId: string; accounts: Account[]; entries: Entry[]; trialBalance: TrialLine[]; ledger: LedgerLine[] };
type DraftLine = { accountId: string; debit: string; credit: string; description: string };
type StatementLine = { group: string; amount: number };

const numberFormat = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const dateFormat = new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" });
const natureLabels: Record<string, string> = { asset: "Activo", liability: "Pasivo", equity: "Patrimonio", revenue: "Ingreso", expense: "Gasto" };
const areaLabels: Record<string, string> = { statement_of_financial_position: "Situación financiera", profit_or_loss: "Resultado", other_comprehensive_income: "Resultado integral", cash_flow: "Flujo de efectivo", management: "Gestión" };
const statusLabels: Record<PeriodStatus, string> = { open: "Abierto", soft_closed: "Pre-cierre", closed: "Cerrado", locked: "Bloqueado" };

function amount(value: string | number) { const number = Number(value); return Number.isFinite(number) ? number : 0; }
function periodName(period: Period) { return new Intl.DateTimeFormat("es-CL", { month: "long", year: "numeric" }).format(new Date(`${period.period_start}T00:00:00`)); }
function defaultLines(): DraftLine[] { return [{ accountId: "", debit: "", credit: "", description: "" }, { accountId: "", debit: "", credit: "", description: "" }]; }

export function AccountingWorkbench({ organizationId }: { organizationId: string | null }) {
  const [data, setData] = useState<Payload | null>(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const [periodId, setPeriodId] = useState("");
  const [accountFilter, setAccountFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [entryOpen, setEntryOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [entryDate, setEntryDate] = useState("");
  const [description, setDescription] = useState("");
  const [externalReference, setExternalReference] = useState("");
  const [currencyCode, setCurrencyCode] = useState("CLP");
  const [lines, setLines] = useState<DraftLine[]>(defaultLines());
  const [accountDraft, setAccountDraft] = useState({ code: "", name: "", nature: "expense", normalBalance: "debit", statementArea: "profit_or_loss", presentationGroup: "" });

  async function load(nextYear = year, nextPeriodId?: string) {
    if (!organizationId) { setData(null); setLoading(false); return; }
    setLoading(true);
    const params = new URLSearchParams({ organizationId, year: String(nextYear) });
    if (nextPeriodId) params.set("periodId", nextPeriodId);
    const response = await fetch(`/api/accounting?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as Payload | null;
    if (response.ok && payload) {
      setData(payload);
      setPeriodId(payload.selectedPeriodId);
      setAccountFilter((current) => payload.accounts.some((account) => account.id === current) ? current : "");
      setMessage(null);
    } else {
      setData(null);
      setMessage(response.status === 403 ? "Tu rol no puede acceder a los libros contables." : "No fue posible cargar la contabilidad.");
    }
    setLoading(false);
  }

  useEffect(() => { void load(); }, [organizationId]);

  const period = data?.periods.find((item) => item.id === periodId) ?? null;
  const canManage = data?.role === "administrator" || data?.role === "finance";
  const editablePeriod = Boolean(period && ["open", "soft_closed"].includes(period.status));
  const debitTotal = useMemo(() => lines.reduce((total, line) => total + amount(line.debit), 0), [lines]);
  const creditTotal = useMemo(() => lines.reduce((total, line) => total + amount(line.credit), 0), [lines]);
  const isBalanced = debitTotal > 0 && Math.round(debitTotal * 100) === Math.round(creditTotal * 100) && lines.every((line) => line.accountId && ((amount(line.debit) > 0) !== (amount(line.credit) > 0)));
  const trialTotals = useMemo(() => (data?.trialBalance ?? []).reduce((totals, line) => ({ debit: totals.debit + line.debit, credit: totals.credit + line.credit, debitBalance: totals.debitBalance + line.debitBalance, creditBalance: totals.creditBalance + line.creditBalance }), { debit: 0, credit: 0, debitBalance: 0, creditBalance: 0 }), [data]);
  const ifrsStatement = useMemo(() => {
    const groups = { asset: new Map<string, number>(), liability: new Map<string, number>(), equity: new Map<string, number>() };
    let revenue = 0;
    let expense = 0;
    for (const line of data?.trialBalance ?? []) {
      const signedBalance = amount(line.debit) - amount(line.credit);
      const value = ["asset", "expense"].includes(line.nature) ? signedBalance : -signedBalance;
      if (line.nature === "revenue") revenue += value;
      else if (line.nature === "expense") expense += value;
      else if (line.nature === "asset" || line.nature === "liability" || line.nature === "equity") {
        const target = groups[line.nature];
        const group = line.presentation_group || natureLabels[line.nature];
        target.set(group, (target.get(group) ?? 0) + value);
      }
    }
    const asLines = (items: Map<string, number>): StatementLine[] => [...items.entries()].map(([group, amount]) => ({ group, amount })).filter((line) => line.amount !== 0).sort((left, right) => left.group.localeCompare(right.group));
    const assets = asLines(groups.asset);
    const liabilities = asLines(groups.liability);
    const equity = asLines(groups.equity);
    const assetTotal = assets.reduce((total, line) => total + line.amount, 0);
    const liabilityTotal = liabilities.reduce((total, line) => total + line.amount, 0);
    const equityTotal = equity.reduce((total, line) => total + line.amount, 0);
    const result = revenue - expense;
    return { assets, liabilities, equity, assetTotal, liabilityTotal, equityTotal, revenue, expense, result, difference: assetTotal - liabilityTotal - equityTotal - result };
  }, [data]);
  const ledger = useMemo(() => {
    const filtered = (data?.ledger ?? []).filter((line) => !accountFilter || line.account_id === accountFilter).sort((left, right) => `${left.entryDate}-${left.entryId}-${left.line_number}`.localeCompare(`${right.entryDate}-${right.entryId}-${right.line_number}`));
    let balance = 0;
    return filtered.map((line) => { balance += amount(line.functional_debit) - amount(line.functional_credit); return { ...line, balance }; });
  }, [data, accountFilter]);
  const accountGroups = useMemo(() => Object.entries(natureLabels).map(([nature, label]) => ({
    nature,
    label,
    accounts: (data?.accounts ?? []).filter((account) => account.nature === nature),
  })).filter((group) => group.accounts.length > 0), [data]);
  const years = useMemo(() => [...new Set([year, new Date().getFullYear(), ...(data?.periods.map((period) => Number(period.period_start.slice(0, 4))) ?? [])])].sort((left, right) => right - left), [data, year]);

  function resetEntry() {
    setEntryDate(period?.period_start ?? new Date().toISOString().slice(0, 10)); setDescription(""); setExternalReference(""); setCurrencyCode("CLP"); setLines(defaultLines());
  }
  function openEntry() { resetEntry(); setEntryOpen(true); }
  function updateLine(index: number, patch: Partial<DraftLine>) { setLines((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line)); }
  async function request(body: Record<string, unknown>) {
    if (!organizationId) return false;
    setSaving(true);
    const response = await fetch("/api/accounting", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, ...body }) });
    const payload = await response.json().catch(() => null) as { error?: string; detail?: string } | null;
    setSaving(false);
    if (!response.ok) { setMessage(payload?.detail || (payload?.error === "unbalanced_manual_entry" ? "El asiento debe cuadrar: cada línea lleva sólo debe o haber." : "No fue posible guardar. Revisa los datos y el período.")); return false; }
    return true;
  }
  async function submitEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isBalanced || !period) { setMessage("Completa cuentas y asegura que el debe sea igual al haber."); return; }
    if (await request({ action: "post_manual_entry", periodId: period.id, entryDate, description, externalReference, currencyCode, lines })) {
      setEntryOpen(false); setMessage("Asiento contabilizado y protegido para auditoría."); await load(year, period.id);
    }
  }
  async function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await request({ action: "create_account", account: accountDraft })) {
      setAccountOpen(false); setAccountDraft({ code: "", name: "", nature: "expense", normalBalance: "debit", statementArea: "profit_or_loss", presentationGroup: "" }); setMessage("Cuenta agregada al plan de cuentas."); await load(year, period?.id);
    }
  }
  async function installStandard() {
    if (await request({ action: "install_chilean_ifrs_standard" })) {
      setMessage("Plan de cuentas IFRS / Chile instalado. Puedes ajustar o agregar cuentas propias.");
      await load(year, period?.id);
    }
  }
  async function generateFromSources() {
    if (!period || !window.confirm(`Se crearán asientos contabilizados desde documentos emitidos, recibidos y pagos registrados hasta el ${dateFormat.format(new Date(`${period.period_end}T00:00:00`))}. Los asientos quedan trazables y no se duplicarán. ¿Continuar?`)) return;
    if (await request({ action: "generate_ifrs_source_entries", periodId: period.id })) {
      setMessage("Asientos IFRS generados desde los documentos y pagos registrados. Revisa las cuentas de gasto por clasificar antes del cierre.");
      await load(year, period.id);
    }
  }

  return <main className="dashboard billing-dashboard">
    <section className="headline"><div><span className="eyebrow">CONTABILIDAD OPERATIVA · IFRS / CHILE</span><h1>Libros, balance y asientos</h1><p>Balance de situación financiera, estado de resultados, mayor por cuenta y asientos de doble partida. Debe y haber están siempre disponibles para activos, pasivos y patrimonio; la naturaleza sólo define su presentación.</p></div><div className="headline-actions"><button className="secondary-button" type="button" onClick={() => void installStandard()} disabled={!canManage || saving}>Instalar estándar IFRS</button><button className="secondary-button" type="button" onClick={() => setAccountOpen(true)} disabled={!canManage || saving}>Nueva cuenta</button><button className="primary-button" type="button" onClick={openEntry} disabled={!canManage || !editablePeriod || !data?.accounts.length || saving}>Nuevo asiento</button></div></section>
    {message && <p className="operation-message">{message}</p>}
    {loading ? <section className="panel billing-empty"><p>Cargando libros contables…</p></section> : !data ? <section className="panel billing-empty"><p>Selecciona una empresa para consultar su contabilidad.</p></section> : <>
      <section className="billing-form-panel panel"><div className="panel-heading"><div><span className="panel-label">CONTEXTO CONTABLE</span><h2>Período de trabajo</h2><p>Los informes se calculan al cierre del mes seleccionado; no mezclan años contables.</p></div><button className="secondary-button" type="button" onClick={() => void load(year, periodId)} disabled={loading}>Actualizar</button></div><div className="billing-form"><label>Año contable<select value={year} onChange={(event) => { const nextYear = Number(event.target.value); setYear(nextYear); void load(nextYear); }}>{years.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label>Mes / período<select value={periodId} onChange={(event) => { setPeriodId(event.target.value); void load(year, event.target.value); }} disabled={!data.periods.length}><option value="">Sin períodos</option>{data.periods.map((item) => <option key={item.id} value={item.id}>{periodName(item)} · {statusLabels[item.status]}</option>)}</select></label>{period && <p className="form-note">Estado: <strong>{statusLabels[period.status]}</strong>{period.notes ? ` · ${period.notes}` : ""}</p>}</div></section>
      {!data.accounts.length && <section className="panel billing-empty"><h2>Instala el plan de cuentas IFRS / Chile</h2><p>Crea una base editable para activos, pasivos, patrimonio, ingresos, gastos e IVA. Luego podrás registrar asientos y construir los estados financieros.</p><button className="primary-button" type="button" disabled={!canManage || saving} onClick={() => void installStandard()}>Instalar plan estándar</button></section>}
      <section className="kpis billing-kpis" aria-label="Resumen del período"><article className="kpi-card accent"><span>Asientos contabilizados</span><strong>{data.entries.filter((entry) => entry.status === "posted").length}</strong><small>Libro diario de {period ? periodName(period) : year}</small></article><article className="kpi-card"><span>Débitos del período</span><strong>{numberFormat.format(data.entries.flatMap((entry) => entry.lines).reduce((total, line) => total + amount(line.functional_debit), 0))}</strong><small>Asientos incluidos en la vista</small></article><article className="kpi-card"><span>Créditos del período</span><strong>{numberFormat.format(data.entries.flatMap((entry) => entry.lines).reduce((total, line) => total + amount(line.functional_credit), 0))}</strong><small>Debe cuadrar con débitos</small></article><article className="kpi-card"><span>Cuentas con saldo</span><strong>{data.trialBalance.length}</strong><small>Acumulado hasta el cierre mensual</small></article></section>
      <section className="billing-form-panel panel"><div className="panel-heading"><div><span className="panel-label">INCORPORACIÓN DESDE OPERACIONES</span><h2>Asientos IFRS desde los datos registrados</h2><p>Genera devengos de documentos emitidos y recibidos, más cobros y pagos ejecutados. El IVA se separa; las compras quedan inicialmente en “Gastos operacionales por clasificar” para su revisión contable.</p></div><button className="primary-button" type="button" onClick={() => void generateFromSources()} disabled={!canManage || !editablePeriod || saving}>Generar asientos desde datos</button></div><p className="form-note">La generación es idempotente: cada documento o pago se incorpora una sola vez. La fecha de emisión se usa como aproximación de devengo; valida IFRS 15, activos fijos, provisiones y reclasificaciones antes de emitir estados formales.</p></section>
      <section className="table-section"><div className="table-heading"><div><span className="panel-label">ESTADOS FINANCIEROS · IFRS</span><h2>Balance de situación financiera</h2><p>Construido desde asientos contabilizados al cierre seleccionado. El resultado del período se presenta dentro de patrimonio hasta su cierre.</p></div><span className={`status ${Math.abs(ifrsStatement.difference) < 0.01 ? "paid" : "cancelled"}`}>{Math.abs(ifrsStatement.difference) < 0.01 ? "Ecuación balanceada" : `Diferencia ${numberFormat.format(ifrsStatement.difference)}`}</span></div><div className="table-scroll"><table className="billing-cycles-table"><thead><tr><th>Activo</th><th>Importe</th><th>Pasivo y patrimonio</th><th>Importe</th></tr></thead><tbody>{Array.from({ length: Math.max(ifrsStatement.assets.length, ifrsStatement.liabilities.length + ifrsStatement.equity.length + 1, 1) }, (_, index) => { const asset = ifrsStatement.assets[index]; const right = [...ifrsStatement.liabilities, ...ifrsStatement.equity, { group: "Resultado del período", amount: ifrsStatement.result }][index]; return <tr key={index}><td>{asset?.group || ""}</td><td>{asset ? numberFormat.format(asset.amount) : ""}</td><td>{right?.group || ""}</td><td>{right ? numberFormat.format(right.amount) : ""}</td></tr>; })}<tr><td><strong>Total activos</strong></td><td><strong>{numberFormat.format(ifrsStatement.assetTotal)}</strong></td><td><strong>Total pasivo y patrimonio</strong></td><td><strong>{numberFormat.format(ifrsStatement.liabilityTotal + ifrsStatement.equityTotal + ifrsStatement.result)}</strong></td></tr></tbody></table></div><div className="kpis billing-kpis"><article className="kpi-card"><span>Ingresos</span><strong>{numberFormat.format(ifrsStatement.revenue)}</strong></article><article className="kpi-card"><span>Gastos</span><strong>{numberFormat.format(ifrsStatement.expense)}</strong></article><article className="kpi-card accent"><span>Resultado del período</span><strong>{numberFormat.format(ifrsStatement.result)}</strong><small>Ingresos menos gastos</small></article></div></section>
      <section className="table-section"><div className="table-heading"><div><span className="panel-label">PLAN DE CUENTAS</span><h2>Catálogo contable agrupado</h2><p>Abre sólo la familia que necesitas. Por ejemplo, <strong>Préstamos y obligaciones financieras</strong> está dentro de Pasivo; también puedes crear cuentas nuevas en cualquier familia.</p></div><button className="secondary-button" type="button" onClick={() => setAccountOpen(true)} disabled={!canManage || saving}>Nueva cuenta</button></div><div className="account-plan-groups">{accountGroups.map((group) => <details className="account-plan-group" key={group.nature}><summary><span><strong>{group.label}</strong><small>{group.accounts.length} cuenta{group.accounts.length === 1 ? "" : "s"} · saldo normal {group.accounts[0]?.normal_balance === "debit" ? "deudor" : "acreedor"}</small></span><span className="account-plan-chevron" aria-hidden="true">⌄</span></summary><div className="table-scroll"><table className="billing-cycles-table"><thead><tr><th>Código</th><th>Cuenta</th><th>Saldo normal</th><th>Presentación IFRS</th></tr></thead><tbody>{group.accounts.map((account) => <tr key={account.id}><td><strong>{account.account_code}</strong></td><td>{account.account_name}</td><td>{account.normal_balance === "debit" ? "Deudor" : "Acreedor"}</td><td>{account.presentation_group || areaLabels[account.statement_area]}</td></tr>)}</tbody></table></div></details>)}</div></section>
      <section className="table-section"><div className="table-heading"><div><span className="panel-label">LIBRO DIARIO</span><h2>Asientos del período</h2><p>Los asientos manuales se publican balanceados en una sola transacción y quedan incluidos en el control de cierre.</p></div></div><div className="table-scroll"><table className="billing-cycles-table"><thead><tr><th>Fecha</th><th>Glosa / referencia</th><th>Cuenta</th><th>Debe</th><th>Haber</th><th>Estado</th></tr></thead><tbody>{data.entries.flatMap((entry) => entry.lines.map((line, index) => <tr key={`${entry.id}-${line.line_number}`}><td>{index === 0 ? dateFormat.format(new Date(`${entry.entry_date}T00:00:00`)) : ""}</td><td>{index === 0 ? <><strong>{entry.description}</strong><small>{entry.external_reference || "Sin referencia"}</small></> : line.description || "—"}</td><td>{line.account ? `${line.account.account_code} · ${line.account.account_name}` : "Cuenta no disponible"}</td><td>{amount(line.functional_debit) ? numberFormat.format(amount(line.functional_debit)) : "—"}</td><td>{amount(line.functional_credit) ? numberFormat.format(amount(line.functional_credit)) : "—"}</td><td>{index === 0 ? <span className={`status ${entry.status === "posted" ? "paid" : "pending"}`}>{entry.status === "posted" ? "Contabilizado" : entry.status === "reversed" ? "Reversado" : "Borrador"}</span> : ""}</td></tr>))}</tbody></table></div>{!data.entries.length && <p className="billing-empty">No hay asientos para este período.</p>}</section>
      <section className="table-section"><div className="table-heading"><div><span className="panel-label">BALANCE DE COMPROBACIÓN</span><h2>Saldos acumulados al {period ? dateFormat.format(new Date(`${period.period_end}T00:00:00`)) : String(year)}</h2><p>Construido sólo desde asientos contabilizados hasta el cierre del período seleccionado.</p></div></div><div className="table-scroll"><table className="billing-cycles-table"><thead><tr><th>Cuenta</th><th>Naturaleza</th><th>Débitos</th><th>Créditos</th><th>Saldo deudor</th><th>Saldo acreedor</th></tr></thead><tbody>{data.trialBalance.map((line) => <tr key={line.id}><td><strong>{line.account_code} · {line.account_name}</strong><small>{areaLabels[line.statement_area]}</small></td><td>{natureLabels[line.nature]}</td><td>{numberFormat.format(line.debit)}</td><td>{numberFormat.format(line.credit)}</td><td>{line.debitBalance ? numberFormat.format(line.debitBalance) : "—"}</td><td>{line.creditBalance ? numberFormat.format(line.creditBalance) : "—"}</td></tr>)}<tr><td><strong>Total</strong></td><td>—</td><td><strong>{numberFormat.format(trialTotals.debit)}</strong></td><td><strong>{numberFormat.format(trialTotals.credit)}</strong></td><td><strong>{numberFormat.format(trialTotals.debitBalance)}</strong></td><td><strong>{numberFormat.format(trialTotals.creditBalance)}</strong></td></tr></tbody></table></div>{!data.trialBalance.length && <p className="billing-empty">Aún no hay saldos contabilizados hasta este cierre.</p>}</section>
      <section className="table-section"><div className="table-heading"><div><span className="panel-label">LIBRO MAYOR</span><h2>Movimientos por cuenta</h2><p>Selecciona una cuenta para seguir el saldo movimiento a movimiento dentro del período.</p></div><label>Cuenta<select value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)}><option value="">Todas las cuentas</option>{data.accounts.map((account) => <option key={account.id} value={account.id}>{account.account_code} · {account.account_name}</option>)}</select></label></div><div className="table-scroll"><table className="billing-cycles-table"><thead><tr><th>Fecha</th><th>Cuenta</th><th>Glosa</th><th>Debe</th><th>Haber</th><th>Saldo</th></tr></thead><tbody>{ledger.map((line) => <tr key={`${line.entryId}-${line.line_number}`}><td>{dateFormat.format(new Date(`${line.entryDate}T00:00:00`))}</td><td>{line.account ? `${line.account.account_code} · ${line.account.account_name}` : "—"}</td><td>{line.description || line.entryDescription}<small>{line.externalReference || "Sin referencia"}</small></td><td>{amount(line.functional_debit) ? numberFormat.format(amount(line.functional_debit)) : "—"}</td><td>{amount(line.functional_credit) ? numberFormat.format(amount(line.functional_credit)) : "—"}</td><td>{numberFormat.format(line.balance)}</td></tr>)}</tbody></table></div>{!ledger.length && <p className="billing-empty">No hay movimientos contabilizados en este mayor.</p>}</section>
    </>}
    {entryOpen && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Registrar asiento manual"><form className="entry-modal" onSubmit={submitEntry}><div className="modal-header"><div><span className="panel-label">ASIENTO MANUAL</span><h2>Contabilizar asiento balanceado</h2><p>Se publica inmediatamente y no podrá editarse después.</p></div><button className="close-button" type="button" onClick={() => setEntryOpen(false)} aria-label="Cerrar">×</button></div><div className="form-grid"><label>Fecha<input type="date" required min={period?.period_start} max={period?.period_end} value={entryDate} onChange={(event) => setEntryDate(event.target.value)} /></label><label>Moneda<input value={currencyCode} maxLength={3} onChange={(event) => setCurrencyCode(event.target.value.toUpperCase())} required /></label><label className="form-wide">Glosa *<input value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} required /></label><label className="form-wide">Referencia externa<input value={externalReference} maxLength={180} onChange={(event) => setExternalReference(event.target.value)} /></label></div><div className="table-scroll"><table className="billing-cycles-table"><thead><tr><th>Cuenta</th><th>Glosa línea</th><th>Debe</th><th>Haber</th><th /></tr></thead><tbody>{lines.map((line, index) => <tr key={index}><td><select value={line.accountId} onChange={(event) => updateLine(index, { accountId: event.target.value })} required><option value="">Seleccionar cuenta</option>{data?.accounts.filter((account) => account.is_postable).map((account) => <option key={account.id} value={account.id}>{account.account_code} · {account.account_name}</option>)}</select></td><td><input value={line.description} maxLength={500} onChange={(event) => updateLine(index, { description: event.target.value })} /></td><td><input type="number" min="0" step="0.01" value={line.debit} onChange={(event) => updateLine(index, { debit: event.target.value, credit: event.target.value ? "" : line.credit })} /></td><td><input type="number" min="0" step="0.01" value={line.credit} onChange={(event) => updateLine(index, { credit: event.target.value, debit: event.target.value ? "" : line.debit })} /></td><td><button className="text-button" type="button" disabled={lines.length <= 2} onClick={() => setLines((current) => current.filter((_, lineIndex) => lineIndex !== index))}>Quitar</button></td></tr>)}</tbody></table></div><div className="headline-actions"><button className="secondary-button" type="button" onClick={() => setLines((current) => [...current, { accountId: "", debit: "", credit: "", description: "" }])}>Agregar línea</button><span className={`status ${isBalanced ? "paid" : "pending"}`}>Debe {numberFormat.format(debitTotal)} · Haber {numberFormat.format(creditTotal)}</span><button className="primary-button" disabled={!isBalanced || saving || !canManage} type="submit">Contabilizar asiento</button></div></form></div>}
    {accountOpen && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Crear cuenta contable"><form className="entry-modal" onSubmit={submitAccount}><div className="modal-header"><div><span className="panel-label">PLAN DE CUENTAS</span><h2>Nueva cuenta postable</h2><p>La cuenta quedará disponible para asientos manuales de esta empresa.</p></div><button className="close-button" type="button" onClick={() => setAccountOpen(false)} aria-label="Cerrar">×</button></div><div className="form-grid"><label>Código *<input value={accountDraft.code} maxLength={30} placeholder="Ej. 610100" onChange={(event) => setAccountDraft((current) => ({ ...current, code: event.target.value.toUpperCase() }))} required /></label><label>Nombre *<input value={accountDraft.name} maxLength={180} onChange={(event) => setAccountDraft((current) => ({ ...current, name: event.target.value }))} required /></label><label>Naturaleza<select value={accountDraft.nature} onChange={(event) => setAccountDraft((current) => ({ ...current, nature: event.target.value, normalBalance: ["liability", "equity", "revenue"].includes(event.target.value) ? "credit" : "debit", statementArea: ["asset", "liability", "equity"].includes(event.target.value) ? "statement_of_financial_position" : "profit_or_loss" }))}>{Object.entries(natureLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Saldo normal<select value={accountDraft.normalBalance} onChange={(event) => setAccountDraft((current) => ({ ...current, normalBalance: event.target.value }))}><option value="debit">Deudor</option><option value="credit">Acreedor</option></select></label><label>Área de reporte<select value={accountDraft.statementArea} onChange={(event) => setAccountDraft((current) => ({ ...current, statementArea: event.target.value }))}>{Object.entries(areaLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Grupo de presentación<input value={accountDraft.presentationGroup} maxLength={120} placeholder="Ej. Gastos administrativos" onChange={(event) => setAccountDraft((current) => ({ ...current, presentationGroup: event.target.value }))} /></label></div><div className="headline-actions"><button className="secondary-button" type="button" onClick={() => setAccountOpen(false)}>Cancelar</button><button className="primary-button" disabled={saving || !canManage} type="submit">Crear cuenta</button></div></form></div>}
  </main>;
}
