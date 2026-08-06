import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePercentageAmount,
  payrollProvisionTotal,
  summarizePayrollProvision,
} from "../src/lib/payroll-provisions.ts";

test("calcula componentes porcentuales sobre la base contractual", () => {
  assert.equal(calculatePercentageAmount(30_000_000, 4.5), 1_350_000);
});

test("resume base, adiciones y descuentos sin mezclarlos", () => {
  const lines = [
    { source_type: "peoplework" as const, direction: "add" as const, amount: 30_000_000 },
    { source_type: "manual" as const, direction: "add" as const, amount: 1_350_000 },
    { source_type: "manual" as const, direction: "add" as const, amount: 500_000 },
    { source_type: "manual" as const, direction: "deduct" as const, amount: 200_000 },
  ];
  assert.deepEqual(summarizePayrollProvision(lines), {
    contractualBase: 30_000_000,
    additions: 1_850_000,
    deductions: 200_000,
  });
  assert.equal(payrollProvisionTotal(lines), 31_650_000);
});
