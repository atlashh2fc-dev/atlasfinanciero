export type RevenueDocument = {
  documentType?: string | null;
  netAmount?: number | null;
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

export function recognizedNetAmount(document: RevenueDocument) {
  const amount = Number(document.netAmount ?? 0);
  if (!Number.isFinite(amount) || isPurchaseOrderDocument(document)) return 0;
  return isCreditNoteDocument(document) ? -Math.abs(amount) : amount;
}
