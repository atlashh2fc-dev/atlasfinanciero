-- Recepción debe conservar el mismo perfil operativo que Catalina,
-- incluida la capacidad acotada de crear proveedores desde digitación.
update public.organization_memberships reception_membership
set role = catalina_membership.role,
    can_create_suppliers = catalina_membership.can_create_suppliers
from public.profiles reception_profile,
     public.profiles catalina_profile,
     public.organization_memberships catalina_membership
where reception_profile.id = reception_membership.user_id
  and lower(reception_profile.email) = 'recepcion@geimser.cl'
  and lower(catalina_profile.email) = 'calvarezp@geimser.cl'
  and catalina_membership.user_id = catalina_profile.id
  and catalina_membership.organization_id = reception_membership.organization_id;
