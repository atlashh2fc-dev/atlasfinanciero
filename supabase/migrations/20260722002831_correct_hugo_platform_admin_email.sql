-- Corrección del correo de Hugo: la cuenta autorizada tiene dos "h" iniciales.
insert into public.platform_administrators (user_id)
select id
from auth.users
where lower(email) in ('hh2fc24@gmail.com', 'laura@geimser.cl')
on conflict (user_id) do nothing;

-- Otorga acceso operativo a todas las empresas para las cuentas canónicas.
insert into public.organization_memberships (organization_id, user_id, role)
select organization.id, administrator.user_id, 'administrator'::public.organization_role
from public.organizations organization
cross join public.platform_administrators administrator
on conflict (organization_id, user_id) do update
set role = excluded.role;

-- Revoca la cuenta escrita por error y cualquier acceso transversal que pudo
-- haber recibido durante la migración anterior.
delete from public.organization_memberships membership
using public.platform_administrators administrator, auth.users user_record
where membership.user_id = administrator.user_id
  and user_record.id = administrator.user_id
  and lower(user_record.email) = 'h2fc24@gmail.com';

delete from public.platform_administrators administrator
using auth.users user_record
where user_record.id = administrator.user_id
  and lower(user_record.email) = 'h2fc24@gmail.com';
