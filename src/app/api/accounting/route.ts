import { NextRequest, NextResponse } from "next/server";
import {
  isUuid,
  requireOrganizationExpenseReadAccess,
  requireOrganizationFinanceAccess,
} from "@/lib/admin-access";

const natures = ["asset", "liability", "equity", "revenue", "expense"] as const;
const balances = ["debit", "credit"] as const;
const areas = ["statement_of_financial_position", "profit_or_loss", "other_comprehensive_income", "cash_flow", "management"] as const;

function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function trimmed(value: unknown, maxLength: number, required = false) {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return (!result && required) || result.length > maxLength ? null : result || null;
}

function positiveAmount(value: unknown) {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;
}

function requestedYear(value: string | null) {
  if (!value || !/^\d{4}$/.test(value)) return new Date().getFullYear();
  const year = Number(value);
  return year >= 2000 && year <= 2100 ? year : new Date().getFullYear();
}

type AccountingLine = { entry_id: string; account_id: string; line_number: number; description: string | null; currency_code: string; functional_debit: number | string; functional_credit: number | string };

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  if (!isUuid(organizationId)) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const context = await requireOrganizationExpenseReadAccess(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });

  const year = requestedYear(request.nextUrl.searchParams.get("year"));
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const [periodsResult, accountsResult, roleResult] = await Promise.all([
    context.supabase.from("financial_periods")
      .select("id, period_start, period_end, status, notes")
      .eq("organization_id", organizationId)
      .gte("period_start", from).lte("period_start", to)
      .order("period_start", { ascending: false }),
    context.supabase.from("chart_of_accounts")
      .select("id, account_code, account_name, nature, normal_balance, statement_area, presentation_group, is_postable, is_active")
      .eq("organization_id", organizationId).eq("is_active", true)
      .order("account_code"),
    context.supabase.from("organization_memberships")
      .select("role").eq("organization_id", organizationId).eq("user_id", context.user?.id ?? "").maybeSingle(),
  ]);
  if (periodsResult.error || accountsResult.error || roleResult.error) return NextResponse.json({ error: "unable_to_load_accounting" }, { status: 500 });

  const periods = periodsResult.data ?? [];
  const requestedPeriodId = request.nextUrl.searchParams.get("periodId");
  const selectedPeriod = periods.find((period) => period.id === requestedPeriodId) ?? periods[0] ?? null;
  const accounts = accountsResult.data ?? [];
  if (!selectedPeriod) return NextResponse.json({ role: roleResult.data?.role ?? null, year, periods, accounts, entries: [], trialBalance: [], ledger: [] });

  const [periodEntriesResult, historicEntriesResult] = await Promise.all([
    context.supabase.from("accounting_entries")
      .select("id, financial_period_id, entry_date, status, description, external_reference, posted_at, created_at")
      .eq("organization_id", organizationId).eq("financial_period_id", selectedPeriod.id)
      .order("entry_date", { ascending: false }).order("created_at", { ascending: false }).limit(500),
    context.supabase.from("accounting_entries")
      .select("id, entry_date, description, external_reference")
      .eq("organization_id", organizationId).eq("status", "posted")
      .lte("entry_date", selectedPeriod.period_end)
      .order("entry_date", { ascending: true }).limit(5_000),
  ]);
  if (periodEntriesResult.error || historicEntriesResult.error) return NextResponse.json({ error: "unable_to_load_accounting_entries" }, { status: 500 });

  const periodEntries = periodEntriesResult.data ?? [];
  const historicEntries = historicEntriesResult.data ?? [];
  const allEntryIds = [...new Set([...periodEntries.map((entry) => entry.id), ...historicEntries.map((entry) => entry.id)])];
  let lines: AccountingLine[] = [];
  for (let index = 0; index < allEntryIds.length; index += 500) {
    const { data, error } = await context.supabase.from("accounting_entry_lines")
      .select("entry_id, account_id, line_number, description, currency_code, functional_debit, functional_credit")
      .eq("organization_id", organizationId).in("entry_id", allEntryIds.slice(index, index + 500))
      .order("line_number");
    if (error) return NextResponse.json({ error: "unable_to_load_accounting_lines" }, { status: 500 });
    lines = lines.concat((data ?? []) as AccountingLine[]);
  }

  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const linesByEntry = new Map<string, AccountingLine[]>();
  for (const line of lines) {
    const current = linesByEntry.get(line.entry_id) ?? [];
    current.push(line);
    linesByEntry.set(line.entry_id, current);
  }
  const historicIds = new Set(historicEntries.map((entry) => entry.id));
  const balanceByAccount = new Map<string, { debit: number; credit: number }>();
  for (const line of lines) {
    if (!historicIds.has(line.entry_id)) continue;
    const current = balanceByAccount.get(line.account_id) ?? { debit: 0, credit: 0 };
    current.debit += Number(line.functional_debit);
    current.credit += Number(line.functional_credit);
    balanceByAccount.set(line.account_id, current);
  }
  const trialBalance = accounts.map((account) => {
    const totals = balanceByAccount.get(account.id) ?? { debit: 0, credit: 0 };
    return { ...account, debit: totals.debit, credit: totals.credit, debitBalance: Math.max(totals.debit - totals.credit, 0), creditBalance: Math.max(totals.credit - totals.debit, 0) };
  }).filter((account) => account.debit || account.credit);
  const entries = periodEntries.map((entry) => ({
    ...entry,
    lines: (linesByEntry.get(entry.id) ?? []).map((line) => ({ ...line, account: accountById.get(line.account_id) ?? null })),
  }));
  const selectedIds = new Set(periodEntries.filter((entry) => entry.status === "posted").map((entry) => entry.id));
  const ledger = historicEntries
    .filter((entry) => selectedIds.has(entry.id))
    .flatMap((entry) => (linesByEntry.get(entry.id) ?? []).map((line) => ({
      entryId: entry.id, entryDate: entry.entry_date, entryDescription: entry.description, externalReference: entry.external_reference,
      ...line, account: accountById.get(line.account_id) ?? null,
    })));

  return NextResponse.json({ role: roleResult.data?.role ?? null, year, periods, selectedPeriodId: selectedPeriod.id, accounts, entries, trialBalance, ledger });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const organizationId = body?.organizationId;
  if (!isUuid(organizationId) || typeof body?.action !== "string") return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const context = await requireOrganizationFinanceAccess(organizationId);
  if (context.error || !context.supabase) return NextResponse.json({ error: context.error }, { status: context.status });

  if (body.action === "create_account") {
    const account = body.account as Record<string, unknown> | null;
    const code = trimmed(account?.code, 30, true)?.toUpperCase();
    const name = trimmed(account?.name, 180, true);
    const nature = account?.nature;
    const normalBalance = account?.normalBalance;
    const statementArea = account?.statementArea;
    const group = trimmed(account?.presentationGroup, 120);
    if (!code || !/^[A-Z0-9._-]+$/.test(code) || !name || !natures.includes(nature as typeof natures[number]) || !balances.includes(normalBalance as typeof balances[number]) || !areas.includes(statementArea as typeof areas[number])) return NextResponse.json({ error: "invalid_account" }, { status: 400 });
    const { data, error } = await context.supabase.from("chart_of_accounts").insert({
      organization_id: organizationId, account_code: code, account_name: name, nature, normal_balance: normalBalance,
      statement_area: statementArea, presentation_group: group, is_postable: true, is_active: true,
    }).select("id, account_code, account_name, nature, normal_balance, statement_area, presentation_group, is_postable, is_active").single();
    if (error || !data) return NextResponse.json({ error: "unable_to_create_account" }, { status: 409 });
    return NextResponse.json({ account: data }, { status: 201 });
  }

  if (body.action === "install_chilean_ifrs_standard") {
    const { data, error } = await context.supabase.rpc("seed_chilean_ifrs_chart_of_accounts", {
      p_organization_id: organizationId,
    });
    if (error) return NextResponse.json({ error: "unable_to_install_ifrs_standard", detail: error.message }, { status: 409 });
    return NextResponse.json({ insertedAccounts: Number(data ?? 0) });
  }

  if (body.action === "generate_ifrs_source_entries") {
    const periodId = body.periodId;
    if (!isUuid(periodId)) return NextResponse.json({ error: "invalid_period" }, { status: 400 });
    const { data: period, error: periodError } = await context.supabase
      .from("financial_periods")
      .select("period_end, status")
      .eq("id", periodId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (periodError || !period) return NextResponse.json({ error: "period_not_found" }, { status: 404 });
    if (["closed", "locked"].includes(period.status)) return NextResponse.json({ error: "closed_period" }, { status: 409 });
    const { data, error } = await context.supabase.rpc("generate_ifrs_source_entries", {
      p_organization_id: organizationId,
      p_cutoff_date: period.period_end,
    });
    if (error) return NextResponse.json({ error: "unable_to_generate_ifrs_entries", detail: error.message }, { status: 409 });
    const result = Array.isArray(data) ? data[0] : data;
    return NextResponse.json({ generatedEntries: Number(result?.generated_entries ?? 0), skippedClosedPeriods: Number(result?.skipped_closed_periods ?? 0) });
  }

  if (body.action === "post_manual_entry") {
    const lines = Array.isArray(body.lines) ? body.lines : [];
    const periodId = body.periodId;
    const entryDate = body.entryDate;
    const description = trimmed(body.description, 500, true);
    const externalReference = trimmed(body.externalReference, 180);
    const currencyCode = trimmed(body.currencyCode, 3, true)?.toUpperCase();
    if (!isUuid(periodId) || !isDate(entryDate) || !description || !currencyCode || !/^[A-Z]{3}$/.test(currencyCode) || lines.length < 2 || lines.length > 200) return NextResponse.json({ error: "invalid_manual_entry" }, { status: 400 });
    const normalizedLines = lines.map((line) => {
      const item = line as Record<string, unknown>;
      return { account_id: item.accountId, debit: positiveAmount(item.debit) ?? 0, credit: positiveAmount(item.credit) ?? 0, description: trimmed(item.description, 500) };
    });
    const isValid = normalizedLines.every((line) => isUuid(line.account_id) && (line.debit > 0) !== (line.credit > 0));
    const debit = normalizedLines.reduce((total, line) => total + line.debit, 0);
    const credit = normalizedLines.reduce((total, line) => total + line.credit, 0);
    if (!isValid || Math.round(debit * 100) !== Math.round(credit * 100) || debit <= 0) return NextResponse.json({ error: "unbalanced_manual_entry" }, { status: 400 });
    const { data, error } = await context.supabase.rpc("post_manual_accounting_entry", {
      p_organization_id: organizationId, p_financial_period_id: periodId, p_entry_date: entryDate,
      p_description: description, p_external_reference: externalReference, p_currency_code: currencyCode, p_lines: normalizedLines,
    });
    if (error || !data) return NextResponse.json({ error: "unable_to_post_manual_entry", detail: error?.message ?? null }, { status: 409 });
    return NextResponse.json({ entry: data }, { status: 201 });
  }
  return NextResponse.json({ error: "unsupported_action" }, { status: 400 });
}
