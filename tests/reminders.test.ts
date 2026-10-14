import assert from "node:assert/strict";
import test from "node:test";

import {
  reminderCopy,
  reminderDayLabel,
  reminderIntervalLabel,
  type DueReminder,
} from "../src/lib/reminders.ts";

const reminder: DueReminder = {
  id: "00000000-0000-0000-0000-000000000001",
  organization_id: "00000000-0000-0000-0000-000000000002",
  organization_name: "GEIMSER",
  title: "Anticipo de sueldo de Hugo Hormazábal",
  message: "Aprobar el anticipo programado para el viernes.",
  style: "playful",
  interval_minutes: 180,
  next_remind_at: "2026-10-14T20:00:00Z",
  snooze_count: 0,
  payable_number: "CXP-20261014-ABCDEF12",
  beneficiary_name: "Hugo Hormazábal",
  amount: "300000.00",
  currency_code: "CLP",
  scheduled_for: "2026-10-16",
  batch_status: "review",
  can_approve: true,
  approve_only: true,
};

test("intervals read the way people say them", () => {
  assert.equal(reminderIntervalLabel(180), "3 h");
  assert.equal(reminderIntervalLabel(45), "45 min");
  assert.equal(reminderIntervalLabel(90), "1 h 30 min");
  assert.equal(reminderIntervalLabel(0), "un rato");
});

test("scheduled Friday is labelled without timezone drift", () => {
  assert.equal(reminderDayLabel("2026-10-16"), "viernes 16-10");
  assert.equal(reminderDayLabel(null), null);
  assert.equal(reminderDayLabel("16-10-2026"), null);
});

test("playful copy names the person, amount and Friday on the first notice", () => {
  const copy = reminderCopy(reminder);
  assert.equal(copy.headline, "Hay un anticipo esperando tu visto bueno");
  assert.match(copy.body, /Hugo Hormazábal/);
  assert.match(copy.body, /300\.000/);
  assert.match(copy.body, /viernes 16-10/);
  assert.equal(copy.approveLabel, "Aprobar anticipo");
  assert.equal(copy.snoozeLabel, "Recuérdamelo en 3 h");
});

test("playful copy escalates with each snooze and keeps counting", () => {
  assert.match(reminderCopy({ ...reminder, snooze_count: 1 }).headline, /^Segundo aviso/);
  assert.match(reminderCopy({ ...reminder, snooze_count: 4 }).headline, /^Quinto aviso/);
  assert.equal(
    reminderCopy({ ...reminder, snooze_count: 7 }).headline,
    "Aviso n.º 8: la perseverancia es una virtud",
  );
  assert.match(reminderCopy({ ...reminder, snooze_count: 3 }).body, /cada 3 h/);
});

test("standard reminders show their own title and message", () => {
  const copy = reminderCopy({ ...reminder, style: "standard" });
  assert.equal(copy.headline, reminder.title);
  assert.equal(copy.body, reminder.message);
  assert.equal(copy.approveLabel, "Aprobar");
});
