"use client";

import { FormEvent, useEffect, useState } from "react";

type CatalogItem = { id?: string; name: string; category: string | null; description: string | null; unit_name: string; unit_price: number; currency: "CLP" | "UF" | "USD"; is_active: boolean };
const blank = (): CatalogItem => ({ name: "", category: "", description: "", unit_name: "unidad", unit_price: 0, currency: "CLP", is_active: true });
const money = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 });

export function ServiceCatalogManagement({ organizationId }: { organizationId: string }) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [draft, setDraft] = useState<CatalogItem | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    if (!organizationId) return;
    setLoading(true);
    const response = await fetch(`/api/customer-control?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as { catalog?: CatalogItem[] } | null;
    if (response.ok) setItems(payload?.catalog ?? []); else setMessage("No fue posible cargar el catálogo.");
    setLoading(false);
  };
  useEffect(() => { void load(); }, [organizationId]);

  const set = (field: keyof CatalogItem, value: string | boolean) => setDraft((current) => current ? { ...current, [field]: field === "unit_price" ? Number(value) || 0 : value } : current);
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!draft) return;
    setSaving(true); setMessage("");
    const response = await fetch("/api/customer-control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_catalog", organizationId, item: { id: draft.id, name: draft.name, category: draft.category, description: draft.description, unitName: draft.unit_name, unitPrice: draft.unit_price, currency: draft.currency, isActive: draft.is_active } }) });
    setSaving(false);
    if (!response.ok) return setMessage("No fue posible guardar. El nombre debe ser único en el catálogo.");
    setDraft(null); setMessage("Producto o servicio guardado."); await load();
  };
  const remove = async (item: CatalogItem) => {
    if (!item.id || !window.confirm(`¿Eliminar “${item.name}”? Si ya está contratado, desactívalo en vez de eliminarlo.`)) return;
    const response = await fetch("/api/customer-control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete_catalog", organizationId, itemId: item.id }) });
    if (!response.ok) return setMessage("No se puede eliminar porque el servicio ya está contratado. Puedes desactivarlo.");
    setMessage("Producto o servicio eliminado."); await load();
  };

  return <section className="panel service-catalog-panel">
    <div className="panel-heading"><div><span className="panel-label">CATÁLOGO COMERCIAL</span><h2>Productos, precios y servicios</h2><p>Este mantenedor define las opciones que se podrán contratar por cliente y usar luego en prefacturas.</p></div><div className="table-actions"><button type="button" className="secondary-button" onClick={() => void load()}>Actualizar</button><button type="button" className="primary-button" onClick={() => setDraft(blank())}>Agregar opción</button></div></div>
    {message && <p className="operation-message">{message}</p>}
    {loading ? <p className="billing-empty">Cargando catálogo…</p> : <div className="table-scroll"><table className="admin-members-table"><thead><tr><th>Producto o servicio</th><th>Categoría</th><th>Precio base</th><th>Estado</th><th /></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><small>{item.description || item.unit_name}</small></td><td>{item.category || "—"}</td><td>{item.currency} {money.format(Number(item.unit_price))}<small>por {item.unit_name}</small></td><td><span className={`status ${item.is_active ? "paid" : "neutral"}`}>{item.is_active ? "Activo" : "Inactivo"}</span></td><td><div className="member-actions"><button type="button" className="text-button" onClick={() => setDraft({ ...item })}>Editar</button><button type="button" className="text-button" onClick={() => void remove(item)}>Eliminar</button></div></td></tr>)}</tbody></table></div>}
    {draft && <div className="modal-backdrop" role="presentation"><section className="entry-modal" role="dialog" aria-modal="true" aria-labelledby="catalog-title"><div className="modal-header"><div><span className="eyebrow">CATÁLOGO COMERCIAL</span><h2 id="catalog-title">{draft.id ? "Editar opción" : "Nueva opción"}</h2></div><button type="button" className="close-button" onClick={() => setDraft(null)} aria-label="Cerrar">×</button></div><form onSubmit={save}><div className="form-grid"><label>Nombre *<input value={draft.name} maxLength={180} onChange={(event) => set("name", event.target.value)} required /></label><label>Categoría<input value={draft.category ?? ""} maxLength={100} onChange={(event) => set("category", event.target.value)} /></label><label>Unidad de cobro<input value={draft.unit_name} maxLength={80} onChange={(event) => set("unit_name", event.target.value)} required /></label><label>Precio base *<input type="number" min="0" step={draft.currency === "UF" ? "0.0001" : "1"} value={draft.unit_price} onChange={(event) => set("unit_price", event.target.value)} required /></label><label>Moneda<select value={draft.currency === "UF" ? "UF" : "CLP"} onChange={(event) => set("currency", event.target.value)}><option value="CLP">CLP</option><option value="UF">UF</option></select><small>La UF se valoriza con la fecha de prefacturación según el SII.</small></label><label>Estado<select value={draft.is_active ? "active" : "inactive"} onChange={(event) => set("is_active", event.target.value === "active")}><option value="active">Activo</option><option value="inactive">Inactivo</option></select></label><label className="form-field-wide">Descripción<textarea value={draft.description ?? ""} maxLength={1000} onChange={(event) => set("description", event.target.value)} /></label></div><div className="form-actions"><button type="button" className="secondary-button" onClick={() => setDraft(null)}>Cancelar</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Guardando…" : "Guardar"}</button></div></form></section></div>}
  </section>;
}
