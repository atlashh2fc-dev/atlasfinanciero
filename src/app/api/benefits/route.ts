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

const programCatalog = {
  "sence-activacion": { name: "Subsidio a la contratación · Activación Laboral", institution: "SENCE", url: "https://www.subsidioalempleo.cl/" },
  "sence-franquicia": { name: "Franquicia Tributaria de Capacitación", institution: "SENCE", url: "https://sence.gob.cl/empresas/franquicia-tributaria" },
  "sercotec-crece": { name: "Crece", institution: "Sercotec", url: "https://www.sercotec.cl/calendario/" },
  "sercotec-sostenible": { name: "Crece Sostenible", institution: "Sercotec", url: "https://www.sercotec.cl/calendario/" },
  corfo: { name: "Convocatorias de innovación y escalamiento", institution: "CORFO", url: "https://www.corfo.cl/sites/cpp/convocatorias" },
  "fosis-innova": { name: "Innova FOSIS", institution: "FOSIS", url: "https://www.fosis.gob.cl/es/programas/innova-fosis/convocatoria-innova-fosis/" },
} as const;

const applicationStatuses = new Set(["preparing", "ready_for_submission", "submitted", "not_selected", "awarded", "withdrawn"]);

function isBenefitsWorkspaceMissing(error: { code?: string } | null) {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

function readText(value: unknown, maxLength: number) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" && value.trim().length <= maxLength ? value.trim() : undefined;
}

