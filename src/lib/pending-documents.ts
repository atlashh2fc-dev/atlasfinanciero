/**
 * Gastos con documento pendiente: reglas puras compartidas por las API y la
 * interfaz. Replican los normalizadores SQL de
 * supabase/migrations/20260928180416_add_received_document_links.sql y
 * 20260928183206_pending_document_expenses.sql para que las sugerencias en
 * pantalla coincidan con lo que la base valida al vincular.
 */

export const expectedDocumentTypes = [
  "Factura afecta",
  "Factura exenta",
  "Boleta de honorarios",
  "Boleta",
  "Otro",
] as const;
export type ExpectedDocumentType = (typeof expectedDocumentTypes)[number];

export const pendingExpenseCategories = [
  "utilities",
  "rent",
  "taxes",
  "insurance",
  "subscriptions",
  "other",
] as const;
export type PendingExpenseCategory = (typeof pendingExpenseCategories)[number];

export type DocumentStatus = "not_required" | "pending_document" | "documented";

/** Tolerancia de monto para vincular sin autorización explícita (CLP). */
export const AMOUNT_TOLERANCE = 1;
/** Ventana de emisión respecto de la fecha del gasto: -30 a +60 días. */
export const ISSUE_WINDOW = { before: 30, after: 60 } as const;

export function isExpectedDocumentType(value: unknown): value is ExpectedDocumentType {
  return typeof value === "string" && (expectedDocumentTypes as readonly string[]).includes(value);
}

export function isPendingExpenseCategory(value: unknown): value is PendingExpenseCategory {
  return typeof value === "string" && (pendingExpenseCategories as readonly string[]).includes(value);
}

/** RUT sin puntos, guion ni ceros a la izquierda (igual que la base). */
export function normalizeTaxId(value: string | null | undefined) {
  const compact = (value ?? "").trim().toUpperCase().replace(/[^0-9K]/g, "").replace(/^0+/, "");
  return compact || null;
}

/** Clave de proveedor: RUT, luego contraparte y por último razón social. */
export function supplierKey(supplier: {
  taxId?: string | null;
  counterpartyId?: string | null;
  name?: string | null;
}) {
  return (
    normalizeTaxId(supplier.taxId) ??
    (supplier.counterpartyId || null) ??
    ((supplier.name ?? "").trim().toUpperCase().replace(/\s+/g, " ") || null)
  );
}

export function sameSupplier(
  left: { taxId?: string | null; counterpartyId?: string | null; name?: string | null },
  right: { taxId?: string | null; counterpartyId?: string | null; name?: string | null },
) {
  if (left.counterpartyId && right.counterpartyId && left.counterpartyId === right.counterpartyId)
    return true;
  const leftKey = supplierKey(left);
  return Boolean(leftKey) && leftKey === supplierKey(right);
}

/** Folio numérico sin ceros a la izquierda; alfanumérico en minúsculas. */
export function normalizeFolio(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  const raw = String(value);
  if (!raw.trim()) return null;
  const compact = raw.replace(/[\s.]/g, "");
  if (/^[0-9]+$/.test(compact)) return compact.replace(/^0+/, "") || "0";
  return raw.trim().toLowerCase();
}

export type DocumentKind = "credit_note" | "debit_note" | "dispatch_guide" | "invoice" | "other";

export function documentKind(documentType: string | null | undefined, siiType?: number | null): DocumentKind {
  if (siiType === 61) return "credit_note";
  if (siiType === 56) return "debit_note";
  if (siiType === 52) return "dispatch_guide";
  if (siiType !== null && siiType !== undefined && [33, 34, 30, 32, 43, 45, 46].includes(siiType))
    return "invoice";
  const text = (documentType ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (/nota\s+(de\s+)?credito/.test(text)) return "credit_note";
  if (/nota\s+(de\s+)?debito/.test(text)) return "debit_note";
  if (/guia/.test(text)) return "dispatch_guide";
  if (/factura|liquidacion/.test(text)) return "invoice";
  return "other";
}

/** Sólo facturas y documentos de cargo equivalentes (boletas, otros) respaldan un gasto. */
export function canBackExpense(documentType: string | null | undefined, siiType?: number | null) {
  const kind = documentKind(documentType, siiType);
  return kind === "invoice" || kind === "other";
}

export function isSettledPaymentStatus(status: string | null | undefined) {
  const normalized = (status ?? "").toLowerCase();
  return normalized.includes("pagada") || normalized.includes("abonada");
}

function daysBetween(from: string, to: string) {
  const start = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / 86_400_000);
}

