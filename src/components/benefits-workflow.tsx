"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Classification = "to_review" | "eligible" | "partial" | "not_eligible" | "monitoring";
type WorkflowStage = "new" | "collecting_documents" | "internal_review" | "ready_for_submission" | "submitted" | "waiting_result" | "awarded" | "not_selected" | "withdrawn";
type DocumentStatus = "not_started" | "collecting" | "complete" | "observed" | "not_required";
type Application = { id: string; program_name: string; institution: string; official_url: string; responsible_name: string | null; classification: Classification; workflow_stage: WorkflowStage; document_status: DocumentStatus; last_activity_at: string; updated_at: string };
type Event = { id: string; application_id: string; note: string | null; created_at: string };
type Payload = { applications: Application[]; events: Event[] };
type Draft = { responsibleName: string; classification: Classification; workflowStage: WorkflowStage; documentStatus: DocumentStatus; note: string };

const classifications: Record<Classification, string> = { to_review: "Por revisar", eligible: "Apta", partial: "Apta con pendientes", not_eligible: "No apta", monitoring: "Monitorear" };
const stages: Record<WorkflowStage, string> = { new: "Sin tomar", collecting_documents: "Juntando documentos", internal_review: "En revisión interna", ready_for_submission: "Lista para postular", submitted: "Postulación enviada", waiting_result: "Esperando resultado", awarded: "Adjudicada", not_selected: "No seleccionada", withdrawn: "Descartada" };
const documentStatuses: Record<DocumentStatus, string> = { not_started: "Sin iniciar", collecting: "Juntando documentos", complete: "Documentos completos", observed: "Documentos observados", not_required: "No requiere" };
const dateTime = new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short" });

function draftFrom(application: Application): Draft {
  return { responsibleName: application.responsible_name ?? "", classification: application.classification, workflowStage: application.workflow_stage, documentStatus: application.document_status, note: "" };
}

export function BenefitsWorkflow({ organizationId, compact = false }: { organizationId: string; compact?: boolean }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const response = await fetch(`/api/benefits/workflow?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
    if (!response.ok) { setMessage("La bandeja de postulaciones aún no está disponible."); setLoading(false); return; }
    const next = await response.json() as Payload;
    setPayload(next);
    setDrafts(Object.fromEntries(next.applications.map((application) => [application.id, draftFrom(application)])));
    setLoading(false);
  }, [organizationId]);

  useEffect(() => { void load(); }, [load]);

  const eventsByApplication = useMemo(() => {
    const grouped = new Map<string, Event[]>();
    for (const event of payload?.events ?? []) grouped.set(event.application_id, [...(grouped.get(event.application_id) ?? []), event]);
    return grouped;
  }, [payload?.events]);

  function updateDraft(applicationId: string, change: Partial<Draft>) {
    setDrafts((current) => ({ ...current, [applicationId]: { ...current[applicationId], ...change } }));
  }

  async function save(application: Application) {
    const draft = drafts[application.id];
    if (!draft || savingId) return;
    setSavingId(application.id);
    setMessage(null);
    const response = await fetch("/api/benefits/workflow", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, applicationId: application.id, ...draft }) });
    setSavingId(null);
    if (!response.ok) { setMessage("No fue posible guardar el seguimiento de esta postulación."); return; }
    setMessage(`Seguimiento de ${application.program_name} actualizado.`);
    await load();
  }

  if (loading) return <section className="benefits-workflow"><p className="operation-message">Cargando postulaciones…</p></section>;
  if (!payload?.applications.length) return compact ? <section className="data-entry-benefits-empty"><strong>No hay postulaciones preparadas todavía.</strong><span>Finanzas debe elegir “Preparar en Atlas” desde Fondos y beneficios para iniciar el seguimiento.</span></section> : null;

  return <section className={`benefits-workflow ${compact ? "is-compact" : ""}`}>
    {!compact && <div className="table-heading"><div><span className="panel-label">SEGUIMIENTO OPERATIVO</span><h2>Quién la toma y en qué etapa está</h2><p>Deja una tipificación, responsable, avance documental y cada gestión relevante. El envío final permanece en el portal oficial.</p></div><button type="button" className="secondary-button" onClick={() => void load()}>Actualizar</button></div>}
    {message && <p className="operation-message">{message}</p>}
    <div className="benefits-workflow-list">{payload.applications.map((application) => {
      const draft = drafts[application.id];
      const events = eventsByApplication.get(application.id) ?? [];
      if (!draft) return null;
      return <article className="benefits-workflow-card" key={application.id}>
        <div className="benefits-workflow-heading"><div><span className="panel-label">{application.institution}</span><h3>{application.program_name}</h3><small>Última actividad: {dateTime.format(new Date(application.last_activity_at))}</small></div><a className="secondary-button" href={application.official_url} target="_blank" rel="noreferrer">Portal oficial <span aria-hidden="true">↗</span></a></div>
        <div className="benefits-workflow-fields">
          <label>Responsable<input value={draft.responsibleName} maxLength={160} placeholder="Nombre de quien la toma" onChange={(event) => updateDraft(application.id, { responsibleName: event.target.value })} /></label>
          <label>Tipificación<select value={draft.classification} onChange={(event) => updateDraft(application.id, { classification: event.target.value as Classification })}>{Object.entries(classifications).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>Etapa<select value={draft.workflowStage} onChange={(event) => updateDraft(application.id, { workflowStage: event.target.value as WorkflowStage })}>{Object.entries(stages).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>Documentos<select value={draft.documentStatus} onChange={(event) => updateDraft(application.id, { documentStatus: event.target.value as DocumentStatus })}>{Object.entries(documentStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>
        <div className="benefits-workflow-note"><label>Registrar gestión<textarea value={draft.note} maxLength={2000} placeholder="Ej. Se solicitó carpeta tributaria; esperando certificado de vigencia." onChange={(event) => updateDraft(application.id, { note: event.target.value })} /></label><button className="primary-button" type="button" disabled={savingId === application.id} onClick={() => void save(application)}>{savingId === application.id ? "Guardando…" : "Guardar gestión"}</button></div>
        {events.length > 0 && <div className="benefits-workflow-history"><span className="panel-label">ÚLTIMAS GESTIONES</span>{events.slice(0, 3).map((event) => <p key={event.id}><strong>{dateTime.format(new Date(event.created_at))}</strong>{event.note || "Estado actualizado sin comentario."}</p>)}</div>}
      </article>;
    })}</div>
  </section>;
}
