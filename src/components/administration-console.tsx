"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ServiceCatalogManagement } from "@/components/service-catalog-management";

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

function PasswordVisibilityButton({ visible, onClick }: { visible: boolean; onClick: () => void }) {
  return <button type="button" className="password-visibility-button" onClick={onClick} aria-label={visible ? "Ocultar contraseña" : "Mostrar contraseña"} aria-pressed={visible} title={visible ? "Ocultar contraseña" : "Mostrar contraseña"}>
    {visible ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 5.1A10.9 10.9 0 0 1 12 4.9c5.2 0 8.8 4.2 9.8 6.1a1.9 1.9 0 0 1 0 1.8 15.4 15.4 0 0 1-3.1 3.9M6.2 6.2A15.5 15.5 0 0 0 2.2 11a1.9 1.9 0 0 0 0 1.8c1 1.9 4.6 6.1 9.8 6.1 1.3 0 2.5-.3 3.6-.8" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.2 12a1.9 1.9 0 0 1 0-1.8c1-1.9 4.6-6.1 9.8-6.1s8.8 4.2 9.8 6.1a1.9 1.9 0 0 1 0 1.8c-1 1.9-4.6 6.1-9.8 6.1S3.2 13.9 2.2 12Z" /><circle cx="12" cy="11" r="3" /></svg>}
  </button>;
}

