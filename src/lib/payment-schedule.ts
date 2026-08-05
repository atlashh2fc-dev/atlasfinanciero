export type SchedulablePaymentBatch = {
  id: string;
  scheduled_for: string;
  status: string;
  total_amount: number | string;
};

export type SchedulablePaymentItem = {
  payment_batch_id: string;
  amount: number | string;
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
  const itemCountByBatch = new Map<string, number>();
  for (const item of items)
    itemCountByBatch.set(
      item.payment_batch_id,
      (itemCountByBatch.get(item.payment_batch_id) ?? 0) + 1,
    );

  return weekDates.map<PaymentWeekSummary>((scheduledFor) => {
    const weekBatches = batches.filter(
      (batch) =>
        batch.scheduled_for === scheduledFor && batch.status !== "cancelled",
    );
    const result: PaymentWeekSummary = {
      scheduledFor,
      batchIds: weekBatches.map((batch) => batch.id),
      itemCount: weekBatches.reduce(
        (sum, batch) => sum + (itemCountByBatch.get(batch.id) ?? 0),
        0,
      ),
      totalAmount: 0,
      draftAmount: 0,
      reviewAmount: 0,
      approvedAmount: 0,
      processingAmount: 0,
      paidAmount: 0,
    };
    for (const batch of weekBatches) {
      const amount = Number(batch.total_amount ?? 0);
      result.totalAmount += amount;
      if (batch.status === "draft") result.draftAmount += amount;
      if (batch.status === "review") result.reviewAmount += amount;
      if (batch.status === "approved") result.approvedAmount += amount;
      if (batch.status === "processing") result.processingAmount += amount;
      if (batch.status === "paid") result.paidAmount += amount;
    }
    return result;
  });
}
