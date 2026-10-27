create or replace function public.rename_household(p_household_id uuid, p_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership_id uuid;
  v_current_name text;
  v_next_name text := trim(coalesce(p_name, ''));
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if length(v_next_name) not between 1 and 120 then
    raise exception 'INVALID_HOUSEHOLD_NAME' using errcode = '22023';
  end if;

  select hm.id into v_membership_id
  from public.household_memberships hm
  where hm.household_id = p_household_id
    and hm.user_id = auth.uid()
    and hm.role = 'PRIMARY_CAREGIVER'
    and hm.status = 'ACTIVE'
  for update;

  if v_membership_id is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select h.name into v_current_name
  from public.households h
  where h.id = p_household_id
  for update;

  if v_current_name is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if v_current_name = v_next_name then
    return v_current_name;
  end if;

  update public.households set name = v_next_name where id = p_household_id;
  insert into public.audit_log(actor_id, action, target_type, target_id, result, reason_code)
  values (auth.uid(), 'HOUSEHOLD_RENAMED', 'household', p_household_id, 'SUCCESS', 'NAME_UPDATED');

  return v_next_name;
end;
$$;

revoke all on function public.rename_household(uuid, text) from public;
grant execute on function public.rename_household(uuid, text) to authenticated;
