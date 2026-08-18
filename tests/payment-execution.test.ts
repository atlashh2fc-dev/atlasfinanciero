import assert from "node:assert/strict";
import test from "node:test";
import {
  groupPaymentItemsBySupplier,
  paymentProposalItemAuthorization,
  sortPaymentProposalsByDate,
  validatePaymentAmount,
} from "../src/lib/payment-execution.ts";

test("incluye los campos de autorización requeridos al crear una propuesta", () => {
  assert.deepEqual(
    paymentProposalItemAuthorization(
      "550e8400-e29b-41d4-a716-446655440000",
      47_980,
      "2026-08-18T15:00:00.000Z",
    ),
    {
      authorization_status: "authorized",
      authorized_amount: 47_980,
      authorized_at: "2026-08-18T15:00:00.000Z",
      authorization_source_batch_id:
        "550e8400-e29b-41d4-a716-446655440000",
    },
  );
});

test("ordena propuestas por fecha sin mutar la colección original", () => {
  const proposals = [
    { id: "c", batch_number: "PP-10", scheduled_for: "2026-09-04" },
    { id: "a", batch_number: "PP-2", scheduled_for: "2026-08-14" },
    { id: "b", batch_number: "PP-1", scheduled_for: "2026-08-14" },
  ];

  assert.deepEqual(
    sortPaymentProposalsByDate(proposals).map((item) => item.id),
    ["b", "a", "c"],
  );
  assert.deepEqual(
    sortPaymentProposalsByDate(proposals, "descending").map((item) => item.id),
    ["c", "b", "a"],
  );
  assert.deepEqual(proposals.map((item) => item.id), ["c", "a", "b"]);
});

test("valida abonos sucesivos contra el saldo vigente", () => {
  assert.deepEqual(validatePaymentAmount(100_000, 0, 40_000), {
    valid: true,
    outstandingAmount: 100_000,
    paymentAmount: 40_000,
    remainingAmount: 60_000,
    settlesPayable: false,
  });
  assert.deepEqual(validatePaymentAmount(100_000, 40_000, 60_000), {
    valid: true,
    outstandingAmount: 60_000,
    paymentAmount: 60_000,
    remainingAmount: 0,
    settlesPayable: true,
  });
  assert.deepEqual(validatePaymentAmount(100_000, 40_000, 60_000.01), {
    valid: false,
    outstandingAmount: 60_000,
    error: "payment_exceeds_outstanding",
  });
});

test("rechaza montos inválidos y controla decimales monetarios", () => {
  assert.equal(validatePaymentAmount(0, 0, 1).valid, false);
  assert.equal(validatePaymentAmount(100, -1, 1).valid, false);
  assert.equal(validatePaymentAmount(100, 0, 0).valid, false);
  assert.deepEqual(validatePaymentAmount(100.1, 0, 100.1), {
    valid: true,
    outstandingAmount: 100.1,
    paymentAmount: 100.1,
    remainingAmount: 0,
    settlesPayable: true,
  });
});

test("agrupa ítems por proveedor normalizado y conserva sus documentos", () => {
  const groups = groupPaymentItemsBySupplier([
    { id: "a", supplier_name: "Comunidad Ed Casa Colorada", amount: 300_000 },
    { id: "b", supplier_name: "  COMUNIDAD ED CASA COLORADA  ", amount: "46195" },
    { id: "c", supplier_name: "GTD Manquehue S.A.", amount: 37_302 },
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].itemIds, ["a", "b"]);
  assert.equal(groups[0].totalAmount, 346_195);
  assert.deepEqual(groups[0].items.map((item) => item.id), ["a", "b"]);
  assert.equal(groups[1].supplierName, "GTD Manquehue S.A.");
  assert.equal(groups[1].totalAmount, 37_302);
});

test("omite selecciones sin proveedor o con monto no ejecutable", () => {
  const groups = groupPaymentItemsBySupplier([
    { id: "empty", supplier_name: " ", amount: 10 },
    { id: "zero", supplier_name: "Proveedor", amount: 0 },
    { id: "invalid", supplier_name: "Proveedor", amount: "no-numérico" },
    { id: "valid", supplier_name: "Proveedor", amount: 25 },
  ]);

  assert.deepEqual(groups.map((group) => group.itemIds), [["valid"]]);
});
