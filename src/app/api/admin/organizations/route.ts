import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/admin-access";

function readText(value: unknown, maximum: number, required = false) {
  if (typeof value !== "string") return required ? null : undefined;
  const text = value.trim();
  if ((!text && required) || text.length > maximum) return null;
  return text || null;
}

async function currentUserAndMemberships() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, user: null, memberships: null, error: null };
  const { data: memberships, error } = await supabase
    .from("organization_memberships")
    .select("organization_id, role, organizations (id, legal_name, tax_id)")
    .eq("user_id", user.id);
  return { supabase, user, memberships, error };
}

export async function GET() {
  const { user, memberships, error } = await currentUserAndMemberships();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (error) return NextResponse.json({ error: "unable_to_read_organizations" }, { status: 500 });

  const organizations = (memberships ?? [])
    .filter((membership) => membership.role === "administrator")
    .map((membership) => ({
      id: membership.organization_id,
      role: membership.role,
      organization: Array.isArray(membership.organizations) ? membership.organizations[0] ?? null : membership.organizations,
    }))
    .filter((item) => item.organization);
  return NextResponse.json({ organizations });
}

export async function POST(request: NextRequest) {
  const { supabase, user, memberships, error } = await currentUserAndMemberships();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (error) return NextResponse.json({ error: "unable_to_read_memberships" }, { status: 500 });
  if (!(memberships ?? []).some((membership) => membership.role === "administrator")) return NextResponse.json({ error: "administrator_required" }, { status: 403 });

  const body: unknown = await request.json().catch(() => null);
  const legalName = readText(body && typeof body === "object" ? (body as { legalName?: unknown }).legalName : null, 180, true);
  const taxId = readText(body && typeof body === "object" ? (body as { taxId?: unknown }).taxId : null, 40);
  if (!legalName || taxId === null) return NextResponse.json({ error: "invalid_organization" }, { status: 400 });

  const { data, error: createError } = await supabase
    .from("organizations")
    .insert({ legal_name: legalName, tax_id: taxId })
    .select("id, legal_name, tax_id")
    .single();
  if (createError) return NextResponse.json({ error: "unable_to_create_organization" }, { status: 403 });

  return NextResponse.json({ organization: data }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const { supabase, user, memberships, error } = await currentUserAndMemberships();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (error) return NextResponse.json({ error: "unable_to_read_memberships" }, { status: 500 });

  const body: unknown = await request.json().catch(() => null);
  const organizationId = body && typeof body === "object" ? (body as { organizationId?: unknown }).organizationId : null;
  const legalName = readText(body && typeof body === "object" ? (body as { legalName?: unknown }).legalName : null, 180, true);
  const taxId = readText(body && typeof body === "object" ? (body as { taxId?: unknown }).taxId : null, 40);
  if (!isUuid(organizationId) || !legalName || taxId === null) return NextResponse.json({ error: "invalid_organization" }, { status: 400 });
  if (!(memberships ?? []).some((membership) => membership.organization_id === organizationId && membership.role === "administrator")) return NextResponse.json({ error: "administrator_required" }, { status: 403 });

  const { data, error: updateError } = await supabase
    .from("organizations")
    .update({ legal_name: legalName, tax_id: taxId })
    .eq("id", organizationId)
    .select("id, legal_name, tax_id")
    .single();
  if (updateError) return NextResponse.json({ error: "unable_to_update_organization" }, { status: 403 });
  return NextResponse.json({ organization: data });
}
