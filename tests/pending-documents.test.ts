import assert from "node:assert/strict";
import test from "node:test";
import {
  canBackExpense,
  classifyDuplicates,
  coveredDocumentMap,
  documentKind,
  duplicateFolioMessage,
  isExpectedDocumentType,
  linkCandidates,
  normalizeFolio,
  normalizeTaxId,
  parseDuplicateFolioError,
  sameSupplier,
  supplierKey,
  validDuplicateReason,
  type DuplicateMatch,
  type ReceivedDocumentLike,
} from "../src/lib/pending-documents.ts";

const payable = {
  id: "p1",
  supplier_counterparty_id: "c1",
  supplier_name: "GTD Manquehue",
  supplier_tax_id: "96.672.170-0",
  invoice_number: null,
  issue_date: "2026-09-01",
  total_amount: 119_000,
  expected_document_type: "Factura afecta",
};

function document(overrides: Partial<ReceivedDocumentLike> = {}): ReceivedDocumentLike {
  return {
    id: "d1",
    supplier_counterparty_id: null,
    supplier_name: "GTD MANQUEHUE S.A.",
    supplier_tax_id: "96672170-0",
    document_number: "3151940",
    sii_folio: 3151940,
    document_type: "Factura electrónica",
    sii_document_type: 33,
    issue_date: "2026-09-05",
    total_amount: 119_000,
    payment_status: "Pendiente de revisión",
    ...overrides,
  };
}

test("normaliza RUT y folio igual que la base", () => {
  assert.equal(normalizeTaxId("09.672.170-0"), "96721700");
  assert.equal(normalizeTaxId("  "), null);
  assert.equal(normalizeFolio("0003151940"), "3151940");
  assert.equal(normalizeFolio("3.151.940"), "3151940");
  assert.equal(normalizeFolio(" AB-12 "), "ab-12");
  assert.equal(normalizeFolio(""), null);
  assert.equal(normalizeFolio(null), null);
  assert.equal(normalizeFolio("000"), "0");
});

test("la clave de proveedor prioriza RUT, luego contraparte y nombre", () => {
  assert.equal(supplierKey({ taxId: "96.672.170-0", counterpartyId: "c1", name: "X" }), "966721700");
  assert.equal(supplierKey({ taxId: null, counterpartyId: "c1", name: "X" }), "c1");
  assert.equal(supplierKey({ name: "  gtd   manquehue " }), "GTD MANQUEHUE");
  assert.equal(sameSupplier({ taxId: "96672170-0" }, { taxId: "96.672.170-0", counterpartyId: "other" }), true);
  assert.equal(sameSupplier({ counterpartyId: "c1" }, { counterpartyId: "c1", taxId: "1-9" }), true);
  assert.equal(sameSupplier({ taxId: "1-9" }, { taxId: "2-7" }), false);
});

test("sólo facturas y documentos de cargo respaldan un gasto", () => {
  assert.equal(documentKind("Nota de crédito electrónica"), "credit_note");
  assert.equal(documentKind(null, 61), "credit_note");
  assert.equal(documentKind("Guía de despacho"), "dispatch_guide");
  assert.equal(documentKind("Factura exenta"), "invoice");
  assert.equal(canBackExpense("Boleta de honorarios"), true);
  assert.equal(canBackExpense("Factura afecta"), true);
  assert.equal(canBackExpense("Nota de crédito"), false);
  assert.equal(canBackExpense("Nota de débito"), false);
  assert.equal(canBackExpense("Otro", 52), false);
  assert.equal(isExpectedDocumentType("Boleta de honorarios"), true);
  assert.equal(isExpectedDocumentType("Nota de crédito"), false);
});

