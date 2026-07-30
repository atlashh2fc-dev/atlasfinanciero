"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type BenefitsProfile = {
  organizationName: string;
  taxId: string | null;
  organizationCreatedAt: string | null;
  documentedSalesLast12Months: number;
  documentsLast12Months: number;
  activePeople: number;
  activeContracts: number;
  monthlyGrossPayroll: number;
  siiConnected: boolean;
  siiConfiguredAt: string | null;
  payrollConnected: boolean;
  payrollSyncedAt: string | null;
};

type BenefitsPayload = { profile: BenefitsProfile; checkedAt: string };
type BenefitCategory = "Todos" | "Empleo" | "Empresa" | "Innovación" | "Emprendimiento";
type BenefitStatus = "available" | "review" | "not-for-company";

type Benefit = {
  id: string;
  institution: string;
  name: string;
  category: Exclude<BenefitCategory, "Todos">;
  status: BenefitStatus;
  description: string;
  amount?: string;
  url: string;
  action: string;
  checks: (profile: BenefitsProfile) => Array<{ label: string; state: "ready" | "review" | "missing" }>;
};

const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short" });

const benefits: Benefit[] = [
  {
    id: "sence-activacion",
    institution: "SENCE",
    name: "Subsidio a la contratación · Activación Laboral",
    category: "Empleo",
    status: "available",
    description: "Bonificación para empresas que contraten personas desempleadas bajo las condiciones del llamado. La empresa postula con Clave Tributaria por cada relación laboral.",
    amount: "Hasta 50% del IMM por trabajador y 60% por trabajadora, por un máximo de cuatro meses.",
    url: "https://www.subsidioalempleo.cl/",
    action: "Ir a postulación SENCE",
    checks: (profile) => [
      { label: profile.taxId ? "RUT de empresa registrado" : "Falta RUT de la empresa", state: profile.taxId ? "ready" : "missing" },
      { label: profile.activeContracts ? `${profile.activeContracts} contrato(s) vigente(s) detectado(s)` : "No hay contratos sincronizados", state: profile.activeContracts ? "ready" : "review" },
      { label: "Validar primera categoría, inicio del contrato, registro DT, remuneración y cotizaciones previas de cada persona", state: "review" },
    ],
  },
  {
    id: "sence-franquicia",
    institution: "SENCE",
    name: "Franquicia Tributaria de Capacitación",
    category: "Empleo",
    status: "review",
    description: "Permite financiar capacitación mediante la franquicia tributaria, cuando la empresa cumple las condiciones vigentes de SENCE.",
    url: "https://sence.gob.cl/empresas/franquicia-tributaria",
    action: "Revisar en SENCE",
    checks: (profile) => [
      { label: profile.activePeople ? `${profile.activePeople} persona(s) activa(s) en PeopleWork` : "Sin dotación sincronizada", state: profile.activePeople ? "ready" : "missing" },
      { label: "Confirmar renta imponible anual y requisitos tributarios en SENCE", state: "review" },
    ],
  },
  {
    id: "sercotec-crece",
    institution: "Sercotec",
    name: "Crece",
    category: "Empresa",
    status: "review",
    description: "Fondo concursable para fortalecer micro y pequeñas empresas formales mediante gestión e inversiones. Los llamados y focos cambian por región.",
    amount: "Referencia 2026: subsidios de hasta $5.000.000, según convocatoria.",
    url: "https://www.sercotec.cl/calendario/",
    action: "Ver convocatorias Sercotec",
    checks: (profile) => [
      { label: profile.siiConnected ? "Integración SII habilitada" : "Sin integración SII habilitada", state: profile.siiConnected ? "ready" : "review" },
      { label: profile.documentsLast12Months ? `${profile.documentsLast12Months} documento(s) de venta registrados en 12 meses` : "Sin ventas documentadas en el período", state: profile.documentsLast12Months ? "ready" : "missing" },
      { label: "Validar inicio de actividades en primera categoría, ventas demostrables en UF, región, rubro y deudas", state: "review" },
    ],
  },
  {
    id: "sercotec-sostenible",
    institution: "Sercotec",
    name: "Crece Sostenible",
    category: "Empresa",
    status: "review",
    description: "Apoyo para inversiones y prácticas que reduzcan impactos ambientales y fortalezcan la gestión de empresas de menor tamaño.",
    amount: "Referencia 2026: hasta $9.000.000, sujeto a bases de cada llamado.",
    url: "https://www.sercotec.cl/calendario/",
    action: "Ver calendario Sercotec",
    checks: (profile) => [
      { label: profile.documentsLast12Months ? "Existe actividad comercial documentada" : "No hay actividad comercial documentada", state: profile.documentsLast12Months ? "ready" : "missing" },
      { label: "Definir proyecto de eficiencia, economía circular o energía y validar bases regionales", state: "review" },
    ],
  },
  {
    id: "corfo",
    institution: "CORFO",
    name: "Convocatorias de innovación y escalamiento",
    category: "Innovación",
    status: "review",
    description: "Programas de innovación, desarrollo tecnológico, inversión y escalamiento. La elegibilidad depende del instrumento y de las bases de cada convocatoria.",
    url: "https://www.corfo.cl/sites/cpp/convocatorias",
    action: "Ver convocatorias CORFO",
    checks: (profile) => [
      { label: profile.taxId ? "Empresa identificada con RUT" : "Falta RUT de empresa", state: profile.taxId ? "ready" : "missing" },
      { label: profile.documentsLast12Months ? "Hay evidencia de operación comercial" : "Sin evidencia comercial cargada", state: profile.documentsLast12Months ? "ready" : "review" },
      { label: "Seleccionar instrumento y validar antigüedad, cofinanciamiento, proyecto y antecedentes tributarios", state: "review" },
    ],
  },
  {
    id: "fosis-innova",
    institution: "FOSIS",
    name: "Innova FOSIS",
    category: "Innovación",
    status: "review",
    description: "Convocatoria para personas jurídicas privadas, universidades e instituciones de investigación que propongan soluciones de innovación social.",
    url: "https://www.fosis.gob.cl/es/programas/innova-fosis/convocatoria-innova-fosis/",
    action: "Revisar convocatoria FOSIS",
    checks: (profile) => [
      { label: profile.organizationCreatedAt ? "Organización registrada en Atlas" : "Sin fecha de registro organizacional", state: profile.organizationCreatedAt ? "ready" : "review" },
      { label: "Confirmar al menos dos años de antigüedad legal y encaje con el desafío vigente", state: "review" },
    ],
  },
  {
    id: "fosis-emprendamos",
    institution: "FOSIS",
    name: "Emprendamos",
    category: "Emprendimiento",
    status: "not-for-company",
    description: "Programa dirigido a personas con negocio en funcionamiento, iniciación de actividades y requisitos de vulnerabilidad. No es una postulación corporativa de Geimser.",
    url: "https://www.fosis.gob.cl/es/postulaciones/",
    action: "Ver requisitos FOSIS",
    checks: () => [
      { label: "Postulación personal con Clave Única", state: "review" },
      { label: "Requiere Registro Social de Hogares y condiciones territoriales", state: "review" },
    ],
  },
  {
    id: "sercotec-semilla",
    institution: "Sercotec",
    name: "Capital Semilla / Capital Abeja",
    category: "Emprendimiento",
    status: "not-for-company",
    description: "Fondos para iniciar un nuevo negocio, normalmente para personas que aún no tienen inicio de actividades en primera categoría. No corresponde a una empresa ya operativa.",
    amount: "Referencia 2026: subsidio de $3.500.000 para emprendimientos seleccionados.",
    url: "https://www.sercotec.cl/calendario/",
    action: "Ver calendario Sercotec",
    checks: () => [
      { label: "Postulación individual; no mediante una sociedad ya operativa", state: "review" },
      { label: "Revisar requisitos de formalización, región y perfil de la persona postulante", state: "review" },
    ],
  },
];