function readDate(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function readAmount(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function financeContext(organizationId: string | null) {
  if (!isUuid(organizationId)) return { error: "invalid_organization" as const, status: 400, supabase: null, user: null };
  return requireOrganizationFinanceAccess(organizationId);
}

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  const context = await financeContext(organizationId);
  if (context.error || !context.supabase) {
    return NextResponse.json({ error: context.error }, { status: context.status });
  }

  const since = isoDateMonthsAgo(12);
  const [organizationResult, documentsResult, peopleResult, contractsResult, siiResult, payrollIntegrationResult, benefitsProfileResult, applicationsResult] = await Promise.all([
    context.supabase.from("organizations").select("legal_name, tax_id, created_at").eq("id", organizationId).maybeSingle(),
    context.supabase.from("issued_documents").select("issue_date, document_type, net_amount").eq("organization_id", organizationId).gte("issue_date", since),
    context.supabase.from("payroll_people").select("id, full_name, is_active").eq("organization_id", organizationId).eq("provider", "peoplework"),
    context.supabase.from("payroll_contracts").select("person_id, start_date, end_date, monthly_gross_salary").eq("organization_id", organizationId).eq("provider", "peoplework"),
    context.supabase.from("sii_integrations").select("is_enabled, configured_at").eq("organization_id", organizationId).maybeSingle(),
    context.supabase.from("payroll_integrations").select("is_active, last_sync_at").eq("organization_id", organizationId).eq("provider", "peoplework").maybeSingle(),
    context.supabase.from("benefits_company_profiles").select("region, commune, business_sector, legal_start_date, first_category_confirmed, annual_sales_verified, tax_folder_reviewed_at, no_tax_or_labor_debt_declared, no_pending_public_renditions_declared, project_focus, project_budget").eq("organization_id", organizationId).maybeSingle(),
    context.supabase.from("benefits_applications").select("id, program_id, program_name, institution, official_url, status, deadline, notes, updated_at").eq("organization_id", organizationId).order("updated_at", { ascending: false }),
  ]);

  const benefitsWorkspaceMissing = isBenefitsWorkspaceMissing(benefitsProfileResult.error) || isBenefitsWorkspaceMissing(applicationsResult.error);
  if (organizationResult.error || documentsResult.error || peopleResult.error || contractsResult.error || siiResult.error || payrollIntegrationResult.error || (!benefitsWorkspaceMissing && (benefitsProfileResult.error || applicationsResult.error))) {
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
  const peopleById = new Map((peopleResult.data ?? []).map((person) => [person.id, person]));
  const senceSalaryLimit = 553_553 * 3;
  const senceCandidates = currentContracts
    .filter((contract) => contract.start_date && contract.start_date >= "2026-07-15" && amount(contract.monthly_gross_salary) <= senceSalaryLimit)
    .map((contract) => ({
      personId: contract.person_id,
      personName: peopleById.get(contract.person_id)?.full_name ?? "Colaborador sin nombre sincronizado",
      startDate: contract.start_date,
      monthlyGrossSalary: amount(contract.monthly_gross_salary),
    }));

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
      configuration: benefitsWorkspaceMissing ? {
        region: null,
        commune: null,
        business_sector: null,
        legal_start_date: null,
        first_category_confirmed: false,
        annual_sales_verified: false,
        tax_folder_reviewed_at: null,
        no_tax_or_labor_debt_declared: false,
        no_pending_public_renditions_declared: false,
        project_focus: null,
        project_budget: null,
      } : benefitsProfileResult.data,
    },
    sence: { salaryLimit: senceSalaryLimit, candidates: senceCandidates },
    applications: benefitsWorkspaceMissing ? [] : applicationsResult.data ?? [],
    workspaceReady: !benefitsWorkspaceMissing,
    checkedAt: new Date().toISOString(),
  });
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const organizationId = body?.organizationId;
  const context = await financeContext(organizationId as string | null);
  if (context.error || !context.supabase || !isUuid(organizationId)) return NextResponse.json({ error: context.error }, { status: context.status });

  const region = readText(body?.region, 100);
  const commune = readText(body?.commune, 100);
  const businessSector = readText(body?.businessSector, 160);
  const legalStartDate = readDate(body?.legalStartDate);
  const taxFolderReviewedAt = readDate(body?.taxFolderReviewedAt);
  const projectFocus = readText(body?.projectFocus, 1000);
  const projectBudget = readAmount(body?.projectBudget);
  const flags = ["firstCategoryConfirmed", "annualSalesVerified", "noTaxOrLaborDebtDeclared", "noPendingPublicRenditionsDeclared"];
  if ([region, commune, businessSector, legalStartDate, taxFolderReviewedAt, projectFocus, projectBudget].some((value) => value === undefined) || flags.some((key) => typeof body?.[key] !== "boolean")) {
    return NextResponse.json({ error: "invalid_benefits_profile" }, { status: 400 });
  }

  const { error } = await context.supabase.from("benefits_company_profiles").upsert({
    organization_id: organizationId,
    region,
    commune,
    business_sector: businessSector,
    legal_start_date: legalStartDate,
    first_category_confirmed: body?.firstCategoryConfirmed,
    annual_sales_verified: body?.annualSalesVerified,
    tax_folder_reviewed_at: taxFolderReviewedAt,
    no_tax_or_labor_debt_declared: body?.noTaxOrLaborDebtDeclared,
    no_pending_public_renditions_declared: body?.noPendingPublicRenditionsDeclared,
    project_focus: projectFocus,
    project_budget: projectBudget,
  }, { onConflict: "organization_id" });
  if (isBenefitsWorkspaceMissing(error)) return NextResponse.json({ error: "benefits_workspace_not_migrated" }, { status: 409 });
  if (error) return NextResponse.json({ error: "unable_to_save_benefits_profile" }, { status: 409 });
  return NextResponse.json({ ok: true });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const organizationId = body?.organizationId;
  const programId = body?.programId;
  const context = await financeContext(organizationId as string | null);
  if (context.error || !context.supabase || !isUuid(organizationId)) return NextResponse.json({ error: context.error }, { status: context.status });
  if (typeof programId !== "string" || !(programId in programCatalog)) return NextResponse.json({ error: "invalid_benefits_program" }, { status: 400 });
  const program = programCatalog[programId as keyof typeof programCatalog];
  const { data, error } = await context.supabase.from("benefits_applications").upsert({
    organization_id: organizationId,
    program_id: programId,
    program_name: program.name,
    institution: program.institution,
    official_url: program.url,
    status: "preparing",
  }, { onConflict: "organization_id,program_id" }).select("id, program_id, status").single();
  if (isBenefitsWorkspaceMissing(error)) return NextResponse.json({ error: "benefits_workspace_not_migrated" }, { status: 409 });
  if (error) return NextResponse.json({ error: "unable_to_create_benefits_application" }, { status: 409 });
  return NextResponse.json({ application: data });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const organizationId = body?.organizationId;
  const applicationId = body?.applicationId;
  const status = body?.status;
  const deadline = readDate(body?.deadline);
  const notes = readText(body?.notes, 2000);
  const context = await financeContext(organizationId as string | null);
  if (context.error || !context.supabase || !isUuid(organizationId) || !isUuid(applicationId) || typeof status !== "string" || !applicationStatuses.has(status) || deadline === undefined || notes === undefined) return NextResponse.json({ error: "invalid_benefits_application" }, { status: 400 });
  const { error } = await context.supabase.from("benefits_applications").update({ status, deadline, notes }).eq("id", applicationId).eq("organization_id", organizationId);
  if (isBenefitsWorkspaceMissing(error)) return NextResponse.json({ error: "benefits_workspace_not_migrated" }, { status: 409 });
  if (error) return NextResponse.json({ error: "unable_to_update_benefits_application" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
