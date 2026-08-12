import assert from "node:assert/strict";
import test from "node:test";
import {
  isFridayDate,
  nextFriday,
  summarizePaymentWeeks,
  upcomingFridays,
} from "../src/lib/payment-schedule.ts";

test("encuentra el viernes vigente o siguiente", () => {
  assert.equal(nextFriday("2026-08-05"), "2026-08-07");
  assert.equal(nextFriday("2026-08-07"), "2026-08-07");
  assert.equal(nextFriday("2026-08-07", false), "2026-08-14");
  assert.deepEqual(upcomingFridays(4, "2026-08-05"), [
    "2026-08-07",
    "2026-08-14",
    "2026-08-21",
    "2026-08-28",
  ]);
  assert.equal(isFridayDate("2026-08-14"), true);
  assert.equal(isFridayDate("2026-08-13"), false);
});

test("totaliza carga y estados por viernes", () => {
  const weeks = summarizePaymentWeeks(
    [
      { id: "a", scheduled_for: "2026-08-07", status: "draft", total_amount: 2500 },
      { id: "b", scheduled_for: "2026-08-07", status: "approved", total_amount: "4000" },
      { id: "c", scheduled_for: "2026-08-14", status: "review", total_amount: 3000 },
      { id: "d", scheduled_for: "2026-08-14", status: "cancelled", total_amount: 9999 },
      { id: "e", scheduled_for: "2026-08-07", status: "paid", total_amount: 700 },
    ],
    [
      { payment_batch_id: "a", amount: 1000 },
      { payment_batch_id: "a", amount: 1500 },
      { payment_batch_id: "b", amount: 4000 },
      { payment_batch_id: "c", amount: 3000 },
      { payment_batch_id: "e", amount: 700 },
    ],
    ["2026-08-07", "2026-08-14"],
  );
  assert.deepEqual(weeks[0], {
    scheduledFor: "2026-08-07",
    batchIds: ["a", "b"],
    itemCount: 3,
    totalAmount: 6500,
    draftAmount: 2500,
    reviewAmount: 0,
    approvedAmount: 4000,
    processingAmount: 0,
    paidAmount: 700,
  });
  assert.equal(weeks[1].totalAmount, 3000);
  assert.equal(weeks[1].itemCount, 1);
  assert.equal(weeks[1].reviewAmount, 3000);
});