export type PendingPayableLike = {
  id: string;
  supplier_counterparty_id: string | null;
  supplier_name: string;
  supplier_tax_id?: string | null;
  invoice_number?: string | null;
  issue_date: string;
  total_amount: number | string;
  expected_document_type?: string | null;
};

export type ReceivedDocumentLike = {
  id: string;
  supplier_counterparty_id: string | null;
  supplier_name: string;
  supplier_tax_id?: string | null;
  document_number: string | null;
  sii_folio?: number | string | null;
  document_type?: string | null;
  sii_document_type?: number | null;
  issue_date: string;
  total_amount: number | string;
  payment_status: string | null;
  /** Cuenta directa vigente que ya cubre este documento. */
  covered_by_direct_payable_id?: string | null;
  active_payment_batch?: unknown;
  paid_amount?: number | string | null;
};

export type LinkCandidate<T extends ReceivedDocumentLike = ReceivedDocumentLike> = {
  document: T;
  match: "same_folio" | "same_amount" | "same_supplier";
  amountDifference: number;
  dayDifference: number | null;
  withinTolerance: boolean;
  withinWindow: boolean;
  score: number;
};

/**
 * Documentos del mismo proveedor que pueden respaldar la cuenta (selector
 * manual y sugerencias). Excluye notas de crédito/guías, documentos ya
 * pagados, cubiertos por otra cuenta o reservados en una propuesta activa.
 * Ordena por folio exacto, luego diferencia de monto y cercanía de fecha.
 */
export function linkCandidates<T extends ReceivedDocumentLike>(
  payable: PendingPayableLike,
  documents: T[],
  options: { onlySuggested?: boolean } = {},
): LinkCandidate<T>[] {
  const payableSupplier = {
    taxId: payable.supplier_tax_id,
    counterpartyId: payable.supplier_counterparty_id,
    name: payable.supplier_name,
  };
  const payableTotal = Number(payable.total_amount ?? 0);
  const payableFolio = normalizeFolio(payable.invoice_number);
  const candidates: LinkCandidate<T>[] = [];
  for (const document of documents) {
    if (!canBackExpense(document.document_type, document.sii_document_type ?? null)) continue;
    if (Number(document.total_amount ?? 0) <= 0) continue;
    if (isSettledPaymentStatus(document.payment_status)) continue;
    if (Number(document.paid_amount ?? 0) > 0) continue;
    if (document.covered_by_direct_payable_id || document.active_payment_batch) continue;
    if (
      !sameSupplier(payableSupplier, {
        taxId: document.supplier_tax_id,
        counterpartyId: document.supplier_counterparty_id,
        name: document.supplier_name,
      })
    )
      continue;
    const amountDifference = Math.round((Number(document.total_amount ?? 0) - payableTotal) * 100) / 100;
    const dayDifference = daysBetween(payable.issue_date, document.issue_date);
    const withinTolerance = Math.abs(amountDifference) <= AMOUNT_TOLERANCE;
    const withinWindow =
      dayDifference !== null && dayDifference >= -ISSUE_WINDOW.before && dayDifference <= ISSUE_WINDOW.after;
    const sameFolio =
      payableFolio !== null &&
      payableFolio === normalizeFolio(document.sii_folio ?? document.document_number);
    const match = sameFolio ? "same_folio" : withinTolerance && withinWindow ? "same_amount" : "same_supplier";
    if (options.onlySuggested && match === "same_supplier") continue;
    const expectedKindMatches =
      !payable.expected_document_type ||
      documentKind(payable.expected_document_type) === documentKind(document.document_type, document.sii_document_type ?? null);
    const score =
      (sameFolio ? 1_000 : 0) +
      (withinTolerance ? 500 : Math.max(0, 300 - Math.abs(amountDifference) / Math.max(payableTotal, 1) * 300)) +
      (withinWindow ? 100 : 0) +
      (expectedKindMatches ? 25 : 0) -
      Math.min(90, Math.abs(dayDifference ?? 90));
    candidates.push({ document, match, amountDifference, dayDifference, withinTolerance, withinWindow, score });
  }
  return candidates.sort((left, right) => right.score - left.score);
}

