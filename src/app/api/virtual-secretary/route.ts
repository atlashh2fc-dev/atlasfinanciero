import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/admin-access";
import { buildMonthlyRevenueSchedule, calculateSubscriptionAmounts, inclusiveEndDate, isSubscriptionStatus, renewalAlertDates } from "@/lib/virtual-secretary";

const writeRoles = new Set(["administrator", "finance", "operations"]);
const treasuryRoles = new Set(["administrator", "finance"]);
const currencies = new Set(["CLP", "UF", "USD"]);
const allowedMimeTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);

function text(value: unknown, max: number, required = false) {
  if (typeof value !== "string") return required ? undefined : null;
  const result = value.trim();
  return result.length > max || (required && !result) ? undefined : result || null;
}

function number(value: unknown, min = 0, max = 999_999_999_999) {
  const result = Number(value);
  return Number.isFinite(result) && result >= min && result <= max ? result : undefined;
}

function date(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : undefined;
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isGeimser(name: string | null | undefined) {
  return (name ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/gi, "").toLowerCase().includes("geimser");
}

async function context(organizationId: unknown, write = false, treasury = false) {
  if (!isUuid(organizationId)) return { error: "invalid_organization", status: 400 } as const;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "authentication_required", status: 401 } as const;
  const [{ data: membership }, { data: organization }] = await Promise.all([
    supabase.from("organization_memberships").select("role").eq("organization_id", organizationId).eq("user_id", user.id).maybeSingle(),
    supabase.from("organizations").select("legal_name").eq("id", organizationId).maybeSingle(),
  ]);
  if (!membership || !organization) return { error: "organization_access_required", status: 403 } as const;
  if (!isGeimser(organization.legal_name)) return { error: "virtual_secretary_is_only_available_for_geimser", status: 403 } as const;
  if (write && !writeRoles.has(membership.role)) return { error: "subscription_write_not_authorized", status: 403 } as const;
  if (treasury && !treasuryRoles.has(membership.role)) return { error: "treasury_authorization_required", status: 403 } as const;
  return { error: null, status: 200, supabase, user, role: membership.role, organizationId } as const;
}

const subscriptionSelect = "id, subscription_code, product_id, plan_id, counterparty_id, customer_type, billing_contact_email, operational_contact_email, sales_owner_id, service_owner_id, opportunity_id, quote_id, contract_id, issued_document_id, status, currency_code, list_net_amount, discount_amount, net_amount, tax_rate, tax_amount, gross_amount, validated_paid_amount, payment_validation_amount, outstanding_amount, contracted_months, projected_start_on, current_start_on, current_end_on, next_renewal_on, due_on, grace_period_days, automatic_renewal, sale_origin, special_conditions, activated_at, suspension_reason, cancellation_reason, created_at, updated_at";

