import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type DocumentRequest = {
  id?: unknown;
  organizationId?: unknown;
  invoiceNumber?: unknown;
  issueDate?: unknown;
  documentType?: unknown;
  issuer?: unknown;
  issuerRut?: unknown;
  client?: unknown;
  recipient?: unknown;
  recipientRut?: unknown;
  netAmount?: unknown;
  vatAmount?: unknown;
  totalAmount?: unknown;
  status?: unknown;
  paymentDate?: unknown;
  paymentMethod?: unknown;
  paymentCondition?: unknown;
  notes?: unknown;
  factoringEntity?: unknown;
  factoredAt?: unknown;
  factoringSettledAt?: unknown;
  factoringRecourseAt?: unknown;
};

const writeRoles = new Set(["administrator", "finance", "operations"]);
const paymentConditions = new Set(["advance", "post_service"]);

function readText(value: unknown, maxLength: number, required = false) {
  if (value === undefined || value === null) return required ? null : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if ((!text && required) || text.length > maxLength) return null;
  return text || null;
}

function readAmount(value: unknown, required = false) {
  if (value === undefined || value === null || value === "")
    return required ? undefined : null;
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

function readDate(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : null;
}

function readPaymentCondition(value: unknown) {
  return typeof value === "string" && paymentConditions.has(value)
    ? value
    : null;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { error: "authentication_required" },
      { status: 401 },
    );

  const body = (await request
    .json()
    .catch(() => null)) as DocumentRequest | null;
  const issueDate = readDate(body?.issueDate);
  const documentType = readText(body?.documentType, 100, true);
  const issuer = readText(body?.issuer, 180, true);
  const client = readText(body?.client, 180, true);
  const netAmount = readAmount(body?.netAmount, true);
  const totalAmount = readAmount(body?.totalAmount, true);
  const vatAmount = readAmount(body?.vatAmount);
  const status = readText(body?.status, 80, true);
  const paymentCondition = readPaymentCondition(body?.paymentCondition);
  const requiresPaymentCondition = documentType
    ?.toLocaleLowerCase()
    .includes("factura");

  if (
    !issueDate ||
    !documentType ||
    !issuer ||
    !client ||
    netAmount === undefined ||
    totalAmount === undefined ||
    vatAmount === undefined ||
    !status ||
    (requiresPaymentCondition && !paymentCondition)
  ) {
    return NextResponse.json({ error: "invalid_document" }, { status: 400 });
  }

  const { data: memberships, error: membershipsError } = await supabase
    .from("organization_memberships")
    .select("organization_id, role")
    .eq("user_id", user.id);
  if (membershipsError)
    return NextResponse.json(
      { error: "unable_to_read_memberships" },
      { status: 500 },
    );

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("active_organization_id")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError)
    return NextResponse.json(
      { error: "unable_to_read_active_organization" },
      { status: 500 },
    );

  const eligibleMemberships = (memberships ?? []).filter((membership) =>
    writeRoles.has(membership.role),
  );
  const requestedOrganizationId = body?.organizationId;
  const membership = isUuid(requestedOrganizationId)
    ? eligibleMemberships.find(
        (item) => item.organization_id === requestedOrganizationId,
      )
    : (eligibleMemberships.find(
        (item) => item.organization_id === profile?.active_organization_id,
      ) ?? (eligibleMemberships.length === 1 ? eligibleMemberships[0] : null));

  if (!membership) {
    return NextResponse.json(
      {
        error:
          eligibleMemberships.length > 1
            ? "organization_selection_required"
            : "document_write_not_authorized",
      },
      { status: 403 },
    );
  }

  const { data, error } = await supabase
    .from("issued_documents")
    .insert({
      organization_id: membership.organization_id,
      document_number: readText(body?.invoiceNumber, 80),
      issue_date: issueDate,
      document_type: documentType,
      issuer_name: issuer,
      issuer_tax_id: readText(body?.issuerRut, 40),
      client_name: client,
      recipient_name: readText(body?.recipient, 180),
      recipient_tax_id: readText(body?.recipientRut, 40),
      net_amount: netAmount,
      vat_amount: vatAmount,
      total_amount: totalAmount,
      payment_status: status,
      payment_condition: paymentCondition,
      source_file_name: "Atlas Financiero",
      source_sheet_name: "Registro manual",
      source_row: 0,
    })
    .select(
      "id, document_number, issue_date, document_type, issuer_name, issuer_tax_id, client_name, recipient_name, recipient_tax_id, net_amount, vat_amount, total_amount, payment_status, payment_condition, source_file_name, source_sheet_name, source_row",
    )
    .single();

  if (error)
    return NextResponse.json(
      { error: "unable_to_create_document" },
      { status: 403 },
    );
  return NextResponse.json({ document: data }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { error: "authentication_required" },
      { status: 401 },
    );

  const body = (await request
    .json()
    .catch(() => null)) as DocumentRequest | null;
  const documentId = body?.id;
  const status = readText(body?.status, 80, true);
  const paymentDateValue = body?.paymentDate;
  const paymentDate =
    paymentDateValue === "" ||
    paymentDateValue === null ||
    paymentDateValue === undefined
      ? null
      : readDate(paymentDateValue);
  const factoredAt = body?.factoredAt ? readDate(body.factoredAt) : null;
  const factoringSettledAt = body?.factoringSettledAt
    ? readDate(body.factoringSettledAt)
    : null;
  const factoringRecourseAt = body?.factoringRecourseAt
    ? readDate(body.factoringRecourseAt)
    : null;
  if (
    !isUuid(documentId) ||
    !status ||
    (paymentDateValue && !paymentDate) ||
    (body?.factoredAt && !factoredAt) ||
    (body?.factoringSettledAt && !factoringSettledAt) ||
    (body?.factoringRecourseAt && !factoringRecourseAt)
  )
    return NextResponse.json(
      { error: "invalid_document_update" },
      { status: 400 },
    );
  if (
    (status === "Factorizada" ||
      status === "Pagada al factoring" ||
      status === "Recomprada al factoring") &&
    !readText(body?.factoringEntity, 180, true)
  )
    return NextResponse.json(
      { error: "factoring_entity_required" },
      { status: 400 },
    );

  const { data: memberships, error: membershipsError } = await supabase
    .from("organization_memberships")
    .select("organization_id, role")
    .eq("user_id", user.id);
  if (membershipsError)
    return NextResponse.json(
      { error: "unable_to_read_memberships" },
      { status: 500 },
    );

  const eligibleOrganizationIds = (memberships ?? [])
    .filter((membership) => writeRoles.has(membership.role))
    .map((membership) => membership.organization_id);
  if (!eligibleOrganizationIds.length)
    return NextResponse.json(
      { error: "document_write_not_authorized" },
      { status: 403 },
    );

  const { data, error } = await supabase
    .from("issued_documents")
    .update({
      payment_status: status,
      payment_date: paymentDate,
      payment_method: readText(body?.paymentMethod, 80),
      payment_condition: readPaymentCondition(body?.paymentCondition),
      notes: readText(body?.notes, 2_000),
      factoring_entity: readText(body?.factoringEntity, 180),
      factored_at: factoredAt,
      factoring_settled_at: factoringSettledAt,
      factoring_recourse_at: factoringRecourseAt,
    })
    .eq("id", documentId)
    .in("organization_id", eligibleOrganizationIds)
    .select(
      "id, document_number, issue_date, document_type, issuer_name, issuer_tax_id, client_name, recipient_name, recipient_tax_id, net_amount, vat_amount, total_amount, notes, payment_term_days, due_date, due_month, payment_status, payment_date, payment_method, payment_condition, factoring_entity, factored_at, factoring_settled_at, factoring_recourse_at, origin_account_or_tax_id, destination_bank, destination_account, source_file_name, source_sheet_name, source_row",
    )
    .maybeSingle();
  if (error || !data)
    return NextResponse.json(
      { error: "unable_to_update_document" },
      { status: 403 },
    );
  return NextResponse.json({ document: data });
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json(
      { error: "authentication_required" },
      { status: 401 },
    );

  const [
    { data: memberships, error: membershipsError },
    { data: profile, error: profileError },
  ] = await Promise.all([
    supabase
      .from("organization_memberships")
      .select("organization_id")
      .eq("user_id", user.id),
    supabase
      .from("profiles")
      .select("active_organization_id")
      .eq("id", user.id)
      .maybeSingle(),
  ]);
  if (membershipsError || profileError)
    return NextResponse.json(
      { error: "unable_to_read_memberships" },
      { status: 500 },
    );

  const organizationIds = (memberships ?? []).map(
    (membership) => membership.organization_id,
  );
  const organizationId =
    profile?.active_organization_id &&
    organizationIds.includes(profile.active_organization_id)
      ? profile.active_organization_id
      : organizationIds.length === 1
        ? organizationIds[0]
        : null;
  if (!organizationId)
    return NextResponse.json(
      {
        error: organizationIds.length
          ? "organization_selection_required"
          : "organization_membership_required",
      },
      { status: 403 },
    );

  const { data, error } = await supabase
    .from("issued_documents")
    .select(
      "id, document_number, issue_date, document_type, issuer_name, issuer_tax_id, client_name, recipient_name, recipient_tax_id, net_amount, vat_amount, total_amount, notes, payment_term_days, due_date, due_month, payment_status, payment_date, payment_method, payment_condition, factoring_entity, factored_at, factoring_settled_at, factoring_recourse_at, origin_account_or_tax_id, destination_bank, destination_account, source_file_name, source_sheet_name, source_row",
    )
    .eq("organization_id", organizationId)
    .order("issue_date", { ascending: false });
  if (error)
    return NextResponse.json(
      { error: "unable_to_load_documents" },
      { status: 500 },
    );

  return NextResponse.json({ documents: data ?? [] });
}