export function AdministrationConsole({ activeOrganizationId, isSuperAdmin }: { activeOrganizationId: string; isSuperAdmin: boolean }) {
  const [organizations, setOrganizations] = useState<AdminOrganization[]>([]);
  const [organizationId, setOrganizationId] = useState(activeOrganizationId);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [membersLoadError, setMembersLoadError] = useState<string | null>(null);
  const [legalName, setLegalName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [newLegalName, setNewLegalName] = useState("");
  const [newTaxId, setNewTaxId] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrganizationRole>("auditor");
  const [newUserName, setNewUserName] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [showNewUserPassword, setShowNewUserPassword] = useState(false);
  const [newUserRole, setNewUserRole] = useState<OrganizationRole>("auditor");
  const [message, setMessage] = useState<string | null>(null);
  const [recoveryLink, setRecoveryLink] = useState<{ email: string; url: string } | null>(null);
  const [passwordMember, setPasswordMember] = useState<Member | null>(null);
  const [memberPassword, setMemberPassword] = useState("");
  const [showMemberPassword, setShowMemberPassword] = useState(false);
  const recoveryLinkInputRef = useRef<HTMLInputElement>(null);
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
      setMembersLoadError(null);
      return;
    }
    const response = await fetch(`/api/admin/members?organizationId=${encodeURIComponent(organization)}`, { cache: "no-store" });
    if (!response.ok) {
      setMembers([]);
      setInvitations([]);
      return setMembersLoadError("No fue posible leer los accesos de esta organización. Actualiza la vista o vuelve a ingresar.");
    }
    const payload = await response.json() as { members: Member[]; invitations: Invitation[] };
    setMembers(payload.members);
    setInvitations(payload.invitations);
    setMembersLoadError(null);
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
    const activateResponse = await fetch("/api/session/active-organization", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId: payload.organization.id }) });
    if (!activateResponse.ok) {
      await loadOrganizations();
      return setMessage("La empresa fue creada, pero no se pudo activarla. Actualiza la vista; si el problema continúa, revisaremos su asignación de administrador.");
    }
    setNewLegalName("");
    setNewTaxId("");
    setOrganizationId(payload.organization.id);
    window.location.assign("/");
  }

  async function deleteOrganization() {
    if (!current || !isSuperAdmin) return;
    const confirmationName = window.prompt(`Esta acción elimina definitivamente ${current.legal_name}, sus usuarios asignados y todos sus datos.\n\nEscribe el nombre exacto de la empresa para confirmar:`);
    if (confirmationName === null) return;
    setIsSaving(true);
    const response = await fetch("/api/admin/organizations", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, confirmationName }) });
    setIsSaving(false);
    if (!response.ok) return setMessage("No se eliminó la empresa. Debes escribir su nombre exacto y confirmar que quieres borrar todos sus datos.");
    window.location.assign("/");
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

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId || !newUserName.trim() || !newUserEmail.trim() || newUserPassword.length < 12) return;
    setIsSaving(true);
    const response = await fetch("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, fullName: newUserName, email: newUserEmail, password: newUserPassword, role: newUserRole }) });
    const payload = await response.json().catch(() => null);
    setIsSaving(false);
    if (!response.ok) {
      const error = readError(payload);
      return setMessage(error === "admin_provisioning_not_configured" ? "Para crear cuentas falta configurar SUPABASE_SECRET_KEY en el servidor. La clave nunca va al navegador." : "No fue posible crear la cuenta. Revisa el correo, la contraseña o si ya existe.");
    }
    setNewUserName("");
    setNewUserEmail("");
    setNewUserPassword("");
    setMessage("Cuenta creada y acceso asignado. La persona ya puede iniciar sesión con la contraseña definida.");
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

  async function resendInvitation(invitationId: string) {
    setIsSaving(true);
    const response = await fetch("/api/admin/invitations", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, invitationId }) });
    setIsSaving(false);
    if (!response.ok) return setMessage("No fue posible renovar la invitación. Verifica que aún esté pendiente.");
    setMessage("Invitación renovada y enviada nuevamente. El enlace anterior quedó invalidado.");
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

  async function generateRecoveryLink(member: Member) {
    setIsSaving(true);
    const response = await fetch("/api/admin/recovery-link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, userId: member.userId }) });
    const payload = await response.json().catch(() => null) as { email?: string; recoveryLink?: string } | null;
    setIsSaving(false);
    if (!response.ok || !payload?.email || !payload.recoveryLink) return setMessage("No fue posible generar el enlace seguro de recuperación.");
    setRecoveryLink({ email: payload.email, url: payload.recoveryLink });
    setMessage("Enlace de recuperación generado. Compártelo sólo con la persona indicada: permite definir una contraseña nueva.");
  }

  function openPasswordAssignment(member: Member) {
    setPasswordMember(member);
    setMemberPassword("");
    setShowMemberPassword(false);
  }

  function closePasswordAssignment() {
    setPasswordMember(null);
    setMemberPassword("");
    setShowMemberPassword(false);
  }

  async function assignPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!passwordMember || !organizationId || memberPassword.length < 12) return;
    setIsSaving(true);
    const response = await fetch("/api/admin/users", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, userId: passwordMember.userId, password: memberPassword }) });
    setIsSaving(false);
    if (!response.ok) {
      setMemberPassword("");
      return setMessage("No fue posible actualizar la contraseña. Verifica que el usuario siga teniendo acceso a esta organización.");
    }
    const name = passwordMember.profile?.full_name || passwordMember.profile?.email || "el usuario";
    closePasswordAssignment();
    setMessage(`Contraseña actualizada para ${name}. Compártela por un canal seguro.`);
  }

  async function copyRecoveryLink() {
    if (!recoveryLink) return;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(recoveryLink.url);
        copied = true;
      }
    } catch {
      copied = false;
    }

    if (!copied) {
      const input = recoveryLinkInputRef.current;
      if (input) {
        input.focus();
        input.select();
        input.setSelectionRange(0, recoveryLink.url.length);
        copied = document.execCommand("copy");
      }
    }

    if (copied) {
      setMessage("Enlace copiado. Envíalo a la persona por un canal seguro.");
      return;
    }
    setMessage("No se pudo acceder al portapapeles. El enlace quedó seleccionado: usa Cmd+C para copiarlo.");
  }

  return (
    <main className="dashboard administration-dashboard">
      <section className="headline">
        <div><span className="eyebrow">GOBIERNO Y ACCESOS</span><h1>Administración</h1><p>Controla organizaciones, miembros y responsabilidades operativas. Los permisos se aplican directamente en la base de datos.</p></div>
      </section>

      {message && <p className="operation-message">{message}</p>}
      {recoveryLink && <section className="panel recovery-link-panel"><div className="panel-heading"><div><span className="panel-label">RECUPERACIÓN ASISTIDA</span><h2>Enlace único para {recoveryLink.email}</h2><p>Este enlace no se envía por correo ni queda guardado en Atlas. Compártelo sólo con la persona autorizada.</p></div><button type="button" className="close-button" onClick={() => setRecoveryLink(null)} aria-label="Ocultar enlace">×</button></div><div className="recovery-link-row"><input ref={recoveryLinkInputRef} value={recoveryLink.url} readOnly aria-label="Enlace seguro de recuperación" /><button type="button" className="secondary-button" onClick={() => void copyRecoveryLink()}>Copiar enlace</button></div></section>}
      {passwordMember && <div className="modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) closePasswordAssignment(); }}><section className="entry-modal password-assignment-modal" role="dialog" aria-modal="true" aria-labelledby="password-assignment-title"><div className="modal-header"><div><span className="eyebrow">ACCESO DE USUARIO</span><h2 id="password-assignment-title">Asignar contraseña</h2><p>{passwordMember.profile?.full_name || passwordMember.profile?.email || "Usuario"} · {passwordMember.profile?.email ?? "Correo no disponible"}</p></div><button type="button" className="close-button" onClick={closePasswordAssignment} aria-label="Cerrar">×</button></div><form onSubmit={assignPassword}><div className="form-grid"><label>Contraseña nueva<div className="password-field"><input type={showMemberPassword ? "text" : "password"} value={memberPassword} onChange={(event) => setMemberPassword(event.target.value)} autoComplete="new-password" minLength={12} maxLength={256} placeholder="Mínimo 12 caracteres" required /><PasswordVisibilityButton visible={showMemberPassword} onClick={() => setShowMemberPassword((visible) => !visible)} /></div><small>Usa el ojo para revisar la contraseña antes de guardarla.</small></label></div><div className="form-actions"><button type="button" className="secondary-button" onClick={closePasswordAssignment} disabled={isSaving}>Cancelar</button><button type="submit" className="primary-button" disabled={isSaving || memberPassword.length < 12}>{isSaving ? "Guardando…" : "Guardar contraseña"}</button></div></form></section></div>}
      {isLoading ? <section className="panel billing-empty"><p>Cargando administración…</p></section> : <>
        <section className="admin-grid">
          <article className="panel">
            <div className="panel-heading"><div><span className="panel-label">ORGANIZACIÓN ACTIVA</span><h2>Datos legales y tributarios</h2></div></div>
            <form className="admin-form" onSubmit={updateOrganization}>
              <label>Organización<select value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}>{organizations.map((item) => <option value={item.id} key={item.id}>{item.organization.legal_name}</option>)}</select></label>
              <label>Razón social<input value={legalName} maxLength={180} onChange={(event) => setLegalName(event.target.value)} required /></label>
              <label>RUT<input value={taxId} maxLength={40} onChange={(event) => setTaxId(event.target.value)} /></label>
              <div className="admin-form-actions"><button type="submit" className="primary-button" disabled={isSaving || !organizationId}>Guardar cambios</button>{isSuperAdmin && <button type="button" className="text-button danger-button" disabled={isSaving || !organizationId} onClick={() => void deleteOrganization()}>Eliminar empresa</button>}</div>
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

        <section className="panel admin-invite-panel">
          <div className="panel-heading"><div><span className="panel-label">ALTA DIRECTA</span><h2>Crear usuario y asignar acceso</h2><p>Para incorporaciones controladas: crea la cuenta, define su contraseña inicial y asígnala inmediatamente a esta organización.</p></div></div>
          <form className="admin-invite-form" onSubmit={createUser}>
            <label>Nombre completo<input value={newUserName} maxLength={160} onChange={(event) => setNewUserName(event.target.value)} placeholder="Nombre y apellido" required /></label>
            <label>Correo<input type="email" value={newUserEmail} onChange={(event) => setNewUserEmail(event.target.value)} placeholder="nombre@empresa.cl" required /></label>
            <label>Contraseña inicial<div className="password-field"><input type={showNewUserPassword ? "text" : "password"} minLength={12} value={newUserPassword} onChange={(event) => setNewUserPassword(event.target.value)} placeholder="Mínimo 12 caracteres" autoComplete="new-password" required /><PasswordVisibilityButton visible={showNewUserPassword} onClick={() => setShowNewUserPassword((visible) => !visible)} /></div></label>
            <label>Rol<select value={newUserRole} onChange={(event) => setNewUserRole(event.target.value as OrganizationRole)}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <button className="primary-button" type="submit" disabled={isSaving || !organizationId}>Crear usuario</button>
          </form>
        </section>

        {organizationId && <ServiceCatalogManagement organizationId={organizationId} />}

        <section className="table-section">
          <div className="table-heading"><div><span className="panel-label">MIEMBROS</span><h2>Accesos de {current?.legal_name ?? "la organización"}</h2><p>{membersLoadError ?? `${members.length} activo(s) · ${invitations.length} invitación(es) pendiente(s).`}</p></div><button type="button" className="secondary-button" disabled={isSaving} onClick={() => void loadMembers(organizationId)}>Actualizar</button></div>
          <div className="table-scroll"><table className="admin-members-table"><thead><tr><th>Usuario</th><th>Rol</th><th>Estado</th><th>Fecha</th><th>Acción</th></tr></thead><tbody>{membersLoadError ? <tr><td colSpan={5}>No se pudo cargar la información de accesos.</td></tr> : <>{invitations.map((invitation) => <tr key={`invitation-${invitation.id}`}><td><strong>{invitation.email}</strong><small>Invitación enviada por correo</small></td><td>{roleLabels[invitation.role]}</td><td><span className="status pending">Pendiente</span></td><td>{new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(invitation.invitedAt))}</td><td><button type="button" className="text-button" disabled={isSaving} onClick={() => void resendInvitation(invitation.id)}>Reenviar invitación</button></td></tr>)}{members.map((member) => <tr key={member.userId}><td><strong>{member.profile?.full_name || member.profile?.email || "Usuario"}</strong><small>{member.profile?.email ?? "Correo no disponible"}</small></td><td><select value={member.role} onChange={(event) => void changeRole(member.userId, event.target.value as OrganizationRole)} disabled={isSaving}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td><td><span className="status paid">Activo</span></td><td>{new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(member.createdAt))}</td><td><div className="member-actions"><button type="button" className="text-button" disabled={isSaving} onClick={() => openPasswordAssignment(member)}>Asignar contraseña</button><button type="button" className="text-button" disabled={isSaving} onClick={() => void generateRecoveryLink(member)}>Generar enlace</button><button type="button" className="text-button" disabled={isSaving} onClick={() => void removeMember(member.userId)}>Quitar</button></div></td></tr>)}</>}</tbody></table></div>
          {!membersLoadError && !members.length && !invitations.length && <p className="billing-empty">Aún no hay accesos ni invitaciones para esta organización.</p>}
        </section>
      </>}
    </main>
  );
}
