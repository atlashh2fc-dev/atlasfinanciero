export const payrollProvisionCategories = [
  "employer_contributions",
  "bonus",
  "commission",
  "overtime",
  "vacation",
  "severance",
  "allowance",
  "adjustment",
  "other",
] as const;

export type PayrollProvisionCategory = typeof payrollProvisionCategories[number];
export type PayrollProvisionDirection = "add" | "deduct";
export type PayrollProvisionCalculation = "fixed" | "percentage";

export type PayrollProvisionAmountLine = {
  source_type: "peoplework" | "manual";
  direction: PayrollProvisionDirection;
  amount: number | string;
};

function finiteNumber(value: number | string) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

export function calculatePercentageAmount(base: number, rate: number) {
  if (!Number.isFinite(base) || base < 0) throw new Error("La base de cálculo debe ser un monto no negativo.");
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) throw new Error("El porcentaje debe ser mayor que cero y menor o igual a 1.000%.");
  return roundCurrency(base * rate / 100);
}

export function summarizePayrollProvision(lines: PayrollProvisionAmountLine[]) {
  return lines.reduce((summary, line) => {
    const value = Math.max(0, finiteNumber(line.amount));
    if (line.source_type === "peoplework") summary.contractualBase += value;
    else if (line.direction === "add") summary.additions += value;
    else summary.deductions += value;
    return summary;
  }, { contractualBase: 0, additions: 0, deductions: 0 });
}

export function payrollProvisionTotal(lines: PayrollProvisionAmountLine[]) {
  const summary = summarizePayrollProvision(lines);
  return roundCurrency(summary.contractualBase + summary.additions - summary.deductions);
}
