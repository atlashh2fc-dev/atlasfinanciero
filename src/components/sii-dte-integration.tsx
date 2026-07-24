"use client";

import { useEffect, useMemo, useState } from "react";

type SiiDocument = {
  id: string;
  supplier_name: string;
  supplier_tax_id: string | null;
  document_number: string | null;
  document_type: string;
  sii_document_type: number | null;
  sii_folio: number | string | null;
  sii_received_at: string | null;
  sii_response_deadline: string | null;
  sii_event_status: string | null;
  sii_last_checked_at: string | null;
};

type Integration = {
  taxpayer_rut: string;
  environment: "production" | "certification";
  inbound_channel: "email" | "provider" | "manual";
  inbound_address: string | null;
  is_enabled: boolean;
  configured_at: string | null;
};

type Event = {
  id: string;
  received_document_id: string;
  action: string;
  reason: string | null;
  request_status: "pending" | "completed" | "failed";
  sii_response_code: number | null;
  sii_response_message: string | null;
  requested_at: string;
  completed_at: string | null;
};

type MailSyncRun = {
  started_at: string;
  completed_at: string | null;
  run_status: "completed" | "failed";
  dte_created: number;
  dte_updated: number;
  dte_skipped: number;
  invoice_files_attached: number;
  payment_matched: number;
  payment_review_required: number;
  error_detail: string | null;
};

type RcvSyncRun = {
  started_at: string;
  completed_at: string | null;
  run_status: "completed" | "failed";
  trigger_source: "cron" | "manual";
  periods: string[];
  purchase_entries_fetched: number;
  sale_entries_fetched: number;
  purchases_created: number;
  purchases_linked: number;
  sales_created: number;
  sales_linked: number;
  discrepancies: number;
  error_detail: string | null;
};

type RcvPendingEntry = {
  id: string;
  operation: "purchase" | "sale";
  period: string;
  document_type: number;
  folio: number | string;
  counterpart_tax_id: string;
  counterpart_name: string | null;
  total_amount: number | string | null;
  match_status: "unmatched" | "amount_mismatch";
  match_detail: string | null;
};

type ConfigDraft = {
  taxpayerRut: string;
  environment: "production" | "certification";
  inboundChannel: "email" | "provider" | "manual";
  inboundAddress: string;
  isEnabled: boolean;
};

const dateTime = new Intl.DateTimeFormat("es-CL", {
  dateStyle: "medium",
  timeStyle: "short",
});

function displayDate(value: string | null) {
  return value ? dateTime.format(new Date(value)) : "—";
}

function eventLabel(action: string) {
  return (
    {
      ACD: "Aceptación de contenido",
      ERM: "Acuse de recibo",
      RCD: "Reclamo de contenido",
      RFP: "Reclamo por falta parcial",
      RFT: "Reclamo por falta total",
    } as Record<string, string>
  )[action] ?? action;
}

function documentState(document: SiiDocument, events: Event[]) {
  const event = events.find(
    (item) =>
      item.received_document_id === document.id &&
      item.request_status === "completed" &&
      item.sii_response_code === 0,
  );
  if (document.sii_event_status === "accepted_content") return "Aceptada";
  if (document.sii_event_status === "receipt_acknowledged") return "Acuse registrado";
  if (document.sii_event_status === "claimed") return "Reclamada";
  if (document.sii_event_status === "decision_window_closed") return "Plazo vencido en SII";
  if (event) return eventLabel(event.action);
  return "Pendiente de decisión";
}

function lookupErrorMessage(error?: string) {
  if (error === "sii_network_timeout") return "El SII tardó demasiado en responder. La consulta se detuvo sin registrar ninguna acción; inténtalo nuevamente.";
  if (error === "sii_network_unavailable") return "El SII no está disponible en este momento. Vuelve a consultar en unos minutos.";
  if (error === "sii_certificate_not_configured") return "Falta el certificado tributario para consultar el SII.";
  if (error === "sii_document_identity_required") return "Falta Tipo DTE, Folio o RUT del emisor para consultar este documento.";
  return "El SII no pudo confirmar la recepción del documento. Revisa su identidad y vuelve a intentar.";
}

