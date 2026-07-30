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
  configuration: CompanyConfiguration;
};

type CompanyConfiguration = {
  region: string | null;
  commune: string | null;
  business_sector: string | null;
  legal_start_date: string | null;
  first_category_confirmed: boolean;
  annual_sales_verified: boolean;
  tax_folder_reviewed_at: string | null;
  no_tax_or_labor_debt_declared: boolean;
  no_pending_public_renditions_declared: boolean;
  project_focus: string | null;
  project_budget: number | null;
};
type SenceCandidate = { personId: string; personName: string; startDate: string; monthlyGrossSalary: number };
type BenefitsApplication = { id: string; program_id: string; program_name: string; institution: string; official_url: string; status: ApplicationStatus; deadline: string | null; notes: string | null; updated_at: string };
type ApplicationStatus = "preparing" | "ready_for_submission" | "submitted" | "not_selected" | "awarded" | "withdrawn";
type BenefitsPayload = { profile: BenefitsProfile; sence: { salaryLimit: number; candidates: SenceCandidate[] }; applications: BenefitsApplication[]; workspaceReady: boolean; checkedAt: string };
type ProfileDraft = {
  region: string;
  commune: string;
  businessSector: string;
  legalStartDate: string;
  firstCategoryConfirmed: boolean;
  annualSalesVerified: boolean;
  taxFolderReviewedAt: string;
  noTaxOrLaborDebtDeclared: boolean;
  noPendingPublicRenditionsDeclared: boolean;
  projectFocus: string;
  projectBudget: string;
};
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
const appStatusLabel: Record<ApplicationStatus, string> = { preparing: "Preparando", ready_for_submission: "Lista para postular", submitted: "Postulada", not_selected: "No seleccionada", awarded: "Adjudicada", withdrawn: "Descartada" };

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
      { label: profile.configuration.first_category_confirmed ? "Primera categoría confirmada en el perfil" : "Confirmar tributación en primera categoría", state: profile.configuration.first_category_confirmed ? "ready" : "missing" },
      { label: profile.configuration.region ? `Región registrada: ${profile.configuration.region}` : "Falta región de ejecución", state: profile.configuration.region ? "ready" : "missing" },
      { label: "Validar Registro DT y cotizaciones previas de cada persona en SENCE", state: "review" },
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
      { label: profile.configuration.first_category_confirmed ? "Primera categoría confirmada" : "Falta confirmar primera categoría", state: profile.configuration.first_category_confirmed ? "ready" : "missing" },
      { label: profile.configuration.annual_sales_verified ? "Ventas validadas con carpeta tributaria" : `${profile.documentsLast12Months} documento(s) de venta en Atlas; falta validar carpeta tributaria`, state: profile.configuration.annual_sales_verified ? "ready" : "review" },
      { label: profile.configuration.no_tax_or_labor_debt_declared ? "Sin deudas declaradas" : "Falta declaración de deudas tributarias, laborales y previsionales", state: profile.configuration.no_tax_or_labor_debt_declared ? "ready" : "missing" },
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
      { label: profile.configuration.project_focus ? "Proyecto de sostenibilidad definido" : "Falta definir el proyecto a financiar", state: profile.configuration.project_focus ? "ready" : "missing" },
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
      { label: profile.configuration.project_focus ? "Proyecto registrado para evaluar" : "Falta describir el proyecto", state: profile.configuration.project_focus ? "ready" : "missing" },
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

function profileDraft(configuration: CompanyConfiguration): ProfileDraft {
  return {
    region: configuration.region ?? "",
    commune: configuration.commune ?? "",
    businessSector: configuration.business_sector ?? "",
    legalStartDate: configuration.legal_start_date ?? "",
    firstCategoryConfirmed: configuration.first_category_confirmed,
    annualSalesVerified: configuration.annual_sales_verified,
    taxFolderReviewedAt: configuration.tax_folder_reviewed_at ?? "",
    noTaxOrLaborDebtDeclared: configuration.no_tax_or_labor_debt_declared,
    noPendingPublicRenditionsDeclared: configuration.no_pending_public_renditions_declared,
    projectFocus: configuration.project_focus ?? "",
    projectBudget: configuration.project_budget?.toString() ?? "",
  };
}

