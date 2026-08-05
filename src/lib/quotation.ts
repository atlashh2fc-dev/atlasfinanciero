export type QuoteBillingPeriod = "one_time" | "monthly";

export type QuoteCostBreakdown = {
  catalogItemId: string;
  name: string;
  quantity: number;
  unitCost: number;
};

export type QuoteLine = {
  id: string;
  catalogItemId: string | null;
  name: string;
  category: string;
  unitName: string;
  billingPeriod: QuoteBillingPeriod;
  quantity: number;
  unitCost: number;
  marginPercent: number;
  costBreakdown?: QuoteCostBreakdown[];
};

export function calculateCatalogUnitCost(directUnitCost: number, components: QuoteCostBreakdown[]) {
  if (!Number.isFinite(directUnitCost) || directUnitCost < 0) throw new RangeError("Direct cost must be non-negative");
  const componentCost = components.reduce((total, component) => {
    if (!Number.isFinite(component.quantity) || component.quantity <= 0) throw new RangeError("Component quantity must be positive");
    if (!Number.isFinite(component.unitCost) || component.unitCost < 0) throw new RangeError("Component cost must be non-negative");
    return total + component.quantity * component.unitCost;
  }, 0);
  return Math.round((directUnitCost + componentCost) * 10_000) / 10_000;
}

export function salePriceFromMargin(unitCost: number, marginPercent: number) {
  if (!Number.isFinite(unitCost) || unitCost < 0) throw new RangeError("Unit cost must be non-negative");
  if (!Number.isFinite(marginPercent) || marginPercent < 0 || marginPercent >= 100) throw new RangeError("Margin must be between 0 and 100");
  if (unitCost === 0) return 0;
  return Math.round((unitCost / (1 - marginPercent / 100)) * 100) / 100;
}

export function calculateQuote(lines: QuoteLine[], termMonths: number) {
  if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 120) throw new RangeError("Term must be between 1 and 120 months");

  const totals = lines.reduce((result, line) => {
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) throw new RangeError("Quantity must be positive");
    const cost = line.unitCost * line.quantity;
    const sale = salePriceFromMargin(line.unitCost, line.marginPercent) * line.quantity;
    if (line.billingPeriod === "one_time") {
      result.costOneTime += cost;
      result.saleOneTime += sale;
    } else {
      result.costMonthly += cost;
      result.saleMonthly += sale;
    }
    return result;
  }, { costOneTime: 0, saleOneTime: 0, costMonthly: 0, saleMonthly: 0 });

  const contractCost = totals.costOneTime + totals.costMonthly * termMonths;
  const contractValue = totals.saleOneTime + totals.saleMonthly * termMonths;
  const grossProfit = contractValue - contractCost;

  return {
    ...totals,
    contractCost,
    contractValue,
    grossProfit,
    grossMarginPercent: contractValue > 0 ? (grossProfit / contractValue) * 100 : 0,
  };
}
