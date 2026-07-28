"use client";

import { FormEvent, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Counterparty = { id: string; legal_name: string; trade_name: string | null; tax_id: string | null };
type CostCenter = { id: string; code: string; name: string };
type Catalogs = { customers: Counterparty[]; suppliers: Counterparty[]; costCenters: CostCenter[] };

const today = () => new Date().toISOString().slice(0, 10);
const label = (item: Counterparty) => item.trade_name?.trim() || item.legal_name;

export function DataEntryWorkspace({ organizationId, organizationName, organizationTaxId }: { organizationId: string; organizationName: string; organizationTaxId: string | null }) {
  const [catalogs, setCatalogs] = useState<Catalogs>({ customers: [], suppliers: [], costCenters: [] });
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [savingSale, setSavingSale] = useState(false);
  const [savingCost, setSavingCost] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(`/api/data-entry?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<Catalogs> : Promise.reject())
      .then((payload) => { if (active) setCatalogs(payload); })
      .catch(() => { if (active) setMessage("No fue posible cargar clientes, proveedores y centros de costo."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [organizationId]);

  async function submitSale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingSale(true); setMessage(null);
    const form = new FormData(event.currentTarget);
    form.set("issuerName", organizationName);
    form.set("issuerTaxId", organizationTaxId ?? "");
    form.set("status", "Pendiente");
    form.set("paymentCondition", "post_service");
    const response = await fetch("/api/issued-documents", { method: "POST", body: form });
    if (response.ok) { event.currentTarget.reset(); setMessage("Factura de venta registrada como pendiente de revisión."); }
    else setMessage("No se pudo registrar la factura. Revisa los campos obligatorios.");
    setSavingSale(false);
  }

  async function submitCost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingCost(true); setMessage(null);
    const form = new FormData(event.currentTarget);
    form.set("organizationId", organizationId);
    form.set("action", "cost");
    const response = await fetch("/api/data-entry", { method: "POST", body: form });
    if (response.ok) { event.currentTarget.reset(); setMessage("Costo registrado como pendiente de revisión."); }
    else setMessage("No se pudo registrar el costo. Revisa los campos obligatorios.");
    setSavingCost(false);
  }

  async function signOut() {
    await createClient().auth.signOut();
    window.location.assign("/login");
  }

  return <main className="data-entry-workspace">
    <header className="data-entry-header">
      <div><span className="eyebrow">CAPTURA DE DOCUMENTOS</span><h1>Digitación</h1><p>Registra documentos para revisión. Esta vista no muestra resultados, saldos ni balances.</p></div>
      <button type="button" className="secondary-button" onClick={() => void signOut()}>Cerrar sesión</button>
    </header>
    {message && <p className="operation-message" role="status">{message}</p>}
    {loading ? <p>Cargando catálogos…</p> : <div className="data-entry-grid">
      <section className="panel"><div className="panel-heading"><div><span className="panel-label">VENTAS</span><h2>Ingresar factura de venta</h2><p>Queda pendiente para validación de Finanzas.</p></div></div>
        <form className="admin-form" onSubmit={(event) => void submitSale(event)}>
          <div className="form-grid">
            <label>Cliente *<select name="clientId" required defaultValue=""><option value="" disabled>Selecciona cliente</option>{catalogs.customers.map((item) => <option key={item.id} value={item.id}>{label(item)}{item.tax_id ? ` · ${item.tax_id}` : ""}</option>)}</select></label>
            <label>Folio / número *<input name="invoiceNumber" required maxLength={80} /></label>
            <label>Tipo *<select name="documentType" defaultValue="Factura afecta"><option>Factura afecta</option><option>Factura exenta</option><option>Nota de crédito</option><option>Nota de débito</option></select></label>
            <label>Fecha emisión *<input name="issueDate" type="date" required defaultValue={today()} /></label>
            <label>Vencimiento *<input name="dueDate" type="date" required defaultValue={today()} /></label>
            <label>Monto neto *<input name="netAmount" type="number" min="0" step="0.01" required /></label>
            <label>Adjunto (PDF o imagen)<input name="file" type="file" accept="application/pdf,image/jpeg,image/png" /></label>
          </div>
          <button className="primary-button" disabled={savingSale || !catalogs.customers.length}>{savingSale ? "Guardando…" : "Registrar venta"}</button>
        </form>
      </section>
      <section className="panel"><div className="panel-heading"><div><span className="panel-label">COSTOS</span><h2>Ingresar factura de proveedor</h2><p>No crea pagos ni aprobaciones.</p></div></div>
        <form className="admin-form" onSubmit={(event) => void submitCost(event)}>
          <div className="form-grid">
            <label>Proveedor *<select name="supplierId" required defaultValue=""><option value="" disabled>Selecciona proveedor</option>{catalogs.suppliers.map((item) => <option key={item.id} value={item.id}>{label(item)}{item.tax_id ? ` · ${item.tax_id}` : ""}</option>)}</select></label>
            <label>Centro de costo *<select name="costCenterId" required defaultValue=""><option value="" disabled>Selecciona centro</option>{catalogs.costCenters.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select></label>
            <label>Folio / número *<input name="documentNumber" required maxLength={80} /></label>
            <label>Tipo *<select name="documentType" defaultValue="Factura afecta"><option>Factura afecta</option><option>Factura exenta</option><option>Nota de crédito</option><option>Nota de débito</option><option>Boleta</option><option>Otro</option></select></label>
            <label>Fecha emisión *<input name="issueDate" type="date" required defaultValue={today()} /></label>
            <label>Vencimiento<input name="dueDate" type="date" /></label>
            <label>Monto neto *<input name="netAmount" type="number" min="0" step="0.01" required /></label>
            <label>IVA *<input name="vatAmount" type="number" min="0" step="0.01" required /></label>
            <label>Otros impuestos *<input name="additionalTaxAmount" type="number" min="0" step="0.01" defaultValue="0" required /></label>
            <label>Adjunto (PDF o imagen)<input name="file" type="file" accept="application/pdf,image/jpeg,image/png" /></label>
          </div>
          <label>Observación<textarea name="notes" maxLength={2000} /></label>
          <button className="primary-button" disabled={savingCost || !catalogs.suppliers.length || !catalogs.costCenters.length}>{savingCost ? "Guardando…" : "Registrar costo"}</button>
        </form>
      </section>
    </div>}
  </main>;
}
