"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Center = { id: string; code: string; name: string; is_active: boolean };
type Person = { id: string; full_name: string; is_active: boolean };
type Customer = { id: string; legal_name: string; trade_name: string | null; tax_id: string | null };
type Assignment = { id: string; person_id: string; cost_center_id: string; allocation_percentage: number; effective_from: string; effective_to: string | null };
type CustomerLink = { id: string; cost_center_id: string; counterparty_id: string; allocation_percentage: number; effective_from: string; effective_to: string | null };
type Payload = { centers: Center[]; people: Person[]; customers: Customer[]; assignments: Assignment[]; customerLinks: CustomerLink[] };

const today = () => new Date().toISOString().slice(0, 10);

export function CostCenterManagement({ organizationId }: { organizationId: string | null }) {
  const [data, setData] = useState<Payload | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [centerCode, setCenterCode] = useState(""); const [centerName, setCenterName] = useState("");
  const [personId, setPersonId] = useState(""); const [workerCenterId, setWorkerCenterId] = useState(""); const [workerAllocation, setWorkerAllocation] = useState("100"); const [workerDate, setWorkerDate] = useState(today());
  const [customerId, setCustomerId] = useState(""); const [customerCenterId, setCustomerCenterId] = useState(""); const [customerAllocation, setCustomerAllocation] = useState("100"); const [customerDate, setCustomerDate] = useState(today());
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);

  const load = useCallback(async () => {
    if (!organizationId) return;
    const response = await fetch(`/api/cost-centers?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    if (!response.ok) return setMessage("No fue posible cargar los centros de costo.");
    setData(await response.json() as Payload); setMessage(null);
  }, [organizationId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (data?.centers.length) { setWorkerCenterId((value) => value || data.centers[0].id); setCustomerCenterId((value) => value || data.centers[0].id); } if (data?.people.length) setPersonId((value) => value || data.people[0].id); if (data?.customers.length) setCustomerId((value) => value || data.customers[0].id); }, [data]);
  const personNameById = useMemo(() => new Map(data?.people.map((person) => [person.id, person.full_name]) ?? []), [data]);
  const customerNameById = useMemo(() => new Map(data?.customers.map((customer) => [customer.id, customer.trade_name || customer.legal_name]) ?? []), [data]);
  const centerGroups = useMemo(() => {
    const groups = new Map<string, Center[]>();
    for (const center of data?.centers ?? []) {
      const key = center.code.split(".")[0] || "Otros";
      groups.set(key, [...(groups.get(key) ?? []), center]);
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, "es", { numeric: true })).map(([key, centers]) => {
      const sortedCenters = centers.sort((left, right) => left.code.localeCompare(right.code, "es", { numeric: true }));
      const rootCenter = sortedCenters.find((center) => center.code === `${key}.0.0.0`);
      return { key, centers: sortedCenters, name: rootCenter?.name ?? `Grupo ${key}` };
    });
  }, [data]);
  useEffect(() => { if (centerGroups.length) setExpandedGroups((current) => current.length ? current : [centerGroups[0].key]); }, [centerGroups]);

  async function submit(action: string, values: Record<string, unknown>) {
    if (!organizationId || saving) return;
    setSaving(true); setMessage(null);
    const response = await fetch("/api/cost-centers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, action, ...values }) });
    setSaving(false);
    if (!response.ok) return setMessage("No fue posible guardar. Verifica que no exista una asignación idéntica y que los porcentajes sean válidos.");
    setMessage("Configuración guardada."); await load();
  }
  function createCenter(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void submit("create_center", { code: centerCode, name: centerName }).then(() => { setCenterCode(""); setCenterName(""); }); }
  function assignWorker(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void submit("assign_worker", { personId, costCenterId: workerCenterId, allocationPercentage: workerAllocation, effectiveFrom: workerDate }); }
  function linkCustomer(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void submit("link_customer", { counterpartyId: customerId, costCenterId: customerCenterId, allocationPercentage: customerAllocation, effectiveFrom: customerDate }); }

  return <main className="dashboard cost-centers-dashboard"><section className="headline"><div><span className="eyebrow">ESTRUCTURA DE GESTIÓN</span><h1>Centros de costo</h1><p>Revisa la estructura por familia y abre la configuración sólo cuando necesites crear centros o cambiar imputaciones.</p></div></section><section className="table-section cost-center-section"><div className="table-heading"><div><span className="panel-label">MAPA DE CENTROS</span><h2>Centros, personas y clientes</h2><p>Los grupos concentran la estructura; cada centro muestra sus imputaciones y clientes compensadores vigentes.</p></div><button type="button" className="secondary-button" onClick={() => void load()} disabled={saving}>Actualizar</button></div>{message && <p className="operation-message">{message}</p>}<details className="cost-center-management-panel"><summary><span><strong>Gestionar estructura e imputaciones</strong><small>Crear centro, asignar persona o vincular cliente</small></span><span className="cost-center-management-hint">Abrir configuración</span></summary><div className="admin-grid"><article className="panel"><div className="panel-heading"><div><span className="panel-label">1 · ESTRUCTURA</span><h2>Nuevo centro</h2></div></div><form className="admin-form" onSubmit={createCenter}><label>Código<input value={centerCode} maxLength={40} placeholder="PROY-001" onChange={(event) => setCenterCode(event.target.value)} required /></label><label>Nombre<input value={centerName} maxLength={160} placeholder="Proyecto o unidad" onChange={(event) => setCenterName(event.target.value)} required /></label><button className="secondary-button" disabled={saving}>Crear centro</button></form></article><article className="panel"><div className="panel-heading"><div><span className="panel-label">2 · DOTACIÓN</span><h2>Asignar persona</h2></div></div><form className="admin-form" onSubmit={assignWorker}><label>Persona<select value={personId} onChange={(event) => setPersonId(event.target.value)}>{data?.people.map((person) => <option key={person.id} value={person.id}>{person.full_name}</option>)}</select></label><label>Centro<select value={workerCenterId} onChange={(event) => setWorkerCenterId(event.target.value)}>{data?.centers.map((center) => <option key={center.id} value={center.id}>{center.code} · {center.name}</option>)}</select></label><label>% de imputación<input type="number" min="0.01" max="100" step="0.01" value={workerAllocation} onChange={(event) => setWorkerAllocation(event.target.value)} required /></label><label>Vigente desde<input type="date" value={workerDate} onChange={(event) => setWorkerDate(event.target.value)} required /></label><button className="secondary-button" disabled={saving || !data?.centers.length || !data?.people.length}>Asignar</button></form></article><article className="panel"><div className="panel-heading"><div><span className="panel-label">3 · INGRESOS</span><h2>Vincular cliente</h2></div></div><form className="admin-form" onSubmit={linkCustomer}><label>Cliente<select value={customerId} onChange={(event) => setCustomerId(event.target.value)}>{data?.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.trade_name || customer.legal_name}</option>)}</select></label><label>Centro<select value={customerCenterId} onChange={(event) => setCustomerCenterId(event.target.value)}>{data?.centers.map((center) => <option key={center.id} value={center.id}>{center.code} · {center.name}</option>)}</select></label><label>% de ingreso<input type="number" min="0.01" max="100" step="0.01" value={customerAllocation} onChange={(event) => setCustomerAllocation(event.target.value)} required /></label><label>Vigente desde<input type="date" value={customerDate} onChange={(event) => setCustomerDate(event.target.value)} required /></label><button className="secondary-button" disabled={saving || !data?.centers.length || !data?.customers.length}>Vincular</button></form></article></div></details><div className="cost-center-groups">{centerGroups.length ? centerGroups.map((group) => { const isExpanded = expandedGroups.includes(group.key); const assignments = data?.assignments.filter((item) => group.centers.some((center) => center.id === item.cost_center_id)) ?? []; const links = data?.customerLinks.filter((item) => group.centers.some((center) => center.id === item.cost_center_id)) ?? []; return <section className="cost-center-group" key={group.key}><button type="button" className="cost-center-group-toggle" onClick={() => setExpandedGroups((current) => current.includes(group.key) ? current.filter((key) => key !== group.key) : [...current, group.key])} aria-expanded={isExpanded}><span className="cost-center-group-chevron">{isExpanded ? "▾" : "▸"}</span><span><strong>{group.key} · {group.name}</strong><small>{group.centers.length} centro(s) · {assignments.length} imputación(es) · {links.length} cliente(s) compensador(es)</small></span></button>{isExpanded && <div className="table-scroll"><table><thead><tr><th>Centro</th><th>Persona / imputación</th><th>Cliente compensador</th></tr></thead><tbody>{group.centers.map((center) => { const centerAssignments = data?.assignments.filter((item) => item.cost_center_id === center.id) ?? []; const centerLinks = data?.customerLinks.filter((item) => item.cost_center_id === center.id) ?? []; return <tr key={center.id}><td><strong>{center.code}</strong><small>{center.name}</small></td><td>{centerAssignments.length ? centerAssignments.map((item) => <small key={item.id}>{personNameById.get(item.person_id) ?? "Persona"} · {item.allocation_percentage}% desde {item.effective_from}</small>) : "—"}</td><td>{centerLinks.length ? centerLinks.map((item) => <small key={item.id}>{customerNameById.get(item.counterparty_id) ?? "Cliente"} · {item.allocation_percentage}% desde {item.effective_from}</small>) : "—"}</td></tr>; })}</tbody></table></div>}</section>; }) : <p className="billing-empty">Crea el primer centro de costo para comenzar.</p>}</div></section></main>;
}
