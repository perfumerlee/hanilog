-- Contact details are optional and are disclosed only through the matching
-- active bearer share link. A recipient must opt in at link creation.
alter table public.glucose_share_links
  add column guardian_contact_phone text;

alter table public.glucose_share_links
  add constraint glucose_share_guardian_phone_e164
  check (guardian_contact_phone is null or guardian_contact_phone ~ '^\+[1-9][0-9]{7,14}$');

create function public.create_glucose_share_link_v3(
  p_pet_id uuid, p_token_hash text, p_from_date date, p_to_date date,
  p_expires_at timestamptz, p_include_care_times boolean, p_include_care_values boolean,
  p_guardian_contact_phone text default null
)
returns table(id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_exp timestamptz; v_now timestamptz := clock_timestamp();
begin
  if auth.uid() is null or not private.can_access_pet(p_pet_id,true) then
    raise exception 'PET_SHARE_ACCESS_DENIED' using errcode='42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_from_date is null or p_to_date is null or p_to_date < p_from_date or p_to_date > p_from_date + 365
     or p_expires_at is null or p_expires_at <= v_now or p_expires_at > v_now + interval '7 days'
     or (coalesce(p_include_care_values,false) and not coalesce(p_include_care_times,false))
     or (p_guardian_contact_phone is not null and p_guardian_contact_phone !~ '^\+[1-9][0-9]{7,14}$') then
    raise exception 'GLUCOSE_SHARE_INVALID' using errcode='22023';
  end if;
  insert into public.glucose_share_links(pet_id,created_by,token_hash,from_date,to_date,include_care_times,include_care_values,expires_at,guardian_contact_phone)
    values(p_pet_id,auth.uid(),p_token_hash,p_from_date,p_to_date,coalesce(p_include_care_times,false),coalesce(p_include_care_values,false),p_expires_at,p_guardian_contact_phone)
    returning glucose_share_links.id,glucose_share_links.expires_at into v_id,v_exp;
  insert into public.audit_log(actor_id,action,target_type,target_id,result,reason_code)
    values(auth.uid(),'GLUCOSE_SHARE_CREATED','glucose_share',v_id,'SUCCESS',
      case when p_guardian_contact_phone is null then 'READ_ONLY_LIMITED_RANGE' else 'READ_ONLY_WITH_GUARDIAN_CONTACT' end);
  id := v_id; expires_at := v_exp; return next;
end;
$$;
revoke all on function public.create_glucose_share_link_v3(uuid,text,date,date,timestamptz,boolean,boolean,text) from public, anon;
grant execute on function public.create_glucose_share_link_v3(uuid,text,date,date,timestamptz,boolean,boolean,text) to authenticated;

create function public.list_my_glucose_share_links_v3(p_pet_id uuid)
returns table(id uuid,from_date date,to_date date,created_at timestamptz,expires_at timestamptz,revoked_at timestamptz,
  include_care_times boolean,include_care_values boolean,guardian_contact_phone text)
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can_access_pet(p_pet_id,true) then
    raise exception 'PET_SHARE_ACCESS_DENIED' using errcode='42501';
  end if;
  return query select s.id,s.from_date,s.to_date,s.created_at,s.expires_at,s.revoked_at,
      s.include_care_times,s.include_care_values,s.guardian_contact_phone
    from public.glucose_share_links s where s.pet_id=p_pet_id order by s.created_at desc limit 50;
end;
$$;
revoke all on function public.list_my_glucose_share_links_v3(uuid) from public, anon;
grant execute on function public.list_my_glucose_share_links_v3(uuid) to authenticated;

create function public.resolve_glucose_share_link_with_contact(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb; v_phone text;
begin
  -- Existing resolver checks expiry/revocation, scopes data, and records access.
  v_result := public.resolve_glucose_share_link(p_token_hash);
  if v_result is null then return null; end if;
  select s.guardian_contact_phone into v_phone
    from public.glucose_share_links s
   where s.token_hash=p_token_hash and s.revoked_at is null and s.expires_at>clock_timestamp();
  return v_result || jsonb_build_object('guardian_contact_phone',v_phone);
end;
$$;
revoke all on function public.resolve_glucose_share_link_with_contact(text) from public, anon, authenticated;
grant execute on function public.resolve_glucose_share_link_with_contact(text) to service_role;

comment on column public.glucose_share_links.guardian_contact_phone is
  'Optional guardian phone shown to any holder of this active bearer share link only after explicit owner opt-in.';
