import assert from "node:assert/strict";
import test from "node:test";
import { buildEffectivePayrollByMonth } from "../src/lib/payroll-reporting.ts";

const provisions = [{ id: "provision-1", period_month: "2026-08-01", posted_amount: 120 }];
const revisions = [
  { id: "revision-1", provision_id: "provision-1", as_of_date: "2026-08-07", status: "posted" as const },
  { id: "revision-2", provision_id: "provision-1", as_of_date: "2026-08-14", status: "posted" as const },
  { id: "revision-draft", provision_id: "provision-1", as_of_date: "2026-08-21", status: "draft" as const },
];
const provisionLines = [
  { revision_id: "revision-1", source_type: "peoplework" as const, direction: "add" as const, amount: 100, cost_center_id: "center-a", source_cost_center_code: "A", source_cost_center_name: "Centro A" },
  { revision_id: "revision-2", source_type: "peoplework" as const, direction: "add" as const, amount: 80, cost_center_id: "center-a", source_cost_center_code: " A ", source_cost_center_name: "Centro A" },
  { revision_id: "revision-2", source_type: "peoplework" as const, direction: "add" as const, amount: 20, cost_center_id: "center-b", source_cost_center_code: "b", source_cost_center_name: "Centro B" },
  { revision_id: "revision-2", source_type: "manual" as const, direction: "add" as const, amount: 20, cost_center_id: null, source_cost_center_code: null, source_cost_center_name: null },
  { revision_id: "revision-draft", source_type: "peoplework" as const, direction: "add" as const, amount: 999, cost_center_id: "center-a", source_cost_center_code: "A", source_cost_center_name: "Centro A" },
];

test("usa la última provisión contabilizada y distribuye ajustes corporativos", () => {
  const result = buildEffectivePayrollByMonth({
    periods: ["2026-08"], payrollCostLines: [], provisions, revisions, provisionLines,
  }).get("2026-08");
  assert.equal(result?.basis, "posted_provision");
  assert.equal(result?.amount, 120);
  assert.equal(result?.revisionId, "revision-2");
  assert.deepEqual(result?.allocations.map((line) => [line.costCenterId, line.amount]), [
    ["center-a", 96],
    ["center-b", 24],
  ]);
});

test("la nómina oficial reemplaza a la provisión y nunca se suma con ella", () => {
  const result = buildEffectivePayrollByMonth({
    periods: ["2026-08"],
    payrollCostLines: [
      { period_month: "2026-08-01", amount: 75, data_basis: "official_payroll", cost_center_code: "a", cost_center_name: "Centro A" },
      { period_month: "2026-08-01", amount: 35, data_basis: "official_payroll", cost_center_code: null, cost_center_name: null },
    ],
    provisions,
    revisions,
    provisionLines,
  }).get("2026-08");
  assert.equal(result?.basis, "official");
  assert.equal(result?.amount, 110);
  assert.equal(result?.allocations.reduce((total, line) => total + line.amount, 0), 110);
  assert.equal(result?.allocations.some((line) => line.key === "__unallocated__"), true);
});

test("un borrador no habilita ni modifica el costo laboral reconocido", () => {
  const result = buildEffectivePayrollByMonth({
    periods: ["2026-09"],
    payrollCostLines: [],
    provisions: [{ id: "provision-2", period_month: "2026-09-01", posted_amount: 0 }],
    revisions: [{ id: "draft", provision_id: "provision-2", as_of_date: "2026-09-07", status: "draft" }],
    provisionLines: [{ revision_id: "draft", source_type: "peoplework", direction: "add", amount: 500, cost_center_id: null, source_cost_center_code: null, source_cost_center_name: null }],
  }).get("2026-09");
  assert.equal(result?.basis, "missing");
  assert.equal(result?.amount, 0);
});
