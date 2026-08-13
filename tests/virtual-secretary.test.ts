import assert from "node:assert/strict";
import test from "node:test";
import { addCalendarMonths, buildMonthlyRevenueSchedule, calculateSubscriptionAmounts, inclusiveEndDate, renewalAlertDates } from "../src/lib/virtual-secretary.ts";

test("calcula neto, IVA y bruto sin mezclar el cobro", () => {
  assert.deepEqual(calculateSubscriptionAmounts(100_000, 10_000, 19), { listNet: 100_000, discount: 10_000, net: 90_000, tax: 17_100, gross: 107_100 });
  assert.throws(() => calculateSubscriptionAmounts(100, 101, 19));
});

test("respeta meses calendario y fin inclusivo", () => {
  assert.equal(addCalendarMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(inclusiveEndDate("2026-01-01", 3), "2026-03-31");
});

test("distribuye el devengo mensual conservando exactamente el total", () => {
  const schedule = buildMonthlyRevenueSchedule("2026-01-01", "2026-03-31", 100_000);
  assert.equal(schedule.length, 3);
  assert.equal(schedule.reduce((sum, row) => sum + row.amount, 0), 100_000);
  assert.deepEqual(schedule.map((row) => row.recognitionOn), ["2026-01-31", "2026-02-28", "2026-03-31"]);
});

test("genera alertas de renovación sin duplicados", () => {
  assert.deepEqual(renewalAlertDates("2026-12-31", [1, 7, 7]), [
    { days: 7, alertOn: "2026-12-24" },
    { days: 1, alertOn: "2026-12-30" },
  ]);
});
