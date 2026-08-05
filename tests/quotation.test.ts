import assert from "node:assert/strict";
import test from "node:test";

import { calculateCatalogUnitCost, calculateQuote, salePriceFromMargin, type QuoteLine } from "../src/lib/quotation.ts";

test("catalog product cost combines direct cost and shared infrastructure or AI resources", () => {
  assert.equal(calculateCatalogUnitCost(100, [
    { catalogItemId: "vercel", name: "Vercel", quantity: 1, unitCost: 250 },
    { catalogItemId: "gpt", name: "IA GPT", quantity: 2, unitCost: 75 },
    { catalogItemId: "mercury", name: "Mercury (IA gratis)", quantity: 1, unitCost: 0 },
  ]), 500);
});

test("sale price uses gross margin over the final sale value", () => {
  assert.equal(salePriceFromMargin(700, 30), 1000);
  assert.equal(salePriceFromMargin(0, 70), 0);
  assert.throws(() => salePriceFromMargin(100, 100), RangeError);
});

test("quotation separates setup and recurring economics", () => {
  const lines: QuoteLine[] = [
    { id: "setup", catalogItemId: null, name: "Setup", category: "professional_service", unitName: "servicio", billingPeriod: "one_time", quantity: 1, unitCost: 600, marginPercent: 40 },
    { id: "saas", catalogItemId: null, name: "Atlas", category: "saas", unitName: "licencia", billingPeriod: "monthly", quantity: 2, unitCost: 700, marginPercent: 30 },
  ];
  assert.deepEqual(calculateQuote(lines, 12), {
    costOneTime: 600,
    saleOneTime: 1000,
    costMonthly: 1400,
    saleMonthly: 2000,
    contractCost: 17400,
    contractValue: 25000,
    grossProfit: 7600,
    grossMarginPercent: 30.4,
  });
});
