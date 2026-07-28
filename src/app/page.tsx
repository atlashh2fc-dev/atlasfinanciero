import { FinanceDashboard } from "@/components/finance-dashboard";
import { DataEntryWorkspace } from "@/components/data-entry-workspace";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [{ data: profile }, { data: memberships }] = await Promise.all([
    supabase.from("profiles").select("active_organization_id").eq("id", user.id).maybeSingle(),
    supabase.from("organization_memberships").select("organization_id, role, organizations (legal_name, tax_id)").eq("user_id", user.id),
  ]);
  const membership = (memberships ?? []).find((item) => item.organization_id === profile?.active_organization_id) ?? memberships?.[0];
  if (!membership) redirect("/login");
  if (membership.role === "data_entry") {
    const organization = Array.isArray(membership.organizations) ? membership.organizations[0] : membership.organizations;
    return <DataEntryWorkspace organizationId={membership.organization_id} organizationName={organization?.legal_name ?? "Organización"} organizationTaxId={organization?.tax_id ?? null} />;
  }

  return <FinanceDashboard />;
}
