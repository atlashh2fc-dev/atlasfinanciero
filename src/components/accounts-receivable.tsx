"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { InvoiceRecord } from "@/data/facturas-emitidas-2026";
import {
  isCreditNoteDocument,
  isPurchaseOrderDocument,
  recognizedNetAmount,
} from "@/lib/document-revenue";
import {
  DocumentNormalizer,
  type NormalizationTarget,
} from "@/components/document-normalizer";

type FollowupStatus = "open" | "committed" | "resolved";
type CollectionFollowup = {
  id: string;
  issued_document_id: string;
  status: FollowupStatus;
  responsible_name: string | null;
  next_action_on: string | null;
  promised_payment_date: string | null;
  note: string | null;
};

type IssuedDocumentPayment = {
  id: string;
  issued_document_id: string;
  amount: number | string;
  paid_on: string;
};

const money = new Intl.NumberFormat("es-CL", {
  style: "currency",
  currency: "CLP",
  maximumFractionDigits: 0,
});

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-CL", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}

function daysOverdue(dueDate: string | null, today: Date) {
  if (!dueDate) return null;
  return Math.floor(
    (today.getTime() - new Date(`${dueDate}T00:00:00`).getTime()) / 86400000,
  );
}

function agingBucket(days: number | null) {
  if (days === null) return "Sin vencimiento";
  if (days > 0) return "Vencido";
  const daysUntilDue = Math.abs(days);
  if (daysUntilDue <= 2) return "Vence en 2 días";
  if (daysUntilDue <= 7) return "Vence en 7 días";
  if (daysUntilDue <= 15) return "Vence en 15 días";
  if (daysUntilDue <= 30) return "Vence en 30 días";
  return "Más de 30 días";
}

function displayFollowupStatus(status: FollowupStatus) {
  return { open: "Abierta", committed: "Compromiso", resolved: "Resuelta" }[
    status
  ];
}

