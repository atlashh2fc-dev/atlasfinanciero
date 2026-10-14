/**
 * Campos obligatorios al registrar un documento emitido. Replica la validación
 * de POST /api/issued-documents para avisar en pantalla qué campo falta: antes
 * cualquier faltante (p. ej. la fecha de vencimiento) se informaba como si
 * faltara el folio, aunque estuviera ingresado.
 */

export type IssuedDocumentDraftFields = {
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  documentType: string;
  issuerName: string;
  clientId: string;
  netAmount: string;
  status: string;
  paymentCondition: string;
};

export type IssuedDocumentField = keyof IssuedDocumentDraftFields;

// Mismo orden que el formulario: el primer faltante es el que recibe el foco.
const fieldOrder: IssuedDocumentField[] = [
  "invoiceNumber",
  "issueDate",
  "dueDate",
  "documentType",
  "status",
  "paymentCondition",
  "issuerName",
  "clientId",
  "netAmount",
];

const fieldLabels: Record<IssuedDocumentField, string> = {
  invoiceNumber: "N° documento",
  issueDate: "Fecha emisión",
  dueDate: "Fecha vencimiento",
  documentType: "Tipo documento",
  status: "Estado",
  paymentCondition: "Condición del servicio",
  issuerName: "Empresa emisora",
  clientId: "Cliente",
  netAmount: "Monto neto",
};

/** Las facturas exigen fecha de vencimiento y condición del servicio; las notas no. */
export function isInvoiceType(documentType: string) {
  return documentType.toLocaleLowerCase().includes("factura");
}

export function missingIssuedDocumentFields(draft: IssuedDocumentDraftFields): IssuedDocumentField[] {
  return fieldOrder.filter((field) => {
    if ((field === "dueDate" || field === "paymentCondition") && !isInvoiceType(draft.documentType)) return false;
    return !draft[field].trim();
  });
}

function joinLabels(labels: string[]) {
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} y ${labels[labels.length - 1]}` : labels[0] ?? "";
}

export function missingIssuedDocumentMessage(missing: IssuedDocumentField[]) {
  if (!missing.length) return "";
  const message = `Falta completar: ${joinLabels(missing.map((field) => fieldLabels[field]))}.`;
  return missing.includes("invoiceNumber")
    ? `${message} Si el ingreso aún no tiene documento emitido, crea primero una prefactura.`
    : message;
}
