"use client";

import { useMemo, useState } from "react";
import {
  documentStatusLabel,
  linkCandidates,
  type ReceivedDocumentLike,
} from "@/lib/pending-documents";

export type PendingDocumentPayable = {
  id: string;
  payable_number: string;
  supplier_counterparty_id: string | null;
  supplier_name: string;
  invoice_number: string | null;
  issue_date: string;
  due_date?: string | null;
  total_amount: number | string;
  status: string;
  document_status?: string | null;
  expected_document_type?: string | null;
  received_document_id?: string | null;
  linked_document?: {
    id: string;
    document_number: string | null;
    document_type?: string | null;
    issue_date: string;
    total_amount: number | string;
  } | null;
};

export type PendingDocumentSuggestion = {
  direct_payable_id: string;
  payable_number: string;
  received_document_id: string;
  document_number: string | null;
  document_type: string | null;
  supplier_name: string | null;
  issue_date: string;
  total_amount: number | string;
  amount_difference: number | string;
  days_from_payable: number;
  match: "same_folio" | "same_amount";
};

const money = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const dates = new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" });
const displayDate = (value: string | null | undefined) =>
  value ? dates.format(new Date(`${value.slice(0, 10)}T00:00:00`)) : "Sin fecha";

const linkErrorMessages: Record<string, string> = {
  document_amount_mismatch:
    "El monto del documento difiere en más de $1. Revisa la diferencia y marca \"Autorizar diferencia de monto\" si corresponde.",
  document_supplier_mismatch: "El documento pertenece a otro proveedor.",
  document_folio_mismatch: "El folio registrado en la cuenta no coincide con el del documento.",
  document_already_linked: "El documento o la cuenta ya tienen un vínculo vigente. Actualizamos la lista.",
  document_already_in_payment:
    "El documento ya tiene pagos o está en una propuesta activa: no puede respaldar esta cuenta sin pagarse dos veces.",
  document_type_not_allowed: "Sólo facturas, boletas u otros documentos de cargo pueden respaldar un gasto.",
};

export function PendingDocumentBadge({ status }: { status?: string | null }) {
  if (status !== "pending_document" && status !== "documented") return null;
  return (
    <span className={`pending-document-badge ${status === "documented" ? "is-documented" : ""}`}>
      {status === "documented" ? "Documentada" : "Documento pendiente"}
    </span>
  );
}

