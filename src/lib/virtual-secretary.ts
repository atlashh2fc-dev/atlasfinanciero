export const subscriptionStatuses = [
  "draft", "pending_payment", "payment_validation", "paid_pending_activation",
  "active", "expiring", "expired_pending_payment", "suspended_nonpayment",
  "cancelled", "voided",
] as const;

export type SubscriptionStatus = typeof subscriptionStatuses[number];

export const statusLabels: Record<SubscriptionStatus, string> = {
  draft: "Borrador",
  pending_payment: "Pendiente de pago",
  payment_validation: "Pago en validación",
  paid_pending_activation: "Pagada pendiente de activación",
  active: "Activa",
  expiring: "Próxima a vencer",
  expired_pending_payment: "Vencida pendiente de pago",
  suspended_nonpayment: "Suspendida por no pago",
  cancelled: "Cancelada / dada de baja",
  voided: "Anulada",
};

export const allowedTransitions: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  draft: ["pending_payment", "voided"],
  pending_payment: ["payment_validation", "paid_pending_activation", "voided"],
  payment_validation: ["pending_payment", "paid_pending_activation"],
  paid_pending_activation: ["active", "voided"],
  active: ["expiring", "suspended_nonpayment", "cancelled"],
  expiring: ["active", "expired_pending_payment", "cancelled"],
  expired_pending_payment: ["paid_pending_activation", "suspended_nonpayment", "cancelled"],
  suspended_nonpayment: ["paid_pending_activation", "cancelled"],
  cancelled: [],
  voided: [],
};

export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return typeof value === "string" && (subscriptionStatuses as readonly string[]).includes(value);
}

export function addCalendarMonths(date: string, months: number) {
  const [year, month, day] = date.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + months, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

export function inclusiveEndDate(startOn: string, months: number) {
  const next = new Date(`${addCalendarMonths(startOn, months)}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() - 1);
  return next.toISOString().slice(0, 10);
}

export function calculateSubscriptionAmounts(listNet: number, discount: number, taxRate: number) {
  if (![listNet, discount, taxRate].every(Number.isFinite) || listNet < 0 || discount < 0 || discount > listNet || taxRate < 0 || taxRate > 100) {
    throw new Error("invalid_subscription_amounts");
  }
  const net = Math.round((listNet - discount) * 100) / 100;
  const tax = Math.round(net * taxRate) / 100;
  return { listNet, discount, net, tax, gross: Math.round((net + tax) * 100) / 100 };
}

export function buildMonthlyRevenueSchedule(startOn: string, endOn: string, netAmount: number) {
  const start = new Date(`${startOn}T00:00:00Z`);
  const end = new Date(`${endOn}T00:00:00Z`);
  if (!Number.isFinite(netAmount) || netAmount < 0 || end < start) throw new Error("invalid_revenue_schedule");
  const buckets: string[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const finalMonth = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1);
  while (cursor.getTime() <= finalMonth) {
    const recognition = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    if (recognition > end) recognition.setTime(end.getTime());
    buckets.push(recognition.toISOString().slice(0, 10));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const cents = Math.round(netAmount * 100);
  const base = Math.floor(cents / buckets.length);
  let remainder = cents - base * buckets.length;
  return buckets.map((recognitionOn) => {
    const amount = (base + (remainder-- > 0 ? 1 : 0)) / 100;
    return { recognitionOn, amount };
  });
}

export function renewalAlertDates(endOn: string, alertDays: number[]) {
  const end = new Date(`${endOn}T00:00:00Z`);
  return [...new Set(alertDays.filter((days) => Number.isInteger(days) && days > 0))]
    .sort((a, b) => b - a)
    .map((days) => {
      const date = new Date(end);
      date.setUTCDate(date.getUTCDate() - days);
      return { days, alertOn: date.toISOString().slice(0, 10) };
    });
}