export function SiiDteIntegration({
  organizationId,
  canConfigure,
  documents,
  onRefreshDocuments,
}: {
  organizationId: string | null;
  canConfigure: boolean;
  documents: SiiDocument[];
  onRefreshDocuments: () => Promise<void>;
}) {
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [mailSyncRuns, setMailSyncRuns] = useState<MailSyncRun[]>([]);
  const [rcvSyncRuns, setRcvSyncRuns] = useState<RcvSyncRun[]>([]);
  const [rcvPendingEntries, setRcvPendingEntries] = useState<RcvPendingEntry[]>([]);
  const [syncingRcv, setSyncingRcv] = useState(false);
  const [rcvMessage, setRcvMessage] = useState<string | null>(null);
  const [rcvHistoryStart, setRcvHistoryStart] = useState("2026-01");
  const [certificateConfigured, setCertificateConfigured] = useState(false);
  const [draft, setDraft] = useState<ConfigDraft>({
    taxpayerRut: "",
    environment: "production",
    inboundChannel: "email",
    inboundAddress: "",
    isEnabled: false,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncingMailbox, setSyncingMailbox] = useState(false);
  const [workingDocumentId, setWorkingDocumentId] = useState<string | null>(null);
  const [lookupFeedback, setLookupFeedback] = useState<{ documentId: string; text: string; tone: "info" | "success" | "error" } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    if (!organizationId) {
      setIntegration(null);
      setEvents([]);
      setMailSyncRuns([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(
        `/api/integrations/sii?organizationId=${encodeURIComponent(organizationId)}`,
        { cache: "no-store" },
      );
      const payload = (await response.json().catch(() => null)) as {
        integration?: Integration | null;
        events?: Event[];
        mailSyncRuns?: MailSyncRun[];
        rcvSyncRuns?: RcvSyncRun[];
        rcvPendingEntries?: RcvPendingEntry[];
        certificateConfigured?: boolean;
      } | null;
      if (!response.ok || !payload) {
        setMessage("La integración SII aún no está disponible. Confirma que la migración fue aplicada.");
        return;
      }
      setIntegration(payload.integration ?? null);
      setEvents(payload.events ?? []);
      setMailSyncRuns(payload.mailSyncRuns ?? []);
      setRcvSyncRuns(payload.rcvSyncRuns ?? []);
      setRcvPendingEntries(payload.rcvPendingEntries ?? []);
      setCertificateConfigured(Boolean(payload.certificateConfigured));
      if (payload.integration) {
        setDraft({
          taxpayerRut: payload.integration.taxpayer_rut,
          environment: payload.integration.environment,
          inboundChannel: payload.integration.inbound_channel,
          inboundAddress: payload.integration.inbound_address ?? "",
          isEnabled: payload.integration.is_enabled,
        });
      }
      setMessage(null);
    } catch {
      setMessage("No fue posible cargar la integración SII.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [organizationId]);

  const trackedDocuments = useMemo(
    () =>
      documents.filter(
        (document) => document.sii_document_type && document.sii_folio,
      ),
    [documents],
  );
  const alerts = useMemo(() => {
    const now = Date.now();
    return trackedDocuments.filter((document) => {
      if (document.sii_event_status) return false;
      if (!document.sii_response_deadline) return true;
      return new Date(document.sii_response_deadline).valueOf() - now <= 48 * 60 * 60 * 1000;
    });
  }, [trackedDocuments]);

  async function saveConfiguration() {
    if (!organizationId) return;
    setSaving(true);
    try {
      const response = await fetch("/api/integrations/sii", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          taxpayerRut: draft.taxpayerRut,
          environment: draft.environment,
          inboundChannel: draft.inboundChannel,
          inboundAddress: draft.inboundAddress || null,
          isEnabled: draft.isEnabled,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        integration?: Integration;
      } | null;
      if (!response.ok || !payload?.integration) {
        setMessage("No fue posible guardar. Revisa el RUT, tus permisos de Administrador y la configuración.");
        return;
      }
      setIntegration(payload.integration);
      setMessage("Configuración SII guardada.");
    } catch {
      setMessage("No fue posible guardar la configuración SII.");
    } finally {
      setSaving(false);
    }
  }

  async function requestRcvSync(period?: string) {
    const response = await fetch("/api/integrations/sii/rcv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(period ? { organizationId, period } : { organizationId }),
    });
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      purchasesFetched?: number;
      salesFetched?: number;
      purchasesCreated?: number;
      salesCreated?: number;
      discrepancies?: number;
    } | null;
    return { ok: response.ok, payload };
  }

  async function syncRcvNow() {
    if (!organizationId) return;
    setSyncingRcv(true);
    setRcvMessage("Sincronizando el Registro de Compras y Ventas del SII…");
    try {
      const { ok, payload } = await requestRcvSync();
      if (!ok) {
        setRcvMessage(payload?.error || "No fue posible sincronizar el RCV.");
        return;
      }
      await Promise.all([load(), onRefreshDocuments()]);
      setRcvMessage(`RCV sincronizado: ${payload?.purchasesFetched ?? 0} compra(s) y ${payload?.salesFetched ?? 0} venta(s) leídas del SII; ${(payload?.purchasesCreated ?? 0) + (payload?.salesCreated ?? 0)} documento(s) nuevo(s) y ${payload?.discrepancies ?? 0} discrepancia(s) de monto.`);
    } catch {
      setRcvMessage("No fue posible sincronizar el RCV. Inténtalo nuevamente.");
    } finally {
      setSyncingRcv(false);
    }
  }

  async function syncRcvHistory() {
    if (!organizationId) return;
    const match = rcvHistoryStart.match(/^(\d{4})-(\d{2})$/);
    if (!match) {
      setRcvMessage("Indica el mes inicial del histórico en formato AAAA-MM.");
      return;
    }
    const now = new Date();
    const periods: string[] = [];
    let year = Number(match[1]);
    let month = Number(match[2]);
    while (year < now.getFullYear() || (year === now.getFullYear() && month <= now.getMonth() + 1)) {
      periods.push(`${year}${String(month).padStart(2, "0")}`);
      month += 1;
      if (month > 12) { month = 1; year += 1; }
    }
    if (!periods.length || periods.length > 60) {
      setRcvMessage(periods.length ? "El histórico está limitado a 60 meses por ejecución." : "El mes inicial debe ser anterior o igual al mes actual.");
      return;
    }
    setSyncingRcv(true);
    let totals = { purchases: 0, sales: 0, created: 0, discrepancies: 0 };
    try {
      for (const [index, period] of periods.entries()) {
        setRcvMessage(`Trayendo histórico del SII: período ${period} (${index + 1} de ${periods.length})…`);
        const { ok, payload } = await requestRcvSync(period);
        if (!ok) {
          setRcvMessage(`El período ${period} falló: ${payload?.error || "sin detalle"}. Avance previo: ${totals.purchases} compra(s) y ${totals.sales} venta(s) leídas.`);
          return;
        }
        totals = {
          purchases: totals.purchases + (payload?.purchasesFetched ?? 0),
          sales: totals.sales + (payload?.salesFetched ?? 0),
          created: totals.created + (payload?.purchasesCreated ?? 0) + (payload?.salesCreated ?? 0),
          discrepancies: totals.discrepancies + (payload?.discrepancies ?? 0),
        };
      }
      await Promise.all([load(), onRefreshDocuments()]);
      setRcvMessage(`Histórico completo (${periods.length} período(s)): ${totals.purchases} compra(s) y ${totals.sales} venta(s) leídas del SII; ${totals.created} documento(s) nuevo(s) y ${totals.discrepancies} discrepancia(s) de monto.`);
    } catch {
      setRcvMessage("La sincronización histórica se interrumpió. Puedes reintentarla: los períodos ya traídos no se duplican.");
    } finally {
      setSyncingRcv(false);
    }
  }

  async function refreshDocument(document: SiiDocument) {
    if (!organizationId) return;
    setWorkingDocumentId(document.id);
    setLookupFeedback({ documentId: document.id, text: "Consultando al SII…", tone: "info" });
    try {
      const response = await fetch("/api/integrations/sii", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, documentId: document.id, operation: "refresh" }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        receiptDate?: string | null;
        history?: unknown;
      } | null;
      if (!response.ok) {
        setLookupFeedback({ documentId: document.id, text: lookupErrorMessage(payload?.error), tone: "error" });
        return;
      }
      await Promise.all([load(), onRefreshDocuments()]);
      const eventsFound = Array.isArray(payload?.history) ? payload.history.length : null;
      const text = payload?.receiptDate
        ? `El SII informa recepción el ${displayDate(payload.receiptDate)}${eventsFound === null ? "." : `; además informa ${eventsFound} evento(s).`}`
        : "El SII no tiene información nueva de recepción para esta factura.";
      setLookupFeedback({ documentId: document.id, text, tone: payload?.receiptDate ? "success" : "info" });
    } catch {
      setLookupFeedback({ documentId: document.id, text: "No fue posible consultar el SII. Inténtalo nuevamente.", tone: "error" });
    } finally {
      setWorkingDocumentId(null);
    }
  }

  async function registerAction(document: SiiDocument, action: "ACD" | "ERM" | "RCD" | "RFP" | "RFT") {
    if (!organizationId) return;
    const claim = ["RCD", "RFP", "RFT"].includes(action);
    const reason = claim ? window.prompt("Motivo del reclamo (quedará en la bitácora del SII):") : null;
    if (claim && !reason?.trim()) return;
    const verb = action === "ACD" ? "aceptar el contenido" : action === "ERM" ? "registrar el acuse de recibo" : "registrar el reclamo";
    if (!window.confirm(`¿Confirmas ${verb} para el folio ${document.sii_folio}? Esta acción se enviará al SII y quedará auditada.`)) return;
    setWorkingDocumentId(document.id);
    try {
      const response = await fetch("/api/integrations/sii", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          documentId: document.id,
          operation: "register",
          action,
          reason: reason?.trim() || undefined,
          confirm: true,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        accepted?: boolean;
        result?: { code?: number | null; message?: string | null };
      } | null;
      if (!response.ok) {
        setMessage(payload?.error === "sii_integration_not_enabled" ? "Primero habilita la integración SII." : "El SII rechazó o no pudo procesar la solicitud. Revisa la bitácora.");
        return;
      }
      await Promise.all([load(), onRefreshDocuments()]);
      setMessage(payload?.accepted ? "Acción registrada correctamente en el SII." : `El SII no registró la acción: ${payload?.result?.message || "sin detalle"}.`);
    } catch {
      setMessage("No fue posible enviar la acción al SII.");
    } finally {
      setWorkingDocumentId(null);
    }
  }

  return <>
    <section className="table-section sii-workbench">
      <div className="table-heading"><div><span className="panel-label">SII · DTE RECIBIDOS</span><h2>Decisiones tributarias</h2><p>El Registro de Compras y Ventas del SII se sincroniza a diario como fuente oficial; el correo tributario aporta el XML con el detalle.</p></div><div className="sii-heading-actions"><span className={`status ${certificateConfigured && integration?.is_enabled ? "paid" : "cancelled"}`}>{certificateConfigured && integration?.is_enabled ? "Automático activo" : "Conexión pendiente"}</span></div></div>
      {message && <p className="operation-message">{message}</p>}
      <div className="sii-summary-grid">
        <article><strong>{alerts.length}</strong><span>listos para decidir</span></article>
        <article><strong>{trackedDocuments.length}</strong><span>DTE identificados desde correo</span></article>
      </div>
      {integration?.is_enabled && <p className="form-note">{mailSyncRuns[0] ? mailSyncRuns[0].run_status === "completed" ? `Última revisión: ${displayDate(mailSyncRuns[0].completed_at)}. En las últimas 24 horas: ${mailSyncRuns.filter((run) => new Date(run.started_at).valueOf() >= Date.now() - 24 * 60 * 60 * 1000).reduce((total, run) => total + run.dte_created, 0)} factura(s) nueva(s), ${mailSyncRuns.filter((run) => new Date(run.started_at).valueOf() >= Date.now() - 24 * 60 * 60 * 1000).reduce((total, run) => total + run.invoice_files_attached, 0)} respaldo(s) adjuntado(s) y ${mailSyncRuns.filter((run) => new Date(run.started_at).valueOf() >= Date.now() - 24 * 60 * 60 * 1000).reduce((total, run) => total + run.payment_matched, 0)} comprobante(s) conciliado(s).` : `La última revisión automática falló: ${mailSyncRuns[0].error_detail || "sin detalle"}.` : "La primera revisión automática quedará registrada dentro de 30 minutos."}</p>}
      {alerts.length > 0 && <p className="sii-alert"><strong>Atención:</strong> hay DTE sin decisión o con plazo próximo. Resuélvelos desde la bandeja de abajo.</p>}
      {loading ? <p className="billing-empty">Cargando estado SII…</p> : <details className="sii-settings"><summary>Configuración de la conexión</summary>{canConfigure ? <form className="sii-settings-form" onSubmit={(event) => { event.preventDefault(); void saveConfiguration(); }}>
        <label>RUT contribuyente<input required value={draft.taxpayerRut} maxLength={12} onChange={(event) => setDraft((current) => ({ ...current, taxpayerRut: event.target.value }))} /></label>
        <label>Ambiente<select value={draft.environment} onChange={(event) => setDraft((current) => ({ ...current, environment: event.target.value as ConfigDraft["environment"] }))}><option value="production">Producción</option><option value="certification">Certificación</option></select></label>
        <label>Canal<select value={draft.inboundChannel} onChange={(event) => setDraft((current) => ({ ...current, inboundChannel: event.target.value as ConfigDraft["inboundChannel"] }))}><option value="email">Correo tributario</option><option value="provider">Proveedor XML</option><option value="manual">Carga manual</option></select></label>
        <label>Referencia<input value={draft.inboundAddress} maxLength={254} placeholder="correo o proveedor" onChange={(event) => setDraft((current) => ({ ...current, inboundAddress: event.target.value }))} /></label>
        <button className="secondary-button" disabled={saving || !certificateConfigured}>{saving ? "Guardando…" : "Guardar"}</button>
      </form> : <p className="form-note">Sólo Administrador puede modificar la conexión.</p>}<p className="form-note">Estado: {integration?.is_enabled ? "habilitada" : "deshabilitada"}. El ingreso automático requiere conectar el correo tributario o proveedor XML.</p></details>}
    </section>

    <section className="table-section">
      <div className="table-heading"><div><span className="panel-label">SII · REGISTRO DE COMPRAS Y VENTAS</span><h2>Fuente oficial del SII</h2><p>Todo documento emitido o recibido según el SII, aunque nunca llegue el correo. El automático diario cubre el período actual y anterior; el histórico se trae por rango.</p></div><div className="sii-heading-actions"><button type="button" className="secondary-button" disabled={syncingRcv || !integration?.is_enabled || !canConfigure || integration?.environment !== "production"} onClick={() => void syncRcvNow()}>{syncingRcv ? "Sincronizando…" : "Sincronizar RCV ahora"}</button></div></div>
      {integration?.is_enabled && integration.environment !== "production" && <p className="form-note">El RCV sólo existe en el ambiente de producción del SII. Cambia el ambiente para habilitar la sincronización.</p>}
      {canConfigure && <div className="sii-settings-form" style={{ alignItems: "end" }}>
        <label>Traer histórico desde<input type="month" value={rcvHistoryStart} min="2017-08" max={new Date().toISOString().slice(0, 7)} onChange={(event) => setRcvHistoryStart(event.target.value)} /></label>
        <button type="button" className="secondary-button" disabled={syncingRcv || !integration?.is_enabled || integration?.environment !== "production"} onClick={() => void syncRcvHistory()}>{syncingRcv ? "Sincronizando…" : "Traer histórico"}</button>
      </div>}
      {rcvMessage && <p className="operation-message">{rcvMessage}</p>}
      <p className="form-note">{rcvSyncRuns[0]
        ? rcvSyncRuns[0].run_status === "completed"
          ? `Última sincronización (${rcvSyncRuns[0].trigger_source === "cron" ? "automática" : "manual"}): ${displayDate(rcvSyncRuns[0].completed_at)} · períodos ${rcvSyncRuns[0].periods.join(", ")} · ${rcvSyncRuns[0].purchase_entries_fetched} compra(s) y ${rcvSyncRuns[0].sale_entries_fetched} venta(s) leídas · ${rcvSyncRuns[0].purchases_created + rcvSyncRuns[0].sales_created} documento(s) creado(s) · ${rcvSyncRuns[0].discrepancies} discrepancia(s).`
          : `La última sincronización del RCV falló: ${rcvSyncRuns[0].error_detail || "sin detalle"}.`
        : "Aún no hay sincronizaciones del RCV. La primera corre automáticamente cada mañana, o ejecútala ahora."}</p>
      {rcvPendingEntries.length > 0 && <>
        <p className="sii-alert"><strong>Revisión requerida:</strong> {rcvPendingEntries.length} entrada(s) del RCV sin conciliar o con montos distintos a los registrados.</p>
        <div className="table-scroll"><table><thead><tr><th>Operación</th><th>Documento</th><th>Contraparte</th><th>Total SII</th><th>Situación</th></tr></thead><tbody>{rcvPendingEntries.map((entry) => <tr key={entry.id}><td>{entry.operation === "purchase" ? "Compra" : "Venta"}<small>Período {entry.period}</small></td><td><strong>DTE {entry.document_type}</strong><small>Folio {entry.folio}</small></td><td>{entry.counterpart_name || entry.counterpart_tax_id}<small>{entry.counterpart_tax_id}</small></td><td>{entry.total_amount === null ? "—" : new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP" }).format(Number(entry.total_amount))}</td><td><span className={`status ${entry.match_status === "amount_mismatch" ? "cancelled" : "pending"}`}>{entry.match_status === "amount_mismatch" ? "Montos distintos" : "Sin conciliar"}</span>{entry.match_detail && <small>{entry.match_detail}</small>}</td></tr>)}</tbody></table></div>
      </>}
    </section>

    <section className="table-section">
      <div className="table-heading"><div><span className="panel-label">BANDEJA DE DECISIÓN</span><h2>Documentos listos para revisar</h2><p>Consulta el SII antes de aceptar o reclamar. Todas las acciones quedan registradas.</p></div></div>
      <div className="table-scroll"><table><thead><tr><th>Documento</th><th>Recepción / plazo</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>{trackedDocuments.length ? trackedDocuments.map((document) => { const busy = workingDocumentId === document.id; const latest = events.find((item) => item.received_document_id === document.id); const feedback = lookupFeedback?.documentId === document.id ? lookupFeedback : null; const closed = document.sii_event_status === "decision_window_closed"; return <tr key={document.id}><td><strong>{document.supplier_name}</strong><small>DTE {document.sii_document_type} · Folio {document.sii_folio}</small></td><td>{displayDate(document.sii_received_at)}<small>Plazo: {displayDate(document.sii_response_deadline)}</small></td><td><span className={`status ${document.sii_event_status === "claimed" || closed ? "cancelled" : document.sii_event_status ? "paid" : "pending"}`}>{documentState(document, events)}</span>{closed ? <small>El SII ya cerró el plazo para aceptar o reclamar.</small> : latest && <small>{eventLabel(latest.action)} · {latest.request_status}{latest.sii_response_message ? ` · ${latest.sii_response_message}` : ""}</small>}</td><td>{closed ? <small>No hay acciones disponibles.</small> : <><div className="cycle-actions"><button type="button" className="secondary-button" disabled={busy || !integration?.is_enabled} onClick={() => void refreshDocument(document)}>{busy ? "Consultando…" : "Consultar"}</button>{!document.sii_event_status && <><button type="button" className="primary-button" disabled={busy || !integration?.is_enabled} onClick={() => void registerAction(document, "ACD")}>Aceptar</button><button type="button" className="text-button" disabled={busy || !integration?.is_enabled} onClick={() => void registerAction(document, "RCD")}>Reclamar</button></>}</div>{feedback && <p className={`sii-lookup-feedback ${feedback.tone}`}>{feedback.text}</p>}</>}</td></tr>; }) : <tr><td colSpan={4}>Aún no hay DTE preparados para decisión.</td></tr>}</tbody></table></div>
    </section>
  </>;
}
