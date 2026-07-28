"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Counterparty = { id: string; legal_name: string; trade_name: string | null; tax_id: string | null };
type CostCenter = { id: string; code: string; name: string };
type Entry = { id: string; kind: "sale" | "cost"; number: string | null; documentType: string | null; counterpart: string | null; issuedOn: string | null; amount: number | string | null; status: string | null; attachmentName: string | null; hasAttachment: boolean; createdAt: string };
type Payload = { customers: Counterparty[]; suppliers: Counterparty[]; costCenters: CostCenter[]; entries: Entry[] };
type View = "register" | "history";

const today = () => new Date().toISOString().slice(0, 10);
const label = (item: Counterparty) => item.trade_name?.trim() || item.legal_name;
const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const displayDate = (value: string | null) => value ? new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00`)) : "—";

function reviewStatus(status: string | null) {
  return !status || status === "Pendiente" ? "En revisión" : "Procesado por Finanzas";
}

function RegisterIcon() {
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6" /><path d="M12 18v-6" /><path d="M9 15h6" /></svg>;
}

function HistoryIcon() {
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7v5l3 2" /></svg>;
}

export function DataEntryWorkspace({ organizationId, organizationName, organizationTaxId }: { organizationId: string; organizationName: string; organizationTaxId: string | null }) {
  const [data, setData] = useState<Payload>({ customers: [], suppliers: [], costCenters: [], entries: [] });
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [savingSale, setSavingSale] = useState(false);
  const [savingCost, setSavingCost] = useState(false);
  const [openingFile, setOpeningFile] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [view, setView] = useState<View>("history");

  const load = useCallback(async () => {
    const response = await fetch(`/api/data-entry?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("unable_to_load_data_entry_workspace");
    setData(await response.json() as Payload);
  }, [organizationId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    load().catch(() => { if (active) setMessage("No fue posible cargar tus catálogos e ingresos."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load]);

  const pendingEntries = useMemo(() => data.entries.filter((entry) => !entry.status || entry.status === "Pendiente").length, [data.entries]);
  const salesCount = useMemo(() => data.entries.filter((entry) => entry.kind === "sale").length, [data.entries]);
  const costsCount = data.entries.length - salesCount;

  function selectView(nextView: View) {
    setMessage(null);
    setView(nextView);
  }

  async function submitSale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingSale(true); setMessage(null);
    const form = new FormData(event.currentTarget);
    form.set("issuerName", organizationName);
    form.set("issuerTaxId", organizationTaxId ?? "");
    form.set("status", "Pendiente");
    form.set("paymentCondition", "post_service");
    const response = await fetch("/api/issued-documents", { method: "POST", body: form });
    if (response.ok) {
      event.currentTarget.reset();
      await load();
      setView("history");
      setMessage("Venta registrada. Ya la puedes revisar en Mis ingresos.");
    } else setMessage("No se pudo registrar la venta. Revisa los campos obligatorios.");
    setSavingSale(false);
  }

  async function submitCost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingCost(true); setMessage(null);
    const form = new FormData(event.currentTarget);
    form.set("organizationId", organizationId);
    form.set("action", "cost");
    const response = await fetch("/api/data-entry", { method: "POST", body: form });
    if (response.ok) {
      event.currentTarget.reset();
      await load();
      setView("history");
      setMessage("Costo registrado. Ya lo puedes revisar en Mis ingresos.");
    } else setMessage("No se pudo registrar el costo. Revisa los campos obligatorios.");
    setSavingCost(false);
  }

  async function openAttachment(entry: Entry) {
    setOpeningFile(entry.id);
    const response = await fetch(`/api/data-entry?organizationId=${encodeURIComponent(organizationId)}&fileId=${encodeURIComponent(entry.id)}&fileKind=${entry.kind}`);
    const payload = await response.json().catch(() => null) as { signedUrl?: string } | null;
    if (response.ok && payload?.signedUrl) window.open(payload.signedUrl, "_blank", "noopener,noreferrer");
    else setMessage("No fue posible abrir el respaldo de este documento.");
    setOpeningFile(null);
  }

  async function signOut() {
    await createClient().auth.signOut();
    window.location.assign("/login");
  }

  return <div className={`app-shell ${sidebarCollapsed ? "sidebar-is-collapsed" : ""}`}>
    <aside className={`sidebar ${sidebarCollapsed ? "is-collapsed" : ""}`}>
      <div className="brand">
        <div className="brand-identity">
          <img className="brand-logo" src="/atlas-financiero-logo.png" alt="" />
          <span className="brand-name">Atlas <b>Financiero</b></span>
        </div>
        <button className="sidebar-collapse-button" type="button" onClick={() => setSidebarCollapsed((current) => !current)} aria-label={sidebarCollapsed ? "Expandir navegación" : "Contraer navegación"} title={sidebarCollapsed ? "Expandir navegación" : "Contraer navegación"}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m14 7-5 5 5 5" /><path d="M20 5v14" /></svg>
        </button>
      </div>
      <div className="workspace-label">ESPACIO DE TRABAJO</div>
      <div className="workspace-switcher data-entry-organization" title={organizationName}>{organizationName}</div>
      <nav aria-label="Navegación principal">
        <section className="navigation-group" aria-label="Mi trabajo" style={{ "--navigation-group-accent": "#80d9b8", "--navigation-group-accent-soft": "#203a40" } as React.CSSProperties}>
          <div className="navigation-group-toggle is-active-group">
            <span className="navigation-group-heading"><span className="navigation-group-icon"><HistoryIcon /></span><span className="navigation-group-label">MI TRABAJO</span></span>
          </div>
          <div className="navigation-group-items is-open">
            <button type="button" className={`nav-item ${view === "register" ? "active" : ""}`} onClick={() => selectView("register")}>
              <span className="nav-icon"><RegisterIcon /></span><span className="nav-item-label">Registrar documento</span>
            </button>
            <button type="button" className={`nav-item ${view === "history" ? "active" : ""}`} onClick={() => selectView("history")}>
              <span className="nav-icon"><HistoryIcon /></span><span className="nav-item-label">Mis ingresos</span><span className="nav-count">{data.entries.length}</span>
            </button>
          </div>
        </section>
      </nav>
      <div className="sidebar-bottom"><p>Digitación</p></div>
    </aside>

    <section className="content-area">
      <header className="topbar">
        <div className="breadcrumb">Digitación <span>/</span> {view === "history" ? "Mis ingresos" : "Registrar documento"}</div>
        <div className="topbar-actions"><span className="access-role">Digitador</span><button className="avatar" type="button" onClick={() => void signOut()} aria-label="Cerrar sesión" title="Cerrar sesión">DG</button></div>
      </header>
      <main className="dashboard data-entry-content">
        <header className="headline data-entry-header">
          <div><span className="eyebrow">OPERACIÓN · DOCUMENTOS</span><h1>{view === "history" ? "Mis ingresos" : "Registrar documento"}</h1><p>{view === "history" ? "Revisa sólo los documentos que tú cargaste y su etapa de revisión. No se muestran saldos, pagos ni resultados de la empresa." : "Registra ventas y costos para que Finanzas los revise. Tus documentos quedarán disponibles en Mis ingresos."}</p></div>
          {view === "history" ? <button type="button" className="primary-button" onClick={() => selectView("register")}>Registrar documento</button> : <button type="button" className="secondary-button" onClick={() => selectView("history")}>Ver mis ingresos</button>}
        </header>
        {message && <p className="operation-message" role="status">{message}</p>}
        {loading ? <section className="panel data-entry-loading">Cargando tu bandeja…</section> : view === "history" ? <section className="panel data-entry-history">
          <div className="data-entry-history-heading"><div><span className="panel-label">TRAZABILIDAD PERSONAL</span><h2>Documentos que ingresaste</h2><p>Cada documento queda visible para ti, sin revelar información financiera consolidada.</p></div><button type="button" className="secondary-button" onClick={() => void load()}>Actualizar</button></div>
          <div className="data-entry-summary"><article><span>Ventas ingresadas</span><strong>{salesCount}</strong></article><article><span>Costos ingresados</span><strong>{costsCount}</strong></article><article><span>En revisión</span><strong>{pendingEntries}</strong></article></div>
          <div className="table-scroll data-entry-table"><table><thead><tr><th>Documento</th><th>Cliente / proveedor</th><th>Fecha</th><th>Monto</th><th>Revisión</th><th>Respaldo</th></tr></thead><tbody>{data.entries.map((entry) => <tr key={`${entry.kind}-${entry.id}`}><td><span className={`data-entry-kind is-${entry.kind}`}>{entry.kind === "sale" ? "Venta" : "Costo"}</span><strong>{entry.number || "Sin folio"}</strong><small>{entry.documentType || "Documento"}</small></td><td>{entry.counterpart || "Sin contraparte"}</td><td>{displayDate(entry.issuedOn)}</td><td>{money.format(Number(entry.amount ?? 0))}</td><td><span className={`status ${(!entry.status || entry.status === "Pendiente") ? "pending" : "paid"}`}>{reviewStatus(entry.status)}</span></td><td>{entry.hasAttachment ? <button type="button" className="text-button" onClick={() => void openAttachment(entry)} disabled={openingFile === entry.id}>{openingFile === entry.id ? "Abriendo…" : "Ver respaldo"}</button> : <span className="data-entry-empty">Sin adjunto</span>}</td></tr>)}{!data.entries.length && <tr><td colSpan={6}><div className="data-entry-empty-state"><strong>Aún no has ingresado documentos.</strong><span>Cuando registres una venta o costo aparecerá aquí, con su estado de revisión.</span><button type="button" className="primary-button" onClick={() => selectView("register")}>Registrar el primero</button></div></td></tr>}</tbody></table></div>
        </section> : <div className="data-entry-register-grid">
          <section className="panel data-entry-form-panel"><div className="panel-heading"><div><span className="panel-label">VENTAS</span><h2>Ingresar factura de venta</h2><p>Se envía a revisión de Finanzas; tú podrás verla luego en Mis ingresos.</p></div></div>
            <form className="admin-form" onSubmit={(event) => void submitSale(event)}><div className="form-grid">
              <label>Cliente *<select name="clientId" required defaultValue=""><option value="" disabled>Selecciona cliente</option>{data.customers.map((item) => <option key={item.id} value={item.id}>{label(item)}{item.tax_id ? ` · ${item.tax_id}` : ""}</option>)}</select></label><label>Folio / número *<input name="invoiceNumber" required maxLength={80} /></label><label>Tipo *<select name="documentType" defaultValue="Factura afecta"><option>Factura afecta</option><option>Factura exenta</option><option>Nota de crédito</option><option>Nota de débito</option></select></label><label>Fecha emisión *<input name="issueDate" type="date" required defaultValue={today()} /></label><label>Vencimiento *<input name="dueDate" type="date" required defaultValue={today()} /></label><label>Monto neto *<input name="netAmount" type="number" min="0" step="0.01" required /></label><label className="data-entry-wide-field">Adjunto (PDF o imagen)<input name="file" type="file" accept="application/pdf,image/jpeg,image/png" /></label>
            </div><button className="primary-button" disabled={savingSale || !data.customers.length}>{savingSale ? "Guardando…" : "Registrar venta"}</button></form>
          </section>
          <section className="panel data-entry-form-panel"><div className="panel-heading"><div><span className="panel-label">COSTOS</span><h2>Ingresar factura de proveedor</h2><p>No crea pagos ni aprobaciones; sólo deja la carga lista para revisión.</p></div></div>
            <form className="admin-form" onSubmit={(event) => void submitCost(event)}><div className="form-grid">
              <label>Proveedor *<select name="supplierId" required defaultValue=""><option value="" disabled>Selecciona proveedor</option>{data.suppliers.map((item) => <option key={item.id} value={item.id}>{label(item)}{item.tax_id ? ` · ${item.tax_id}` : ""}</option>)}</select></label><label>Centro de costo *<select name="costCenterId" required defaultValue=""><option value="" disabled>Selecciona centro</option>{data.costCenters.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select></label><label>Folio / número *<input name="documentNumber" required maxLength={80} /></label><label>Tipo *<select name="documentType" defaultValue="Factura afecta"><option>Factura afecta</option><option>Factura exenta</option><option>Nota de crédito</option><option>Nota de débito</option><option>Boleta</option><option>Otro</option></select></label><label>Fecha emisión *<input name="issueDate" type="date" required defaultValue={today()} /></label><label>Vencimiento<input name="dueDate" type="date" /></label><label>Monto neto *<input name="netAmount" type="number" min="0" step="0.01" required /></label><label>IVA *<input name="vatAmount" type="number" min="0" step="0.01" required /></label><label>Otros impuestos *<input name="additionalTaxAmount" type="number" min="0" step="0.01" defaultValue="0" required /></label><label>Adjunto (PDF o imagen)<input name="file" type="file" accept="application/pdf,image/jpeg,image/png" /></label>
            </div><label>Observación<textarea name="notes" maxLength={2000} /></label><button className="primary-button" disabled={savingCost || !data.suppliers.length || !data.costCenters.length}>{savingCost ? "Guardando…" : "Registrar costo"}</button></form>
          </section>
        </div>}
      </main>
    </section>
  </div>;
}
