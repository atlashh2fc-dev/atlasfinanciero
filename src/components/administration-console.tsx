"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type OrganizationRole = "administrator" | "finance" | "operations" | "auditor";
type Organization = { id: string; legal_name: string; tax_id: string | null };
type AdminOrganization = { id: string; role: OrganizationRole; organization: Organization };
type Member = { userId: string; role: OrganizationRole; createdAt: string; profile: { email: string | null; full_name: string | null } | null };
type Invitation = { id: string; email: string; role: OrganizationRole; status: "pending"; invitedAt: string };

const roleLabels: Record<OrganizationRole, string> = {
  administrator: "Administrador",
  finance: "Finanzas",
  operations: "Operación",
  auditor: "Auditor",
};

function readError(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return null;
  return typeof payload.error === "string" ? payload.error : null;
}

export function AdministrationConsole({ activeOrganizationId }: { activeOrganizationId: string }) {
  const [organizations, setOrganizations] = useState<AdminOrganization[]>([]);
  const [organizationId, setOrganizationId] = useState(activeOrganizationId);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [legalName, setLegalName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [newLegalName, setNewLegalName] = useState("");
  const [newTaxId, setNewTaxId] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrganizationRole>("auditor");
  const [message, setMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const current = useMemo(() => organizations.find((item) => item.id === organizationId)?.organization ?? null, [organizations, organizationId]);

  async function loadOrganizations() {
    const response = await fetch("/api/admin/organizations", { cache: "no-store" });
    if (!response.ok) {
      setMessage("No fue posible cargar la administración. Verifica que tu rol sea Administrador.");
      setIsLoading(false);
      return;
    }
    const payload = await response.json() as { organizations: AdminOrganization[] };
    setOrganizations(payload.organizations);
    setOrganizationId((selected) => payload.organizations.some((item) => item.id === selected) ? selected : payload.organizations[0]?.id ?? "");
    setIsLoading(false);
  }

  async function loadMembers(organization: string) {
    if (!organization) {
      setMembers([]);
      setInvitations([]);
      return;
    }
    const response = await fetch(`/api/admin/members?organizationId=${encodeURIComponent(organization)}`, { cache: "no-store" });
    if (!response.ok) return setMessage("No fue posible cargar los miembros de esta organización.");
    const payload = await response.json() as { members: Member[]; invitations: Invitation[] };
    setMembers(payload.members);
    setInvitations(payload.invitations);
  }

  useEffect(() => { void loadOrganizations(); }, []);
  useEffect(() => {
    if (current) {
      setLegalName(current.legal_name);
      setTaxId(current.tax_id ?? "");
    }
    void loadMembers(organizationId);
  }, [organizationId, current?.id]);

  async function updateOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || !legalName.trim()) return;
    setIsSaving(true);
    const response = await fetch("/api/admin/organizations", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, legalName, taxId }) });
    setIsSaving(false);
    if (!response.ok) return setMessage("No fue posible actualizar la organización.");
    setMessage("Datos de organización actualizados.");
    await loadOrganizations();
  }

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newLegalName.trim()) return;
    setIsSaving(true);
    const response = await fetch("/api/admin/organizations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ legalName: newLegalName, taxId: newTaxId }) });
    const payload = await response.json().catch(() => null) as { organization?: Organization } | null;
    setIsSaving(false);
    if (!response.ok || !payload?.organization) return setMessage("No fue posible crear la organización.");
    await fetch("/api/session/active-organization", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId: payload.organization.id }) });
    setNewLegalName("");
    setNewTaxId("");
    setOrganizationId(payload.organization.id);
    setMessage("Organización creada. Quedaste asignado como Administrador y quedó seleccionada como activa.");
    await loadOrganizations();
  }

  async function inviteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || !inviteEmail.trim()) return;
    setIsSaving(true);
    const response = await fetch("/api/admin/invitations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, email: inviteEmail, role: inviteRole }) });
    const payload = await response.json().catch(() => null);
    setIsSaving(false);
    if (!response.ok) {
      const error = readError(payload);
      return setMessage(error === "admin_provisioning_not_configured" ? "Para enviar invitaciones falta configurar SUPABASE_SECRET_KEY en el servidor. La clave nunca va al navegador." : "No fue posible enviar la invitación. Revisa el correo, la configuración de Auth o si la persona ya existe.");
    }
    setInviteEmail("");
    setMessage("Invitación enviada. La persona definirá su contraseña al aceptar el correo; el acceso se habilita automáticamente al finalizar.");
    await loadMembers(organizationId);
  }

  async function changeRole(userId: string, role: OrganizationRole) {
    setIsSaving(true);
    const response = await fetch("/api/admin/members", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, userId, role }) });
    setIsSaving(false);
    if (!response.ok) return setMessage("No fue posible actualizar el rol. La organización debe conservar al menos un Administrador.");
    setMessage("Rol actualizado.");
    await loadMembers(organizationId);
  }

  async function removeMember(userId: string) {
    if (!window.confirm("¿Quitar a este usuario de la organización? Perderá acceso a sus datos y operaciones.")) return;
    setIsSaving(true);
    const response = await fetch(`/api/admin/members?organizationId=${encodeURIComponent(organizationId)}&userId=${encodeURIComponent(userId)}`, { method: "DELETE" });
    setIsSaving(false);
    if (!response.ok) return setMessage("No fue posible quitar al usuario. La organización debe conservar al menos un Administrador.");
    setMessage("Usuario retirado de la organización.");
    await loadMembers(organizationId);
  }

  return (
    <main className="dashboard administration-dashboard">
      <section className="headline">
        <div><span className="eyebrow">GOBIERNO Y ACCESOS</span><h1>Administración</h1><p>Controla organizaciones, miembros y responsabilidades operativas. Los permisos se aplican directamente en la base de datos.</p></div>
      </section>

      {message && <p className="operation-message">{message}</p>}
      {isLoading ? <section className="panel billing-empty"><p>Cargando administración…</p></section> : <>
        <section className="admin-grid">
          <article className="panel">
            <div className="panel-heading"><div><span className="panel-label">ORGANIZACIÓN ACTIVA</span><h2>Datos legales y tributarios</h2></div></div>
            <form className="admin-form" onSubmit={updateOrganization}>
              <label>Organización<select value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}>{organizations.map((item) => <option value={item.id} key={item.id}>{item.organization.legal_name}</option>)}</select></label>
              <label>Razón social<input value={legalName} maxLength={180} onChange={(event) => setLegalName(event.target.value)} required /></label>
              <label>RUT<input value={taxId} maxLength={40} onChange={(event) => setTaxId(event.target.value)} /></label>
              <button type="submit" className="primary-button" disabled={isSaving || !organizationId}>Guardar cambios</button>
            </form>
          </article>
          <article className="panel">
            <div className="panel-heading"><div><span className="panel-label">NUEVA ORGANIZACIÓN</span><h2>Incorporar una empresa</h2></div></div>
            <form className="admin-form" onSubmit={createOrganization}>
              <label>Razón social<input value={newLegalName} maxLength={180} onChange={(event) => setNewLegalName(event.target.value)} required /></label>
              <label>RUT<input value={newTaxId} maxLength={40} onChange={(event) => setNewTaxId(event.target.value)} /></label>
              <button type="submit" className="secondary-button" disabled={isSaving}>Crear organización</button>
            </form>
          </article>
        </section>

        <section className="panel admin-invite-panel">
          <div className="panel-heading"><div><span className="panel-label">INCORPORAR USUARIO</span><h2>Invitar y asignar responsabilidad</h2><p>La persona define su contraseña desde el correo. El acceso se activa sólo al completar esa validación.</p></div></div>
          <form className="admin-invite-form" onSubmit={inviteMember}>
            <label>Correo<input type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="nombre@empresa.cl" required /></label>
            <label>Rol<select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as OrganizationRole)}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <button className="primary-button" type="submit" disabled={isSaving || !organizationId}>Enviar invitación</button>
          </form>
        </section>

        <section className="table-section">
          <div className="table-heading"><div><span className="panel-label">MIEMBROS</span><h2>Accesos de {current?.legal_name ?? "la organización"}</h2><p>{members.length} activo(s) · {invitations.length} invitación(es) pendiente(s).</p></div><button type="button" className="secondary-button" disabled={isSaving} onClick={() => void loadMembers(organizationId)}>Actualizar</button></div>
          <div className="table-scroll"><table className="admin-members-table"><thead><tr><th>Usuario</th><th>Rol</th><th>Estado</th><th>Fecha</th><th>Acción</th></tr></thead><tbody>{invitations.map((invitation) => <tr key={`invitation-${invitation.id}`}><td><strong>{invitation.email}</strong><small>Invitación enviada por correo</small></td><td>{roleLabels[invitation.role]}</td><td><span className="status pending">Pendiente</span></td><td>{new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(invitation.invitedAt))}</td><td><span className="origin">Sin acceso hasta aceptar</span></td></tr>)}{members.map((member) => <tr key={member.userId}><td><strong>{member.profile?.full_name || member.profile?.email || "Usuario"}</strong><small>{member.profile?.email ?? "Correo no disponible"}</small></td><td><select value={member.role} onChange={(event) => void changeRole(member.userId, event.target.value as OrganizationRole)} disabled={isSaving}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td><td><span className="status paid">Activo</span></td><td>{new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(member.createdAt))}</td><td><button type="button" className="text-button" disabled={isSaving} onClick={() => void removeMember(member.userId)}>Quitar</button></td></tr>)}</tbody></table></div>
          {!members.length && !invitations.length && <p className="billing-empty">Aún no hay accesos ni invitaciones para esta organización.</p>}
        </section>
      </>}
    </main>
  );
}
