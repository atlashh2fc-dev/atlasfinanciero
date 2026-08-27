export type SchedulablePaymentBatch = {
  id: string;
  scheduled_for: string;
  status: string;
  total_amount: number | string;
};

export type SchedulablePaymentItem = {
  payment_batch_id: string;
  amount: number | string;
  authorized_amount?: number | string | null;
  outstanding_amount?: number | string | null;
  status?: string | null;
  authorization_status?: string | null;
};

export type PaymentWeekSummary = {
  scheduledFor: string;
  batchIds: string[];
  itemCount: number;
  totalAmount: number;
  draftAmount: number;
  reviewAmount: number;
  approvedAmount: number;
  processingAmount: number;
  paidAmount: number;
  carryoverAmount: number;
  carryoverItemCount: number;
};

function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function isFridayDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.getUTCDay() === 5;
}

export function nextFriday(value = isoDate(new Date()), includeToday = true) {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  const offset = (5 - parsed.getUTCDay() + 7) % 7;
  parsed.setUTCDate(parsed.getUTCDate() + (offset === 0 && !includeToday ? 7 : offset));
  return isoDate(parsed);
}

export function upcomingFridays(count = 6, value = isoDate(new Date())) {
  const first = new Date(`${nextFriday(value)}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const item = new Date(first);
    item.setUTCDate(first.getUTCDate() + index * 7);
    return isoDate(item);
  });
}

export function summarizePaymentWeeks(
  batches: SchedulablePaymentBatch[],
  items: SchedulablePaymentItem[],
  weekDates: string[],
) {
  const firstVisibleWeek = weekDates[0];
  const itemSummaryByBatch = new Map<
    string,
    { itemCount: number; outstandingAmount: number }
  >();
  for (const item of items) {
    if (
      item.authorization_status === "cancelled" ||
      ["cancelled", "paid"].includes(item.status ?? "")
    )
      continue;
    const outstandingAmount = Number(
      item.outstanding_amount ?? item.authorized_amount ?? item.amount ?? 0,
    );
    if (!Number.isFinite(outstandingAmount) || outstandingAmount <= 0) continue;
    const current = itemSummaryByBatch.get(item.payment_batch_id) ?? {
      itemCount: 0,
      outstandingAmount: 0,
    };
    itemSummaryByBatch.set(item.payment_batch_id, {
      itemCount: current.itemCount + 1,
      outstandingAmount: current.outstandingAmount + outstandingAmount,
    });
  }

  return weekDates.map<PaymentWeekSummary>((scheduledFor) => {
    const weekBatches = batches.filter(
      (batch) =>
        batch.scheduled_for === scheduledFor ||
        (scheduledFor === firstVisibleWeek &&
          Boolean(firstVisibleWeek) &&
          batch.scheduled_for < firstVisibleWeek &&
          !["cancelled", "paid"].includes(batch.status)),
    );
    const activeBatches = weekBatches.filter(
      (batch) => !["cancelled", "paid"].includes(batch.status),
    );
    const result: PaymentWeekSummary = {
      scheduledFor,
      batchIds: activeBatches.map((batch) => batch.id),
      itemCount: activeBatches.reduce(
        (sum, batch) =>
          sum + (itemSummaryByBatch.get(batch.id)?.itemCount ?? 0),
        0,
      ),
      totalAmount: 0,
      draftAmount: 0,
      reviewAmount: 0,
      approvedAmount: 0,
      processingAmount: 0,
      paidAmount: 0,
      carryoverAmount: 0,
      carryoverItemCount: 0,
    };
    for (const batch of weekBatches) {
      const itemSummary = itemSummaryByBatch.get(batch.id);
      const amount = itemSummary
        ? itemSummary.outstandingAmount
        : Number(batch.total_amount ?? 0);
      const isCarryover =
        Boolean(firstVisibleWeek) && batch.scheduled_for < firstVisibleWeek;
      if (!["cancelled", "paid"].includes(batch.status))
        result.totalAmount += amount;
      if (batch.status === "draft") result.draftAmount += amount;
      if (batch.status === "review") result.reviewAmount += amount;
      if (batch.status === "approved") result.approvedAmount += amount;
      if (batch.status === "processing") result.processingAmount += amount;
      if (batch.status === "paid") result.paidAmount += amount;
      if (isCarryover && !["cancelled", "paid"].includes(batch.status)) {
        result.carryoverAmount += amount;
        result.carryoverItemCount += itemSummary?.itemCount ?? 0;
      }
    }
    return result;
  });
}
