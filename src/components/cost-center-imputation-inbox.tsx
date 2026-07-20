"use client";

import { useEffect, useMemo, useState } from "react";

type Center = { id: string; code: string; name: string };
type Source = "issued_document" | "received_document" | "direct_payable" | "budget_line" | "financing_plan";
type Kind = "income" | "expense" | "planned_income" | "planned_expense" | "commitment";
type Row = { id: string; source: Source; kind: Kind; reference: string; title: string; counterparty: string; date: string | null; amount: number; currency: string; status: string | null };
type Payload = { centers: Center[]; rows: Row[] };

const sourceLabels: Record<Source, string> = {
  issued_document: "Factura emitida",
  received_document: "Factura recibida",
  direct_payable: "Cuenta por pagar",
  budget_line: "Presupuesto",
  financing_plan: "Compromiso de pago",
};
const kindLabels: Record<Kind, string> = { income: "Ingreso real", expense: "Gasto real", planned_income: "Ingreso proyectado", planned_expense: "Gasto proyectado", commitment: "Compromiso" };
const currency = (value: number, code: string) => new Intl.NumberFormat("es-CL", { style: "currency", currency: code, maximumFractionDigits: code === "UF" ? 4 : 0 }).format(value);
const date = (value: string | null) => value ? new Intl.DateTimeFormat("es-CL", { dateStyle: "medium" }).format(new Date(`${value}T00:00:00`)) : "Sin fecha";