export function AccountsReceivable({
  records,
  organizationId,
  canManage,
  isPersisted,
  payments = [],
  onEditDocument,
  onDocumentNormalized,
}: {
  records: InvoiceRecord[];
  organizationId: string | null;
  canManage: boolean;
  isPersisted: boolean;
  payments?: IssuedDocumentPayment[];
  onEditDocument?: (record: InvoiceRecord) => void;
  onDocumentNormalized?: (recordId: string, invoiceNumber: string) => void;
}) {
  const [followups, setFollowups] = useState<CollectionFollowup[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<InvoiceRecord | null>(null);
  const [followupStatus, setFollowupStatus] = useState<FollowupStatus>("open");
  const [responsibleName, setResponsibleName] = useState("");
  const [nextActionOn, setNextActionOn] = useState("");
  const [promisedPaymentDate, setPromisedPaymentDate] = useState("");
  const [note, setNote] = useState("");
  const [normalizationTarget, setNormalizationTarget] =
    useState<NormalizationTarget | null>(null);
  const [year, setYear] = useState(String(new Date().getFullYear()));

  async function loadFollowups() {
    if (!organizationId) {
      setFollowups([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    const response = await fetch(
      `/api/collections/followups?organizationId=${encodeURIComponent(organizationId)}`,
      { cache: "no-store" },
    );
    const payload = response.ok
      ? ((await response.json()) as { followups: CollectionFollowup[] })
      : null;
    setFollowups(payload?.followups ?? []);
    if (!response.ok)
      setMessage("No fue posible cargar las gestiones de cobranza.");
    setIsLoading(false);
  }

  useEffect(() => {
    void loadFollowups();
  }, [organizationId]);

  const today = useMemo(() => new Date(), []);
  const availableYears = useMemo(
    () =>
      Array.from(
        new Set(
          records
            .map((record) => record.year)
            .filter((value): value is number => typeof value === "number"),
        ),
      ).sort((first, second) => second - first),
    [records],
  );
  const recordsForYear = useMemo(
    () =>
      year === "Todos"
        ? records
        : records.filter((record) => record.year === Number(year)),
    [records, year],
  );
  const paidAmountByDocument = useMemo(() => {
    const amounts = new Map<string, number>();
    payments.forEach((payment) =>
      amounts.set(
        payment.issued_document_id,
        (amounts.get(payment.issued_document_id) ?? 0) + Number(payment.amount),
      ),
    );
    return amounts;
  }, [payments]);
  const outstandingBalance = (record: InvoiceRecord) =>
    Math.max(
      0,
      Number(record.totalAmount ?? recognizedNetAmount(record)) -
        (paidAmountByDocument.get(record.id) ?? 0),
    );
  const receivables = useMemo(
    () =>
      recordsForYear.filter(
        (record) =>
          !isPurchaseOrderDocument(record) &&
          !isCreditNoteDocument(record) &&
          ["pendiente", "abonada"].includes(
            record.status?.trim().toLocaleLowerCase("es-CL") ?? "",
          ) &&
          outstandingBalance(record) > 0,
      ),
    [recordsForYear, paidAmountByDocument],
  );
  const totalPending = useMemo(
    () =>
      receivables.reduce(
        (total, record) => total + outstandingBalance(record),
        0,
      ),
    [receivables],
  );
  const overdue = useMemo(
    () =>
      receivables.filter(
        (record) => (daysOverdue(record.dueDate, today) ?? -1) > 0,
      ),
    [receivables, today],
  );
  const overdueAmount = useMemo(
    () =>
      overdue.reduce((total, record) => total + outstandingBalance(record), 0),
    [overdue],
  );
  const aging = useMemo(
    () =>
      [
        "Vencido",
        "Vence en 2 días",
        "Vence en 7 días",
        "Vence en 15 días",
        "Vence en 30 días",
        "Más de 30 días",
        "Sin vencimiento",
      ].map((bucket) => ({
        bucket,
        amount: receivables
          .filter(
            (record) =>
              agingBucket(daysOverdue(record.dueDate, today)) === bucket,
          )
          .reduce((total, record) => total + outstandingBalance(record), 0),
      })),
    [receivables, today],
  );
  const followupsByDocument = useMemo(
    () => new Map(followups.map((item) => [item.issued_document_id, item])),
    [followups],
  );
  const scheduledAmount = useMemo(
    () =>
      receivables
        .filter((record) => followupsByDocument.get(record.id)?.next_action_on)
        .reduce((total, record) => total + outstandingBalance(record), 0),
    [receivables, followupsByDocument],
  );
  const greenAlertAmount = aging
    .filter(
      (item) =>
        item.bucket === "Vence en 2 días" || item.bucket === "Vence en 7 días",
    )
    .reduce((total, item) => total + item.amount, 0);

  function openFollowup(record: InvoiceRecord) {
    const current = followupsByDocument.get(record.id);
    setSelected(record);
    setFollowupStatus(current?.status ?? "open");
    setResponsibleName(current?.responsible_name ?? "");
    setNextActionOn(current?.next_action_on ?? "");
    setPromisedPaymentDate(current?.promised_payment_date ?? "");
    setNote(current?.note ?? "");
  }

  async function saveFollowup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !organizationId) return;
    setIsSaving(true);
    const response = await fetch("/api/collections/followups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organizationId,
        issuedDocumentId: selected.id,
        status: followupStatus,
        responsibleName,
        nextActionOn,
        promisedPaymentDate,
        note,
      }),
    });
    setIsSaving(false);
    if (!response.ok)
      return setMessage(
        "No fue posible guardar la gestión. Revisa tus permisos y vuelve a intentarlo.",
      );
    setMessage("Gestión de cobranza guardada.");
    setSelected(null);
    await loadFollowups();
  }

  return (
    <main className="dashboard receivables-dashboard">
      <section className="headline">
        <div>
          <span className="eyebrow">
            CONTROL DE COBRANZA · {year === "Todos" ? "TODOS LOS AÑOS" : year}
          </span>
          <h1>Cuentas por cobrar</h1>
          <p>
            Prioriza documentos pendientes, vencidos y compromisos de pago.
            Editar pago actualiza estado, fechas y ciclo de factoring; la
            gestión conserva responsable y compromiso.
          </p>
        </div>
        <div className="headline-actions">
          <label className="period-picker">
            Año
            <select
              value={year}
              onChange={(event) => setYear(event.target.value)}
            >
              <option value="Todos">Todos los años</option>
              {availableYears.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void loadFollowups()}
            disabled={isLoading}
          >
            Actualizar
          </button>
        </div>
      </section>

      {message && <p className="operation-message">{message}</p>}
      {!isPersisted && (
        <p className="operation-message">
          La vista está en modo de respaldo local: la gestión se habilita cuando
          los documentos estén disponibles desde Atlas.
        </p>
      )}

      <section className="kpis kpis-five" aria-label="Indicadores de cobranza">
        <article className="kpi-card">
          <span>Cuentas por cobrar</span>
          <strong>{money.format(totalPending)}</strong>
            <small>{receivables.length} documento(s) con saldo pendiente</small>
        </article>
        <article className="kpi-card accent">
          <span>Vencido</span>
          <strong>{money.format(overdueAmount)}</strong>
          <small>{overdue.length} documento(s) con vencimiento superado</small>
        </article>
        <article className="kpi-card">
          <span>Gestión programada</span>
          <strong>{money.format(scheduledAmount)}</strong>
          <small>Documentos con próxima acción definida</small>
        </article>
        <article className="kpi-card">
          <span>Compromisos de pago</span>
          <strong>
            {
              receivables.filter(
                (record) =>
                  followupsByDocument.get(record.id)?.status === "committed",
              ).length
            }
          </strong>
          <small>Seguimientos con promesa registrada</small>
        </article>
        <article className="kpi-card">
          <span>Alerta verde ≤ 7 días</span>
          <strong>{money.format(greenAlertAmount)}</strong>
          <small>Vence en 7 o 2 días: programar caja</small>
        </article>
      </section>

      <section className="executive-grid">
        <article className="panel executive-chart">
          <div className="panel-heading">
            <div>
              <span className="panel-label">CALENDARIO DE COBRANZA</span>
              <h2>Vencimientos para flujo de caja</h2>
            </div>
            <span className="unit">CLP neto/exento</span>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={aging}
                margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
              >
                <XAxis
                  dataKey="bucket"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "#7e8ba0", fontSize: 10 }}
                />
                <YAxis hide />
                <Tooltip
                  formatter={(value) => money.format(Number(value))}
                  contentStyle={{
                    borderRadius: 12,
                    border: "1px solid #e6e9ef",
                  }}
                />
                <Bar dataKey="amount" name="Saldo pendiente" radius={[5, 5, 0, 0]}>
                  {aging.map((item) => (
                    <Cell
                      key={item.bucket}
                      fill={
                        item.bucket === "Vencido"
                          ? "#d85f6c"
                          : item.bucket === "Vence en 7 días" ||
                              item.bucket === "Vence en 2 días"
                            ? "#20a67a"
                            : "#9eabc7"
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </article>
        <article className="panel receivables-priority">
          <div className="panel-heading">
            <div>
              <span className="panel-label">PRIORIDAD</span>
              <h2>Acción recomendada</h2>
            </div>
          </div>
          <strong>
            {overdue.length
              ? `${overdue.length} documento(s) vencido(s)`
              : "Sin vencimientos pendientes"}
          </strong>
          <p>
            {overdue.length
              ? `Concentran ${money.format(overdueAmount)} y deben tener responsable o próximo contacto.`
              : "Mantén una próxima acción para los documentos pendientes antes de su vencimiento."}
          </p>
          <small>
            Los compromisos sólo se muestran cuando han sido registrados por un
            usuario autorizado.
          </small>
        </article>
      </section>

      <section
        className="analysis-strip"
        aria-label="Tramos de vencimiento para caja"
      >
        {(
          [
            "Vence en 30 días",
            "Vence en 15 días",
            "Vence en 7 días",
            "Vence en 2 días",
          ] as const
        ).map((bucket) => {
          const amount =
            aging.find((item) => item.bucket === bucket)?.amount ?? 0;
          const green =
            bucket === "Vence en 7 días" || bucket === "Vence en 2 días";
          return (
            <article key={bucket}>
              <span>{green ? "ALERTA VERDE" : "PLANIFICACIÓN"}</span>
              <strong>{bucket}</strong>
              <p>{money.format(amount)} de saldo pendiente.</p>
            </article>
          );
        })}
      </section>

      <section className="table-section">
        <div className="table-heading">
          <div>
            <span className="panel-label">CARTERA OPERATIVA</span>
            <h2>Documentos pendientes</h2>
            <p>
              {isLoading
                ? "Cargando gestión…"
                : `${receivables.length} documento(s) priorizados por vencimiento.`}
            </p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="receivables-table">
            <thead>
              <tr>
                <th>Documento / cliente</th>
                <th>Vence</th>
                <th className="money-col">Factura</th>
                <th className="money-col">Abonado</th>
                <th className="money-col">Saldo</th>
                <th>Antigüedad</th>
                <th>Gestión</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              {receivables.map((record) => {
                const days = daysOverdue(record.dueDate, today);
                const followup = followupsByDocument.get(record.id);
                const bucket = agingBucket(days);
                const greenAlert =
                  bucket === "Vence en 7 días" || bucket === "Vence en 2 días";
                return (
                  <tr key={record.id}>
                    <td>
                      <strong>
                        N° {record.invoiceNumber ?? "—"} ·{" "}
                        {record.client ?? "Cliente no informado"}
                      </strong>
                      <small>
                        {record.recipient ??
                          record.documentType ??
                          "Documento emitido"}
                      </small>
                    </td>
                    <td>{formatDate(record.dueDate)}</td>
                    <td className="money-col">
                      {money.format(Number(record.totalAmount ?? recognizedNetAmount(record)))}
                    </td>
                    <td className="money-col">
                      {money.format(paidAmountByDocument.get(record.id) ?? 0)}
                    </td>
                    <td className="money-col">
                      <strong>{money.format(outstandingBalance(record))}</strong>
                    </td>
                    <td>
                      <span
                        className={
                          days !== null && days > 0
                            ? "status cancelled"
                            : greenAlert
                              ? "status paid"
                              : "status neutral"
                        }
                      >
                        {days === null
                          ? "Sin fecha"
                          : days > 0
                            ? `${days} día(s) vencido`
                            : bucket}
                      </span>
                    </td>
                    <td>
                      {followup ? (
                        <>
                          <strong>
                            {displayFollowupStatus(followup.status)}
                          </strong>
                          <small>
                            {followup.next_action_on
                              ? `Próxima acción ${formatDate(followup.next_action_on)}`
                              : followup.note || "Sin próxima fecha"}
                          </small>
                        </>
                      ) : (
                        <span className="origin">Sin gestión registrada</span>
                      )}
                    </td>
                    <td>
                      {canManage && isPersisted ? (
                        <div className="cycle-actions">
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => openFollowup(record)}
                          >
                            Gestionar
                          </button>
                          {onEditDocument && (
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={() => onEditDocument(record)}
                            >
                              Editar pago
                            </button>
                          )}
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() =>
                              setNormalizationTarget({
                                id: record.id,
                                kind: "issued",
                                title: `${record.client ?? "Cliente no informado"} · ${record.documentType ?? "Documento emitido"}`,
                                invoiceNumber: record.invoiceNumber,
                              })
                            }
                          >
                            {record.invoiceNumber
                              ? "Adjuntar factura"
                              : "Ingresar factura"}
                          </button>
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!receivables.length && (
          <p className="billing-empty">
            No hay documentos con saldo pendiente en los datos disponibles.
          </p>
        )}
      </section>

      {selected && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="entry-modal collection-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="collection-title"
          >
            <div className="modal-header">
              <div>
                <span className="eyebrow">GESTIÓN DE COBRANZA</span>
                <h2 id="collection-title">
                  Factura N° {selected.invoiceNumber ?? "—"}
                </h2>
                <p>
                  {selected.client ?? "Cliente no informado"} ·{" "}
                  {money.format(selected.netAmount ?? 0)}
                </p>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={() => setSelected(null)}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <form onSubmit={saveFollowup}>
              <div className="form-grid">
                <label>
                  Estado
                  <select
                    value={followupStatus}
                    onChange={(event) =>
                      setFollowupStatus(event.target.value as FollowupStatus)
                    }
                  >
                    <option value="open">Abierta</option>
                    <option value="committed">Compromiso de pago</option>
                    <option value="resolved">Resuelta</option>
                  </select>
                </label>
                <label>
                  Responsable
                  <input
                    value={responsibleName}
                    maxLength={180}
                    onChange={(event) => setResponsibleName(event.target.value)}
                    placeholder="Nombre responsable"
                  />
                </label>
                <label>
                  Próxima acción
                  <input
                    type="date"
                    value={nextActionOn}
                    onChange={(event) => setNextActionOn(event.target.value)}
                  />
                </label>
                <label>
                  Fecha compromiso de pago
                  <input
                    type="date"
                    value={promisedPaymentDate}
                    onChange={(event) =>
                      setPromisedPaymentDate(event.target.value)
                    }
                  />
                </label>
                <label className="collection-note">
                  Nota de gestión
                  <textarea
                    value={note}
                    maxLength={2000}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Contacto, acuerdo o próximo paso"
                  />
                </label>
              </div>
              <div className="form-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setSelected(null)}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={isSaving}
                >
                  {isSaving ? "Guardando…" : "Guardar gestión"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      <DocumentNormalizer
        organizationId={organizationId}
        target={normalizationTarget}
        onClose={() => setNormalizationTarget(null)}
        onSaved={(invoiceNumber) => {
          if (normalizationTarget)
            onDocumentNormalized?.(normalizationTarget.id, invoiceNumber);
          setMessage("Factura adjuntada y folio normalizado correctamente.");
        }}
      />
    </main>
  );
}
