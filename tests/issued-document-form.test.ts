import assert from "node:assert/strict";
import test from "node:test";
import {
  missingIssuedDocumentFields,
  missingIssuedDocumentMessage,
  type IssuedDocumentDraftFields,
} from "../src/lib/issued-document-form.ts";

const complete: IssuedDocumentDraftFields = {
  invoiceNumber: "160",
  issueDate: "2026-10-14",
  dueDate: "2026-11-13",
  documentType: "Factura afecta",
  issuerName: "GEIMSER",
  clientId: "4c4437b3-e9fc-4bdc-9e56-00aca6704e7c",
  netAmount: "145890",
  status: "Pendiente",
  paymentCondition: "post_service",
};

test("un documento completo no tiene faltantes", () => {
  assert.deepEqual(missingIssuedDocumentFields(complete), []);
  assert.equal(missingIssuedDocumentMessage([]), "");
});

test("factura con folio pero sin vencimiento avisa el vencimiento, no el folio", () => {
  const missing = missingIssuedDocumentFields({ ...complete, dueDate: "" });
  assert.deepEqual(missing, ["dueDate"]);
  const message = missingIssuedDocumentMessage(missing);
  assert.equal(message, "Falta completar: Fecha vencimiento.");
  assert.doesNotMatch(message, /folio|prefactura/i);
});

test("sin folio sugiere crear una prefactura", () => {
  const missing = missingIssuedDocumentFields({ ...complete, invoiceNumber: "  " });
  assert.deepEqual(missing, ["invoiceNumber"]);
  assert.match(missingIssuedDocumentMessage(missing), /^Falta completar: N° documento\. .*prefactura/);
});

test("lista varios faltantes en el orden del formulario", () => {
  const missing = missingIssuedDocumentFields({ ...complete, netAmount: "", dueDate: "", clientId: "" });
  assert.deepEqual(missing, ["dueDate", "clientId", "netAmount"]);
  assert.equal(missingIssuedDocumentMessage(missing), "Falta completar: Fecha vencimiento, Cliente y Monto neto.");
});

test("las notas de crédito no exigen vencimiento ni condición del servicio", () => {
  const missing = missingIssuedDocumentFields({ ...complete, documentType: "Nota de crédito", dueDate: "", paymentCondition: "" });
  assert.deepEqual(missing, []);
});

test("factura exenta sí exige condición del servicio", () => {
  const missing = missingIssuedDocumentFields({ ...complete, documentType: "Factura exenta", paymentCondition: "" });
  assert.deepEqual(missing, ["paymentCondition"]);
});
