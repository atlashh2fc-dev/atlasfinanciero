import { NextRequest, NextResponse } from "next/server";
import { isUuid, requireOrganizationFinanceAccess } from "@/lib/admin-access";

export const dynamic = "force-dynamic";

function amount(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoDateMonthsAgo(months: number) {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString().slice(0, 10);
}

function isCurrentContract(contract: { end_date: string | null }) {
  return !contract.end_date || contract.end_date >= new Date().toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!isUuid(organizationId)) {
    return NextResponse.json({ error: "invalid_organization" }, { status: 400 });
  }

  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase) {
    return NextResponse.json({ error: context.error }, { status: context.status });
  }

  const since = isoDateMonthsAgo(12);
  const [organizationResult, documentsResult, peopleResult, contractsResult, siiResult, payrollIntegrationResult] = await Promise.all([
    context.supabase.from("organizations").select("legal_name, tax_id, created_at").eq("id", organizationId).maybeSingle(),
    context.supabase.from("issued_documents").select("issue_date, document_type, net_amount").eq("organization_id", organizationId).gte("issue_date", since),
    context.supabase.from("payroll_people").select("id, is_active").eq("organization_id", organizationId).eq("provider", "peoplework"),
    context.supabase.from("payroll_contracts").select("person_id, end_date, monthly_gross_salary").eq("organization_id", organizationId).eq("provider", "peoplework"),
    context.supabase.from("sii_integrations").select("is_enabled, configured_at").eq("organization_id", organizationId).maybeSingle(),
    context.supabase.from("payroll_integrations").select("is_active, last_sync_at").eq("organization_id", organizationId).eq("provider", "peoplework").maybeSingle(),
  ]);

  if (organizationResult.error || documentsResult.error || peopleResult.error || contractsResult.error || siiResult.error || payrollIntegrationResult.error) {
    return NextResponse.json({ error: "unable_to_load_benefits_profile" }, { status: 500 });
  }

  const documents = documentsResult.data ?? [];
  const documentedSales = documents.reduce((total, document) => {
    const type = (document.document_type ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const value = amount(document.net_amount);
    return type.includes("nota de credito") ? total - Math.abs(value) : total + value;
  }, 0);
  const currentContracts = (contractsResult.data ?? []).filter(isCurrentContract);
  const activePeople = (peopleResult.data ?? []).filter((person) => person.is_active).length;

  return NextResponse.json({
    profile: {
      organizationName: organizationResult.data?.legal_name ?? "Organización",
      taxId: organizationResult.data?.tax_id ?? null,
      organizationCreatedAt: organizationResult.data?.created_at ?? null,
      documentedSalesLast12Months: documentedSales,
      documentsLast12Months: documents.length,
      activePeople,
      activeContracts: currentContracts.length,
      monthlyGrossPayroll: currentContracts.reduce((total, contract) => total + amount(contract.monthly_gross_salary), 0),
      siiConnected: Boolean(siiResult.data?.is_enabled),
      siiConfiguredAt: siiResult.data?.configured_at ?? null,
      payrollConnected: Boolean(payrollIntegrationResult.data?.is_active),
      payrollSyncedAt: payrollIntegrationResult.data?.last_sync_at ?? null,
    },
    checkedAt: new Date().toISOString(),
  });
}