function statusLabel(status: BenefitStatus) {
  if (status === "available") return "Postulación disponible";
  if (status === "not-for-company") return "No postula la empresa";
  return "Revisión de bases";
}

function formatDate(value: string | null) {
  return value ? dateTime.format(new Date(value)) : "Sin sincronización";
}

export function BenefitsHub({ organizationId }: { organizationId: string | null }) {
  const [payload, setPayload] = useState<BenefitsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<BenefitCategory>("Todos");

  const load = useCallback(async () => {
    if (!organizationId) {
      setLoading(false);
      setError("Selecciona una organización para preparar el análisis.");
      return;
    }
    setLoading(true);
    setError(null);
    const response = await fetch(`/api/benefits?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    if (response.ok) setPayload(await response.json() as BenefitsPayload);
    else setError("No fue posible preparar el perfil de beneficios con tu sesión actual.");
    setLoading(false);
  }, [organizationId]);

  useEffect(() => { void load(); }, [load]);

  const shownBenefits = useMemo(() => benefits.filter((benefit) => category === "Todos" || benefit.category === category), [category]);
  const readyPrograms = payload ? benefits.filter((benefit) => benefit.status !== "not-for-company" && benefit.checks(payload.profile).some((check) => check.state === "ready")).length : 0;

  if (loading) return <main className="dashboard"><p className="operation-message">Preparando perfil de beneficios…</p></main>;
  if (!payload) return <main className="dashboard"><p className="operation-message">{error ?? "No hay información disponible."}</p></main>;

  const { profile } = payload;
  return <main className="dashboard benefits-hub">
    <section className="headline">
      <div><span className="eyebrow">FONDOS PÚBLICOS · CHILE</span><h1>Fondos y beneficios</h1><p>Prechequeo para {profile.organizationName} con información tributaria y de dotación disponible en Atlas. Las bases del organismo son la decisión final.</p></div>
      <div className="headline-actions"><span className="refresh">Revisado {formatDate(payload.checkedAt)}</span><button className="secondary-button" type="button" onClick={() => void load()}>Actualizar análisis</button></div>
    </section>

    <section className="kpis kpis-four" aria-label="Perfil disponible para beneficios">
      <article className="kpi-card accent"><span>Ventas documentadas</span><strong>{money.format(profile.documentedSalesLast12Months)}</strong><small>Últimos 12 meses en documentos emitidos; no reemplaza carpeta tributaria</small></article>
      <article className="kpi-card"><span>Dotación activa</span><strong>{profile.activePeople}</strong><small>{profile.payrollConnected ? "Sincronizada desde PeopleWork" : "PeopleWork aún no está habilitado"}</small></article>
      <article className="kpi-card"><span>Contratos vigentes</span><strong>{profile.activeContracts}</strong><small>Base para revisar beneficios de contratación</small></article>
      <article className="kpi-card"><span>Oportunidades con datos</span><strong>{readyPrograms}</strong><small>Programas que ya tienen alguna condición respaldada en Atlas</small></article>
    </section>

    <section className="benefits-profile-panel">
      <div><span className="panel-label">EVIDENCIA DISPONIBLE</span><h2>Qué se puede respaldar desde Atlas</h2></div>
      <div className="benefits-evidence">
        <span className={profile.taxId ? "is-ready" : "is-missing"}>{profile.taxId ? "RUT de empresa registrado" : "Falta RUT de empresa"}</span>
        <span className={profile.siiConnected ? "is-ready" : "is-review"}>{profile.siiConnected ? "SII conectado" : "SII sin conexión activa"}</span>
        <span className={profile.payrollConnected ? "is-ready" : "is-review"}>{profile.payrollConnected ? `PeopleWork sincronizado ${formatDate(profile.payrollSyncedAt)}` : "Dotación sin sincronización activa"}</span>
      </div>
      <p>Atlas no puede certificar deudas, inicio de actividades, cotizaciones previas, Registro Social de Hogares, Clave Tributaria ni información de la Dirección del Trabajo. Cada organismo valida esos antecedentes en su portal.</p>
    </section>

    <section className="benefits-catalog">
      <div className="table-heading"><div><span className="panel-label">CATÁLOGO OFICIAL</span><h2>Oportunidades para revisar</h2><p>Se muestran líneas de empleo, empresa, innovación y emprendimiento. El acceso abre el sitio oficial para completar una postulación autenticada.</p></div></div>
      <div className="benefits-filters" role="tablist" aria-label="Filtrar beneficios">{(["Todos", "Empleo", "Empresa", "Innovación", "Emprendimiento"] as BenefitCategory[]).map((item) => <button key={item} type="button" role="tab" aria-selected={category === item} className={category === item ? "is-active" : ""} onClick={() => setCategory(item)}>{item}</button>)}</div>
      <div className="benefits-list">{shownBenefits.map((benefit) => {
        const checks = benefit.checks(profile);
        return <article className="benefit-card" key={benefit.id}>
          <div className="benefit-card-header"><div><span className="panel-label">{benefit.institution} · {benefit.category.toUpperCase()}</span><h3>{benefit.name}</h3></div><span className={`benefit-status ${benefit.status}`}>{statusLabel(benefit.status)}</span></div>
          <p>{benefit.description}</p>
          {benefit.amount && <p className="benefit-amount">{benefit.amount}</p>}
          <ul className="benefit-checks">{checks.map((check) => <li className={check.state} key={check.label}><span aria-hidden="true">{check.state === "ready" ? "✓" : check.state === "missing" ? "!" : "•"}</span>{check.label}</li>)}</ul>
          <a className="secondary-button benefit-action" href={benefit.url} target="_blank" rel="noreferrer">{benefit.action}<span aria-hidden="true">↗</span></a>
        </article>;
      })}</div>
    </section>
  </main>;
}