export async function GET(request: NextRequest) {
  const organizationId = request.nextUrl.searchParams.get("organizationId");
  const access = await context(organizationId);
  if (access.error || !access.supabase) return NextResponse.json({ error: access.error }, { status: access.status });
  const id = request.nextUrl.searchParams.get("id");
  const [products, plans, customers, opportunities, quotes, contracts, subscriptions, periods, payments, alerts, events, revenue] = await Promise.all([
    access.supabase.from("service_products").select("*").eq("organization_id", organizationId).eq("code", "SECRETARIA-VIRTUAL").order("name"),
    access.supabase.from("service_plans").select("*").eq("organization_id", organizationId).order("duration_months"),
    access.supabase.from("counterparties").select("id, legal_name, trade_name, tax_id, email, billing_email, kind").eq("organization_id", organizationId).in("kind", ["customer", "both"]).eq("is_active", true).order("legal_name"),
    access.supabase.from("commercial_opportunities").select("id, counterparty_id, title, stage").eq("organization_id", organizationId).order("updated_at", { ascending: false }),
    access.supabase.from("sales_quotes").select("id, counterparty_id, quote_number, title, status").eq("organization_id", organizationId).order("updated_at", { ascending: false }),
    access.supabase.from("commercial_contracts").select("id, counterparty_id, contract_code, name, status").eq("organization_id", organizationId).order("updated_at", { ascending: false }),
    access.supabase.from("service_subscriptions").select(subscriptionSelect).eq("organization_id", organizationId).order("created_at", { ascending: false }),
    access.supabase.from("subscription_periods").select("*").eq("organization_id", organizationId).order("sequence_number"),
    access.supabase.from("subscription_payments").select("*").eq("organization_id", organizationId).order("paid_at", { ascending: false }),
    access.supabase.from("subscription_alerts").select("*").eq("organization_id", organizationId).order("alert_on"),
    access.supabase.from("subscription_events").select("*").eq("organization_id", organizationId).order("created_at", { ascending: false }),
    access.supabase.from("subscription_revenue_schedule").select("*").eq("organization_id", organizationId).order("recognition_on"),
  ]);
  const failed = [products, plans, customers, opportunities, quotes, contracts, subscriptions, periods, payments, alerts, events, revenue].find((result) => result.error);
  if (failed?.error) return NextResponse.json({ error: "unable_to_load_virtual_secretary", detail: failed.error.message }, { status: 500 });
  const filter = <T extends { subscription_id?: string; id?: string }>(rows: T[] | null) => id ? (rows ?? []).filter((row) => row.subscription_id === id || row.id === id) : rows ?? [];
  return NextResponse.json({ role: access.role, products: products.data ?? [], plans: plans.data ?? [], customers: customers.data ?? [], opportunities: opportunities.data ?? [], quotes: quotes.data ?? [], contracts: contracts.data ?? [], subscriptions: filter(subscriptions.data), periods: filter(periods.data), payments: filter(payments.data), alerts: filter(alerts.data), events: filter(events.data), revenueSchedule: filter(revenue.data) });
}

