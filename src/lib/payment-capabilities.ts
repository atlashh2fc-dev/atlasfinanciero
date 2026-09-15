export type PaymentCapability = "create_proposals" | "record_transfers";

export type PaymentCapabilityMembership = {
  role: string;
  can_create_payment_proposals?: boolean | null;
  can_record_payment_transfers?: boolean | null;
};

/**
 * Finance roles always operate payments. Data entry only gets the individual
 * capability granted on its membership, never approval or rescheduling.
 */
export function hasPaymentCapability(
  membership: PaymentCapabilityMembership | null | undefined,
  capability: PaymentCapability,
) {
  if (!membership) return false;
  if (["administrator", "finance"].includes(membership.role)) return true;
  if (membership.role !== "data_entry") return false;
  return capability === "create_proposals"
    ? membership.can_create_payment_proposals === true
    : membership.can_record_payment_transfers === true;
}
