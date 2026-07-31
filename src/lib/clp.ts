const CLP_VAT_RATE = 0.19;

/**
 * Chilean peso amounts are persisted and settled as whole, safe integers.
 * This parser is deliberately strict for new financial events: rounding is
 * reserved for normalizing historical imported records at read time.
 */
export function parseWholeClpAmount(
  value: unknown,
  options: { allowZero?: boolean } = {},
) {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    value === ""
  )
    return null;

  const amount = Number(value);
  const minimum = options.allowZero ? 0 : 1;
  return Number.isSafeInteger(amount) && amount >= minimum ? amount : null;
}

/** Normalize historical decimal values for CLP presentation and settlement. */
export function normalizeClpAmount(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) && Math.abs(amount) <= Number.MAX_SAFE_INTEGER
    ? Math.round(amount)
    : 0;
}

export function calculateClpInvoiceAmounts(
  netAmount: number,
  includesVat: boolean,
) {
  if (!Number.isSafeInteger(netAmount) || netAmount < 0)
    throw new RangeError("CLP net amount must be a non-negative whole peso");

  const vatAmount = includesVat
    ? Math.round(netAmount * CLP_VAT_RATE)
    : 0;

  return {
    netAmount,
    vatAmount,
    totalAmount: netAmount + vatAmount,
  };
}