async function createSale(access: Exclude<Awaited<ReturnType<typeof context>>, { error: string }>, body: Record<string, unknown>) {
  const { supabase, organizationId, user, role } = access;
  const planId = isUuid(body.planId) ? body.planId : null;
  const counterpartyId = isUuid(body.counterpartyId) ? body.counterpartyId : null;
  const startOn = date(body.startOn);
  const dueOn = date(body.dueOn);
  const customerType = body.customerType === "individual" || body.customerType === "company" ? body.customerType : null;
  const billingEmail = text(body.billingEmail, 320, true);
  const operationalEmail = text(body.operationalEmail, 320, true);
  const discount = number(body.discountAmount, 0);
  if (!planId || !counterpartyId || !startOn || !dueOn || !customerType || !billingEmail || !operationalEmail || discount === undefined) return NextResponse.json({ error: "invalid_subscription_sale" }, { status: 400 });
  if (!isEmail(billingEmail) || !isEmail(operationalEmail) || dueOn < new Date().toISOString().slice(0, 10)) return NextResponse.json({ error: "invalid_subscription_contacts_or_due_date" }, { status: 400 });
  const [{ data: product }, { data: plan }, { data: customer }] = await Promise.all([
    supabase.from("service_products").select("id, tax_rate").eq("organization_id", organizationId).eq("code", "SECRETARIA-VIRTUAL").eq("is_active", true).maybeSingle(),
    supabase.from("service_plans").select("*").eq("organization_id", organizationId).eq("id", planId).eq("is_active", true).maybeSingle(),
    supabase.from("counterparties").select("id, tax_id").eq("organization_id", organizationId).eq("id", counterpartyId).eq("is_active", true).maybeSingle(),
  ]);
  if (!product || !plan || plan.product_id !== product.id || !customer) return NextResponse.json({ error: "subscription_master_data_not_found" }, { status: 404 });
  const exceptionReason = text(body.exceptionReason, 1000);
  if (plan.is_exceptional && (!treasuryRoles.has(role) || !exceptionReason)) return NextResponse.json({ error: "monthly_plan_requires_authorized_exception" }, { status: 403 });
  if (discount > 0 && !treasuryRoles.has(role)) return NextResponse.json({ error: "discount_requires_authorization" }, { status: 403 });
  if (customerType === "company" && !customer.tax_id) return NextResponse.json({ error: "company_tax_id_required" }, { status: 409 });
  const sourceLinks = [
    ["commercial_opportunities", body.opportunityId],
    ["sales_quotes", body.quoteId],
    ["commercial_contracts", body.contractId],
  ] as const;
  for (const [table, sourceId] of sourceLinks) {
    if (!isUuid(sourceId)) continue;
    const { data: linked } = await supabase.from(table).select("id").eq("organization_id", organizationId).eq("counterparty_id", counterpartyId).eq("id", sourceId).maybeSingle();
    if (!linked) return NextResponse.json({ error: "sale_source_does_not_belong_to_customer" }, { status: 409 });
  }
  const listNet = Number(customerType === "company" ? plan.company_net_price : plan.individual_net_price);
  const amounts = calculateSubscriptionAmounts(listNet, discount, Number(product.tax_rate));
  const endOn = inclusiveEndDate(startOn, plan.duration_months);
  const values = {
    organization_id: organizationId, product_id: product.id, plan_id: plan.id, counterparty_id: customer.id, customer_type: customerType,
    billing_contact_email: billingEmail, operational_contact_email: operationalEmail, sales_owner_id: user.id, service_owner_id: isUuid(body.serviceOwnerId) ? body.serviceOwnerId : null,
    opportunity_id: isUuid(body.opportunityId) ? body.opportunityId : null, quote_id: isUuid(body.quoteId) ? body.quoteId : null, contract_id: isUuid(body.contractId) ? body.contractId : null,
    status: "pending_payment", currency_code: plan.currency_code, list_net_amount: amounts.listNet, discount_amount: amounts.discount, net_amount: amounts.net,
    tax_rate: product.tax_rate, tax_amount: amounts.tax, gross_amount: amounts.gross, outstanding_amount: amounts.gross, contracted_months: plan.duration_months,
    projected_start_on: startOn, current_start_on: startOn, current_end_on: endOn, next_renewal_on: endOn, due_on: dueOn, grace_period_days: plan.grace_period_days,
    automatic_renewal: body.automaticRenewal !== false, sale_origin: text(body.saleOrigin, 160), special_conditions: [text(body.specialConditions, 4000), exceptionReason ? `Excepción plan mensual: ${exceptionReason}` : null].filter(Boolean).join("\n") || null,
  };
  const { data: subscription, error } = await supabase.from("service_subscriptions").insert(values).select(subscriptionSelect).single();
  if (error || !subscription) return NextResponse.json({ error: "unable_to_create_subscription", detail: error?.message }, { status: 409 });
  const { data: period, error: periodError } = await supabase.from("subscription_periods").insert({ organization_id: organizationId, subscription_id: subscription.id, sequence_number: 1, kind: "initial", status: "payment_pending", starts_on: startOn, ends_on: endOn, net_amount: amounts.net, tax_amount: amounts.tax, gross_amount: amounts.gross }).select("id").single();
  if (periodError || !period) return NextResponse.json({ error: "subscription_created_without_period", id: subscription.id }, { status: 500 });
  const alerts = renewalAlertDates(endOn, plan.alert_days).map(({ days, alertOn }) => ({ organization_id: organizationId, subscription_id: subscription.id, alert_type: "renewal", alert_on: alertOn, priority: days <= 3 ? "high" : "medium", assigned_to: user.id, amount: amounts.gross, action_recommended: `Contactar y preparar renovación; quedan ${days} días.` }));
  const schedule = buildMonthlyRevenueSchedule(startOn, endOn, amounts.net).map((row) => ({ organization_id: organizationId, subscription_id: subscription.id, period_id: period.id, recognition_on: row.recognitionOn, amount: row.amount }));
  const [alertsResult, scheduleResult, eventResult] = await Promise.all([
    alerts.length ? supabase.from("subscription_alerts").insert(alerts) : Promise.resolve({ error: null }),
    schedule.length ? supabase.from("subscription_revenue_schedule").insert(schedule) : Promise.resolve({ error: null }),
    supabase.from("subscription_events").insert({ organization_id: organizationId, subscription_id: subscription.id, event_type: "sale_confirmed", from_status: "draft", to_status: "pending_payment", reason: text(body.saleOrigin, 160), evidence: { opportunityId: values.opportunity_id, quoteId: values.quote_id, contractId: values.contract_id } }),
  ]);
  if (alertsResult.error || scheduleResult.error || eventResult.error) return NextResponse.json({ error: "subscription_created_with_incomplete_traceability", id: subscription.id }, { status: 500 });
  return NextResponse.json({ subscription }, { status: 201 });
}