/**
 * Qué documentos quedan cubiertos por una cuenta directa vigente. Un documento
 * cubierto no es una segunda deuda ni un segundo gasto: se representa por la
 * cuenta directa que lo pagó o lo pagará.
 */
export function coveredDocumentMap(
  payables: Array<{ id: string; payable_number: string; status: string; received_document_id?: string | null }>,
) {
  const covered = new Map<string, { id: string; payable_number: string; status: string }>();
  for (const payable of payables) {
    if (!payable.received_document_id || ["cancelled", "rejected"].includes(payable.status)) continue;
    covered.set(payable.received_document_id, {
      id: payable.id,
      payable_number: payable.payable_number,
      status: payable.status,
    });
  }
  return covered;
}

export type DuplicateMatch = {
  source: "received" | "direct";
  id: string;
  number: string | null;
  document_type: string | null;
  supplier_name: string | null;
  total_amount: number | string | null;
  issue_date: string | null;
  status: string | null;
  match: "same_folio" | "same_amount";
};

export type DuplicateFolioDetail = {
  source: "received" | "direct";
  id: string;
  number: string | null;
  label: string | null;
};

/** Lee el detalle JSON del error 'duplicate_payable_folio' que lanza la base. */
export function parseDuplicateFolioError(
  error: { message?: string | null; details?: string | null } | null | undefined,
): DuplicateFolioDetail | null {
  if (!error?.message?.includes("duplicate_payable_folio")) return null;
  try {
    const parsed = JSON.parse(error.details ?? "") as Partial<DuplicateFolioDetail>;
    if (parsed.source !== "received" && parsed.source !== "direct") return null;
    return {
      source: parsed.source,
      id: String(parsed.id ?? ""),
      number: parsed.number ?? null,
      label: parsed.label ?? null,
    };
  } catch {
    return { source: "direct", id: "", number: null, label: null };
  }
}

export function duplicateFolioMessage(detail: DuplicateFolioDetail | null) {
  const number = detail?.number ? `N° ${detail.number} ` : "";
  if (detail?.source === "received")
    return `Ya existe la factura ${number}de este proveedor registrada como documento recibido${detail.label ? ` (${detail.label})` : ""}. Vincúlala en lugar de registrarla otra vez.`;
  return `Ya existe la factura ${number}de este proveedor registrada como cuenta por pagar directa${detail?.label ? ` ${detail.label}` : ""}. No se creó un duplicado.`;
}

export function duplicateMatchLabel(match: DuplicateMatch) {
  const kind = match.source === "direct" ? "Cuenta por pagar directa" : match.document_type || "Documento recibido";
  const number = match.number ? ` N° ${match.number}` : "";
  return `${kind}${number}${match.supplier_name ? ` · ${match.supplier_name}` : ""}`;
}

/** Separa bloqueos por folio de advertencias por proveedor + monto + fecha. */
export function classifyDuplicates(matches: DuplicateMatch[]) {
  return {
    sameFolio: matches.filter((match) => match.match === "same_folio"),
    sameAmount: matches.filter((match) => match.match === "same_amount"),
  };
}

export function validDuplicateReason(value: unknown) {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  return reason.length >= 3 && reason.length <= 500 ? reason : null;
}

export function documentStatusLabel(status: string | null | undefined) {
  if (status === "pending_document") return "Documento pendiente";
  if (status === "documented") return "Documentada";
  return "Sin documento requerido";
}
