export type RevenueDocument = {
  documentType?: string | null;
  invoiceNumber?: string | null;
  netAmount?: number | null;
  totalAmount?: number | null;
};

function normalizedDocumentType(value: string | null | undefined) {
  return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

export function isPurchaseOrderDocument(document: RevenueDocument) {
  const type = normalizedDocumentType(document.documentType);
  return type.includes("orden de compra") || type === "oc";
}

export function isCreditNoteDocument(document: RevenueDocument) {
  return normalizedDocumentType(document.documentType).includes("nota de credito");
}

export function isAllocatableInvoice(document: RevenueDocument) {
  const type = normalizedDocumentType(document.documentType);
  return !isPurchaseOrderDocument(document) && !isCreditNoteDocument(document) && type.includes("factura");
}

/** A revenue entry is only invoiced once its fiscal document has a folio. */
export function hasIssuedDocumentNumber(document: RevenueDocument) {
  return Boolean(document.invoiceNumber?.trim());
}

export function recognizedNetAmount(document: RevenueDocument) {
  const amount = Number(document.netAmount ?? 0);
  if (!Number.isFinite(amount) || isPurchaseOrderDocument(document)) return 0;
  return isCreditNoteDocument(document) ? -Math.abs(amount) : amount;
}

/** Balance still collectible after all registered partial payments. */
export function outstandingDocumentBalance(
  document: RevenueDocument,
  paidAmount = 0,
) {
  const documentAmount = Number(
    document.totalAmount ?? recognizedNetAmount(document),
  );
  const paid = Number(paidAmount);
  return Math.max(
    0,
    (Number.isFinite(documentAmount) ? documentAmount : 0) -
      (Number.isFinite(paid) ? paid : 0),
  );
}