async function registerPayment(request: NextRequest) {
  const form = await request.formData();
  const organizationId = form.get("organizationId");
  const access = await context(organizationId, true);
  if (access.error || !access.supabase || !access.user) return NextResponse.json({ error: access.error }, { status: access.status });
  const subscriptionId = form.get("subscriptionId");
  const paymentMethod = form.get("paymentMethod");
  const providerCode = text(form.get("providerCode"), 80, true);
  const amount = number(form.get("amount"), 0.01);
  const currencyCode = form.get("currencyCode");
  const paidAt = text(form.get("paidAt"), 40, true);
  const idempotencyKey = text(form.get("idempotencyKey") ?? request.headers.get("idempotency-key"), 180, true);
  const evidence = form.get("evidence");
  if (!isUuid(subscriptionId) || !["gateway", "bank_transfer"].includes(String(paymentMethod)) || !providerCode || !amount || !currencies.has(String(currencyCode)) || !paidAt || Number.isNaN(Date.parse(paidAt)) || !idempotencyKey || (evidence !== null && !(evidence instanceof File))) return NextResponse.json({ error: "invalid_subscription_payment" }, { status: 400 });
  if (paymentMethod === "bank_transfer" && (!(evidence instanceof File) || !text(form.get("transferReference"), 180, true))) return NextResponse.json({ error: "transfer_evidence_required" }, { status: 400 });
  if (paymentMethod === "gateway" && (!text(form.get("externalTransactionId"), 180, true) || !text(form.get("providerStatus"), 120, true))) return NextResponse.json({ error: "gateway_transaction_evidence_required" }, { status: 400 });
  if (evidence instanceof File && (evidence.size < 1 || evidence.size > 52_428_800 || !allowedMimeTypes.has(evidence.type))) return NextResponse.json({ error: "invalid_payment_evidence" }, { status: 400 });
  const [{ data: subscription }, { data: period }] = await Promise.all([
    access.supabase.from("service_subscriptions").select("id, currency_code, gross_amount, status").eq("organization_id", organizationId).eq("id", subscriptionId).maybeSingle(),
    access.supabase.from("subscription_periods").select("id").eq("organization_id", organizationId).eq("subscription_id", subscriptionId).in("status", ["payment_pending", "paid"]).order("sequence_number", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (!subscription) return NextResponse.json({ error: "subscription_not_found" }, { status: 404 });
  const safeName = evidence instanceof File ? evidence.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) : null;
  const evidencePath = safeName ? `${organizationId}/${subscriptionId}/${crypto.randomUUID()}-${safeName}` : null;
  if (evidence instanceof File && evidencePath) {
    const { error } = await access.supabase.storage.from("subscription-payment-evidence").upload(evidencePath, evidence, { contentType: evidence.type, upsert: false });
    if (error) return NextResponse.json({ error: "unable_to_upload_payment_evidence" }, { status: 409 });
  }
  const mismatches: string[] = [];
  if (subscription.currency_code !== currencyCode) mismatches.push("currency_mismatch");
  if (amount > Number(subscription.gross_amount)) mismatches.push("overpayment");
  if (["cancelled", "voided"].includes(subscription.status)) mismatches.push("expired_subscription");
  const { data: payment, error } = await access.supabase.from("subscription_payments").insert({
    organization_id: organizationId, subscription_id: subscriptionId, period_id: period?.id ?? null, payment_method: paymentMethod, provider_code: providerCode, external_transaction_id: text(form.get("externalTransactionId"), 180), idempotency_key: idempotencyKey,
    purchase_order: text(form.get("purchaseOrder"), 180), provider_status: text(form.get("providerStatus"), 120), amount, currency_code: currencyCode, paid_at: paidAt,
    validation_status: "pending", origin_bank: text(form.get("originBank"), 160), origin_account_holder: text(form.get("originAccountHolder"), 180), transfer_reference: text(form.get("transferReference"), 180), destination_account: text(form.get("destinationAccount"), 180), evidence_path: evidencePath, evidence_name: evidence instanceof File ? evidence.name : null,
    notification_evidence: { receivedAt: new Date().toISOString(), source: paymentMethod }, observations: text(form.get("observations"), 2000),
  }).select("*").single();
  if (error || !payment) {
    if (evidencePath) await access.supabase.storage.from("subscription-payment-evidence").remove([evidencePath]);
    return NextResponse.json({ error: /duplicate|unique/i.test(error?.message ?? "") ? "duplicate_payment" : "unable_to_register_payment" }, { status: 409 });
  }
  if (mismatches.length) await access.supabase.from("subscription_payment_exceptions").insert(mismatches.map((type) => ({ organization_id: organizationId, subscription_id: subscriptionId, payment_id: payment.id, exception_type: type, details: { expectedCurrency: subscription.currency_code, expectedAmount: subscription.gross_amount, receivedCurrency: currencyCode, receivedAmount: amount } })));
  await access.supabase.rpc("refresh_subscription_amounts", { p_organization_id: organizationId, p_subscription_id: subscriptionId });
  return NextResponse.json({ payment, exceptions: mismatches }, { status: 201 });
}

export async function POST(request: NextRequest) {
  if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) return registerPayment(request);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const access = await context(body?.organizationId, true, ["validate_payment", "update_plan"].includes(String(body?.action)));
  if (!body || access.error || !access.supabase || !access.user) return NextResponse.json({ error: access.error ?? "invalid_request" }, { status: access.status ?? 400 });
  if (body.action === "create_sale") return createSale(access as never, body);
  if (body.action === "transition") {
    if (!isUuid(body.subscriptionId) || !isSubscriptionStatus(body.toStatus)) return NextResponse.json({ error: "invalid_transition" }, { status: 400 });
    const { data, error } = await access.supabase.rpc("transition_service_subscription", { p_organization_id: access.organizationId, p_subscription_id: body.subscriptionId, p_to_status: body.toStatus, p_reason: text(body.reason, 2000), p_evidence: typeof body.evidence === "object" && body.evidence ? body.evidence : {} });
    if (error) return NextResponse.json({ error: "transition_rejected", detail: error.message }, { status: 409 });
    if (body.toStatus === "active") {
      const { data: period } = await access.supabase.from("subscription_periods").select("id, starts_on, ends_on").eq("organization_id", access.organizationId).eq("subscription_id", body.subscriptionId).in("status", ["payment_pending", "paid"]).order("sequence_number", { ascending: false }).limit(1).maybeSingle();
      if (period) {
        await Promise.all([
          access.supabase.from("subscription_periods").update({ status: "active", paid_at: new Date().toISOString(), activated_at: new Date().toISOString() }).eq("organization_id", access.organizationId).eq("id", period.id),
          access.supabase.from("service_subscriptions").update({ current_start_on: period.starts_on, current_end_on: period.ends_on, next_renewal_on: period.ends_on }).eq("organization_id", access.organizationId).eq("id", body.subscriptionId),
        ]);
      }
    }
    return NextResponse.json({ subscription: data });
  }
  if (body.action === "update_plan") {
    if (!isUuid(body.planId)) return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
    const individualPrice = number(body.individualPrice, 0);
    const companyPrice = number(body.companyPrice, 0);
    if (individualPrice === undefined || companyPrice === undefined) return NextResponse.json({ error: "invalid_plan_price" }, { status: 400 });
    const { data, error } = await access.supabase.from("service_plans").update({ individual_net_price: individualPrice, company_net_price: companyPrice, is_active: body.isActive !== false }).eq("organization_id", access.organizationId).eq("id", body.planId).select("*").maybeSingle();
    return error || !data ? NextResponse.json({ error: "unable_to_update_plan" }, { status: 409 }) : NextResponse.json({ plan: data });
  }
  if (body.action === "prepare_renewal") {
    if (!isUuid(body.subscriptionId)) return NextResponse.json({ error: "invalid_subscription" }, { status: 400 });
    const { data: subscription } = await access.supabase.from("service_subscriptions").select("id, plan_id, current_end_on, net_amount, tax_amount, gross_amount, status, service_owner_id").eq("organization_id", access.organizationId).eq("id", body.subscriptionId).maybeSingle();
    if (!subscription || !subscription.current_end_on || !["active", "expiring", "expired_pending_payment", "suspended_nonpayment"].includes(subscription.status)) return NextResponse.json({ error: "subscription_not_renewable" }, { status: 409 });
    const { data: plan } = await access.supabase.from("service_plans").select("duration_months, alert_days").eq("organization_id", access.organizationId).eq("id", subscription.plan_id).maybeSingle();
    if (!plan) return NextResponse.json({ error: "plan_not_found" }, { status: 404 });
    const start = new Date(`${subscription.current_end_on}T00:00:00Z`); start.setUTCDate(start.getUTCDate() + 1);
    const startsOn = start.toISOString().slice(0, 10); const endsOn = inclusiveEndDate(startsOn, plan.duration_months);
    const { data: prior } = await access.supabase.from("subscription_periods").select("sequence_number").eq("organization_id", access.organizationId).eq("subscription_id", subscription.id).order("sequence_number", { ascending: false }).limit(1).maybeSingle();
    const { data: period, error } = await access.supabase.from("subscription_periods").insert({ organization_id: access.organizationId, subscription_id: subscription.id, sequence_number: (prior?.sequence_number ?? 0) + 1, kind: subscription.status === "suspended_nonpayment" ? "reactivation" : "renewal", status: "payment_pending", starts_on: startsOn, ends_on: endsOn, net_amount: subscription.net_amount, tax_amount: subscription.tax_amount, gross_amount: subscription.gross_amount }).select("id").single();
    if (error || !period) return NextResponse.json({ error: "unable_to_prepare_renewal", detail: error?.message }, { status: 409 });
    await Promise.all([
      access.supabase.from("service_subscriptions").update({ status: "expiring", validated_paid_amount: 0, payment_validation_amount: 0, outstanding_amount: subscription.gross_amount, next_renewal_on: startsOn }).eq("organization_id", access.organizationId).eq("id", subscription.id),
      access.supabase.from("subscription_revenue_schedule").insert(buildMonthlyRevenueSchedule(startsOn, endsOn, Number(subscription.net_amount)).map((row) => ({ organization_id: access.organizationId, subscription_id: subscription.id, period_id: period.id, recognition_on: row.recognitionOn, amount: row.amount }))),
      access.supabase.from("subscription_events").insert({ organization_id: access.organizationId, subscription_id: subscription.id, event_type: "renewal_prepared", from_status: subscription.status, to_status: "expiring", evidence: { periodId: period.id, startsOn, endsOn } }),
    ]);
    return NextResponse.json({ period }, { status: 201 });
  }
  if (body.action === "validate_payment") {
    if (!isUuid(body.paymentId) || !["validated", "rejected"].includes(String(body.validationStatus))) return NextResponse.json({ error: "invalid_payment_validation" }, { status: 400 });
    const { data: payment } = await access.supabase.from("subscription_payments").select("id, subscription_id").eq("organization_id", access.organizationId).eq("id", body.paymentId).maybeSingle();
    if (!payment) return NextResponse.json({ error: "payment_not_found" }, { status: 404 });
    const validationStatus = String(body.validationStatus);
    if (validationStatus === "validated") {
      const { count } = await access.supabase.from("subscription_payment_exceptions").select("id", { count: "exact", head: true }).eq("organization_id", access.organizationId).eq("payment_id", payment.id).eq("status", "open");
      if ((count ?? 0) > 0) return NextResponse.json({ error: "payment_has_open_exceptions" }, { status: 409 });
    }
    const { error } = await access.supabase.from("subscription_payments").update({ validation_status: validationStatus, validated_at: new Date().toISOString(), validated_by: access.user.id, observations: text(body.reason, 2000) }).eq("organization_id", access.organizationId).eq("id", payment.id).eq("validation_status", "pending");
    if (error) return NextResponse.json({ error: "unable_to_validate_payment" }, { status: 409 });
    const { data: subscription, error: refreshError } = await access.supabase.rpc("refresh_subscription_amounts", { p_organization_id: access.organizationId, p_subscription_id: payment.subscription_id });
    if (refreshError) return NextResponse.json({ error: "payment_validated_but_subscription_not_refreshed" }, { status: 500 });
    await access.supabase.from("subscription_events").insert({ organization_id: access.organizationId, subscription_id: payment.subscription_id, event_type: `payment_${validationStatus}`, reason: text(body.reason, 2000), evidence: { paymentId: payment.id } });
    return NextResponse.json({ subscription });
  }
  return NextResponse.json({ error: "unsupported_subscription_action" }, { status: 400 });
}
