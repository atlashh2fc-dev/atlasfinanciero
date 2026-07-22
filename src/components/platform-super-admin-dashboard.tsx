"use client";

import { useEffect, useMemo, useState } from "react";

type OrganizationSummary = { organization_id: string; legal_name: string; tax_id: string | null; members_count: number; revenue: number; expenses: number; operating_result: number };
type PlatformOverview = { year: number; organizations: OrganizationSummary[] };

const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });

export function PlatformSuperAdminDashboard() {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [data, setData] = useState<PlatformOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/admin/platform-overview?year=${year}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<PlatformOverview> : Promise.reject())
      .then((payload) => { if (active) { setData(payload); setError(null); } })
      .catch(() => { if (active) setError("No fue posible cargar la vista global de empresas."); });
    return () => { active = false; };
  }, [year]);

  const totals = useMemo(() => (data?.organizations ?? []).reduce((current, organization) => ({ organizations: current.organizations + 1, members: current.members + Number(organization.members_count), revenue: current.revenue + Number(organization.revenue), expenses: current.expenses + Number(organization.expenses), result: current.result + Number(organization.operating_result) }), { organizations: 0, members: 0, revenue: 0, expenses: 0, result: 0 }), [data]);

  return <main className="dashboard platform-super-admin-dashboard">
    <section className="headline"><div><span className="eyebrow">PLATAFORMA SAAS · SUPER ADMIN</span><h1>Portafolio de empresas</h1><p>Vista transversal de empresas, usuarios y resultado documentado. No modifica la operación ni los permisos de cada tenant.</p></div><div className="headline-actions"><label className="period-picker">Año<select value={year} onChange={(event) => setYear(Number(event.target.value))}>{Array.from({ length: Math.min(7, new Date().getFullYear() - 2019) }, (_, index) => new Date().getFullYear() - index).map((item) => <option key={item} value={item}>{item}</option>)}</select></label></div></section>
    {error && <p className="operation-message">{error}</p>}
    <section className="kpis platform-overview-kpis"><article className="kpi-card"><span>Empresas</span><strong>{totals.organizations}</strong><small>Con acceso administrado</small></article><article className="kpi-card"><span>Usuarios asignados</span><strong>{totals.members}</strong><small>En todos los tenants</small></article><article className="kpi-card"><span>Ingresos netos</span><strong>{money.format(totals.revenue)}</strong><small>Documentados en {year}</small></article><article className="kpi-card"><span>Resultado documentado</span><strong className={totals.result < 0 ? "is-negative" : ""}>{money.format(totals.result)}</strong><small>Ingresos menos gastos y cuentas directas</small></article></section>
    <section className="table-section"><div className="table-heading"><div><span className="panel-label">EMPRESAS ACTIVAS EN LA PLATAFORMA</span><h2>Resultado por empresa</h2><p>Los importes son netos CLP y excluyen remuneraciones, presupuesto y flujo de caja.</p></div></div><div className="table-scroll"><table className="platform-overview-table"><thead><tr><th>Empresa</th><th>Usuarios</th><th className="money-col">Ingresos</th><th className="money-col">Gastos</th><th className="money-col">Resultado</th></tr></thead><tbody>{data?.organizations.length ? data.organizations.map((organization) => <tr key={organization.organization_id}><td><strong>{organization.legal_name}</strong><small>{organization.tax_id || "RUT no registrado"}</small></td><td>{organization.members_count}</td><td className="money-col">{money.format(Number(organization.revenue))}</td><td className="money-col">{money.format(Number(organization.expenses))}</td><td className={`money-col ${Number(organization.operating_result) < 0 ? "is-negative" : ""}`}>{money.format(Number(organization.operating_result))}</td></tr>) : <tr><td colSpan={5}>No hay empresas disponibles para este período.</td></tr>}</tbody></table></div></section>
  </main>;
}