export function CostCenterImputationInbox({ organizationId }: { organizationId: string | null }) {
  const [data, setData] = useState<Payload | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkCenterId, setBulkCenterId] = useState("");
  const [rowCenters, setRowCenters] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<"all" | Kind>("all");
  const [search, setSearch] = useState("");

  async function load() {
    if (!organizationId) { setData(null); return; }
    setLoading(true);
    const response = await fetch(`/api/cost-center-imputations?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as Payload | null;
    setLoading(false);
    if (!response.ok || !payload) { setData(null); setMessage("No fue posible cargar las imputaciones pendientes."); return; }
    setData(payload); setMessage(null); setSelected([]); setRowCenters({});
  }
  useEffect(() => { void load(); }, [organizationId]);

  const visibleRows = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return (data?.rows ?? []).filter((row) => (filter === "all" || row.kind === filter) && (!term || `${row.reference} ${row.title} ${row.counterparty} ${sourceLabels[row.source]}`.toLocaleLowerCase().includes(term)));
  }, [data, filter, search]);
  const totals = useMemo(() => (data?.rows ?? []).reduce((summary, row) => {
    if (row.currency !== "CLP") return summary;
    if (row.kind === "income") summary.income += row.amount;
    if (row.kind === "expense") summary.expense += row.amount;
    if (row.kind === "planned_income") summary.plannedIncome += row.amount;
    if (row.kind === "planned_expense") summary.plannedExpense += row.amount;
    return summary;
  }, { income: 0, expense: 0, plannedIncome: 0, plannedExpense: 0 }), [data]);

  async function assign(source: Source, recordIds: string[], costCenterId: string) {
    if (!organizationId || !costCenterId || !recordIds.length) return;
    setSaving(true); setMessage(null);
    const response = await fetch("/api/cost-center-imputations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, source, recordIds, costCenterId }) });
    setSaving(false);
    if (!response.ok) { setMessage("No fue posible asignar el centro. Verifica que siga activo y vuelve a intentar."); return; }
    const result = await response.json() as { assigned: number };
    setMessage(`${result.assigned} registro(s) imputado(s) y sincronizado(s) con los módulos financieros.`);
    await load();
  }
  async function assignSelected() {
    if (!bulkCenterId || !selected.length) return;
    const groups = new Map<Source, string[]>();
    for (const row of data?.rows ?? []) if (selected.includes(row.id)) groups.set(row.source, [...(groups.get(row.source) ?? []), row.id]);
    setSaving(true); setMessage(null);
    const responses = await Promise.all([...groups.entries()].map(async ([source, recordIds]) => fetch("/api/cost-center-imputations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, source, recordIds, costCenterId: bulkCenterId }) })));
    setSaving(false);
    if (responses.some((response) => !response.ok)) { setMessage("Algunos registros no pudieron imputarse. No se modificaron los que ya tenían centro asignado."); await load(); return; }
    setMessage(`${selected.length} registro(s) imputado(s) y sincronizado(s) con los módulos financieros.`); await load();
  }
  function toggle(id: string) { setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]); }

  return <main className="dashboard">
    <section className="headline"><div><span className="eyebrow">CONTROL DE IMPUTACIÓN</span><h1>Imputaciones pendientes</h1><p>Concentra ingresos, gastos, presupuesto y compromisos sin centro de costo. La asignación actualiza el registro origen y su trazabilidad.</p></div><button className="secondary-button" type="button" disabled={loading || saving} onClick={() => void load()}>{loading ? "Actualizando…" : "Actualizar"}</button></section>
    {message && <p className="operation-message">{message}</p>}
    <section className="kpis"><article className="kpi-card accent"><span>Sin imputar</span><strong>{data?.rows.length ?? 0}</strong><small>Registros que requieren centro</small></article><article className="kpi-card"><span>Ingresos reales</span><strong>{currency(totals.income, "CLP")}</strong><small>Facturas emitidas pendientes</small></article><article className="kpi-card"><span>Gastos reales</span><strong>{currency(totals.expense, "CLP")}</strong><small>Facturas y cuentas por pagar</small></article><article className="kpi-card"><span>Plan pendiente</span><strong>{currency(totals.plannedIncome + totals.plannedExpense, "CLP")}</strong><small>Ingresos y gastos proyectados</small></article></section>
    <section className="table-section"><div className="table-heading"><div><span className="panel-label">BANDEJA CENTRALIZADA</span><h2>Registros sin centro de costo</h2><p>Selecciona varios para una imputación masiva o resuelve uno directamente en la tabla.</p></div></div>
      <div className="p2p-payment-filters"><label>Buscar<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Documento, contraparte o descripción" /></label><label>Tipo<select value={filter} onChange={(event) => setFilter(event.target.value as "all" | Kind)}><option value="all">Todos</option><option value="income">Ingresos reales</option><option value="expense">Gastos reales</option><option value="planned_income">Ingresos proyectados</option><option value="planned_expense">Gastos proyectados</option><option value="commitment">Compromisos</option></select></label><label>Centro para seleccionados<select value={bulkCenterId} onChange={(event) => setBulkCenterId(event.target.value)}><option value="">Selecciona un centro</option>{data?.centers.map((center) => <option key={center.id} value={center.id}>{center.code} · {center.name}</option>)}</select></label><button className="primary-button" type="button" disabled={saving || !selected.length || !bulkCenterId} onClick={() => void assignSelected()}>Asignar {selected.length || ""} seleccionado(s)</button></div>
      {loading ? <p className="billing-empty">Cargando registros…</p> : <div className="table-scroll"><table><thead><tr><th><input type="checkbox" aria-label="Seleccionar registros visibles" checked={Boolean(visibleRows.length) && visibleRows.every((row) => selected.includes(row.id))} onChange={(event) => setSelected(event.target.checked ? [...new Set([...selected, ...visibleRows.map((row) => row.id)])] : selected.filter((id) => !visibleRows.some((row) => row.id === id)))} /></th><th>Registro</th><th>Origen</th><th>Fecha</th><th className="money-col">Monto</th><th>Centro de costo</th><th /></tr></thead><tbody>{visibleRows.map((row) => <tr key={`${row.source}-${row.id}`}><td><input type="checkbox" aria-label={`Seleccionar ${row.reference}`} checked={selected.includes(row.id)} onChange={() => toggle(row.id)} /></td><td><strong>{row.reference}</strong><small>{row.title}</small><small>{row.counterparty}</small></td><td><span className="status neutral">{kindLabels[row.kind]}</span><small>{sourceLabels[row.source]}{row.status ? ` · ${row.status}` : ""}</small></td><td>{date(row.date)}</td><td className="money-col">{currency(row.amount, row.currency)}</td><td><select value={rowCenters[row.id] ?? ""} onChange={(event) => setRowCenters((current) => ({ ...current, [row.id]: event.target.value }))}><option value="">Selecciona un centro</option>{data?.centers.map((center) => <option key={center.id} value={center.id}>{center.code} · {center.name}</option>)}</select></td><td><button className="secondary-button" type="button" disabled={saving || !(rowCenters[row.id] ?? "")} onClick={() => void assign(row.source, [row.id], rowCenters[row.id])}>Asignar</button></td></tr>)}{!visibleRows.length && <tr><td colSpan={7}>No hay registros pendientes para este filtro.</td></tr>}</tbody></table></div>}
    </section>
  </main>;
}
