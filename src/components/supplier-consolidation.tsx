"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Supplier = { id: string; name: string; legalName: string; taxId: string | null };
type Candidate = { key: string; members: Supplier[] };
type Payload = { suppliers: Supplier[]; candidates: Candidate[] };

export function SupplierConsolidation({ organizationId, canManage }: { organizationId: string | null; canManage: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [canonicalId, setCanonicalId] = useState("");
  const [duplicateId, setDuplicateId] = useState("");
  const [duplicates, setDuplicates] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    if (!organizationId) { setData(null); return; }
    const response = await fetch(`/api/supplier-consolidation?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    const payload = response.ok ? await response.json() as Payload : null;
    setData(payload);
    if (!response.ok) setMessage("No fue posible cargar el directorio de proveedores.");
  }
  useEffect(() => { void load(); }, [organizationId]);

  const suppliersById = useMemo(() => new Map(data?.suppliers.map((supplier) => [supplier.id, supplier]) ?? []), [data]);
  const availableDuplicates = (data?.suppliers ?? []).filter((supplier) => supplier.id !== canonicalId && !duplicates.includes(supplier.id));

  function addDuplicate() {
    if (!duplicateId || duplicateId === canonicalId) return;
    setDuplicates((current) => current.includes(duplicateId) ? current : [...current, duplicateId]);
    setDuplicateId("");
  }
  function useCandidate(candidate: Candidate) {
    const [canonical, ...rest] = candidate.members;
    setCanonicalId(canonical?.id ?? "");
    setDuplicates(rest.map((supplier) => supplier.id));
    setDuplicateId("");
    setMessage("Revisa la ficha canónica y confirma la unificación cuando estés listo.");
  }
  async function consolidate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || !canonicalId || !duplicates.length) return;
    setSaving(true);
    const response = await fetch("/api/supplier-consolidation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId, canonicalCounterpartyId: canonicalId, duplicateCounterpartyIds: duplicates }),
    });
    const payload = await response.json().catch(() => null) as { consolidation?: { canonical_name?: string; updated_records?: number }; error?: string } | null;
    setSaving(false);
    if (!response.ok) { setMessage("No fue posible consolidar. Verifica las fichas seleccionadas e inténtalo nuevamente."); return; }
    setMessage(`${payload?.consolidation?.canonical_name ?? "Proveedor"} quedó como ficha única. Se actualizaron ${payload?.consolidation?.updated_records ?? 0} registros sin borrar historial.`);
    setCanonicalId(""); setDuplicateId(""); setDuplicates([]); await load();
  }

  return <main className="dashboard">
    <section className="headline"><div><span className="eyebrow">MAESTRO DE PROVEEDORES · CONSOLIDACIÓN SEGURA</span><h1>Unificar proveedores duplicados</h1><p>Una sola empresa canónica en búsquedas y combobox. Los documentos, pagos y respaldos se reasignan sin eliminar información; la ficha anterior queda conservada como historial.</p></div></section>
    {message && <p className="operation-message">{message}</p>}
    <section className="panel"><div className="panel-heading"><div><span className="panel-label">CONSOLIDAR</span><h2>Elegir ficha canónica</h2><p>Selecciona el nombre que debe quedar visible y agrega las fichas duplicadas que se integrarán a ella.</p></div></div>
      <form className="admin-form" onSubmit={consolidate}>
        <label>Proveedor canónico<select required disabled={!canManage} value={canonicalId} onChange={(event) => { setCanonicalId(event.target.value); setDuplicates((current) => current.filter((id) => id !== event.target.value)); }}><option value="">Selecciona el nombre único</option>{data?.suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}{supplier.taxId ? ` · ${supplier.taxId}` : ""}</option>)}</select></label>
        <label>Ficha duplicada<select disabled={!canManage || !canonicalId} value={duplicateId} onChange={(event) => setDuplicateId(event.target.value)}><option value="">Selecciona una ficha a integrar</option>{availableDuplicates.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}{supplier.taxId ? ` · ${supplier.taxId}` : ""}</option>)}</select></label>
        <div className="form-actions"><button type="button" className="secondary-button" disabled={!duplicateId || !canManage} onClick={addDuplicate}>Agregar duplicado</button><button type="submit" className="primary-button" disabled={!canManage || !canonicalId || !duplicates.length || saving}>{saving ? "Unificando…" : "Unificar sin borrar historial"}</button></div>
      </form>
      {duplicates.length > 0 && <div className="p2p-payment-blocked"><strong>Fichas que pasarán a la empresa canónica</strong>{duplicates.map((id) => <p key={id}>{suppliersById.get(id)?.name ?? "Proveedor"} <button className="secondary-button" type="button" onClick={() => setDuplicates((current) => current.filter((item) => item !== id))}>Quitar</button></p>)}</div>}
    </section>
    <section className="table-section"><div className="table-heading"><div><span className="panel-label">SUGERENCIAS</span><h2>Coincidencias detectadas</h2><p>Se agrupan variaciones de espacios y razón social, como “Mi Bodega” y “Mi Bodega SpA”. Siempre requieren tu confirmación antes de unificarse.</p></div></div>
      <div className="table-scroll"><table><thead><tr><th>Posible empresa</th><th>Fichas detectadas</th><th>Acción</th></tr></thead><tbody>{data?.candidates.length ? data.candidates.map((candidate) => <tr key={candidate.key}><td><strong>{candidate.members[0]?.name}</strong></td><td>{candidate.members.map((supplier) => <small key={supplier.id}>{supplier.name}{supplier.taxId ? ` · ${supplier.taxId}` : ""}<br /></small>)}</td><td>{canManage && <button type="button" className="secondary-button" onClick={() => useCandidate(candidate)}>Preparar unificación</button>}</td></tr>) : <tr><td colSpan={3}>No hay fichas duplicadas activas detectadas. Las variaciones históricas ya vinculadas a una misma ficha se normalizan automáticamente.</td></tr>}</tbody></table></div>
    </section>
  </main>;
}
