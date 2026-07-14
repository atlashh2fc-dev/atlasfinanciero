import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const writeRoles = new Set(["administrator", "finance", "operations"]);
const areas = new Set(["commercial", "billing", "payments", "collections", "legal", "other"]);

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function clean(value: unknown, maxLength: number, required = false) {
  if (typeof value !== "string") return required ? null : null;
  const result = value.trim();
  return (!result && required) || result.length > maxLength ? null : result || null;
}

function optionalDays(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const days = Number(value);
  return Number.isInteger(days) && days >= 0 && days <= 365 ? days : undefined;
}

async function membership(supabase: Awaited<ReturnType<typeof createClient>>, organizationId: unknown, userId: string, write = false) {
  if (!isUuid(organizationId)) return null;
  const { data, error } = await supabase.from("organization_memberships").select("organization_id, role").eq("organization_id", organizationId).eq("user_id", userId).maybeSingle();
  if (error || !data || (write && !writeRoles.has(data.role))) return null;
  return data.organization_id;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const organizationId = await membership(supabase, request.nextUrl.searchParams.get("organizationId"), user.id);
  if (!organizationId) return NextResponse.json({ error: "organization_access_required" }, { status: 403 });

  const [profiles, contacts] = await Promise.all([
    supabase.from("counterparties").select("id, legal_name, trade_name, tax_id, business_activity, address_line1, commune, city, website, email, phone, payment_term_days, billing_email, billing_phone, legal_representative_name, legal_representative_tax_id, legal_representative_address, legal_representative_phone, legal_representative_email, is_active").eq("organization_id", organizationId).in("kind", ["customer", "both"]).order("legal_name"),
    supabase.from("counterparty_contacts").select("id, counterparty_id, contact_area, job_title, full_name, phone, email, is_primary").eq("organization_id", organizationId).order("contact_area").order("full_name"),
  ]);
  if (profiles.error || contacts.error) return NextResponse.json({ error: "unable_to_load_customer_profiles" }, { status: 500 });
  return NextResponse.json({ profiles: profiles.data ?? [], contacts: contacts.data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const organizationId = await membership(supabase, body?.organizationId, user.id, true);
  if (!organizationId) return NextResponse.json({ error: "organization_write_not_authorized" }, { status: 403 });
  if (body?.action !== "save_profile") return NextResponse.json({ error: "unsupported_customer_profile_action" }, { status: 400 });

  const profile = body.profile as Record<string, unknown> | null;
  const legalName = clean(profile?.legalName, 250, true);
  const paymentTermDays = optionalDays(profile?.paymentTermDays);
  if (!profile || !legalName || paymentTermDays === undefined) return NextResponse.json({ error: "invalid_customer_profile" }, { status: 400 });

  const values = {
    legal_name: legalName, trade_name: clean(profile.tradeName, 180), tax_id: clean(profile.taxId, 40), kind: "customer", business_activity: clean(profile.businessActivity, 500), address_line1: clean(profile.addressLine1, 300), commune: clean(profile.commune, 120), city: clean(profile.city, 120), website: clean(profile.website, 300), email: clean(profile.email, 320), phone: clean(profile.phone, 80), payment_term_days: paymentTermDays, billing_email: clean(profile.billingEmail, 320), billing_phone: clean(profile.billingPhone, 80), legal_representative_name: clean(profile.legalRepresentativeName, 180), legal_representative_tax_id: clean(profile.legalRepresentativeTaxId, 40), legal_representative_address: clean(profile.legalRepresentativeAddress, 300), legal_representative_phone: clean(profile.legalRepresentativePhone, 80), legal_representative_email: clean(profile.legalRepresentativeEmail, 320), is_active: profile.isActive !== false,
  };

  const requestedId = profile.id;
  let counterpartyId: string;
  if (isUuid(requestedId)) {
    const { data, error } = await supabase.from("counterparties").update(values).eq("id", requestedId).eq("organization_id", organizationId).select("id").maybeSingle();
    if (error || !data) return NextResponse.json({ error: "unable_to_update_customer_profile" }, { status: 409 });
    counterpartyId = data.id;
  } else {
    const { data, error } = await supabase.from("counterparties").insert({ ...values, organization_id: organizationId }).select("id").single();
    if (error || !data) return NextResponse.json({ error: "unable_to_create_customer_profile" }, { status: 409 });
    counterpartyId = data.id;
  }

  const inputContacts = Array.isArray(body.contacts) ? body.contacts : [];
  const contacts = inputContacts.map((item) => item as Record<string, unknown>).map((contact) => ({
    contact_area: typeof contact.contactArea === "string" && areas.has(contact.contactArea) ? contact.contactArea : null,
    job_title: clean(contact.jobTitle, 160), full_name: clean(contact.fullName, 180, true), phone: clean(contact.phone, 80), email: clean(contact.email, 320), is_primary: contact.isPrimary === true,
  })).filter((contact) => contact.full_name || contact.contact_area || contact.job_title || contact.phone || contact.email);
  if (contacts.some((contact) => !contact.contact_area || !contact.full_name)) return NextResponse.json({ error: "invalid_customer_contact" }, { status: 400 });

  const { error: deleteError } = await supabase.from("counterparty_contacts").delete().eq("organization_id", organizationId).eq("counterparty_id", counterpartyId);
  if (deleteError) return NextResponse.json({ error: "unable_to_replace_customer_contacts" }, { status: 409 });
  if (contacts.length) {
    const { error: insertError } = await supabase.from("counterparty_contacts").insert(contacts.map((contact) => ({ ...contact, organization_id: organizationId, counterparty_id: counterpartyId })));
    if (insertError) return NextResponse.json({ error: "unable_to_save_customer_contacts" }, { status: 409 });
  }
  return NextResponse.json({ id: counterpartyId });
}