test("sugiere la factura del mismo proveedor, monto y ventana de fechas", () => {
  const candidates = linkCandidates(payable, [
    document(),
    document({ id: "far", issue_date: "2026-12-30" }),
    document({ id: "other-amount", total_amount: 150_000 }),
    document({ id: "other-supplier", supplier_tax_id: "76123456-7", supplier_name: "Otro" }),
    document({ id: "nc", document_type: "Nota de crédito", sii_document_type: 61 }),
    document({ id: "paid", payment_status: "Pagada" }),
    document({ id: "covered", covered_by_direct_payable_id: "p9" }),
    document({ id: "reserved", active_payment_batch: { id: "b1" } }),
  ]);
  assert.deepEqual(candidates.map((candidate) => candidate.document.id), ["d1", "far", "other-amount"]);
  assert.equal(candidates[0].match, "same_amount");
  assert.equal(candidates[0].withinTolerance, true);
  assert.equal(candidates[0].dayDifference, 4);
  assert.equal(candidates[1].match, "same_supplier");
  assert.equal(candidates[2].amountDifference, 31_000);

  const suggested = linkCandidates(payable, [document(), document({ id: "far", issue_date: "2026-12-30" })], { onlySuggested: true });
  assert.deepEqual(suggested.map((candidate) => candidate.document.id), ["d1"]);
});

test("el folio exacto gana aunque el monto difiera; 1 CLP es tolerancia", () => {
  const candidates = linkCandidates(
    { ...payable, invoice_number: "003151940" },
    [
      document({ id: "same-amount", document_number: "999", sii_folio: 999 }),
      document({ id: "same-folio", total_amount: 120_500 }),
      document({ id: "rounding", document_number: "1000", sii_folio: 1000, total_amount: 119_000.6 }),
    ],
  );
  assert.equal(candidates[0].document.id, "same-folio");
  assert.equal(candidates[0].match, "same_folio");
  assert.equal(candidates[0].withinTolerance, false);
  assert.equal(candidates.find((candidate) => candidate.document.id === "rounding")?.withinTolerance, true);
});

test("un documento cubierto por una cuenta vigente no se cuenta dos veces", () => {
  const covered = coveredDocumentMap([
    { id: "p1", payable_number: "CXP-1", status: "paid", received_document_id: "d1" },
    { id: "p2", payable_number: "CXP-2", status: "cancelled", received_document_id: "d2" },
    { id: "p3", payable_number: "CXP-3", status: "rejected", received_document_id: "d3" },
    { id: "p4", payable_number: "CXP-4", status: "review", received_document_id: null },
  ]);
  assert.deepEqual([...covered.keys()], ["d1"]);
  assert.equal(covered.get("d1")?.payable_number, "CXP-1");
});

test("traduce el bloqueo por folio duplicado a un mensaje claro", () => {
  const detail = parseDuplicateFolioError({
    message: "duplicate_payable_folio",
    details: JSON.stringify({ source: "direct", id: "p1", number: "3151940", label: "CXP-20260905-47AE8755" }),
  });
  assert.deepEqual(detail, { source: "direct", id: "p1", number: "3151940", label: "CXP-20260905-47AE8755" });
  assert.equal(
    duplicateFolioMessage(detail),
    "Ya existe la factura N° 3151940 de este proveedor registrada como cuenta por pagar directa CXP-20260905-47AE8755. No se creó un duplicado.",
  );
  assert.match(
    duplicateFolioMessage({ source: "received", id: "d1", number: "2378", label: "Factura electrónica" }),
    /registrada como documento recibido/,
  );
  assert.equal(parseDuplicateFolioError({ message: "other error" }), null);
  assert.equal(parseDuplicateFolioError({ message: "duplicate_payable_folio", details: "no-json" })?.source, "direct");
});

test("separa bloqueos por folio de advertencias por monto y exige motivo", () => {
  const matches: DuplicateMatch[] = [
    { source: "received", id: "d1", number: "2377", document_type: "Factura", supplier_name: "Vocalcom", total_amount: 10, issue_date: "2026-02-01", status: "Pagada", match: "same_folio" },
    { source: "direct", id: "p1", number: "CXP-1", document_type: "Cuenta por pagar directa", supplier_name: "Vocalcom", total_amount: 10, issue_date: "2026-02-03", status: "approved", match: "same_amount" },
  ];
  const { sameFolio, sameAmount } = classifyDuplicates(matches);
  assert.deepEqual(sameFolio.map((match) => match.id), ["d1"]);
  assert.deepEqual(sameAmount.map((match) => match.id), ["p1"]);
  assert.equal(validDuplicateReason("  no "), null);
  assert.equal(validDuplicateReason("Segunda cuota del mismo servicio"), "Segunda cuota del mismo servicio");
  assert.equal(validDuplicateReason("x".repeat(501)), null);
});