export function BenefitsHub({ organizationId }: { organizationId: string | null }) {
  const [payload, setPayload] = useState<BenefitsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<BenefitCategory>("Todos");
  const [editingProfile, setEditingProfile] = useState(false);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);

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

  function openProfileEditor() {
    if (!payload) return;
    setDraft(profileDraft(payload.profile.configuration));
    setEditingProfile(true);
  }

  async function saveProfile() {
    if (!organizationId || !draft || saving) return;
    setSaving(true);
    setOperationMessage(null);
    const response = await fetch("/api/benefits", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId, ...draft }),
    });
    setSaving(false);
    if (!response.ok) { const result = await response.json().catch(() => null) as { error?: string } | null; setOperationMessage(result?.error === "benefits_workspace_not_migrated" ? "La base aún debe aplicar la migración de beneficios." : "No fue posible guardar el perfil postulante. Revisa los campos e inténtalo nuevamente."); return; }
    setEditingProfile(false);
    setOperationMessage("Perfil postulante actualizado. Se recalculó la preparación de cada oportunidad.");
    await load();
  }

  async function prepareApplication(benefit: Benefit) {
    if (!organizationId || saving) return;
    setSaving(true);
    setOperationMessage(null);
    const response = await fetch("/api/benefits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, programId: benefit.id }) });
    setSaving(false);
    if (!response.ok) { const result = await response.json().catch(() => null) as { error?: string } | null; setOperationMessage(result?.error === "benefits_workspace_not_migrated" ? "La base aún debe aplicar la migración de beneficios." : "No fue posible abrir la postulación en Atlas."); return; }
    setOperationMessage(`${benefit.name} quedó en la bandeja de postulaciones.`);
    await load();
  }

  async function setApplicationStatus(application: BenefitsApplication, status: ApplicationStatus) {
    if (!organizationId || saving) return;
    setSaving(true);
    const response = await fetch("/api/benefits", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, applicationId: application.id, status, deadline: application.deadline, notes: application.notes }) });
    setSaving(false);
    if (!response.ok) { setOperationMessage("No fue posible actualizar el estado de esta postulación."); return; }
    setOperationMessage("Estado de postulación actualizado.");
    await load();
  }

  const shownBenefits = useMemo(() => benefits.filter((benefit) => category === "Todos" || benefit.category === category), [category]);
  const readyPrograms = payload ? benefits.filter((benefit) => benefit.status !== "not-for-company" && benefit.checks(payload.profile).some((check) => check.state === "ready")).length : 0;

  if (loading) return <main className="dashboard"><p className="operation-message">Preparando perfil de beneficios…</p></main>;
  if (!payload) return <main className="dashboard"><p className="operation-message">{error ?? "No hay información disponible."}</p></main>;

  const { profile } = payload;
  return <main className="dashboard benefits-hub">
    <section className="headline">
      <div><span className="eyebrow">FONDOS PÚBLICOS · CHILE</span><h1>Fondos y beneficios</h1><p>Prechequeo para {profile.organizationName} con información tributaria y de dotación disponible en Atlas. Las bases del organismo son la decisión final.</p></div>
      <div className="headline-actions"><span className="refresh">Revisado {formatDate(payload.checkedAt)}</span><button className="secondary-button" type="button" disabled={!payload.workspaceReady} onClick={openProfileEditor}>Configurar perfil</button><button className="secondary-button" type="button" onClick={() => void load()}>Actualizar análisis</button></div>
    </section>

    <section className="kpis kpis-four" aria-label="Perfil disponible para beneficios">
      <article className="kpi-card accent"><span>Ventas documentadas</span><strong>{money.format(profile.documentedSalesLast12Months)}</strong><small>Últimos 12 meses en documentos emitidos; no reemplaza carpeta tributaria</small></article>
      <article className="kpi-card"><span>Dotación activa</span><strong>{profile.activePeople}</strong><small>{profile.payrollConnected ? "Sincronizada desde PeopleWork" : "PeopleWork aún no está habilitado"}</small></article>
      <article className="kpi-card"><span>Contratos vigentes</span><strong>{profile.activeContracts}</strong><small>Base para revisar beneficios de contratación</small></article>
      <article className="kpi-card"><span>Oportunidades con datos</span><strong>{readyPrograms}</strong><small>Programas que ya tienen alguna condición respaldada en Atlas</small></article>
    </section>

    {operationMessage && <p className="operation-message">{operationMessage}</p>}
    {!payload.workspaceReady && <p className="operation-message">La bandeja y el perfil se habilitan automáticamente al aplicar la migración de beneficios incluida en esta entrega.</p>}

    <section className="benefits-profile-panel">
      <div><span className="panel-label">EVIDENCIA DISPONIBLE</span><h2>Qué se puede respaldar desde Atlas</h2></div>
      <div className="benefits-evidence">
        <span className={profile.taxId ? "is-ready" : "is-missing"}>{profile.taxId ? "RUT de empresa registrado" : "Falta RUT de empresa"}</span>
        <span className={profile.siiConnected ? "is-ready" : "is-review"}>{profile.siiConnected ? "SII conectado" : "SII sin conexión activa"}</span>
        <span className={profile.payrollConnected ? "is-ready" : "is-review"}>{profile.payrollConnected ? `PeopleWork sincronizado ${formatDate(profile.payrollSyncedAt)}` : "Dotación sin sincronización activa"}</span>
      </div>
      <p>Atlas no puede certificar deudas, cotizaciones previas, Registro Social de Hogares, Clave Tributaria ni Registro Electrónico Laboral. Configura la evidencia disponible y cada organismo validará el antecedente oficial en su portal.</p>
    </section>

    <section className="benefits-sence-section">
      <div className="table-heading"><div><span className="panel-label">SENCE · ACTIVACIÓN LABORAL</span><h2>Nuevas contrataciones a revisar</h2><p>Atlas detecta contratos vigentes iniciados desde el 15 de julio de 2026 y bajo el tope de tres IMM. Aún debes confirmar cotizaciones previas, región habilitada y Registro Electrónico Laboral en SENCE.</p></div><span className="unit">Tope: {money.format(payload.sence.salaryLimit)}</span></div>
      <div className="table-scroll"><table><thead><tr><th>Colaborador</th><th>Inicio de contrato</th><th className="money-col">Bruto mensual</th><th>Estado Atlas</th></tr></thead><tbody>{payload.sence.candidates.length ? payload.sence.candidates.map((candidate) => <tr key={candidate.personId}><td><strong>{candidate.personName}</strong><small>Datos de PeopleWork</small></td><td>{candidate.startDate}</td><td className="money-col">{money.format(candidate.monthlyGrossSalary)}</td><td><span className="status pending">Pre-elegible</span><small>Falta validación externa SENCE / DT</small></td></tr>) : <tr><td colSpan={4}>No hay contratos pre-elegibles según los datos sincronizados. Atlas revisa fecha de inicio y remuneración, no cotizaciones previas.</td></tr>}</tbody></table></div>
    </section>

    {payload.applications.length > 0 && <section className="benefits-applications-section"><div className="table-heading"><div><span className="panel-label">BANDEJA DE POSTULACIONES</span><h2>Preparación y seguimiento</h2><p>El estado organiza el trabajo interno. La postulación y confirmación final ocurren en la plataforma oficial.</p></div></div><div className="benefits-applications-list">{payload.applications.map((application) => <article key={application.id}><div><span className="panel-label">{application.institution}</span><h3>{application.program_name}</h3><small>Actualizada {formatDate(application.updated_at)}</small></div><select aria-label={`Estado de ${application.program_name}`} value={application.status} disabled={saving} onChange={(event) => void setApplicationStatus(application, event.target.value as ApplicationStatus)}>{Object.entries(appStatusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><a className="secondary-button" href={application.official_url} target="_blank" rel="noreferrer">Portal oficial <span aria-hidden="true">↗</span></a></article>)}</div></section>}

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
          {benefit.status !== "not-for-company" && <button className="primary-button benefit-prepare" type="button" disabled={!payload.workspaceReady || saving || payload.applications.some((application) => application.program_id === benefit.id)} onClick={() => void prepareApplication(benefit)}>{payload.applications.some((application) => application.program_id === benefit.id) ? "En bandeja" : "Preparar en Atlas"}</button>}
          <a className="secondary-button benefit-action" href={benefit.url} target="_blank" rel="noreferrer">{benefit.action}<span aria-hidden="true">↗</span></a>
        </article>;
      })}</div>
    </section>

    {editingProfile && draft && <div className="modal-backdrop" role="presentation"><section className="entry-modal benefits-profile-modal" role="dialog" aria-modal="true" aria-labelledby="benefits-profile-title"><div className="modal-header"><div><span className="eyebrow">ELEGIBILIDAD</span><h2 id="benefits-profile-title">Perfil postulante</h2><p>Registra sólo antecedentes revisados. Atlas mostrará exactamente qué condiciones quedan pendientes.</p></div><button type="button" className="close-button" onClick={() => setEditingProfile(false)} aria-label="Cerrar">×</button></div><div className="form-grid"><label>Región<input value={draft.region} maxLength={100} onChange={(event) => setDraft({ ...draft, region: event.target.value })} placeholder="Ej. Metropolitana" /></label><label>Comuna<input value={draft.commune} maxLength={100} onChange={(event) => setDraft({ ...draft, commune: event.target.value })} /></label><label>Rubro o sector<input value={draft.businessSector} maxLength={160} onChange={(event) => setDraft({ ...draft, businessSector: event.target.value })} placeholder="Ej. tecnología, servicios profesionales" /></label><label>Inicio de actividades / antigüedad legal<input type="date" value={draft.legalStartDate} onChange={(event) => setDraft({ ...draft, legalStartDate: event.target.value })} /></label><label>Carpeta tributaria revisada<input type="date" value={draft.taxFolderReviewedAt} onChange={(event) => setDraft({ ...draft, taxFolderReviewedAt: event.target.value })} /></label><label>Presupuesto estimado del proyecto<input type="number" min="0" step="1" value={draft.projectBudget} onChange={(event) => setDraft({ ...draft, projectBudget: event.target.value })} /></label><label className="form-field-wide">Proyecto a financiar<textarea value={draft.projectFocus} maxLength={1000} onChange={(event) => setDraft({ ...draft, projectFocus: event.target.value })} placeholder="Problema, inversión y resultado esperado" /></label><label className="benefits-checkbox"><input type="checkbox" checked={draft.firstCategoryConfirmed} onChange={(event) => setDraft({ ...draft, firstCategoryConfirmed: event.target.checked })} />Primera categoría confirmada con antecedente tributario</label><label className="benefits-checkbox"><input type="checkbox" checked={draft.annualSalesVerified} onChange={(event) => setDraft({ ...draft, annualSalesVerified: event.target.checked })} />Ventas anuales verificadas con carpeta tributaria</label><label className="benefits-checkbox"><input type="checkbox" checked={draft.noTaxOrLaborDebtDeclared} onChange={(event) => setDraft({ ...draft, noTaxOrLaborDebtDeclared: event.target.checked })} />Sin deudas tributarias, laborales o previsionales declaradas</label><label className="benefits-checkbox"><input type="checkbox" checked={draft.noPendingPublicRenditionsDeclared} onChange={(event) => setDraft({ ...draft, noPendingPublicRenditionsDeclared: event.target.checked })} />Sin rendiciones pendientes de fondos públicos declaradas</label></div><div className="form-actions"><button className="secondary-button" type="button" onClick={() => setEditingProfile(false)}>Cancelar</button><button className="primary-button" type="button" disabled={saving} onClick={() => void saveProfile()}>{saving ? "Guardando…" : "Guardar perfil"}</button></div></section></div>}
  </main>;
}
