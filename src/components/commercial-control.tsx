"use client";

import { type DragEvent, type FormEvent, useEffect, useMemo, useState } from "react";

type Customer = { id: string; legal_name: string; trade_name: string | null; tax_id: string | null };
type CostCenter = { id: string; code: string; name: string };
type Opportunity = { id: string; counterparty_id: string; title: string; stage: Stage; expected_amount: number | string; currency_code: Currency; probability: number | string; expected_close_on: string | null; next_action_on: string | null; source: string | null; lost_reason: string | null; description: string | null; updated_at: string };
type Contract = { id: string; counterparty_id: string; opportunity_id: string | null; contract_code: string; name: string; status: ContractStatus; total_amount: number | string; currency_code: Currency; starts_on: string | null; ends_on: string | null; renewal_notice_on: string | null; billing_frequency: Frequency; notes: string | null };
type Project = { id: string; counterparty_id: string; contract_id: string | null; opportunity_id: string | null; cost_center_id: string | null; project_code: string; name: string; status: ProjectStatus; revenue_budget: number | string; expense_budget: number | string; currency_code: Currency; starts_on: string | null; ends_on: string | null; notes: string | null };
type Activity = { id: string; opportunity_id: string; activity_type: ActivityType; subject: string; notes: string | null; due_on: string | null; completed_on: string | null; created_at: string };
type Payload = { customers: Customer[]; centers: CostCenter[]; opportunities: Opportunity[]; contracts: Contract[]; projects: Project[]; activities: Activity[] };
type DossierDocument = { id: string; category: string; title: string; source_url: string; signedUrl: string | null; mime_type: string | null; size_bytes: number | null; download_status: string; error_text: string | null };
type DossierAward = { id: string; related_tender_code: string; relationship: "current_process" | "probable_predecessor"; similarity_score: number | null; supplier_name: string | null; supplier_tax_id: string | null; awarded_amount: number | null; awarded_quantity: number | null; currency_code: string | null; award_date: string | null; award_document_url: string | null; source_url: string };
type PublicMarketDossier = { tender: { external_code: string; executive_summary: Record<string, unknown>; enrichment_status: string; fit_score: number; fit_tier: "green" | "yellow" | "red"; capability_matches: string[]; fit_reasons: string[]; fit_gaps: string[]; source_url: string } | null; documents: DossierDocument[]; awards: DossierAward[] };
type Stage = "exploration" | "meeting" | "quotation" | "proposal" | "pilot" | "negotiation" | "won" | "lost";
type ContractStatus = "draft" | "active" | "expiring" | "closed" | "cancelled";
type ProjectStatus = "planning" | "active" | "on_hold" | "completed" | "cancelled";
type ActivityType = "call" | "meeting" | "email" | "task" | "note";
type Currency = "CLP" | "UF" | "USD";
type Frequency = "monthly" | "quarterly" | "annual" | "one_time";
type CommercialView = "pipeline" | "contracts" | "projects";
type OpportunityDetailTab = "management" | "analysis" | "documents" | "history";

const stages: Array<{ key: Stage; label: string }> = [
  { key: "exploration", label: "Exploración" },
  { key: "meeting", label: "Reunión / demo" },
  { key: "quotation", label: "Cotización pendiente" },
  { key: "proposal", label: "Propuesta enviada" },
  { key: "pilot", label: "MVP / inicio" },
  { key: "negotiation", label: "Negociación / contrato" },
  { key: "won", label: "Cerrada / ejecución" },
  { key: "lost", label: "Baja propuesta" },
];
const stageTone: Record<Stage, string> = { exploration: "neutral", meeting: "info", quotation: "info", proposal: "violet", pilot: "warning", negotiation: "warning", won: "success", lost: "danger" };
const stageProbability: Record<Stage, number> = { exploration: 10, meeting: 25, quotation: 40, proposal: 55, pilot: 70, negotiation: 85, won: 100, lost: 0 };
const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const date = (value: string | null) => value ? new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value}T00:00:00`)) : "—";
const customerName = (customer: Customer | undefined) => customer ? customer.trade_name || customer.legal_name : "Cliente no disponible";
const asText = (value: string | number | null | undefined) => value === null || value === undefined ? "" : String(value);
const blankOpportunity = (): Omit<Opportunity, "id" | "updated_at"> => ({ counterparty_id: "", title: "", stage: "exploration", expected_amount: 0, currency_code: "CLP", probability: 10, expected_close_on: "", next_action_on: "", source: "", lost_reason: "", description: "" });
const blankContract = (): Omit<Contract, "id"> => ({ counterparty_id: "", opportunity_id: null, contract_code: "", name: "", status: "draft", total_amount: 0, currency_code: "CLP", starts_on: "", ends_on: "", renewal_notice_on: "", billing_frequency: "monthly", notes: "" });
const blankProject = (): Omit<Project, "id"> => ({ counterparty_id: "", contract_id: null, opportunity_id: null, cost_center_id: null, project_code: "", name: "", status: "planning", revenue_budget: 0, expense_budget: 0, currency_code: "CLP", starts_on: "", ends_on: "", notes: "" });
const blankActivity = (opportunityId = ""): Omit<Activity, "id" | "created_at"> => ({ opportunity_id: opportunityId, activity_type: "task", subject: "", notes: "", due_on: "", completed_on: null });

function displayAmount(amount: number | string, currency: Currency) {
  const numeric = Number(amount);
  return currency === "CLP" ? money.format(numeric) : `${currency} ${new Intl.NumberFormat("es-CL", { maximumFractionDigits: currency === "UF" ? 2 : 0 }).format(numeric)}`;
}

function publicMarketCode(opportunity: Opportunity | null) {
  if (!opportunity?.source?.toLocaleLowerCase("es").includes("mercado público")) return null;
  return opportunity.source.match(/Mercado P[uú]blico\s*·\s*([A-Z0-9-]{3,40})/i)?.[1]?.toUpperCase() ?? opportunity.title.match(/^([A-Z0-9-]{3,40})\s*·/i)?.[1]?.toUpperCase() ?? null;
}

function summaryText(summary: Record<string, unknown>, key: string, fallback = "No informado") {
  const value = summary[key];
  return typeof value === "string" && value.trim() ? cleanOfficialText(value) : fallback;
}

function summaryList(summary: Record<string, unknown>, key: string) {
  const value = summary[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function evaluationCriteria(summary: Record<string, unknown>) {
  const value = summary.evaluationCriteria;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return typeof record.name === "string" ? [{ name: record.name, weight: typeof record.weight === "string" ? record.weight : null }] : [];
  });
}

function cleanOfficialText(value: string) {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ" };
  let result = value;
  for (let pass = 0; pass < 3; pass += 1) result = result.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#")) { const point = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10); return Number.isFinite(point) ? String.fromCodePoint(point) : entity; }
    return named[code.toLowerCase()] ?? entity;
  });
  return result.replace(/<[^>]*>/g, " ").replace(/^(?:id|class|style)=["'][^"']*["']\s*/i, "").replace(/\s+/g, " ").trim();
}

function historyCodes(summary: Record<string, unknown>) {
  const search = summary.historySearch;
  if (!search || typeof search !== "object" || Array.isArray(search)) return [];
  const exactCodes = (search as Record<string, unknown>).exactCodes;
  return Array.isArray(exactCodes) ? exactCodes.filter((item): item is string => typeof item === "string") : [];
}

function categoryLabel(value: string) { return value === "administrative" ? "Administrativo" : value === "technical" ? "Técnico" : value === "economic" ? "Económico" : value === "award" ? "Adjudicación" : "Otro"; }
function humanBytes(value: number | null) { if (!value) return "—"; if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`; return `${(value / 1024 / 1024).toFixed(1)} MB`; }
function dossierMoney(value: number | null, currencyCode: string | null) { if (value === null) return "Monto no informado"; return currencyCode === "CLP" || !currencyCode ? money.format(value) : `${currencyCode} ${new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(value)}`; }

