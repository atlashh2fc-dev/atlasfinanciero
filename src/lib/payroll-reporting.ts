export type PayrollReportingBasis = "official" | "posted_provision" | "missing";

export type ReportingPayrollCostLine = {
  period_month: string;
  amount: number | string;
  data_basis: "official_payroll" | "contractual_estimate";
  cost_center_code: string | null;
  cost_center_name: string | null;
};

export type ReportingPayrollProvision = {
  id: string;
  period_month: string;
  posted_amount: number | string;
};

export type ReportingPayrollRevision = {
  id: string;
  provision_id: string;
  as_of_date: string;
  status: "draft" | "posted";
};

export type ReportingPayrollProvisionLine = {
  revision_id: string;
  source_type: "peoplework" | "manual";
  direction: "add" | "deduct";
  amount: number | string;
  cost_center_id: string | null;
  source_cost_center_code: string | null;
  source_cost_center_name: string | null;
};

export type EffectivePayrollAllocation = {
  key: string;
  costCenterId: string | null;
  costCenterCode: string | null;
  costCenterName: string;
  amount: number;
};

export type EffectivePayroll = {
  period: string;
  amount: number;
  basis: PayrollReportingBasis;
  revisionId: string | null;
  allocations: EffectivePayrollAllocation[];
};

const UNALLOCATED_KEY = "__unallocated__";

function number(value: number | string) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function normalizedPeriod(value: string) {
  return value.slice(0, 7);
}

function normalizedCode(value: string | null) {
  return value?.trim().toLocaleUpperCase("es-CL") || null;
}

function allocationIdentity(input: {
  costCenterId?: string | null;
  costCenterCode?: string | null;
  costCenterName?: string | null;
}) {
  const costCenterId = input.costCenterId || null;
  const costCenterCode = normalizedCode(input.costCenterCode ?? null);
  const costCenterName = input.costCenterName?.trim() || "Sin centro asignado";
  return {
    key: costCenterId ? `id:${costCenterId}` : costCenterCode ? `code:${costCenterCode}` : UNALLOCATED_KEY,
    costCenterId,
    costCenterCode,
    costCenterName,
  };
}

function addAllocation(
  target: Map<string, EffectivePayrollAllocation>,
  identity: ReturnType<typeof allocationIdentity>,
  amount: number,
) {
  const current = target.get(identity.key) ?? { ...identity, amount: 0 };
  current.amount = round(current.amount + amount);
  target.set(identity.key, current);
}

function balanceAllocations(target: Map<string, EffectivePayrollAllocation>, expectedTotal: number) {
  const actualTotal = [...target.values()].reduce((total, allocation) => total + allocation.amount, 0);
  const difference = round(expectedTotal - actualTotal);
  if (!difference) return;
  const receiver = [...target.values()].sort((left, right) => Math.abs(right.amount) - Math.abs(left.amount))[0];
  if (receiver) receiver.amount = round(receiver.amount + difference);
  else addAllocation(target, allocationIdentity({}), difference);
}

function officialPayroll(
  period: string,
  lines: ReportingPayrollCostLine[],
): EffectivePayroll | null {
  const officialLines = lines.filter((line) => line.data_basis === "official_payroll" && normalizedPeriod(line.period_month) === period);
  if (!officialLines.length) return null;
  const allocations = new Map<string, EffectivePayrollAllocation>();
  for (const line of officialLines) {
    addAllocation(allocations, allocationIdentity({
      costCenterCode: line.cost_center_code,
      costCenterName: line.cost_center_name,
    }), Math.max(0, number(line.amount)));
  }
  const amount = round(officialLines.reduce((total, line) => total + Math.max(0, number(line.amount)), 0));
  balanceAllocations(allocations, amount);
  return { period, amount, basis: "official", revisionId: null, allocations: [...allocations.values()] };
}

function provisionPayroll(
  period: string,
  provision: ReportingPayrollProvision | undefined,
  revisions: ReportingPayrollRevision[],
  lines: ReportingPayrollProvisionLine[],
): EffectivePayroll | null {
  if (!provision || number(provision.posted_amount) <= 0) return null;
  const latest = revisions
    .filter((revision) => revision.provision_id === provision.id && revision.status === "posted")
    .sort((left, right) => right.as_of_date.localeCompare(left.as_of_date))[0];
  if (!latest) return null;

  const revisionLines = lines.filter((line) => line.revision_id === latest.id);
  const sourceLines = revisionLines.filter((line) => line.source_type === "peoplework");
  const sourceTotal = sourceLines.reduce((total, line) => total + Math.max(0, number(line.amount)), 0);
  const allocations = new Map<string, EffectivePayrollAllocation>();

  for (const line of sourceLines) {
    addAllocation(allocations, allocationIdentity({
      costCenterId: line.cost_center_id,
      costCenterCode: line.source_cost_center_code,
      costCenterName: line.source_cost_center_name,
    }), Math.max(0, number(line.amount)));
  }

  for (const line of revisionLines.filter((item) => item.source_type === "manual")) {
    const signedAmount = (line.direction === "deduct" ? -1 : 1) * Math.max(0, number(line.amount));
    if (line.cost_center_id) {
      addAllocation(allocations, allocationIdentity({ costCenterId: line.cost_center_id }), signedAmount);
      continue;
    }
    if (sourceTotal > 0 && sourceLines.length) {
      let distributed = 0;
      sourceLines.forEach((source, index) => {
        const share = index === sourceLines.length - 1
          ? round(signedAmount - distributed)
          : round(signedAmount * Math.max(0, number(source.amount)) / sourceTotal);
        distributed = round(distributed + share);
        addAllocation(allocations, allocationIdentity({
          costCenterId: source.cost_center_id,
          costCenterCode: source.source_cost_center_code,
          costCenterName: source.source_cost_center_name,
        }), share);
      });
    } else {
      addAllocation(allocations, allocationIdentity({}), signedAmount);
    }
  }

  const amount = round(number(provision.posted_amount));
  balanceAllocations(allocations, amount);
  return { period, amount, basis: "posted_provision", revisionId: latest.id, allocations: [...allocations.values()] };
}

export function buildEffectivePayrollByMonth(input: {
  periods: string[];
  payrollCostLines: ReportingPayrollCostLine[];
  provisions: ReportingPayrollProvision[];
  revisions: ReportingPayrollRevision[];
  provisionLines: ReportingPayrollProvisionLine[];
}) {
  const provisionByPeriod = new Map(input.provisions.map((provision) => [normalizedPeriod(provision.period_month), provision]));
  return new Map(input.periods.map((period) => {
    const official = officialPayroll(period, input.payrollCostLines);
    if (official) return [period, official];
    const provision = provisionPayroll(period, provisionByPeriod.get(period), input.revisions, input.provisionLines);
    if (provision) return [period, provision];
    return [period, { period, amount: 0, basis: "missing", revisionId: null, allocations: [] } satisfies EffectivePayroll];
  }));
}
