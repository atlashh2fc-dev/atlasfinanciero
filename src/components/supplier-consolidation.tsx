"use client";

import { useEffect, useState } from "react";

type Supplier = { id: string; name: string; legalName: string; taxId: string | null };
type Payload = { suppliers: Supplier[] };

export function SupplierConsolidation({ organizationId }: { organizationId: string | null }) {
  const [data, setData] = useState<Payload | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    if (!organizationId) { setData(null); return; }
    const response = await fetch(`/api/supplier-consolidation?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    const payload = response.ok ? await response.json() as Payload : null;
    setData(payload);
    if (!response.ok) setMessage("No fue posible cargar el directorio de proveedores.");
  }
  useEffect(() => { void load(); }, [organizationId]);

  return <main className="dashboard">
    <section className="headline"><div><span className="eyebrow">MAESTRO DE PROVEEDORES</span><h1>Directorio de proveedores</h1><p>Una sola ficha visible por empresa en búsquedas y combobox. Las variaciones históricas ya están vinculadas a su empresa canónica, sin perder documentos, pagos ni respaldos.</p></div></section>
    {message && <p className="operation-message">{message}</p>}
    <section className="panel"><div className="panel-heading"><div><span className="panel-label">DIRECTORIO CONSOLIDADO</span><h2>{data?.suppliers.length ?? 0} empresas disponibles</h2><p>Los nuevos registros reconocen automáticamente una empresa existente por nombre normalizado o proveedor seleccionado, para mantener esta lista sin duplicados.</p></div></div></section>
    <section className="table-section"><div className="table-heading"><div><span className="panel-label">EMPRESAS ACTIVAS</span><h2>Proveedores disponibles</h2><p>Esta es la misma fuente que alimenta los combobox de gastos, cuentas por pagar, compras y factoring.</p></div></div>
      <div className="table-scroll"><table><thead><tr><th>Proveedor</th><th>Razón social</th><th>RUT</th></tr></thead><tbody>{data?.suppliers.length ? data.suppliers.map((supplier) => <tr key={supplier.id}><td><strong>{supplier.name}</strong></td><td>{supplier.legalName}</td><td>{supplier.taxId ?? "—"}</td></tr>) : <tr><td colSpan={3}>No hay proveedores activos para esta organización.</td></tr>}</tbody></table></div>
    </section>
  </main>;
}
