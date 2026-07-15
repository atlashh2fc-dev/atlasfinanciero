-- La aprobación formal es la única vía para mover una prefactura desde
-- revisión a aprobada. Esta condición también permite que el trigger de
-- aprobación complete el cambio aunque no tenga un JWT de usuario directo.
create or replace function public.enforce_preinvoice_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = old.status then
    if old.status <> 'draft' then
      raise exception 'Only draft preinvoices can be edited';
    end if;
    return new;
  end if;

  if old.status = 'draft' and new.status = 'review' then
    if not public.preinvoice_actor_has_role(new.organization_id, array['administrator', 'finance', 'operations']::public.organization_role[]) then
      raise exception 'Not authorized to submit preinvoice for review';
    end if;
    return new;
  end if;

  if old.status = 'review' and new.status = 'draft' then
    if not public.preinvoice_actor_has_role(new.organization_id, array['administrator', 'finance']::public.organization_role[]) then
      raise exception 'Not authorized to return preinvoice to draft';
    end if;
    return new;
  end if;

  if old.status = 'review' and new.status = 'approved' then
    if not exists (
      select 1
      from public.approval_requests request
      where request.organization_id = new.organization_id
        and request.target_type = 'preinvoice'
        and request.target_id = new.id
        and request.status = 'approved'
    ) then
      raise exception 'Preinvoice must be approved through approvals';
    end if;
    return new;
  end if;

  if old.status = 'approved' and new.status = 'issued' then
    if new.issued_document_id is null or not public.preinvoice_actor_has_role(new.organization_id, array['administrator', 'finance']::public.organization_role[]) then
      raise exception 'An authorized finance user and issued document are required';
    end if;
    return new;
  end if;

  if old.status in ('draft', 'review', 'approved') and new.status = 'cancelled' then
    if new.cancellation_reason is null or not public.preinvoice_actor_has_role(new.organization_id, array['administrator', 'finance']::public.organization_role[]) then
      raise exception 'An authorized finance user and cancellation reason are required';
    end if;
    return new;
  end if;

  raise exception 'Invalid preinvoice status transition: % to %', old.status, new.status;
end;
$$;

-- Reafirma la sincronización para cada decisión aprobada o rechazada.
create or replace function public.sync_approval_decision_to_preinvoice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'submitted' and new.target_type = 'preinvoice' then
    if new.status = 'approved' then
      update public.preinvoices
      set status = 'approved',
          approved_at = coalesce(new.completed_at, now()),
          approved_by = coalesce(auth.uid(), approved_by)
      where id = new.target_id
        and organization_id = new.organization_id
        and status = 'review';
    elsif new.status = 'rejected' then
      update public.preinvoices
      set status = 'draft'
      where id = new.target_id
        and organization_id = new.organization_id
        and status = 'review';
    end if;
  end if;
  return new;
end;
$$;

-- Corrige las prefacturas que ya tuvieron aprobación formal, pero quedaron
-- visualmente en revisión por la sincronización anterior.
update public.preinvoices preinvoice
set status = 'approved',
    approved_at = coalesce(request.completed_at, preinvoice.approved_at, now()),
    approved_by = coalesce(
      preinvoice.approved_by,
      (
        select step.decided_by
        from public.approval_steps step
        where step.approval_request_id = request.id
          and step.status = 'approved'
        order by step.decided_at desc nulls last
        limit 1
      )
    )
from public.approval_requests request
where request.organization_id = preinvoice.organization_id
  and request.target_type = 'preinvoice'
  and request.target_id = preinvoice.id
  and request.status = 'approved'
  and preinvoice.status = 'review';
