"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { BenefitsWorkflow } from "@/components/benefits-workflow";

type Counterparty = { id: string; legal_name: string; trade_name: string | null; tax_id: string | null };
type CostCenter = { id: string; code: string; name: string };
type EntryKind = "sale" | "cost" | "collection" | "support";
type Entry = { id: string; kind: EntryKind; issuedDocumentId: string | null; number: string | null; documentType: string | null; counterpart: string | null; issuedOn: string | null; amount: number | string | null; status: string | null; attachmentName: string | null; hasAttachment: boolean; existingProof: boolean; createdAt: string };
type Reference = { kind: "sale" | "collection"; id: string; issuedDocumentId: string; number: string | null; occurredOn: string | null; counterpart: string | null; amount: number | string | null; status: string | null; detail: string | null; hasProof: boolean; createdAt: string };
type Payload = { customers: Counterparty[]; suppliers: Counterparty[]; costCenters: CostCenter[]; references: Reference[]; entries: Entry[] };
type View = "register" | "history" | "support" | "benefits";
type HistoryFilter = "all" | EntryKind;

const emptyPayload: Payload = { customers: [], suppliers: [], costCenters: [], references: [], entries: [] };
const today = () => new Date().toISOString().slice(0, 10);
const label = (item: Counterparty) => item.trade_name?.trim() || item.legal_name;
const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const displayDate = (value: string | null) => value ? new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value.slice(0, 10)}T12:00:00`)) : "—";
const searchable = (value: string | number | null | undefined) => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLocaleLowerCase("es-CL");

const kindLabels: Record<EntryKind, string> = { sale: "Factura", cost: "Costo", collection: "Cobro", support: "Respaldo" };
const filterLabels: { value: HistoryFilter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "sale", label: "Facturas" },
  { value: "collection", label: "Cobros" },
  { value: "cost", label: "Costos" },
  { value: "support", label: "Respaldos" },
];

function reviewStatus(entry: Entry) {
  if (entry.kind === "support") return "Respaldo cargado";
  if (entry.kind === "collection") return "Cobro registrado";
  return !entry.status || entry.status === "Pendiente" ? "En revisión" : entry.status;
}

function RegisterIcon() {
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6" /><path d="M12 18v-6" /><path d="M9 15h6" /></svg>;
}

function HistoryIcon() {
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7v5l3 2" /></svg>;
}

function AttachmentIcon() {
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.6 9.6a2 2 0 0 1-2.8-2.8l8.9-8.9" /></svg>;
}

function BenefitsIcon() {
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v18M16 7.5c-.7-1-2-1.5-4-1.5-2.3 0-4 1.1-4 3s1.7 3 4 3 4 1.1 4 3-1.7 3-4 3c-2 0-3.3-.5-4-1.5" /><path d="M4 20h16" /></svg>;
}

export function DataEntryWorkspace({ organizationId, organizationName, organizationTaxId }: { organizationId: string; organizationName: string; organizationTaxId: string | null }) {
  const [data, setData] = useState<Payload>(emptyPayload);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [savingSale, setSavingSale] = useState(false);
  const [savingCost, setSavingCost] = useState(false);
  const [savingSupport, setSavingSupport] = useState(false);
  const [openingFile, setOpeningFile] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [view, setView] = useState<View>("history");
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [historySearch, setHistorySearch] = useState("");
  const [supportTarget, setSupportTarget] = useState("");

  const load = useCallback(async () => {
    const response = await fetch(`/api/data-entry?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("unable_to_load_data_entry_workspace");
    setData(await response.json() as Payload);
  }, [organizationId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    load().catch(() => { if (active) setMessage("No fue posible cargar el historial de digitación."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load]);

  const categoryEntries = useMemo(() => historyFilter === "all" ? data.entries : data.entries.filter((entry) => entry.kind === historyFilter), [data.entries, historyFilter]);
  const filteredEntries = useMemo(() => {
    const terms = searchable(historySearch).trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return categoryEntries;
    return categoryEntries.filter((entry) => {
      const haystack = searchable([
        kindLabels[entry.kind],
        entry.number,
        entry.documentType,
        entry.counterpart,
        entry.issuedOn,
        entry.amount,
        entry.amount === null ? null : money.format(Number(entry.amount)),
        reviewStatus(entry),
      ].filter(Boolean).join(" "));
      return terms.every((term) => haystack.includes(term));
    });
  }, [categoryEntries, historySearch]);
  const selectedReference = useMemo(() => {
    const [kind, id] = supportTarget.split(":");
    return data.references.find((item) => item.kind === kind && item.id === id) ?? null;
  }, [data.references, supportTarget]);
  const referenceGroups = useMemo(() => ({
    invoices: data.references.filter((item) => item.kind === "sale"),
    collections: data.references.filter((item) => item.kind === "collection"),
  }), [data.references]);

  function selectView(nextView: View) {
    setMessage(null);
    setView(nextView);
  }

  function startSupport(entry?: Entry) {
    if (entry?.kind === "sale" || entry?.kind === "collection") setSupportTarget(`${entry.kind}:${entry.id}`);
    setMessage(null);
    setView("support");
  }

  async function submitSale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingSale(true); setMessage(null);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    form.set("issuerName", organizationName);
    form.set("issuerTaxId", organizationTaxId ?? "");
    form.set("status", "Pendiente");
    form.set("paymentCondition", "post_service");
    const response = await fetch("/api/issued-documents", { method: "POST", body: form });
    if (response.ok) {
      formElement.reset();
      await load();
      setView("history"); setHistoryFilter("sale");
      setMessage("Factura registrada. Ya aparece en el historial.");
    } else setMessage("No se pudo registrar la factura. Revisa los campos obligatorios.");
    setSavingSale(false);
  }

  async function submitCost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingCost(true); setMessage(null);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    form.set("organizationId", organizationId);
    form.set("action", "cost");
    const response = await fetch("/api/data-entry", { method: "POST", body: form });
    if (response.ok) {
      formElement.reset();
      await load();
      setView("history"); setHistoryFilter("cost");
      setMessage("Costo registrado. Ya aparece en el historial.");
    } else {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      setMessage(payload?.error === "duplicate_received_document"
        ? "Esta factura ya está registrada para el mismo proveedor, tipo y folio."
        : "No se pudo registrar el costo. Revisa los campos obligatorios.");
    }
    setSavingCost(false);
  }

  async function submitSupport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedReference) return;
    setSavingSupport(true); setMessage(null);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    form.set("organizationId", organizationId);
    form.set("action", "support");
    form.set("category", selectedReference.kind === "collection" ? "collection" : "invoice");
    form.set("targetId", selectedReference.id);
    const response = await fetch("/api/data-entry", { method: "POST", body: form });
    if (response.ok) {
      formElement.reset();
      setSupportTarget("");
      await load();
      setView("history"); setHistoryFilter("support");
      setMessage("Respaldo cargado y vinculado correctamente.");
    } else setMessage("No se pudo cargar el respaldo. Usa un PDF, JPG o PNG de hasta 50 MB.");
    setSavingSupport(false);
  }

  async function openAttachment(entry: Entry) {
    setOpeningFile(`${entry.kind}:${entry.id}`);
    const fileKind = entry.kind === "support" ? "support" : entry.kind;
    const response = await fetch(`/api/data-entry?organizationId=${encodeURIComponent(organizationId)}&fileId=${encodeURIComponent(entry.id)}&fileKind=${fileKind}`);
    const payload = await response.json().catch(() => null) as { signedUrl?: string } | null;
    if (response.ok && payload?.signedUrl) window.open(payload.signedUrl, "_blank", "noopener,noreferrer");
    else setMessage("No fue posible abrir el archivo.");
    setOpeningFile(null);
  }

  async function signOut() {
    await createClient().auth.signOut();
    window.location.assign("/login");
  }

  const viewName = view === "history" ? "Historial" : view === "support" ? "Adjuntar respaldo" : view === "benefits" ? "Postulaciones" : "Registrar documento";

  return <div className={`app-shell ${sidebarCollapsed ? "sidebar-is-collapsed" : ""}`}>
    <aside className={`sidebar ${sidebarCollapsed ? "is-collapsed" : ""}`}>
      <div className="brand">
        <div className="brand-identity"><img className="brand-logo" src="/atlas-financiero-logo.png" alt="" /><span className="brand-name">Atlas <b>Financiero</b></span></div>
        <button className="sidebar-collapse-button" type="button" onClick={() => setSidebarCollapsed((current) => !current)} aria-label={sidebarCollapsed ? "Expandir navegación" : "Contraer navegación"} title={sidebarCollapsed ? "Expandir navegación" : "Contraer navegación"}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m14 7-5 5 5 5" /><path d="M20 5v14" /></svg></button>
      </div>
      <div className="workspace-label">ESPACIO DE TRABAJO</div>
      <div className="workspace-switcher data-entry-organization" title={organizationName}>{organizationName}</div>
      <nav aria-label="Navegación principal"><section className="navigation-group" aria-label="Mi trabajo" style={{ "--navigation-group-accent": "#80d9b8", "--navigation-group-accent-soft": "#203a40" } as React.CSSProperties}>
        <div className="navigation-group-toggle is-active-group"><span className="navigation-group-heading"><span className="navigation-group-icon"><HistoryIcon /></span><span className="navigation-group-label">MI TRABAJO</span></span></div>
        <div className="navigation-group-items is-open">
          <button type="button" className={`nav-item ${view === "history" ? "active" : ""}`} onClick={() => selectView("history")}><span className="nav-icon"><HistoryIcon /></span><span className="nav-item-label">Historial</span><span className="nav-count">{data.entries.length}</span></button>
          <button type="button" className={`nav-item ${view === "support" ? "active" : ""}`} onClick={() => startSupport()}><span className="nav-icon"><AttachmentIcon /></span><span className="nav-item-label">Adjuntar respaldo</span></button>
          <button type="button" className={`nav-item ${view === "register" ? "active" : ""}`} onClick={() => selectView("register")}><span className="nav-icon"><RegisterIcon /></span><span className="nav-item-label">Registrar documento</span></button>
          <button type="button" className={`nav-item ${view === "benefits" ? "active" : ""}`} onClick={() => selectView("benefits")}><span className="nav-icon"><BenefitsIcon /></span><span className="nav-item-label">Postulaciones</span></button>
        </div>
      </section></nav>
      <div className="sidebar-bottom"><p>Digitación</p></div>
    </aside>

    <section className="content-area">
      <header className="topbar"><div className="breadcrumb">Digitación <span>/</span> {viewName}</div><div className="topbar-actions"><span className="access-role">Digitador</span><button className="avatar" type="button" onClick={() => void signOut()} aria-label="Cerrar sesión" title="Cerrar sesión">DG</button></div></header>
      <main className="dashboard data-entry-content">
        <header className="headline data-entry-header"><div><span className="eyebrow">OPERACIÓN · DOCUMENTOS</span><h1>{viewName}</h1><p>{view === "history" ? "Consulta facturas, cobros, costos y respaldos por categoría. Esta vista no contiene indicadores ni resultados consolidados." : view === "support" ? "Carga un comprobante o documento y vincúlalo a una factura o a un cobro ya registrado." : view === "benefits" ? "Actualiza la tipificación, responsable, documentos y gestiones de cada postulación." : "Registra facturas de venta y documentos de costo para revisión de Finanzas."}</p></div>{view === "history" ? <button type="button" className="primary-button" onClick={() => startSupport()}>Adjuntar respaldo</button> : <button type="button" className="secondary-button" onClick={() => selectView("history")}>Volver al historial</button>}</header>
        {message && <p className="operation-message" role="status">{message}</p>}
        {loading ? <section className="panel data-entry-loading">Cargando historial…</section> : view === "benefits" ? <BenefitsWorkflow organizationId={organizationId} compact /> : view === "history" ? <section className="panel data-entry-history">
          <div className="data-entry-history-heading"><div><span className="panel-label">REGISTRO OPERATIVO</span><h2>Movimientos y documentos</h2><p>Busca por persona, empresa, folio, tipo o estado y combina el resultado con las categorías.</p></div><button type="button" className="secondary-button" onClick={() => void load()}>Actualizar</button></div>
          <div className="data-entry-history-tools">
            <div className="data-entry-history-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
              <input type="search" value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="Buscar cliente, proveedor, folio o estado…" aria-label="Buscar en el historial" />
              {historySearch && <button type="button" onClick={() => setHistorySearch("")} aria-label="Limpiar búsqueda">Limpiar</button>}
            </div>
            <span className="data-entry-history-result-count" aria-live="polite">{historySearch.trim() ? `${filteredEntries.length} de ${categoryEntries.length} registros` : `${categoryEntries.length} registros`}</span>
          </div>
          <div className="data-entry-filters" aria-label="Filtrar historial">{filterLabels.map((filter) => <button key={filter.value} type="button" className={historyFilter === filter.value ? "is-active" : ""} onClick={() => setHistoryFilter(filter.value)}>{filter.label}<span>{filter.value === "all" ? data.entries.length : data.entries.filter((entry) => entry.kind === filter.value).length}</span></button>)}</div>
          <div className="table-scroll data-entry-table"><table><thead><tr><th>Categoría</th><th>Referencia</th><th>Cliente / proveedor</th><th>Fecha</th><th>Monto</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>{filteredEntries.map((entry) => <tr key={`${entry.kind}-${entry.id}`}><td><span className={`data-entry-kind is-${entry.kind}`}>{kindLabels[entry.kind]}</span></td><td><strong>{entry.number || "Sin folio"}</strong><small>{entry.documentType || "Documento"}</small></td><td>{entry.counterpart || "Sin contraparte"}</td><td>{displayDate(entry.issuedOn)}</td><td>{entry.amount === null ? "—" : money.format(Number(entry.amount))}</td><td><span className={`status ${entry.kind === "support" || entry.kind === "collection" || entry.status === "Pagada" ? "paid" : "pending"}`}>{reviewStatus(entry)}</span>{entry.kind === "collection" && entry.existingProof && <small>Con comprobante original</small>}</td><td><div className="data-entry-row-actions">{entry.hasAttachment && <button type="button" className="text-button" onClick={() => void openAttachment(entry)} disabled={openingFile === `${entry.kind}:${entry.id}`}>{openingFile === `${entry.kind}:${entry.id}` ? "Abriendo…" : "Ver archivo"}</button>}{(entry.kind === "sale" || entry.kind === "collection") && <button type="button" className="text-button" onClick={() => startSupport(entry)}>Adjuntar respaldo</button>}{!entry.hasAttachment && entry.kind === "cost" && <span className="data-entry-empty">Sin adjunto</span>}</div></td></tr>)}{!filteredEntries.length && <tr><td colSpan={7}><div className="data-entry-empty-state"><strong>{historySearch.trim() ? "No encontramos coincidencias." : "No hay registros en esta categoría."}</strong><span>{historySearch.trim() ? "Prueba con otro nombre, folio o categoría." : "Puedes cambiar el filtro o registrar un nuevo documento."}</span></div></td></tr>}</tbody></table></div>
        </section> : view === "support" ? <section className="panel data-entry-support-panel">
          <div className="panel-heading"><div><span className="panel-label">VINCULAR DOCUMENTO</span><h2>Nuevo respaldo</h2><p>El archivo se agrega como respaldo; no modifica el monto ni el estado del registro.</p></div></div>
          <form className="admin-form data-entry-support-form" onSubmit={(event) => void submitSupport(event)}>
            <label>Factura o cobro *<select value={supportTarget} onChange={(event) => setSupportTarget(event.target.value)} required><option value="" disabled>Selecciona un registro</option><optgroup label="Facturas registradas">{referenceGroups.invoices.map((item) => <option key={`sale-${item.id}`} value={`sale:${item.id}`}>{item.number || "Sin folio"} · {item.counterpart || "Sin cliente"} · {money.format(Number(item.amount ?? 0))}</option>)}</optgroup><optgroup label="Cobros registrados">{referenceGroups.collections.map((item) => <option key={`collection-${item.id}`} value={`collection:${item.id}`}>Cobro {displayDate(item.occurredOn)} · Factura {item.number || "sin folio"} · {money.format(Number(item.amount ?? 0))}</option>)}</optgroup></select></label>
            {selectedReference && <div className="data-entry-target-preview"><span><small>Categoría</small><strong>{selectedReference.kind === "collection" ? "Cobro registrado" : "Factura de venta"}</strong></span><span><small>Referencia</small><strong>{selectedReference.number || "Sin folio"}</strong></span><span><small>Cliente</small><strong>{selectedReference.counterpart || "Sin cliente"}</strong></span><span><small>Monto</small><strong>{money.format(Number(selectedReference.amount ?? 0))}</strong></span></div>}
            <label>Archivo *<input name="file" type="file" accept="application/pdf,image/jpeg,image/png" required /></label>
            <label>Observación<textarea name="notes" maxLength={2000} placeholder="Ej.: comprobante enviado por el cliente, cartola o respaldo del depósito" /></label>
            <button className="primary-button" disabled={savingSupport || !selectedReference}>{savingSupport ? "Cargando…" : "Cargar y vincular"}</button>
          </form>
        </section> : <div className="data-entry-register-grid">
          <section className="panel data-entry-form-panel"><div className="panel-heading"><div><span className="panel-label">VENTAS</span><h2>Ingresar factura de venta</h2><p>Se envía a revisión de Finanzas y queda visible en el historial.</p></div></div><form className="admin-form" onSubmit={(event) => void submitSale(event)}><div className="form-grid"><label>Cliente *<select name="clientId" required defaultValue=""><option value="" disabled>Selecciona cliente</option>{data.customers.map((item) => <option key={item.id} value={item.id}>{label(item)}{item.tax_id ? ` · ${item.tax_id}` : ""}</option>)}</select></label><label>Folio / número *<input name="invoiceNumber" required maxLength={80} /></label><label>Tipo *<select name="documentType" defaultValue="Factura afecta"><option>Factura afecta</option><option>Factura exenta</option><option>Nota de crédito</option><option>Nota de débito</option></select></label><label>Fecha emisión *<input name="issueDate" type="date" required defaultValue={today()} /></label><label>Vencimiento *<input name="dueDate" type="date" required defaultValue={today()} /></label><label>Monto neto *<input name="netAmount" type="number" min="0" step="1" required /></label><label className="data-entry-wide-field">Adjunto (PDF o imagen)<input name="file" type="file" accept="application/pdf,image/jpeg,image/png" /></label></div><button className="primary-button" disabled={savingSale || !data.customers.length}>{savingSale ? "Guardando…" : "Registrar factura"}</button></form></section>
          <section className="panel data-entry-form-panel"><div className="panel-heading"><div><span className="panel-label">COSTOS</span><h2>Ingresar factura de proveedor</h2><p>No crea pagos ni aprobaciones; deja el documento listo para revisión.</p></div></div><form className="admin-form" onSubmit={(event) => void submitCost(event)}><div className="form-grid"><label>Proveedor *<select name="supplierId" required defaultValue=""><option value="" disabled>Selecciona proveedor</option>{data.suppliers.map((item) => <option key={item.id} value={item.id}>{label(item)}{item.tax_id ? ` · ${item.tax_id}` : ""}</option>)}</select></label><label>Centro de costo *<select name="costCenterId" required defaultValue=""><option value="" disabled>Selecciona centro</option>{data.costCenters.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select></label><label>Folio / número *<input name="documentNumber" required maxLength={80} /></label><label>Tipo *<select name="documentType" defaultValue="Factura afecta"><option>Factura afecta</option><option>Factura exenta</option><option>Nota de crédito</option><option>Nota de débito</option><option>Boleta</option><option>Otro</option></select></label><label>Fecha emisión *<input name="issueDate" type="date" required defaultValue={today()} /></label><label>Vencimiento<input name="dueDate" type="date" /></label><label>Monto neto *<input name="netAmount" type="number" min="0" step="0.01" required /></label><label>IVA *<input name="vatAmount" type="number" min="0" step="0.01" required /></label><label>Otros impuestos *<input name="additionalTaxAmount" type="number" min="0" step="0.01" defaultValue="0" required /></label><label>Adjunto (PDF o imagen)<input name="file" type="file" accept="application/pdf,image/jpeg,image/png" /></label></div><label>Observación<textarea name="notes" maxLength={2000} /></label><button className="primary-button" disabled={savingCost || !data.suppliers.length || !data.costCenters.length}>{savingCost ? "Guardando…" : "Registrar costo"}</button></form></section>
        </div>}
      </main>
    </section>
  </div>;
}
