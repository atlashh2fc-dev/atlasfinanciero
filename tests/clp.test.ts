import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateClpInvoiceAmounts,
  normalizeClpAmount,
  parseWholeClpAmount,
} from "../src/lib/clp.ts";

test("new CLP events accept only whole safe pesos", () => {
  assert.equal(parseWholeClpAmount("291457"), 291457);
  assert.equal(parseWholeClpAmount(1), 1);
  assert.equal(parseWholeClpAmount(0), null);
  assert.equal(parseWholeClpAmount(0, { allowZero: true }), 0);
  assert.equal(parseWholeClpAmount("99.60"), null);
  assert.equal(parseWholeClpAmount(Number.MAX_SAFE_INTEGER + 1), null);
});

test("historical decimal totals normalize to the canonical CLP settlement", () => {
  assert.equal(normalizeClpAmount(291457.18), 291457);
  assert.equal(normalizeClpAmount(101963.96), 101964);
  assert.equal(normalizeClpAmount("invalid"), 0);
});

test("invoice VAT and total are calculated in whole CLP", () => {
  assert.deepEqual(calculateClpInvoiceAmounts(245762, true), {
    netAmount: 245762,
    vatAmount: 46695,
    totalAmount: 292457,
  });
  assert.deepEqual(calculateClpInvoiceAmounts(245762, false), {
    netAmount: 245762,
    vatAmount: 0,
    totalAmount: 245762,
  });
  assert.throws(() => calculateClpInvoiceAmounts(100.4, true), RangeError);
});
