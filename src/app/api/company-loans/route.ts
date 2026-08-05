import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationFinanceAccess } from "@/lib/admin-access";

function isDate(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function amount(value: unknown, allowZero = false) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) return null;
  return Math.round(parsed * 100) / 100;
}

function text(value: unknown, maxLength: number) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result && result.length <= maxLength ? result : null;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const organizationId = body?.organizationId;
  if (!isUuid(organizationId) || typeof body?.action !== "string") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase) {
    return NextResponse.json({ error: context.error }, { status: context.status });
  }

  if (body.action === "create_loan") {
    const borrowerCounterpartyId = body.borrowerCounterpartyId;
    const bankAccountId = body.bankAccountId;
    const contractDate = body.contractDate;
    const disbursementDate = body.disbursementDate;
    const maturityDate = body.maturityDate;
    const principalAmount = amount(body.principalAmount);
    const annualInterestRate = amount(body.annualInterestRate, true);
    const agreementReference = text(body.agreementReference, 180);
    const purpose = text(body.purpose, 2_000);
    const relatedParty = body.relatedParty === true;
    const stampTaxStatus = typeof body.stampTaxStatus === "string" ? body.stampTaxStatus : "review";
    if (
      !isUuid(borrowerCounterpartyId)
      || !isUuid(bankAccountId)
      || !isDate(contractDate)
      || !isDate(disbursementDate)
      || !isDate(maturityDate)
      || !principalAmount
      || annualInterestRate === null
      || annualInterestRate > 100
      || !["review", "pending", "paid", "not_applicable"].includes(stampTaxStatus)
      || (body.agreementReference && !agreementReference)
      || (body.purpose && !purpose)
    ) {
      return NextResponse.json({ error: "invalid_loan" }, { status: 400 });
    }
    const { data, error } = await context.supabase.rpc("create_company_loan", {
      p_organization_id: organizationId,
      p_borrower_counterparty_id: borrowerCounterpartyId,
      p_bank_account_id: bankAccountId,
      p_contract_date: contractDate,
      p_disbursement_date: disbursementDate,
      p_maturity_date: maturityDate,
      p_principal_amount: principalAmount,
      p_annual_interest_rate: annualInterestRate,
      p_agreement_reference: agreementReference,
      p_purpose: purpose,
      p_related_party: relatedParty,
      p_stamp_tax_status: stampTaxStatus,
    });
    if (error || !data) {
      return NextResponse.json(
        { error: "unable_to_create_loan", detail: error?.message ?? null },
        { status: 409 },
      );
    }
    return NextResponse.json({ loan: data }, { status: 201 });
  }

  if (body.action === "create_repayment_event") {
    const loanId = body.loanId;
    const bankAccountId = body.bankAccountId;
    const scheduledOn = body.scheduledOn;
    const principalAmount = amount(body.principalAmount, true);
    const interestAmount = amount(body.interestAmount, true);
    const notes = text(body.notes, 2_000);
    if (
      !isUuid(loanId)
      || !isUuid(bankAccountId)
      || !isDate(scheduledOn)
      || principalAmount === null
      || interestAmount === null
      || principalAmount + interestAmount <= 0
      || (body.notes && !notes)
    ) {
      return NextResponse.json({ error: "invalid_repayment_event" }, { status: 400 });
    }
    const { data, error } = await context.supabase.rpc("create_company_loan_repayment_event", {
      p_organization_id: organizationId,
      p_loan_id: loanId,
      p_bank_account_id: bankAccountId,
      p_scheduled_on: scheduledOn,
      p_principal_amount: principalAmount,
      p_interest_amount: interestAmount,
      p_notes: notes,
    });
    if (error || !data) {
      return NextResponse.json(
        { error: "unable_to_create_repayment_event", detail: error?.message ?? null },
        { status: 409 },
      );
    }
    return NextResponse.json({ event: data }, { status: 201 });
  }

  return NextResponse.json({ error: "unsupported_action" }, { status: 400 });
}
