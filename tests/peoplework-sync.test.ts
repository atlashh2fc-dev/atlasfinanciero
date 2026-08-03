import assert from "node:assert/strict";
import test from "node:test";

import type { PeopleWorkContract, PeopleWorkEmployee } from "../src/lib/peoplework/client.ts";
import {
  buildAttendanceMetrics,
  durationToMinutes,
  normalizeDistribution,
  periodEnd,
  resolveContractCostCenters,
  selectContractsForPeriod,
} from "../src/lib/peoplework/sync-utils.ts";

test("period boundaries use the real last day of each month", () => {
  assert.equal(periodEnd("2024-02-01"), "2024-02-29");
  assert.equal(periodEnd("2026-02-01"), "2026-02-28");
  assert.equal(periodEnd("2026-04-01"), "2026-04-30");
});

test("one canonical contract per person is selected for the requested month", () => {
  const contracts: PeopleWorkContract[] = [
    { id: 10, employee: { id: 7 }, start_date: "01/01/2026", end_date: "31/08/2026", salary: 500_000 },
    { id: 11, employee: { id: 7 }, start_date: "15/08/2026", salary: 650_000 },
    { id: 12, employee: { id: 8 }, start_date: "01/09/2026", salary: 700_000 },
  ];

  assert.deepEqual(selectContractsForPeriod(contracts, "2026-08-01").map((contract) => contract.id), [11]);
  assert.deepEqual(selectContractsForPeriod(contracts, "2026-09-01").map((contract) => contract.id).sort(), [11, 12]);
});

test("the real PeopleWork cost-center shape is mapped and normalized to 100 percent", () => {
  const employee: PeopleWorkEmployee = {
    id: 7,
    cost_center: [{ code: "OPS", name: "Operaciones", percentage: 100 }],
  };
  const contract: PeopleWorkContract = {
    id: 11,
    employee: { id: 7 },
    contract_cost_centers_attributes: [{ name: "Operaciones", percentage: 80 }],
  };

  assert.deepEqual(resolveContractCostCenters(contract, employee), [{ code: "OPS", name: "Operaciones", percentage: 100 }]);
  assert.deepEqual(normalizeDistribution([
    { code: "A", name: "A", percentage: 1 },
    { code: "B", name: "B", percentage: 1 },
  ]), [
    { code: "A", name: "A", percentage: 50 },
    { code: "B", name: "B", percentage: 50 },
  ]);
});

test("attendance is replaced as monthly metrics using each event date", () => {
  const result = buildAttendanceMetrics({
    year: 2026,
    absences: [
      { employee: { id: 10 }, start_date: "03/01/2026", days: 2 },
      { employee: { id: 10 }, start_date: "14/08/2026", days: 1 },
      { employee: { id: 99 }, start_date: "14/08/2026", days: 4 },
    ],
    vacations: [
      { national_identification: "12.345.678-K", start_date: "20/08/2026", days: 5 },
    ],
    attendanceReports: [{
      employee_id: 10,
      date_from: "01/08/2026",
      date_to: "31/08/2026",
      totals: {
        total_days_worked: 3,
        total_days_non_worked: 1,
        total_hours_worked: "08:30:00",
        total_minutes_hours_extra: "00:45:30",
        total_minutes_late: "00:08:30",
        total_minutes_early_departure: "00:02:00",
      },
    }],
    personByEmployeeId: new Map([["10", "person-1"]]),
    personByNationalId: new Map([["12345678K", "person-1"]]),
  });

  assert.equal(result.rejected, 1);
  assert.deepEqual(result.metrics, [
    { personId: "person-1", periodMonth: "2026-01-01", absenceDays: 2, vacationDays: 0, workedDays: 0, nonWorkedDays: 0, workedMinutes: 0, overtimeMinutes: 0, lateMinutes: 0, earlyDepartureMinutes: 0 },
    { personId: "person-1", periodMonth: "2026-08-01", absenceDays: 1, vacationDays: 5, workedDays: 3, nonWorkedDays: 1, workedMinutes: 510, overtimeMinutes: 45.5, lateMinutes: 8.5, earlyDepartureMinutes: 2 },
  ]);
});

test("PeopleWork HH:MM:SS durations retain minute fractions", () => {
  assert.equal(durationToMinutes("08:30:00"), 510);
  assert.equal(durationToMinutes("00:01:30"), 1.5);
  assert.equal(durationToMinutes("invalid"), 0);
});
