import { createHash } from "node:crypto";

export type PayrollCostLineInput = {
  periodMonth: string;
  costCategory: string;
  costCenterCode?: string | null;
  costCenterName?: string | null;
  amount: number;
  currencyCode?: string;
  sourceReference?: string | null;
};

export type NormalizedPayrollCostLine = PayrollCostLineInput & {
  currencyCode: string;
  sourceRecordSha256: string;
};

const monthPattern = /^\d{4}-(0[1-9]|1[0-2])-01$/;

export function normalizePayrollCostLine(line: PayrollCostLineInput): NormalizedPayrollCostLine {
  const costCategory = line.costCategory.trim();
  const currencyCode = (line.currencyCode ?? "CLP").trim().toUpperCase();

  if (!monthPattern.test(line.periodMonth)) throw new Error("El período de remuneraciones debe ser el primer día del mes (YYYY-MM-01).");
  if (!costCategory) throw new Error("Cada costo de remuneraciones requiere una categoría de origen.");
  if (!Number.isFinite(line.amount) || line.amount < 0) throw new Error("El costo de remuneraciones debe ser un monto no negativo.");
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw new Error("La moneda debe usar código ISO de tres letras.");

  const payload = JSON.stringify({
    periodMonth: line.periodMonth,
    costCategory,
    costCenterCode: line.costCenterCode?.trim() || null,
    costCenterName: line.costCenterName?.trim() || null,
    amount: line.amount,
    currencyCode,
    sourceReference: line.sourceReference?.trim() || null,
  });

  return {
    ...line,
    costCategory,
    costCenterCode: line.costCenterCode?.trim() || null,
    costCenterName: line.costCenterName?.trim() || null,
    currencyCode,
    sourceReference: line.sourceReference?.trim() || null,
    sourceRecordSha256: createHash("sha256").update(payload).digest("hex"),
  };
}
