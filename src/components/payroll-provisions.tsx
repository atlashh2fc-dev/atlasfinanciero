"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Center = { id: string; code: string; name: string };
type ProvisionLine = {
  id: string;
  revision_id: string;
  source_type: "peoplework" | "manual";
  category: string;
  label: string;
  calculation_method: "source" | "fixed" | "percentage";
  direction: "add" | "deduct";
  calculation_rate: number | string | null;
  calculation_base: number | string | null;
  amount: number | string;
  cost_center_id: string | null;
  source_cost_center_code: string | null;
  source_cost_center_name: string | null;
  notes: string | null;
};
type Revision = {
  id: string;
  as_of_date: string;
  status: "draft" | "posted";
  total_amount: number | string | null;
  accounting_delta: number | string | null;
  accounting_entry_id: string | null;
  source_refreshed_at: string | null;
  source_sync_run_id: string | null;
  posted_at: string | null;
  notes: string | null;
  displayTotal: number;
  summary: { contractualBase: number; additions: number; deductions: number };
  lines: ProvisionLine[];
};
type Provision = {
  id: string;
  period_month: string;
  status: "open" | "reconciled";
  posted_amount: number | string;
  actual_amount: number | string | null;
  actual_refreshed_at: string | null;
  reconciliation_entry_id: string | null;
  reconciled_at: string | null;
  notes: string | null;
};
type Payload = {
  provision: Provision | null;
  revisions: Revision[];
  currentRevision: Revision | null;
  workingRevision: Revision | null;
  lastPostedRevision: Revision | null;
  sourceIsStale: boolean;
  centers: Center[];
  officialActual: number | null;
  officialActualLines: Array<{ costCenterId: string | null; costCenterCode: string | null; costCenterName: string | null; amount: number }>;
  contractualSourceTotal: number;
  reportedLaborCost: { amount: number; basis: "official" | "posted_provision" } | null;
  comparison: {
    provisionAmount: number;
    actualAmount: number;
    variance: number;
    variancePercentage: number | null;
  } | null;
  canManage: boolean;
};