export function CommercialControl({ organizationId, canManage, initialView = "pipeline", lockedView = false, allowedViews }: { organizationId: string | null; canManage: boolean; initialView?: CommercialView; lockedView?: boolean; allowedViews?: CommercialView[] }) {
  const [data, setData] = useState<Payload | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<CommercialView>(initialView);
  const visibleViews = useMemo<CommercialView[]>(() => allowedViews?.length ? allowedViews : ["pipeline", "contracts", "projects"], [allowedViews]);
  const [opportunityDraft, setOpportunityDraft] = useState<(Omit<Opportunity, "id" | "updated_at"> & { id?: string }) | null>(null);
  const [contractDraft, setContractDraft] = useState<(Omit<Contract, "id"> & { id?: string }) | null>(null);
  const [projectDraft, setProjectDraft] = useState<(Omit<Project, "id"> & { id?: string }) | null>(null);
  const [activityDraft, setActivityDraft] = useState<(Omit<Activity, "id" | "created_at"> & { id?: string }) | null>(null);
  const [selectedOpportunityId, setSelectedOpportunityId] = useState("");
  const [opportunityDetailTab, setOpportunityDetailTab] = useState<OpportunityDetailTab>("management");
  const [opportunityDossier, setOpportunityDossier] = useState<PublicMarketDossier | null>(null);
  const [dossierLoading, setDossierLoading] = useState(false);
  const [pipelineSearch, setPipelineSearch] = useState("");
  const [draggedOpportunityId, setDraggedOpportunityId] = useState("");
  const [dragOverStage, setDragOverStage] = useState<Stage | null>(null);

  async function load() {
    if (!organizationId) { setLoading(false); return; }
    setLoading(true);
    const response = await fetch(`/api/commercial-control?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => null) as Payload | null;
    if (response.ok && payload) { setData(payload); setMessage(""); }
    else setMessage("No fue posible cargar la gestión comercial.");
    setLoading(false);
  }

  useEffect(() => { void load(); }, [organizationId]);
  useEffect(() => { if (!visibleViews.includes(view)) setView(visibleViews[0]); }, [view, visibleViews]);

  const customers = useMemo(() => new Map((data?.customers ?? []).map((customer) => [customer.id, customer])), [data]);
  const selectedOpportunity = data?.opportunities.find((item) => item.id === selectedOpportunityId) ?? null;
  const selectedTenderCode = publicMarketCode(selectedOpportunity);
  const selectedActivities = useMemo(() => (data?.activities ?? []).filter((item) => item.opportunity_id === selectedOpportunityId), [data, selectedOpportunityId]);
  const opportunityExecutive = opportunityDossier?.tender?.executive_summary ?? {};
  const opportunityCriteria = evaluationCriteria(opportunityExecutive);
  const opportunityFines = summaryList(opportunityExecutive, "fines");
  const opportunityHistoryCodes = historyCodes(opportunityExecutive);
  const dueActivities = useMemo(() => (data?.activities ?? []).filter((item) => !item.completed_on && item.due_on && item.due_on <= new Date().toISOString().slice(0, 10)), [data]);
  const weightedPipeline = useMemo(() => (data?.opportunities ?? []).filter((item) => !["won", "lost"].includes(item.stage) && item.currency_code === "CLP").reduce<number>((total, item) => total + Number(item.expected_amount) * Number(item.probability) / 100, 0), [data]);
  const activeContracts = (data?.contracts ?? []).filter((item) => ["active", "expiring"].includes(item.status));
  const activeProjects = (data?.projects ?? []).filter((item) => ["planning", "active", "on_hold"].includes(item.status));
  const filteredOpportunities = useMemo(() => {
    const needle = pipelineSearch.trim().toLocaleLowerCase("es");
    return (data?.opportunities ?? [])
      .filter((item) => !needle || [item.title, item.source, item.description, customerName(customers.get(item.counterparty_id))].some((value) => value?.toLocaleLowerCase("es").includes(needle)))
      .sort((a, b) => (a.next_action_on || a.expected_close_on || "9999").localeCompare(b.next_action_on || b.expected_close_on || "9999"));
  }, [customers, data, pipelineSearch]);

  useEffect(() => {
    setOpportunityDetailTab("management");
    setOpportunityDossier(null);
    if (!organizationId || !selectedTenderCode) { setDossierLoading(false); return; }
    const controller = new AbortController();
    setDossierLoading(true);
    const params = new URLSearchParams({ organizationId, code: selectedTenderCode });
    const loadDossier = async () => {
      const read = async () => {
        const response = await fetch(`/api/mercado-publico/intelligence?${params.toString()}`, { cache: "no-store", signal: controller.signal });
        return response.ok ? response.json() as Promise<PublicMarketDossier> : null;
      };
      let payload = await read();
      const needsRefresh = payload?.tender && !payload.tender.executive_summary?.historySearch;
      if (needsRefresh && canManage) {
        const refresh = await fetch("/api/mercado-publico/intelligence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "capture_tender", organizationId, code: selectedTenderCode, opportunityId: selectedOpportunityId }), signal: controller.signal });
        if (refresh.ok) payload = await read();
      }
      if (payload) setOpportunityDossier(payload);
    };
    void loadDossier()
      .catch((error: unknown) => { if (!(error instanceof DOMException && error.name === "AbortError")) setOpportunityDossier(null); })
      .finally(() => { if (!controller.signal.aborted) setDossierLoading(false); });
    return () => controller.abort();
  }, [canManage, organizationId, selectedOpportunityId, selectedTenderCode]);

  async function save(action: string, record: Record<string, unknown>, onSuccess: () => void, successMessage: string) {
    if (!organizationId) return;
    setSaving(true); setMessage("");
    const response = await fetch("/api/commercial-control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, organizationId, record }) });
    setSaving(false);
    if (!response.ok) { setMessage("No fue posible guardar. Revisa campos obligatorios, fechas, códigos únicos y permisos."); return; }
    onSuccess(); setMessage(successMessage); await load();
  }

  function submitOpportunity(event: FormEvent) { event.preventDefault(); if (!opportunityDraft) return; void save("save_opportunity", { id: opportunityDraft.id, counterpartyId: opportunityDraft.counterparty_id, title: opportunityDraft.title, stage: opportunityDraft.stage, expectedAmount: opportunityDraft.expected_amount, currencyCode: opportunityDraft.currency_code, probability: opportunityDraft.probability, expectedCloseOn: opportunityDraft.expected_close_on, nextActionOn: opportunityDraft.next_action_on, source: opportunityDraft.source, lostReason: opportunityDraft.lost_reason, description: opportunityDraft.description }, () => setOpportunityDraft(null), "Oportunidad comercial guardada."); }
  function submitContract(event: FormEvent) { event.preventDefault(); if (!contractDraft) return; void save("save_contract", { id: contractDraft.id, counterpartyId: contractDraft.counterparty_id, opportunityId: contractDraft.opportunity_id, contractCode: contractDraft.contract_code, name: contractDraft.name, status: contractDraft.status, totalAmount: contractDraft.total_amount, currencyCode: contractDraft.currency_code, startsOn: contractDraft.starts_on, endsOn: contractDraft.ends_on, renewalNoticeOn: contractDraft.renewal_notice_on, billingFrequency: contractDraft.billing_frequency, notes: contractDraft.notes }, () => setContractDraft(null), "Contrato guardado y vinculado al cliente."); }
  function submitProject(event: FormEvent) { event.preventDefault(); if (!projectDraft) return; void save("save_project", { id: projectDraft.id, counterpartyId: projectDraft.counterparty_id, contractId: projectDraft.contract_id, opportunityId: projectDraft.opportunity_id, costCenterId: projectDraft.cost_center_id, projectCode: projectDraft.project_code, name: projectDraft.name, status: projectDraft.status, revenueBudget: projectDraft.revenue_budget, expenseBudget: projectDraft.expense_budget, currencyCode: projectDraft.currency_code, startsOn: projectDraft.starts_on, endsOn: projectDraft.ends_on, notes: projectDraft.notes }, () => setProjectDraft(null), "Proyecto guardado y conectado al contrato/centro de costo."); }
  function submitActivity(event: FormEvent) { event.preventDefault(); if (!activityDraft) return; void save("save_activity", { id: activityDraft.id, opportunityId: activityDraft.opportunity_id, activityType: activityDraft.activity_type, subject: activityDraft.subject, notes: activityDraft.notes, dueOn: activityDraft.due_on, completedOn: Boolean(activityDraft.completed_on) }, () => setActivityDraft(null), "Actividad comercial registrada."); }

  function changeOpportunityStage(item: Opportunity, stage: Stage) {
    if (item.stage === stage) return;
    if (stage === "lost") {
      setOpportunityDraft({ ...item, stage, probability: stageProbability[stage], lost_reason: "" });
      return;
    }
    void save("save_opportunity", {
      id: item.id,
      counterpartyId: item.counterparty_id,
      title: item.title,
      stage,
      expectedAmount: item.expected_amount,
      currencyCode: item.currency_code,
      probability: stageProbability[stage],
      expectedCloseOn: item.expected_close_on,
      nextActionOn: item.next_action_on,
      source: item.source,
      lostReason: null,
      description: item.description,
    }, () => undefined, `Oportunidad movida a ${stages.find((candidate) => candidate.key === stage)?.label}.`);
  }

  function startOpportunityDrag(event: DragEvent<HTMLElement>, item: Opportunity) {
    if (!canManage || saving) {
      event.preventDefault();
      return;
    }
    setDraggedOpportunityId(item.id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", item.id);
  }

  function allowOpportunityDrop(event: DragEvent<HTMLElement>, stage: Stage) {
    if (!canManage || saving) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverStage(stage);
  }

  function dropOpportunity(event: DragEvent<HTMLElement>, stage: Stage) {
    if (!canManage || saving) return;
    event.preventDefault();
    const opportunityId = draggedOpportunityId || event.dataTransfer.getData("text/plain");
    const item = data?.opportunities.find((candidate) => candidate.id === opportunityId);
    setDraggedOpportunityId("");
    setDragOverStage(null);
    if (item && item.stage !== stage) changeOpportunityStage(item, stage);
  }

  function finishOpportunityDrag() {
    setDraggedOpportunityId("");
    setDragOverStage(null);
  }

  return <section className="panel customer-profile-panel crm-workspace">
    <div className="panel-heading crm-workspace-header">
      <div>
        <span className="panel-label">{view === "pipeline" ? "CRM · PIPELINE COMERCIAL" : view === "contracts" ? "CRM · CONTRATOS" : "CRM · PROYECTOS"}</span>
        <h2>{view === "pipeline" ? "Oportunidades por etapa" : view === "contracts" ? "Contratos y renovaciones" : "Ejecución y rentabilidad"}</h2>
        <p>{view === "pipeline" ? "Vista horizontal del ciclo comercial: exploración, reuniones, cotización, propuesta, MVP, contrato y resultado." : "Continuidad comercial conectada con cliente, centro de costo y presupuesto."}</p>
      </div>
      <div className="table-actions">
        <button type="button" className="secondary-button" onClick={() => void load()}>Actualizar</button>
        {canManage && view === "pipeline" && <button type="button" className="primary-button" onClick={() => setOpportunityDraft(blankOpportunity())}>Nueva oportunidad</button>}
        {canManage && view === "contracts" && <button type="button" className="primary-button" onClick={() => setContractDraft(blankContract())}>Nuevo contrato</button>}
        {canManage && view === "projects" && <button type="button" className="primary-button" onClick={() => setProjectDraft(blankProject())}>Nuevo proyecto</button>}
      </div>
    </div>
    {message && <p className="operation-message" role="status" aria-live="polite">{message}</p>}
    <section className="kpis crm-kpis">
      {view === "pipeline" ? <>
        <article className="kpi-card"><span>Pipeline ponderado</span><strong>{money.format(weightedPipeline)}</strong><small>Oportunidades CLP abiertas × probabilidad</small></article>
        <article className="kpi-card"><span>Oportunidades abiertas</span><strong>{(data?.opportunities ?? []).filter((item) => !["won", "lost"].includes(item.stage)).length}</strong><small>En gestión comercial</small></article>
        <article className="kpi-card"><span>Actividades vencidas</span><strong className={dueActivities.length ? "is-negative" : ""}>{dueActivities.length}</strong><small>Requieren gestión hoy</small></article>
        <article className="kpi-card accent"><span>Ganadas</span><strong>{(data?.opportunities ?? []).filter((item) => item.stage === "won").length}</strong><small>Resultado comercial acumulado</small></article>
      </> : <>
        <article className="kpi-card"><span>Contratos vigentes</span><strong>{activeContracts.length}</strong><small>Activos o por renovar</small></article>
        <article className="kpi-card"><span>Próximos a vencer</span><strong>{(data?.contracts ?? []).filter((item) => item.status === "expiring").length}</strong><small>Requieren decisión de renovación</small></article>
        <article className="kpi-card"><span>Proyectos en curso</span><strong>{activeProjects.length}</strong><small>Planificación, activos o pausados</small></article>
        <article className="kpi-card accent"><span>Sin centro de costo</span><strong>{activeProjects.filter((item) => !item.cost_center_id).length}</strong><small>Imputación pendiente</small></article>
      </>}
    </section>
    {(!lockedView && visibleViews.length > 1) && <div className="crm-view-tabs" role="tablist" aria-label="Gestión comercial">
      {visibleViews.includes("pipeline") && <button type="button" className={view === "pipeline" ? "is-active" : ""} onClick={() => setView("pipeline")}>Pipeline</button>}
      {visibleViews.includes("contracts") && <button type="button" className={view === "contracts" ? "is-active" : ""} onClick={() => setView("contracts")}>Contratos</button>}
      {visibleViews.includes("projects") && <button type="button" className={view === "projects" ? "is-active" : ""} onClick={() => setView("projects")}>Proyectos</button>}
    </div>}
    {loading ? <p className="billing-empty">Cargando gestión comercial…</p> : view === "pipeline" ? <>
      <div className="crm-pipeline-toolbar">
        <label>Buscar en el pipeline<input type="search" value={pipelineSearch} onChange={(event) => setPipelineSearch(event.target.value)} placeholder="Cliente, oportunidad, origen o detalle" /></label>
        <p>{canManage && <span>Arrastra para cambiar de etapa · </span>}<strong>{filteredOpportunities.length}</strong> oportunidad(es) visibles</p>
      </div>
      <div className="crm-kanban" aria-label="Pipeline comercial por etapas">
        {stages.map((stage) => {
          const items = filteredOpportunities.filter((item) => item.stage === stage.key);
          const stageAmount = items.filter((item) => item.currency_code === "CLP").reduce((total, item) => total + Number(item.expected_amount), 0);
          return <section
            className={`crm-kanban-column is-${stageTone[stage.key]}${dragOverStage === stage.key ? " is-drag-over" : ""}`}
            key={stage.key}
            aria-label={`Etapa ${stage.label}: ${items.length} oportunidad(es)`}
            onDragEnter={(event) => allowOpportunityDrop(event, stage.key)}
            onDragOver={(event) => allowOpportunityDrop(event, stage.key)}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverStage(null); }}
            onDrop={(event) => dropOpportunity(event, stage.key)}
          >
            <header><div><span>{stage.label}</span><strong>{items.length}</strong></div><small>{money.format(stageAmount)} CLP</small></header>
            <div className="crm-kanban-cards">
              {items.map((item) => <article
                className={`crm-opportunity-card${draggedOpportunityId === item.id ? " is-dragging" : ""}`}
                key={item.id}
                draggable={canManage && !saving}
                onDragStart={(event) => startOpportunityDrag(event, item)}
                onDragEnd={finishOpportunityDrag}
              >
                <button type="button" className="crm-opportunity-open" onClick={() => setSelectedOpportunityId(item.id)}>
                  <strong>{item.title}</strong>
                  <small>{customerName(customers.get(item.counterparty_id))}</small>
                  <span className="crm-opportunity-metrics"><b>{displayAmount(item.expected_amount, item.currency_code)}</b><em>{item.probability}%</em></span>
                  <span className={`crm-opportunity-next${item.next_action_on ? "" : " is-empty"}`}>{item.next_action_on ? `Próxima acción · ${date(item.next_action_on)}` : "Sin próxima acción"}</span>
                </button>
              </article>)}
              {!items.length && <p className="crm-kanban-empty">Sin oportunidades en esta etapa.</p>}
            </div>
          </section>;
        })}
      </div>
    </> : view === "contracts" ? <section className="table-section crm-data-view"><div className="table-scroll"><table><thead><tr><th>Contrato / cliente</th><th>Vigencia</th><th>Monto</th><th>Estado</th>{canManage && <th>Acción</th>}</tr></thead><tbody>{(data?.contracts ?? []).map((item) => <tr key={item.id}><td><strong>{item.contract_code} · {item.name}</strong><small>{customerName(customers.get(item.counterparty_id))}</small></td><td>{date(item.starts_on)} — {date(item.ends_on)}<small>Avisar: {date(item.renewal_notice_on)}</small></td><td>{displayAmount(item.total_amount, item.currency_code)}<small>{item.billing_frequency === "monthly" ? "Mensual" : item.billing_frequency === "quarterly" ? "Trimestral" : item.billing_frequency === "annual" ? "Anual" : "Única vez"}</small></td><td><span className="status pending">{item.status}</span></td>{canManage && <td><button type="button" className="text-button" onClick={() => setContractDraft({ ...item })}>Editar</button></td>}</tr>)}</tbody></table></div>{!data?.contracts.length && <p className="billing-empty">Crea el primer contrato para convertir una venta en compromiso gestionable.</p>}</section> : <section className="table-section crm-data-view"><div className="table-scroll"><table><thead><tr><th>Proyecto / cliente</th><th>Centro de costo</th><th>Presupuesto</th><th>Estado</th>{canManage && <th>Acción</th>}</tr></thead><tbody>{(data?.projects ?? []).map((item) => <tr key={item.id}><td><strong>{item.project_code} · {item.name}</strong><small>{customerName(customers.get(item.counterparty_id))}</small></td><td>{data?.centers.find((center) => center.id === item.cost_center_id)?.code || "Sin centro"}<small>{data?.centers.find((center) => center.id === item.cost_center_id)?.name || "Imputación pendiente"}</small></td><td>{displayAmount(item.revenue_budget, item.currency_code)}<small>Gasto: {displayAmount(item.expense_budget, item.currency_code)}</small></td><td><span className="status pending">{item.status}</span></td>{canManage && <td><button type="button" className="text-button" onClick={() => setProjectDraft({ ...item })}>Editar</button></td>}</tr>)}</tbody></table></div>{!data?.projects.length && <p className="billing-empty">Crea un proyecto para conectar presupuesto, costos y rentabilidad del contrato.</p>}</section>}
    {selectedOpportunity && view === "pipeline" && <CommercialModal title={selectedOpportunity.title} onClose={() => setSelectedOpportunityId("")}>
      <div className="crm-opportunity-detail">
        <div className="crm-opportunity-summary">
          <article><span>Cliente</span><strong>{customerName(customers.get(selectedOpportunity.counterparty_id))}</strong></article>
          <article><span>Monto</span><strong>{displayAmount(selectedOpportunity.expected_amount, selectedOpportunity.currency_code)}</strong></article>
          <article><span>Cierre estimado</span><strong>{date(selectedOpportunity.expected_close_on)}</strong></article>
          <article><span>Próxima acción</span><strong>{date(selectedOpportunity.next_action_on)}</strong></article>
        </div>
        {selectedTenderCode && <nav className="public-market-detail-tabs crm-opportunity-detail-tabs" aria-label="Expediente de la oportunidad">
          {(["management", "analysis", "documents", "history"] as OpportunityDetailTab[]).map((tab) => <button key={tab} type="button" className={opportunityDetailTab === tab ? "is-active" : ""} onClick={() => setOpportunityDetailTab(tab)}>{tab === "management" ? "Gestión" : tab === "analysis" ? "Análisis" : tab === "documents" ? `Archivos (${opportunityDossier?.documents.length ?? 0})` : `Historial (${opportunityDossier?.awards.length ?? 0})`}</button>)}
        </nav>}
        {opportunityDetailTab === "management" && <div className="crm-opportunity-tab-content">
          <div className="crm-opportunity-detail-head"><div><span className={`crm-stage-badge is-${stageTone[selectedOpportunity.stage]}`}>{stages.find((stage) => stage.key === selectedOpportunity.stage)?.label}</span><p>{selectedOpportunity.description || "Sin descripción comercial adicional."}</p>{selectedOpportunity.source && <small>Origen: {selectedOpportunity.source}</small>}</div>{canManage && <div className="table-actions"><button type="button" className="secondary-button" onClick={() => setOpportunityDraft({ ...selectedOpportunity })}>Editar</button><button type="button" className="primary-button" onClick={() => setActivityDraft(blankActivity(selectedOpportunity.id))}>Nueva actividad</button></div>}</div>
          <section className="crm-activity-section"><div className="section-title"><h3>Actividad y próximos pasos</h3><span>{selectedActivities.length}</span></div><div className="control-list">{selectedActivities.length ? selectedActivities.map((activity) => <div key={activity.id}><div><strong>{activity.subject}</strong><small>{activity.activity_type} · vencimiento {date(activity.due_on)} · {activity.completed_on ? `completada ${date(activity.completed_on)}` : "pendiente"}</small>{activity.notes && <small>{activity.notes}</small>}</div>{canManage && !activity.completed_on && <button type="button" className="text-button" onClick={() => setActivityDraft({ ...activity, completed_on: new Date().toISOString().slice(0, 10) })}>Completar</button>}</div>) : <p className="control-empty">Sin actividades. Registra una próxima acción para que la oportunidad no quede sin gestión.</p>}</div></section>
        </div>}
        {selectedTenderCode && opportunityDetailTab !== "management" && dossierLoading && <p className="billing-empty crm-dossier-loading">Cargando análisis y expediente oficial…</p>}
        {selectedTenderCode && opportunityDetailTab !== "management" && !dossierLoading && !opportunityDossier?.tender && <section className="crm-dossier-empty"><strong>Expediente aún no disponible</strong><p>La oportunidad está vinculada a Mercado Público, pero no se encontró su captura documental. Actualízala desde Mercado Público para preparar el análisis y los anexos.</p></section>}
        {opportunityDetailTab === "analysis" && opportunityDossier?.tender && <div className="public-market-tab-content crm-opportunity-tab-content">
          <div className="crm-dossier-heading"><div><span className="panel-label">EVALUACIÓN GEIMSER</span><h3>Resumen ejecutivo y condiciones críticas</h3></div><span className={`public-market-fit is-${opportunityDossier.tender.fit_tier}`}><i />{opportunityDossier.tender.fit_score}/100 · {opportunityDossier.tender.fit_tier === "green" ? "Alta afinidad" : opportunityDossier.tender.fit_tier === "yellow" ? "Revisar" : "Baja afinidad"}</span></div>
          <section className="public-market-executive-grid"><article><span className="panel-label">DECISIÓN COMERCIAL</span><p className="crm-dossier-objective">{summaryText(opportunityExecutive, "objective", selectedOpportunity.description || selectedOpportunity.title)}</p><h4>Por qué encaja</h4><ul>{opportunityDossier.tender.fit_reasons.length ? opportunityDossier.tender.fit_reasons.map((reason) => <li key={reason}>{cleanOfficialText(reason)}</li>) : <li>Revisión comercial requerida.</li>}</ul><h4>Brechas y riesgos</h4><ul>{opportunityDossier.tender.fit_gaps.length ? opportunityDossier.tender.fit_gaps.map((gap) => <li key={gap}>{cleanOfficialText(gap)}</li>) : <li>Sin brechas automáticas detectadas.</li>}</ul></article><article><span className="panel-label">CONDICIONES CRÍTICAS</span><dl><div><dt>Presupuesto</dt><dd>{summaryText(opportunityExecutive, "budget", displayAmount(selectedOpportunity.expected_amount, selectedOpportunity.currency_code))}</dd></div><div><dt>Duración</dt><dd>{summaryText(opportunityExecutive, "contractDuration")}</dd></div><div><dt>Pago</dt><dd>{[summaryText(opportunityExecutive, "paymentTerms", ""), summaryText(opportunityExecutive, "paymentMethod", "")].filter(Boolean).join(" · ") || "No informado"}</dd></div><div><dt>Garantías</dt><dd>{summaryText(opportunityExecutive, "guarantees", "No informadas en la ficha")}</dd></div><div><dt>Renovación</dt><dd>{summaryText(opportunityExecutive, "renewable")}</dd></div><div><dt>Subcontratación</dt><dd>{summaryText(opportunityExecutive, "subcontracting")}</dd></div></dl></article></section>
          {opportunityCriteria.length > 0 && <section className="public-market-criteria"><div><span className="panel-label">CRITERIOS DE EVALUACIÓN</span><h3>Cómo se define la adjudicación</h3></div><div>{opportunityCriteria.map((criterion, index) => <span key={`${criterion.name}-${index}`}><strong>{criterion.weight || "—"}</strong>{criterion.name}</span>)}</div></section>}
          {opportunityFines.length > 0 && <section className="public-market-risk-note"><span className="panel-label">MULTAS Y TÉRMINO ANTICIPADO</span>{opportunityFines.map((fine, index) => <p key={index}>{cleanOfficialText(fine)}</p>)}</section>}
        </div>}
        {opportunityDetailTab === "documents" && opportunityDossier?.tender && <div className="public-market-tab-content crm-opportunity-tab-content"><section className="public-market-file-header"><div><span className="panel-label">EXPEDIENTE DOCUMENTAL</span><h3>Archivos vinculados a esta oportunidad</h3><p>Estado: {opportunityDossier.tender.enrichment_status}. Las copias privadas se abren mediante un enlace temporal.</p></div></section><div className="public-market-files">{opportunityDossier.documents.map((document) => <article key={document.id}><span className={`public-market-file-icon is-${document.category}`}>DOC</span><div><strong>{document.title}</strong><small>{categoryLabel(document.category)} · {humanBytes(document.size_bytes)} · {document.download_status === "downloaded" ? "Copia segura en Atlas" : document.download_status === "failed" ? "Descarga pendiente" : "Fuente oficial"}</small>{document.error_text && <small>{document.error_text}</small>}</div><a className="text-button" href={document.signedUrl || document.source_url} target="_blank" rel="noreferrer">{document.signedUrl ? "Abrir copia" : "Abrir fuente"}</a></article>)}{!opportunityDossier.documents.length && <p className="control-empty">La ficha oficial no publicó anexos descargables. Se conserva su fuente oficial.</p>}</div></div>}
        {opportunityDetailTab === "history" && opportunityDossier?.tender && <div className="public-market-tab-content crm-opportunity-tab-content"><section className="public-market-file-header"><div><span className="panel-label">INTELIGENCIA DE ADJUDICACIÓN</span><h3>Adjudicatarios y procesos comparables</h3><p>Primero se prueba el mismo código bajando el año; si no existe, se revisan procesos del mismo organismo por similitud de objeto.</p></div></section><div className="public-market-history">{opportunityDossier.awards.map((award) => <article key={award.id}><div><span className={`status ${award.relationship === "current_process" ? "paid" : "pending"}`}>{award.relationship === "current_process" ? "Proceso actual" : `Predecesor probable · ${award.similarity_score ?? 0}%`}</span><h3>{award.supplier_name || "Proveedor no publicado"}</h3><p>{award.supplier_tax_id || "RUT no informado"} · licitación {award.related_tender_code}</p></div><div><strong>{dossierMoney(award.awarded_amount, award.currency_code)}</strong><small>{award.awarded_quantity !== null ? `Cantidad ${new Intl.NumberFormat("es-CL").format(award.awarded_quantity)}` : "Cantidad no informada"} · {date(award.award_date)}</small><a className="text-button" href={award.award_document_url || award.source_url} target="_blank" rel="noreferrer">Ver fuente oficial</a></div></article>)}{!opportunityDossier.awards.length && <div className="crm-history-empty"><strong>Sin adjudicación histórica compatible publicada</strong><p>{opportunityHistoryCodes.length ? `Se verificaron ${opportunityHistoryCodes.join(", ")} y los procesos del mismo organismo. Ninguno publicó una adjudicación comparable con este objeto.` : "La fuente oficial no publicó un adjudicatario ni un proceso suficientemente similar."}</p></div>}</div></div>}
      </div>
    </CommercialModal>}
    {opportunityDraft && <CommercialModal title={opportunityDraft.id ? "Editar oportunidad" : "Nueva oportunidad"} onClose={() => setOpportunityDraft(null)}><form onSubmit={submitOpportunity}><div className="form-grid"><label>Cliente *<select value={opportunityDraft.counterparty_id} onChange={(event) => setOpportunityDraft((current) => current ? { ...current, counterparty_id: event.target.value } : current)} required><option value="">Selecciona cliente</option>{data?.customers.map((customer) => <option key={customer.id} value={customer.id}>{customerName(customer)}</option>)}</select></label><label>Oportunidad *<input value={opportunityDraft.title} onChange={(event) => setOpportunityDraft((current) => current ? { ...current, title: event.target.value } : current)} required /></label><label>Etapa<select value={opportunityDraft.stage} onChange={(event) => setOpportunityDraft((current) => current ? { ...current, stage: event.target.value as Stage } : current)}>{stages.map((stage) => <option key={stage.key} value={stage.key}>{stage.label}</option>)}</select></label><label>Monto estimado<input min="0" step="any" type="number" value={asText(opportunityDraft.expected_amount)} onChange={(event) => setOpportunityDraft((current) => current ? { ...current, expected_amount: event.target.value } : current)} /></label><label>Moneda<select value={opportunityDraft.currency_code} onChange={(event) => setOpportunityDraft((current) => current ? { ...current, currency_code: event.target.value as Currency } : current)}><option value="CLP">CLP</option><option value="UF">UF</option><option value="USD">USD</option></select></label><label>Probabilidad (%)<input min="0" max="100" type="number" value={asText(opportunityDraft.probability)} onChange={(event) => setOpportunityDraft((current) => current ? { ...current, probability: event.target.value } : current)} /></label><label>Cierre estimado<input type="date" value={opportunityDraft.expected_close_on || ""} onChange={(event) => setOpportunityDraft((current) => current ? { ...current, expected_close_on: event.target.value } : current)} /></label><label>Próxima acción<input type="date" value={opportunityDraft.next_action_on || ""} onChange={(event) => setOpportunityDraft((current) => current ? { ...current, next_action_on: event.target.value } : current)} /></label><label>Origen<input value={opportunityDraft.source || ""} onChange={(event) => setOpportunityDraft((current) => current ? { ...current, source: event.target.value } : current)} /></label>{opportunityDraft.stage === "lost" && <label>Motivo pérdida *<input value={opportunityDraft.lost_reason || ""} onChange={(event) => setOpportunityDraft((current) => current ? { ...current, lost_reason: event.target.value } : current)} required /></label>}</div><label>Detalle<textarea value={opportunityDraft.description || ""} onChange={(event) => setOpportunityDraft((current) => current ? { ...current, description: event.target.value } : current)} /></label><ModalActions saving={saving} /></form></CommercialModal>}
    {contractDraft && <CommercialModal title={contractDraft.id ? "Editar contrato" : "Nuevo contrato"} onClose={() => setContractDraft(null)}><form onSubmit={submitContract}><div className="form-grid"><CustomerSelect data={data} value={contractDraft.counterparty_id} onChange={(counterparty_id) => setContractDraft((current) => current ? { ...current, counterparty_id, opportunity_id: null } : current)} /><label>Código *<input value={contractDraft.contract_code} onChange={(event) => setContractDraft((current) => current ? { ...current, contract_code: event.target.value } : current)} required /></label><label>Nombre *<input value={contractDraft.name} onChange={(event) => setContractDraft((current) => current ? { ...current, name: event.target.value } : current)} required /></label><label>Oportunidad origen<select value={contractDraft.opportunity_id || ""} onChange={(event) => setContractDraft((current) => current ? { ...current, opportunity_id: event.target.value || null } : current)}><option value="">Sin asociar</option>{(data?.opportunities ?? []).filter((item) => item.counterparty_id === contractDraft.counterparty_id).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label>Monto total<input min="0" step="any" type="number" value={asText(contractDraft.total_amount)} onChange={(event) => setContractDraft((current) => current ? { ...current, total_amount: event.target.value } : current)} /></label><CurrencySelect value={contractDraft.currency_code} onChange={(currency_code) => setContractDraft((current) => current ? { ...current, currency_code } : current)} /><label>Estado<select value={contractDraft.status} onChange={(event) => setContractDraft((current) => current ? { ...current, status: event.target.value as ContractStatus } : current)}>{["draft", "active", "expiring", "closed", "cancelled"].map((item) => <option key={item}>{item}</option>)}</select></label><label>Inicio<input type="date" value={contractDraft.starts_on || ""} onChange={(event) => setContractDraft((current) => current ? { ...current, starts_on: event.target.value } : current)} /></label><label>Fin<input type="date" value={contractDraft.ends_on || ""} onChange={(event) => setContractDraft((current) => current ? { ...current, ends_on: event.target.value } : current)} /></label><label>Aviso renovación<input type="date" value={contractDraft.renewal_notice_on || ""} onChange={(event) => setContractDraft((current) => current ? { ...current, renewal_notice_on: event.target.value } : current)} /></label><label>Frecuencia<select value={contractDraft.billing_frequency} onChange={(event) => setContractDraft((current) => current ? { ...current, billing_frequency: event.target.value as Frequency } : current)}><option value="monthly">Mensual</option><option value="quarterly">Trimestral</option><option value="annual">Anual</option><option value="one_time">Única vez</option></select></label></div><label>Notas<textarea value={contractDraft.notes || ""} onChange={(event) => setContractDraft((current) => current ? { ...current, notes: event.target.value } : current)} /></label><ModalActions saving={saving} /></form></CommercialModal>}
    {projectDraft && <CommercialModal title={projectDraft.id ? "Editar proyecto" : "Nuevo proyecto"} onClose={() => setProjectDraft(null)}><form onSubmit={submitProject}><div className="form-grid"><CustomerSelect data={data} value={projectDraft.counterparty_id} onChange={(counterparty_id) => setProjectDraft((current) => current ? { ...current, counterparty_id, opportunity_id: null, contract_id: null } : current)} /><label>Código *<input value={projectDraft.project_code} onChange={(event) => setProjectDraft((current) => current ? { ...current, project_code: event.target.value } : current)} required /></label><label>Nombre *<input value={projectDraft.name} onChange={(event) => setProjectDraft((current) => current ? { ...current, name: event.target.value } : current)} required /></label><label>Contrato<select value={projectDraft.contract_id || ""} onChange={(event) => setProjectDraft((current) => current ? { ...current, contract_id: event.target.value || null } : current)}><option value="">Sin contrato</option>{(data?.contracts ?? []).filter((item) => item.counterparty_id === projectDraft.counterparty_id).map((item) => <option key={item.id} value={item.id}>{item.contract_code} · {item.name}</option>)}</select></label><label>Oportunidad<select value={projectDraft.opportunity_id || ""} onChange={(event) => setProjectDraft((current) => current ? { ...current, opportunity_id: event.target.value || null } : current)}><option value="">Sin oportunidad</option>{(data?.opportunities ?? []).filter((item) => item.counterparty_id === projectDraft.counterparty_id).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label>Centro de costo<select value={projectDraft.cost_center_id || ""} onChange={(event) => setProjectDraft((current) => current ? { ...current, cost_center_id: event.target.value || null } : current)}><option value="">Imputar después</option>{data?.centers.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select></label><label>Presupuesto ingresos<input min="0" step="any" type="number" value={asText(projectDraft.revenue_budget)} onChange={(event) => setProjectDraft((current) => current ? { ...current, revenue_budget: event.target.value } : current)} /></label><label>Presupuesto gastos<input min="0" step="any" type="number" value={asText(projectDraft.expense_budget)} onChange={(event) => setProjectDraft((current) => current ? { ...current, expense_budget: event.target.value } : current)} /></label><CurrencySelect value={projectDraft.currency_code} onChange={(currency_code) => setProjectDraft((current) => current ? { ...current, currency_code } : current)} /><label>Estado<select value={projectDraft.status} onChange={(event) => setProjectDraft((current) => current ? { ...current, status: event.target.value as ProjectStatus } : current)}>{["planning", "active", "on_hold", "completed", "cancelled"].map((item) => <option key={item}>{item}</option>)}</select></label><label>Inicio<input type="date" value={projectDraft.starts_on || ""} onChange={(event) => setProjectDraft((current) => current ? { ...current, starts_on: event.target.value } : current)} /></label><label>Fin<input type="date" value={projectDraft.ends_on || ""} onChange={(event) => setProjectDraft((current) => current ? { ...current, ends_on: event.target.value } : current)} /></label></div><label>Notas<textarea value={projectDraft.notes || ""} onChange={(event) => setProjectDraft((current) => current ? { ...current, notes: event.target.value } : current)} /></label><ModalActions saving={saving} /></form></CommercialModal>}
    {activityDraft && <CommercialModal title={activityDraft.id ? "Completar actividad" : "Nueva actividad"} onClose={() => setActivityDraft(null)}><form onSubmit={submitActivity}><div className="form-grid"><label>Tipo<select value={activityDraft.activity_type} onChange={(event) => setActivityDraft((current) => current ? { ...current, activity_type: event.target.value as ActivityType } : current)}>{["call", "meeting", "email", "task", "note"].map((item) => <option key={item}>{item}</option>)}</select></label><label>Asunto *<input value={activityDraft.subject} onChange={(event) => setActivityDraft((current) => current ? { ...current, subject: event.target.value } : current)} required /></label><label>Vencimiento<input type="date" value={activityDraft.due_on || ""} onChange={(event) => setActivityDraft((current) => current ? { ...current, due_on: event.target.value } : current)} /></label><label><input type="checkbox" checked={Boolean(activityDraft.completed_on)} onChange={(event) => setActivityDraft((current) => current ? { ...current, completed_on: event.target.checked ? new Date().toISOString().slice(0, 10) : null } : current)} /> Completada</label></div><label>Notas<textarea value={activityDraft.notes || ""} onChange={(event) => setActivityDraft((current) => current ? { ...current, notes: event.target.value } : current)} /></label><ModalActions saving={saving} /></form></CommercialModal>}
  </section>;
}

function CommercialModal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) { return <div className="modal-backdrop crm-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="entry-modal customer-profile-modal crm-modal" role="dialog" aria-modal="true" aria-labelledby="commercial-modal-title"><div className="modal-header"><div><span className="eyebrow">GESTIÓN COMERCIAL</span><h2 id="commercial-modal-title">{title}</h2><p>Conserva el vínculo con cliente, contrato, proyecto y próximos pasos.</p></div><button type="button" className="close-button" onClick={onClose} aria-label="Cerrar">×</button></div>{children}</section></div>; }
function CustomerSelect({ data, value, onChange }: { data: Payload | null; value: string; onChange: (value: string) => void }) { return <label>Cliente *<select value={value} onChange={(event) => onChange(event.target.value)} required><option value="">Selecciona cliente</option>{data?.customers.map((customer) => <option key={customer.id} value={customer.id}>{customerName(customer)}</option>)}</select></label>; }
function CurrencySelect({ value, onChange }: { value: Currency; onChange: (value: Currency) => void }) { return <label>Moneda<select value={value} onChange={(event) => onChange(event.target.value as Currency)}><option value="CLP">CLP</option><option value="UF">UF</option><option value="USD">USD</option></select></label>; }
function ModalActions({ saving }: { saving: boolean }) { return <div className="form-actions"><button className="primary-button" type="submit" disabled={saving}>{saving ? "Guardando…" : "Guardar"}</button></div>; }
