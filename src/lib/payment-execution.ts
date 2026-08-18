export type PaymentProposalForSorting = {
  id: string;
  batch_number: string;
  scheduled_for: string;
};

export type PaymentProposalSortDirection = "ascending" | "descending";

export function paymentProposalItemAuthorization(
  paymentBatchId: string,
  amount: number,
  authorizedAt: string,
) {
  return {
    authorization_status: "authorized" as const,
    authorized_amount: amount,
    authorized_at: authorizedAt,
    authorization_source_batch_id: paymentBatchId,
  };
}

export function sortPaymentProposalsByDate<T extends PaymentProposalForSorting>(
  proposals: readonly T[],
  direction: PaymentProposalSortDirection = "ascending",
) {
  const multiplier = direction === "ascending" ? 1 : -1;

  return proposals
    .map((proposal, index) => ({ proposal, index }))
    .sort((left, right) => {
      const byDate = left.proposal.scheduled_for.localeCompare(
        right.proposal.scheduled_for,
      );
      if (byDate) return byDate * multiplier;

      const byNumber = left.proposal.batch_number.localeCompare(
        right.proposal.batch_number,
        "es-CL",
        { numeric: true },
      );
      if (byNumber) return byNumber;

      return left.index - right.index;
    })
    .map(({ proposal }) => proposal);
}

export type PaymentAmountValidation =
  | {
      valid: true;
      outstandingAmount: number;
      paymentAmount: number;
      remainingAmount: number;
      settlesPayable: boolean;
    }
  | {
      valid: false;
      outstandingAmount: number;
      error:
        | "invalid_total"
        | "invalid_paid"
        | "invalid_payment"
        | "payment_exceeds_outstanding";
    };

function roundedAmount(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function validatePaymentAmount(
  totalAmount: number,
  paidAmount: number,
  paymentAmount: number,
): PaymentAmountValidation {
  if (!Number.isFinite(totalAmount) || totalAmount <= 0)
    return { valid: false, outstandingAmount: 0, error: "invalid_total" };
  if (!Number.isFinite(paidAmount) || paidAmount < 0)
    return {
      valid: false,
      outstandingAmount: roundedAmount(totalAmount),
      error: "invalid_paid",
    };

  const outstandingAmount = roundedAmount(Math.max(0, totalAmount - paidAmount));
  if (!Number.isFinite(paymentAmount) || paymentAmount <= 0)
    return { valid: false, outstandingAmount, error: "invalid_payment" };
  if (roundedAmount(paymentAmount) > outstandingAmount)
    return {
      valid: false,
      outstandingAmount,
      error: "payment_exceeds_outstanding",
    };

  const normalizedPayment = roundedAmount(paymentAmount);
  const remainingAmount = roundedAmount(outstandingAmount - normalizedPayment);
  return {
    valid: true,
    outstandingAmount,
    paymentAmount: normalizedPayment,
    remainingAmount,
    settlesPayable: remainingAmount === 0,
  };
}

export type SupplierPaymentItem = {
  id: string;
  supplier_name: string;
  amount: number | string;
};

export type SupplierPaymentGroup<T extends SupplierPaymentItem> = {
  supplierKey: string;
  supplierName: string;
  itemIds: string[];
  totalAmount: number;
  items: T[];
};

export function normalizedSupplierKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("es-CL");
}

export function groupPaymentItemsBySupplier<T extends SupplierPaymentItem>(
  items: readonly T[],
) {
  const groups = new Map<string, SupplierPaymentGroup<T>>();

  for (const item of items) {
    const supplierName = item.supplier_name.trim().replace(/\s+/g, " ");
    const supplierKey = normalizedSupplierKey(supplierName);
    const itemAmount = Number(item.amount);
    if (!supplierKey || !Number.isFinite(itemAmount) || itemAmount <= 0)
      continue;

    const group = groups.get(supplierKey);
    if (group) {
      group.itemIds.push(item.id);
      group.items.push(item);
      group.totalAmount = roundedAmount(group.totalAmount + itemAmount);
    } else {
      groups.set(supplierKey, {
        supplierKey,
        supplierName,
        itemIds: [item.id],
        totalAmount: roundedAmount(itemAmount),
        items: [item],
      });
    }
  }

  return [...groups.values()];
}