/** Cola de gastos pagados o comprometidos que aún esperan su documento. */
export function PendingDocumentsQueue({
  payables,
  suggestions,
  onOpen,
}: {
  payables: PendingDocumentPayable[];
  suggestions: PendingDocumentSuggestion[];
  onOpen: (payable: PendingDocumentPayable) => void;
}) {
  const pending = payables.filter(
    (payable) =>
      payable.document_status === "pending_document" &&
      !["cancelled", "rejected"].includes(payable.status),
  );
  if (!pending.length) return null;
  const suggestionCount = new Map<string, number>();
  for (const suggestion of suggestions)
    suggestionCount.set(suggestion.direct_payable_id, (suggestionCount.get(suggestion.direct_payable_id) ?? 0) + 1);
  return (
    <section className="pending-document-link" aria-label="Gastos con documento pendiente">
      <div>
        <strong>Gastos con documento pendiente ({pending.length})</strong>
        <small> · Vincula cada uno a su factura o boleta cuando llegue para no contarla dos veces.</small>
      </div>
      <ul>
        {pending.map((payable) => {
          const count = suggestionCount.get(payable.id) ?? 0;
          return (
            <li key={payable.id}>
              <span>
                <strong>{payable.supplier_name}</strong>
                <small>
                  {payable.payable_number} · {displayDate(payable.issue_date)} · {money.format(Number(payable.total_amount ?? 0))}
                  {payable.expected_document_type ? ` · espera ${payable.expected_document_type.toLowerCase()}` : ""}
                </small>
              </span>
              <button type="button" className="secondary-button" onClick={() => onOpen(payable)}>
                {count ? `Vincular documento (${count} sugerido${count === 1 ? "" : "s"})` : "Vincular documento"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Estado documental y vinculación de una cuenta directa (expediente). */
export function PendingDocumentLinkPanel({
  organizationId,
  payable,
  documents,
  suggestions,
  supplierTaxId,
  canLink,
  onChanged,
}: {
  organizationId: string;
  payable: PendingDocumentPayable;
  documents: ReceivedDocumentLike[];
  suggestions: PendingDocumentSuggestion[];
  supplierTaxId?: string | null;
  canLink: boolean;
  onChanged: (message: string) => Promise<void> | void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualDocumentId, setManualDocumentId] = useState("");
  const [allowDifference, setAllowDifference] = useState(false);
  const [unlinkReason, setUnlinkReason] = useState<string | null>(null);
  const documentStatus = payable.document_status ?? "not_required";
  const ownSuggestions = suggestions.filter((suggestion) => suggestion.direct_payable_id === payable.id);
  const manualCandidates = useMemo(
    () =>
      linkCandidates(
        { ...payable, supplier_tax_id: supplierTaxId ?? null },
        documents,
      ),
    [payable, documents, supplierTaxId],
  );
  const selectedManual = manualCandidates.find((candidate) => candidate.document.id === manualDocumentId) ?? null;

  async function send(body: Record<string, unknown>, success: string) {
    setSaving(true);
    setError(null);
    const response = await fetch("/api/procure-to-pay", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId, id: payable.id, ...body }),
    });
    const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    setSaving(false);
    if (!response.ok) {
      setError(
        payload?.message ??
          linkErrorMessages[payload?.error ?? ""] ??
          "No fue posible actualizar el documento de la cuenta. Verifica tus permisos y vuelve a intentar.",
      );
      return;
    }
    setManualDocumentId("");
    setAllowDifference(false);
    setUnlinkReason(null);
    await onChanged(success);
  }

  const link = (receivedDocumentId: string, allowAmountDifference = false) =>
    send(
      { action: "link_direct_payable_document", receivedDocumentId, allowAmountDifference },
      "Documento vinculado. La cuenta quedó documentada y la factura no se contará ni pagará dos veces.",
    );

  if (documentStatus === "not_required" && !canLink) return null;

  return (
    <div className="pending-document-link">
      <div>
        <strong>Documento tributario</strong> <PendingDocumentBadge status={documentStatus} />
        <small>
          {" "}
          {documentStatus === "documented"
            ? "Respaldada por el documento vinculado."
            : documentStatus === "pending_document"
              ? `Se pagó o comprometió antes de recibir ${payable.expected_document_type ? payable.expected_document_type.toLowerCase() : "el documento"}.`
              : documentStatusLabel(documentStatus)}
        </small>
      </div>

      {documentStatus === "documented" && (
        <>
          <p>
            {payable.linked_document
              ? `${payable.linked_document.document_type ?? "Documento"} N° ${payable.linked_document.document_number ?? "sin folio"} · ${displayDate(payable.linked_document.issue_date)} · ${money.format(Number(payable.linked_document.total_amount ?? 0))}`
              : `Folio ${payable.invoice_number ?? "sin folio"}`}
          </p>
          {canLink &&
            (unlinkReason === null ? (
              <button type="button" className="text-button" disabled={saving} onClick={() => setUnlinkReason("")}>
                Desvincular (documento equivocado)
              </button>
            ) : (
              <div className="p2p-inline-action">
                <input
                  autoFocus
                  value={unlinkReason}
                  maxLength={500}
                  onChange={(event) => setUnlinkReason(event.target.value)}
                  placeholder="Motivo: p. ej. se vinculó la factura de otro mes"
                />
                <button
                  type="button"
                  className="secondary-button"
                  disabled={saving || unlinkReason.trim().length < 3}
                  onClick={() => void send({ action: "unlink_direct_payable_document", reason: unlinkReason.trim() }, "Documento desvinculado. La cuenta volvió a quedar con documento pendiente.")}
                >
                  Confirmar
                </button>
              </div>
            ))}
        </>
      )}

      {documentStatus !== "documented" && canLink && (
        <>
          {ownSuggestions.length > 0 && (
            <>
              <small>Sugeridos (mismo proveedor{ownSuggestions.some((item) => item.match === "same_folio") ? ", mismo folio" : ""} y monto):</small>
              <ul>
                {ownSuggestions.map((suggestion) => {
                  const difference = Number(suggestion.amount_difference ?? 0);
                  return (
                    <li key={suggestion.received_document_id}>
                      <span>
                        <strong>
                          {suggestion.document_type ?? "Documento"} N° {suggestion.document_number ?? "sin folio"}
                        </strong>
                        <small>
                          {displayDate(suggestion.issue_date)} · {money.format(Number(suggestion.total_amount ?? 0))}
                          {suggestion.match === "same_folio" ? " · mismo folio" : ""}
                          {Math.abs(difference) > 1 ? ` · diferencia ${money.format(difference)}` : ""}
                        </small>
                      </span>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={saving}
                        onClick={() => void link(suggestion.received_document_id, Math.abs(difference) > 1 && allowDifference)}
                      >
                        Vincular
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          <label>
            Otro documento del proveedor
            <select value={manualDocumentId} onChange={(event) => setManualDocumentId(event.target.value)}>
              <option value="">
                {manualCandidates.length ? "Selecciona una factura o boleta sin pagar" : "No hay documentos disponibles de este proveedor"}
              </option>
              {manualCandidates.map((candidate) => (
                <option key={candidate.document.id} value={candidate.document.id}>
                  {candidate.document.document_number ?? "Sin folio"} · {displayDate(candidate.document.issue_date)} ·{" "}
                  {money.format(Number(candidate.document.total_amount ?? 0))}
                  {candidate.withinTolerance ? "" : ` (dif. ${money.format(candidate.amountDifference)})`}
                </option>
              ))}
            </select>
          </label>
          {(selectedManual && !selectedManual.withinTolerance) || ownSuggestions.some((item) => Math.abs(Number(item.amount_difference ?? 0)) > 1) ? (
            <label className="p2p-inline-check">
              <input type="checkbox" checked={allowDifference} onChange={(event) => setAllowDifference(event.target.checked)} />
              Autorizar diferencia de monto (queda registrada en la bitácora)
            </label>
          ) : null}
          <button
            type="button"
            className="secondary-button"
            disabled={saving || !selectedManual || (!selectedManual.withinTolerance && !allowDifference)}
            onClick={() => selectedManual && void link(selectedManual.document.id, !selectedManual.withinTolerance && allowDifference)}
          >
            {saving ? "Vinculando…" : "Vincular documento seleccionado"}
          </button>
        </>
      )}
      {error && <p className="operation-message" role="alert">{error}</p>}
    </div>
  );
}