const categories = [
  ["employer_contributions", "Cargas patronales"],
  ["bonus", "Bonos"],
  ["commission", "Comisiones"],
  ["overtime", "Horas extra"],
  ["vacation", "Vacaciones"],
  ["severance", "Finiquitos"],
  ["allowance", "Asignaciones"],
  ["adjustment", "Ajuste"],
  ["other", "Otro concepto"],
] as const;
const categoryLabels = Object.fromEntries([
  ["contractual_salary", "Remuneración contractual"],
  ...categories,
]) as Record<string, string>;
const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const percentage = new Intl.NumberFormat("es-CL", { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" });
const date = new Intl.DateTimeFormat("es-CL", { dateStyle: "medium" });
const dateTime = new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short" });

function localDate() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function currentMonth() {
  return localDate().slice(0, 7);
}

function monthEnd(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

function defaultAsOf(month: string) {
  const today = localDate();
  if (today.slice(0, 7) === month) return today;
  return today < `${month}-01` ? `${month}-01` : monthEnd(month);
}

function amount(value: number | string | null | undefined) {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function errorMessage(error: string | undefined, detail: string | null | undefined) {
  if (detail?.includes("current draft")) return "Ya existe una semana en borrador. Contabilízala o descártala antes de abrir otra.";
  if (detail?.includes("closed period")) return "El período contable está cerrado. Debes reabrirlo antes de registrar este movimiento.";
  if (detail?.includes("Official payroll")) return "La nómina real todavía no está disponible para este mes.";
  if (detail?.includes("chronological")) return "Las versiones semanales deben registrarse en orden cronológico.";
  if (detail?.includes("latest PeopleWork snapshot")) return "PeopleWork cambió desde esta versión. Refresca la semana antes de contabilizar.";
  if (detail?.includes("Synchronize PeopleWork") || detail?.includes("Configure PeopleWork")) return "Primero debes sincronizar y configurar PeopleWork para este año.";
  if (detail?.includes("reconciled")) return "La nómina real ya fue conciliada y no puede reemplazarse sin reabrir ese proceso.";
  if (error === "invalid_provision_line_amount") return "El componente no genera monto. Revisa el valor o la base PeopleWork del centro de costo.";
  return detail || "No fue posible completar la operación.";
}

export function PayrollProvisions({ organizationId }: { organizationId: string | null }) {
  const [month, setMonth] = useState(currentMonth());
  const [asOfDate, setAsOfDate] = useState(defaultAsOf(currentMonth()));
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState({
    category: "employer_contributions",
    label: "Cargas patronales estimadas",
    calculationMethod: "percentage",
    direction: "add",
    amount: "",
    calculationRate: "",
    costCenterId: "",
    notes: "",
  });
  const [revisionNotes, setRevisionNotes] = useState("");
  const [actualAllocations, setActualAllocations] = useState<Array<{ costCenterId: string; amount: string }>>([]);
  const [actualDraft, setActualDraft] = useState({ costCenterId: "", amount: "" });

  async function load() {
    if (!organizationId) {
      setPayload(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const params = new URLSearchParams({ organizationId, periodMonth: `${month}-01` });
    const response = await fetch(`/api/payroll-provisions?${params.toString()}`, { cache: "no-store" });
    const next = await response.json().catch(() => null) as Payload | null;
    if (!response.ok || !next) {
      setPayload(null);
      setMessage("No fue posible cargar las provisiones.");
    } else {
      setPayload(next);
      setRevisionNotes(next.currentRevision?.status === "draft" ? next.currentRevision.notes ?? "" : "");
      setActualAllocations(next.officialActualLines.map((line) => ({ costCenterId: line.costCenterId ?? "", amount: String(line.amount) })));
      setMessage("");
    }
    setLoading(false);
  }

  useEffect(() => { void load(); }, [organizationId, month]);

  async function post(body: Record<string, unknown>, success: string) {
    if (!organizationId) return false;
    setSaving(true);
    setMessage("");
    const response = await fetch("/api/payroll-provisions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId, ...body }),
    });
    const result = await response.json().catch(() => null) as { error?: string; detail?: string | null } | null;
    setSaving(false);
    if (!response.ok) {
      setMessage(errorMessage(result?.error, result?.detail));
      return false;
    }
    setMessage(success);
    await load();
    return true;
  }

  const revision = payload?.currentRevision ?? null;
  const editableRevision = payload?.workingRevision ?? null;
  const centerById = useMemo(() => new Map(payload?.centers.map((center) => [center.id, center]) ?? []), [payload?.centers]);
  const percentageBase = useMemo(() => {
    if (!editableRevision) return 0;
    return editableRevision.lines
      .filter((line) => line.source_type === "peoplework" && (!draft.costCenterId || line.cost_center_id === draft.costCenterId))
      .reduce((total, line) => total + amount(line.amount), 0);
  }, [editableRevision, draft.costCenterId]);
  const previewAmount = draft.calculationMethod === "percentage" && Number(draft.calculationRate) > 0
    ? percentageBase * Number(draft.calculationRate) / 100
    : Number(draft.amount) || 0;
  const displayedSummary = revision?.summary ?? {
    contractualBase: payload?.contractualSourceTotal ?? 0,
    additions: 0,
    deductions: 0,
  };
  const displayedEstimate = revision?.displayTotal ?? payload?.contractualSourceTotal ?? 0;
  const accountedProvision = payload?.lastPostedRevision?.displayTotal ?? 0;

  async function addLine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editableRevision) return;
    const created = await post({
      action: "add_line",
      revisionId: editableRevision.id,
      category: draft.category,
      label: draft.label,
      calculationMethod: draft.calculationMethod,
      direction: draft.direction,
      amount: draft.amount,
      calculationRate: draft.calculationRate,
      costCenterId: draft.costCenterId,
      notes: draft.notes,
    }, "Componente agregado a la estimación semanal.");
    if (created) setDraft((current) => ({ ...current, amount: "", calculationRate: "", notes: "" }));
  }

  async function refreshRevision() {
    await post({
      action: "refresh_revision",
      periodMonth: `${month}-01`,
      asOfDate,
    }, editableRevision ? "Base PeopleWork actualizada; los porcentajes fueron recalculados." : "Nueva versión semanal creada desde PeopleWork.");
  }

  async function postRevision() {
    if (!editableRevision) return;
    if (!window.confirm(`Se contabilizará la provisión al ${date.format(new Date(`${editableRevision.as_of_date}T00:00:00`))}. El asiento registrará sólo la diferencia contra la última versión. ¿Continuar?`)) return;
    await post({ action: "post_revision", revisionId: editableRevision.id }, "Versión semanal contabilizada por diferencia.");
  }

  async function reconcileActual() {
    if (!payload?.provision || payload.officialActual === null) return;
    if (!window.confirm("Se ajustará la provisión contabilizada al valor de la nómina real y el mes quedará conciliado. ¿Continuar?")) return;
    await post({ action: "reconcile_actual", provisionId: payload.provision.id }, "Provisión ajustada y conciliada contra la nómina real.");
  }

  function addActualAllocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = Number(actualDraft.amount);
    if (!Number.isFinite(value) || value <= 0) return;
    setActualAllocations((current) => {
      const existing = current.find((line) => line.costCenterId === actualDraft.costCenterId);
      if (existing) return current.map((line) => line === existing ? { ...line, amount: String(amount(line.amount) + value) } : line);
      return [...current, { costCenterId: actualDraft.costCenterId, amount: String(value) }];
    });
    setActualDraft({ costCenterId: "", amount: "" });
  }

  async function saveOfficialActual() {
    if (!actualAllocations.length) return;
    await post({
      action: "save_official_actual",
      periodMonth: `${month}-01`,
      allocations: actualAllocations.map((line) => ({ costCenterId: line.costCenterId || null, amount: amount(line.amount) })),
    }, "Nómina real guardada por centro de costo. Ya puedes ajustar la provisión contra el real.");
  }

  return <main className="dashboard payroll-provisions">
    <section className="headline">
      <div>
        <span className="eyebrow">PROVISIÓN MENSUAL · VERSIÓN SEMANAL</span>
        <h1>Provisiones de remuneraciones</h1>
        <p>Construye el costo esperado desde PeopleWork, agrega componentes no incluidos y conserva cada movimiento semanal hasta conciliarlo con la nómina real.</p>
      </div>
      <div className="headline-actions">
        <label className="period-picker">Mes<input type="month" value={month} onChange={(event) => { const next = event.target.value; setMonth(next); setAsOfDate(defaultAsOf(next)); }} /></label>
        <button className="secondary-button" type="button" onClick={() => void load()} disabled={loading}>{loading ? "Actualizando…" : "Actualizar"}</button>
      </div>
    </section>

    {message && <p className="operation-message">{message}</p>}

    <section className="kpis kpis-six" aria-label="Resumen de provisión">
      <article className="kpi-card"><span>Base PeopleWork</span><strong>{money.format(displayedSummary.contractualBase)}</strong><small>Sueldo bruto contractual de la versión</small></article>
      <article className="kpi-card"><span>Ajustes estimados netos</span><strong>{money.format(displayedSummary.additions - displayedSummary.deductions)}</strong><small>{money.format(displayedSummary.additions)} agregados · {money.format(displayedSummary.deductions)} descuentos</small></article>
      <article className="kpi-card"><span>Estimación de trabajo</span><strong>{money.format(displayedEstimate)}</strong><small>{editableRevision ? `Borrador al ${date.format(new Date(`${editableRevision.as_of_date}T00:00:00`))}; no impacta reportes` : revision ? "Última versión contabilizada" : "Aún sin versión semanal"}</small></article>
      <article className="kpi-card accent"><span>Provisión contabilizada</span><strong>{accountedProvision ? money.format(accountedProvision) : "Pendiente"}</strong><small>{accountedProvision ? "Impacta Contabilidad y Reportes hasta recibir el real" : "El borrador todavía no impacta KPI financieros"}</small></article>
      <article className="kpi-card"><span>Nómina real</span><strong>{payload?.officialActual === null || payload?.officialActual === undefined ? "Pendiente" : money.format(payload.officialActual)}</strong><small>{payload?.officialActual === null || payload?.officialActual === undefined ? "Se activará al recibir la nómina oficial" : "Costo oficial disponible"}</small></article>
      <article className={`kpi-card ${payload?.comparison && payload.comparison.variance !== 0 ? "danger" : ""}`}><span>Desviación vs. real</span><strong>{payload?.comparison ? money.format(payload.comparison.variance) : "—"}</strong><small>{payload?.comparison?.variancePercentage === null || payload?.comparison?.variancePercentage === undefined ? "Sin nómina real para comparar" : percentage.format(payload.comparison.variancePercentage)}</small></article>
    </section>

    {payload?.sourceIsStale && <p className="operation-message">PeopleWork cambió desde que se abrió este borrador. Refresca la versión antes de contabilizar; la base de datos también bloqueará un asiento obsoleto.</p>}

    <section className="billing-form-panel panel">
      <div className="panel-heading">
        <div>
          <span className="panel-label">VERSIÓN DE TRABAJO</span>
          <h2>{editableRevision ? `Semana al ${date.format(new Date(`${editableRevision.as_of_date}T00:00:00`))}` : "Abrir una nueva semana"}</h2>
          <p>Cada semana copia los componentes manuales de la anterior, actualiza PeopleWork y recalcula los porcentajes.</p>
        </div>
        {payload?.provision?.status === "reconciled"
          ? <span className="status paid">Conciliada contra real</span>
          : <div className="headline-actions">
            <label className="period-picker">Fecha de corte<input type="date" min={`${month}-01`} max={monthEnd(month)} value={editableRevision?.as_of_date ?? asOfDate} disabled={Boolean(editableRevision)} onChange={(event) => setAsOfDate(event.target.value)} /></label>
            <button className="primary-button" type="button" onClick={() => void refreshRevision()} disabled={!payload?.canManage || saving}>{editableRevision ? "Refrescar PeopleWork" : "Crear versión semanal"}</button>
          </div>}
      </div>
      {editableRevision && <div className="provision-draft-actions">
        <label className="form-wide">Supuestos / comentario semanal<textarea value={revisionNotes} maxLength={1000} onChange={(event) => setRevisionNotes(event.target.value)} placeholder="Ej. incluye bono trimestral y estimación de horas extra…" /></label>
        <button className="secondary-button" type="button" disabled={saving || revisionNotes === (editableRevision.notes ?? "")} onClick={() => void post({ action: "update_revision_notes", revisionId: editableRevision.id, notes: revisionNotes }, "Comentario semanal guardado.")}>Guardar comentario</button>
        <button className="text-button" type="button" disabled={saving} onClick={() => { if (window.confirm("Se eliminará solamente esta versión en borrador. ¿Continuar?")) void post({ action: "discard_revision", revisionId: editableRevision.id }, "Borrador semanal descartado."); }}>Descartar borrador</button>
      </div>}
    </section>

    {editableRevision && payload?.canManage && <section className="table-section">
      <div className="table-heading"><div><span className="panel-label">COMPONENTES NO INCLUIDOS</span><h2>Agregar supuesto a la provisión</h2><p>Usa un monto fijo o un porcentaje sobre toda la base PeopleWork o sobre un centro de costo específico.</p></div></div>
      <form className="expense-filter-row provision-line-form" onSubmit={addLine}>
        <label><span>Tipo</span><select value={draft.category} onChange={(event) => { const selected = categories.find(([value]) => value === event.target.value); setDraft((current) => ({ ...current, category: event.target.value, label: selected?.[1] ?? current.label })); }}>{categories.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label><span>Concepto</span><input value={draft.label} maxLength={180} onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} required /></label>
        <label><span>Cálculo</span><select value={draft.calculationMethod} onChange={(event) => setDraft((current) => ({ ...current, calculationMethod: event.target.value }))}><option value="percentage">% de base PeopleWork</option><option value="fixed">Monto fijo</option></select></label>
        <label><span>Efecto</span><select value={draft.direction} onChange={(event) => setDraft((current) => ({ ...current, direction: event.target.value }))}><option value="add">Sumar</option><option value="deduct">Descontar</option></select></label>
        <label><span>Centro de costo</span><select value={draft.costCenterId} onChange={(event) => setDraft((current) => ({ ...current, costCenterId: event.target.value }))}><option value="">Toda la empresa</option>{payload.centers.map((center) => <option key={center.id} value={center.id}>{center.code} · {center.name}</option>)}</select></label>
        {draft.calculationMethod === "percentage"
          ? <label><span>Porcentaje</span><input type="number" min="0.0001" max="1000" step="0.0001" value={draft.calculationRate} onChange={(event) => setDraft((current) => ({ ...current, calculationRate: event.target.value }))} required /><small>Base {money.format(percentageBase)} · estimado {money.format(previewAmount)}</small></label>
          : <label><span>Monto</span><input type="number" min="1" step="0.01" value={draft.amount} onChange={(event) => setDraft((current) => ({ ...current, amount: event.target.value }))} required /></label>}
        <label><span>Nota</span><input value={draft.notes} maxLength={1000} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} placeholder="Supuesto o respaldo" /></label>
        <button className="primary-button" type="submit" disabled={saving || previewAmount <= 0}>Agregar componente</button>
      </form>
    </section>}

    <section className="table-section">
      <div className="table-heading">
        <div><span className="panel-label">COMPOSICIÓN</span><h2>Detalle de la estimación vigente</h2><p>PeopleWork permanece identificado como origen; todo lo demás corresponde a supuestos del manager.</p></div>
        {editableRevision && <button className="primary-button" type="button" disabled={!payload?.canManage || saving || editableRevision.displayTotal <= 0} onClick={() => void postRevision()}>Contabilizar versión</button>}
      </div>
      <div className="table-scroll"><table><thead><tr><th>Origen</th><th>Concepto</th><th>Cálculo</th><th>Centro de costo</th><th className="money-col">Efecto</th>{editableRevision && <th />}</tr></thead><tbody>
        {revision?.lines.length ? revision.lines.map((line) => {
          const center = line.cost_center_id ? centerById.get(line.cost_center_id) : null;
          return <tr key={line.id}>
            <td><span className={`status ${line.source_type === "peoplework" ? "neutral" : "pending"}`}>{line.source_type === "peoplework" ? "PeopleWork" : "Manager"}</span></td>
            <td><strong>{line.label}</strong><small>{categoryLabels[line.category] ?? line.category}{line.notes ? ` · ${line.notes}` : ""}</small></td>
            <td>{line.calculation_method === "percentage" ? `${amount(line.calculation_rate).toLocaleString("es-CL", { maximumFractionDigits: 4 })}% de ${money.format(amount(line.calculation_base))}` : line.calculation_method === "source" ? "Base contractual" : "Monto fijo"}</td>
            <td>{center ? `${center.code} · ${center.name}` : line.source_cost_center_name || line.source_cost_center_code || "Toda la empresa"}</td>
            <td className={`money-col ${line.direction === "deduct" ? "is-negative" : ""}`}>{line.direction === "deduct" ? "−" : "+"}{money.format(amount(line.amount))}</td>
            {editableRevision && <td>{line.source_type === "manual" ? <button className="text-button" type="button" disabled={saving} onClick={() => void post({ action: "delete_line", lineId: line.id }, "Componente eliminado.")}>Quitar</button> : null}</td>}
          </tr>;
        }) : <tr><td colSpan={editableRevision ? 6 : 5}>Crea una versión semanal para comenzar la estimación.</td></tr>}
      </tbody><tfoot><tr><td colSpan={4}><strong>Total estimado</strong></td><td className="money-col"><strong>{money.format(displayedEstimate)}</strong></td>{editableRevision && <td />}</tr></tfoot></table></div>
    </section>

    <section className="table-section">
      <div className="table-heading"><div><span className="panel-label">MOVIMIENTO SEMANAL</span><h2>Historial del mes</h2><p>La columna movimiento muestra el asiento incremental, no el total repetido.</p></div>{payload?.provision?.status === "open" && payload.officialActual !== null && amount(payload.provision.posted_amount) > 0 && !editableRevision && <button className="primary-button" type="button" disabled={!payload.canManage || saving} onClick={() => void reconcileActual()}>Ajustar contra nómina real</button>}</div>
      <div className="table-scroll"><table><thead><tr><th>Fecha de corte</th><th>Estado</th><th className="money-col">Estimación</th><th className="money-col">Movimiento contable</th><th>Comentario</th></tr></thead><tbody>
        {payload?.revisions.length ? payload.revisions.map((item) => <tr key={item.id}><td><strong>{date.format(new Date(`${item.as_of_date}T00:00:00`))}</strong><small>{item.source_refreshed_at ? `PeopleWork actualizado ${dateTime.format(new Date(item.source_refreshed_at))}` : "Sin actualización de origen"}</small></td><td><span className={`status ${item.status === "posted" ? "paid" : "pending"}`}>{item.status === "posted" ? "Contabilizada" : "Borrador"}</span></td><td className="money-col">{money.format(item.displayTotal)}</td><td className={`money-col ${amount(item.accounting_delta) < 0 ? "is-negative" : ""}`}>{item.status === "posted" ? money.format(amount(item.accounting_delta)) : "—"}</td><td>{item.notes || "—"}</td></tr>) : <tr><td colSpan={5}>No existen versiones semanales para este mes.</td></tr>}
      </tbody></table></div>
    </section>

    <section className="table-section">
      <div className="table-heading"><div><span className="panel-label">NÓMINA REAL</span><h2>Carga manual por centro de costo</h2><p>Cuando PeopleWork no entrega la liquidación por API, el manager puede registrar aquí el total oficial. Esta fuente reemplaza a la provisión en los KPI; nunca se suma con ella.</p></div>{payload?.canManage && payload?.provision?.status !== "reconciled" && <button className="primary-button" type="button" disabled={saving || !actualAllocations.length} onClick={() => void saveOfficialActual()}>Guardar nómina real</button>}</div>
      {payload?.canManage && payload?.provision?.status !== "reconciled" && <form className="expense-filter-row provision-line-form" onSubmit={addActualAllocation}>
        <label><span>Centro de costo</span><select value={actualDraft.costCenterId} onChange={(event) => setActualDraft((current) => ({ ...current, costCenterId: event.target.value }))}><option value="">Sin centro asignado</option>{payload.centers.map((center) => <option key={center.id} value={center.id}>{center.code} · {center.name}</option>)}</select></label>
        <label><span>Monto liquidado oficial</span><input type="number" min="1" step="0.01" value={actualDraft.amount} onChange={(event) => setActualDraft((current) => ({ ...current, amount: event.target.value }))} required /></label>
        <button className="secondary-button" type="submit" disabled={saving || amount(actualDraft.amount) <= 0}>Agregar al detalle</button>
      </form>}
      <div className="table-scroll"><table><thead><tr><th>Centro de costo</th><th className="money-col">Monto real</th>{payload?.canManage && payload?.provision?.status !== "reconciled" && <th />}</tr></thead><tbody>{actualAllocations.length ? actualAllocations.map((line, index) => { const center = line.costCenterId ? centerById.get(line.costCenterId) : null; return <tr key={`${line.costCenterId || "sin-centro"}-${index}`}><td><strong>{center ? `${center.code} · ${center.name}` : "Sin centro asignado"}</strong></td><td className="money-col">{money.format(amount(line.amount))}</td>{payload?.canManage && payload?.provision?.status !== "reconciled" && <td><button type="button" className="text-button" onClick={() => setActualAllocations((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Quitar</button></td>}</tr>; }) : <tr><td colSpan={payload?.canManage && payload?.provision?.status !== "reconciled" ? 3 : 2}>Aún no se ha cargado la nómina real de este mes.</td></tr>}</tbody><tfoot><tr><td><strong>Total nómina real</strong></td><td className="money-col"><strong>{money.format(actualAllocations.reduce((total, line) => total + amount(line.amount), 0))}</strong></td>{payload?.canManage && payload?.provision?.status !== "reconciled" && <td />}</tr></tfoot></table></div>
    </section>

    {payload?.comparison && <section className="billing-form-panel panel">
      <div className="panel-heading"><div><span className="panel-label">CONTROL CONTRA REAL</span><h2>{payload.comparison.variance === 0 ? "Provisión exacta" : payload.comparison.variance > 0 ? "El gasto real superó la provisión" : "La provisión quedó por sobre el gasto real"}</h2><p>Provisionado {money.format(payload.comparison.provisionAmount)} · real {money.format(payload.comparison.actualAmount)} · diferencia {money.format(payload.comparison.variance)}.</p></div><span className={`status ${payload.comparison.variance === 0 ? "paid" : "pending"}`}>{payload.comparison.variancePercentage === null ? "Sin base" : percentage.format(payload.comparison.variancePercentage)}</span></div>
    </section>}
  </main>;
}
