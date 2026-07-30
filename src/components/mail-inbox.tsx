"use client";

import { useEffect, useMemo, useState } from "react";

type InboxStatus = "imported" | "ignored" | "failed" | "review_required" | "matched";
type InboxItem = {
  id: string;
  kind: "invoice" | "payment";
  messageId: string;
  subject: string | null;
  senderName: string | null;
  senderAddress: string | null;
  receivedAt: string | null;
  processedAt: string;
  status: InboxStatus;
  detail: string | null;
  attachmentCount: number;
  documentId: string | null;
  documentLabel: string | null;
  documentStatus: string | null;
};

type Filter = "all" | "invoice" | "payment" | "review" | "failed";

const dateTime = new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short" });

function statusLabel(status: InboxStatus) {
  return ({
    imported: "Procesado",
    ignored: "Sin acción",
    failed: "Requiere revisión",
    review_required: "Por conciliar",
    matched: "Conciliado",
  } as Record<InboxStatus, string>)[status];
}

function statusTone(status: InboxStatus) {
  if (status === "imported" || status === "matched") return "paid";
  if (status === "failed") return "cancelled";
  return "pending";
}

function formatDate(value: string | null, fallback: string) {
  return dateTime.format(new Date(value ?? fallback));
}

export function MailInbox({ organizationId, canSynchronize }: { organizationId: string | null; canSynchronize: boolean }) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [synchronizing, setSynchronizing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    if (!organizationId) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`/api/mail-inbox?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" });
      const payload = await response.json().catch(() => null) as { items?: InboxItem[] } | null;
      if (!response.ok || !payload) throw new Error("mail_inbox_load_failed");
      setItems(payload.items ?? []);
      setMessage(null);
    } catch {
      setMessage("No fue posible cargar la bandeja. Confirma que la migración de Bandeja mail esté aplicada.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [organizationId]);

  async function syncNow() {
    if (!organizationId) return;
    setSynchronizing(true);
    setMessage("Revisando los correos nuevos del buzón…");
    try {
      const response = await fetch("/api/integrations/sii/mail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
      const payload = await response.json().catch(() => null) as { scanned?: number; created?: number; updated?: number; error?: string; paymentProofs?: { scanned?: number; matched?: number; reviewRequired?: number } } | null;
      if (!response.ok) throw new Error(payload?.error || "mail_sync_failed");
      await load();
      setMessage(`Revisión terminada: ${payload?.scanned ?? 0} correo(s) tributario(s) revisado(s), ${payload?.created ?? 0} factura(s) creada(s), ${payload?.updated ?? 0} actualizada(s) y ${payload?.paymentProofs?.matched ?? 0} comprobante(s) conciliado(s).${(payload?.paymentProofs?.reviewRequired ?? 0) > 0 ? ` Quedaron ${payload?.paymentProofs?.reviewRequired} comprobante(s) por conciliar.` : ""}`);
    } catch {
      setMessage("No fue posible revisar el buzón. Revisa la conexión del correo tributario e inténtalo nuevamente.");
    } finally {
      setSynchronizing(false);
    }
  }

  const summary = useMemo(() => ({
    invoices: items.filter((item) => item.kind === "invoice" && item.status === "imported").length,
    paymentReview: items.filter((item) => item.status === "review_required").length,
    problems: items.filter((item) => item.status === "failed").length,
  }), [items]);
  const visibleItems = useMemo(() => items.filter((item) => {
    if (filter === "invoice") return item.kind === "invoice";
    if (filter === "payment") return item.kind === "payment";
    if (filter === "review") return item.status === "review_required";
    if (filter === "failed") return item.status === "failed";
    return true;
  }), [filter, items]);

  return <main className="dashboard mail-inbox">
    <section className="headline">
      <div>
        <span className="eyebrow">OPERACIÓN · CORREO DE FACTURACIÓN</span>
        <h1>Bandeja mail</h1>
        <p>Seguimiento de facturas y comprobantes que llegaron al buzón. Se conserva la trazabilidad de gestión, no el cuerpo privado de los correos.</p>
      </div>
      <div className="headline-actions">
        {canSynchronize ? <button type="button" className="primary-button" disabled={synchronizing} onClick={() => void syncNow()}>{synchronizing ? "Revisando…" : "Revisar correos nuevos"}</button> : <span className="permission-note">Sólo Administrador puede sincronizar el buzón</span>}
      </div>
    </section>

    <section className="kpis kpis-three" aria-label="Resumen de la bandeja">
      <article className="kpi-card"><span>Facturas procesadas</span><strong>{summary.invoices}</strong><small>desde los correos registrados</small></article>
      <article className="kpi-card"><span>Comprobantes por conciliar</span><strong>{summary.paymentReview}</strong><small>requieren confirmación antes de asociarlos</small></article>
      <article className="kpi-card"><span>Alertas de lectura</span><strong>{summary.problems}</strong><small>correos que no se pudieron procesar</small></article>
    </section>

    <section className="table-section">
      <div className="table-heading mail-inbox-heading"><div><span className="panel-label">TRAZABILIDAD DEL BUZÓN</span><h2>Correos procesados</h2><p>Cada fila indica qué encontró Atlas y a qué documento quedó vinculado.</p></div><button type="button" className="secondary-button" onClick={() => void load()} disabled={loading}>Actualizar vista</button></div>
      {message && <p className="operation-message">{message}</p>}
      <div className="mail-inbox-filters" aria-label="Filtrar correos">
        {([ ["all", "Todos"], ["invoice", "Facturas"], ["payment", "Comprobantes"], ["review", "Por conciliar"], ["failed", "Con alerta"] ] as Array<[Filter, string]>).map(([value, label]) => <button key={value} type="button" className={`filter-chip ${filter === value ? "active" : ""}`} onClick={() => setFilter(value)}>{label}</button>)}
      </div>
      {loading ? <p className="billing-empty">Cargando correos procesados…</p> : <div className="table-scroll"><table className="mail-inbox-table"><thead><tr><th>Correo</th><th>Tipo</th><th>Adjuntos</th><th>Resultado</th><th>Vinculación</th></tr></thead><tbody>{visibleItems.length ? visibleItems.map((item) => <tr key={item.id}><td><strong>{item.subject || (item.kind === "invoice" ? "Correo tributario procesado" : "Comprobante de pago procesado")}</strong><small>{item.senderName || item.senderAddress || "Remitente no disponible"} · {formatDate(item.receivedAt, item.processedAt)}</small></td><td><span className="mail-kind">{item.kind === "invoice" ? "Factura / DTE" : "Comprobante"}</span></td><td>{item.attachmentCount > 0 ? `${item.attachmentCount} archivo(s)` : "Sin adjuntos"}</td><td><span className={`status ${statusTone(item.status)}`}>{statusLabel(item.status)}</span>{item.detail && <small>{item.detail}</small>}</td><td>{item.documentLabel ? <><strong>{item.documentLabel}</strong><small>{item.documentStatus || "Documento vinculado"}</small></> : <small>{item.status === "review_required" ? "Revisar y asociar desde Cuentas por pagar." : "Sin documento asociado"}</small>}</td></tr>) : <tr><td colSpan={5}>No hay correos para este filtro todavía.</td></tr>}</tbody></table></div>}
    </section>
  </main>;
}
