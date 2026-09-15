import assert from "node:assert/strict";
import test from "node:test";
import { hasPaymentCapability } from "../src/lib/payment-capabilities.ts";

test("administración y finanzas operan pagos sin capacidades individuales", () => {
  for (const role of ["administrator", "finance"]) {
    assert.equal(hasPaymentCapability({ role }, "create_proposals"), true);
    assert.equal(hasPaymentCapability({ role }, "record_transfers"), true);
  }
});

test("digitación sólo obtiene la capacidad otorgada en su membresía", () => {
  const proposalsOnly = { role: "data_entry", can_create_payment_proposals: true };
  assert.equal(hasPaymentCapability(proposalsOnly, "create_proposals"), true);
  assert.equal(hasPaymentCapability(proposalsOnly, "record_transfers"), false);

  const transfersOnly = { role: "data_entry", can_record_payment_transfers: true };
  assert.equal(hasPaymentCapability(transfersOnly, "create_proposals"), false);
  assert.equal(hasPaymentCapability(transfersOnly, "record_transfers"), true);

  assert.equal(hasPaymentCapability({ role: "data_entry" }, "create_proposals"), false);
});

test("otros roles y membresías ausentes no operan pagos aunque tengan banderas", () => {
  const flags = { can_create_payment_proposals: true, can_record_payment_transfers: true };
  for (const role of ["operations", "auditor"]) {
    assert.equal(hasPaymentCapability({ role, ...flags }, "create_proposals"), false);
    assert.equal(hasPaymentCapability({ role, ...flags }, "record_transfers"), false);
  }
  assert.equal(hasPaymentCapability(null, "create_proposals"), false);
});
