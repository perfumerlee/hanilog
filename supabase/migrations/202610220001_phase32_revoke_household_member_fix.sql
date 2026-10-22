-- Phase 3.2: qualify the grant ID in the membership-revocation join.
-- This preserves the Phase 3 function contract and changes no stored rows.

create or replace function public.revoke_household_member(p_household_id uuid,p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_membership public.household_memberships%rowtype; v_grant uuid;
begin
  if not private.can_manage_household(p_household_id) or p_user_id=auth.uid() then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into v_membership from public.household_memberships where household_id=p_household_id and user_id=p_user_id and status='ACTIVE' for update;
  if not found or v_membership.role='PRIMARY_CAREGIVER' then raise exception 'MEMBERSHIP_NOT_REVOCABLE' using errcode='42501'; end if;
  update public.household_memberships set status='REVOKED',revoked_at=clock_timestamp() where id=v_membership.id;
  for v_grant in select pag.id from public.pet_access_grants pag join public.pets p on p.id=pag.pet_id
    where p.household_id=p_household_id and pag.user_id=p_user_id and pag.status='ACTIVE' for update of pag
  loop
    update public.pet_access_grants set status='REVOKED',revoked_at=clock_timestamp() where id=v_grant;
  end loop;
  update public.household_invitations set status='REVOKED',resolved_at=clock_timestamp(),resolved_by=auth.uid()
    where household_id=p_household_id and invitee_email=(select lower(email) from auth.users where id=p_user_id) and status='PENDING';
  insert into public.audit_log(actor_id,action,target_type,target_id,result)
    values(auth.uid(),'HOUSEHOLD_MEMBERSHIP_REVOKED','household_membership',v_membership.id,'SUCCESS');
end;
$$;
revoke all on function public.revoke_household_member(uuid,uuid) from public;
grant execute on function public.revoke_household_member(uuid,uuid) to authenticated;
