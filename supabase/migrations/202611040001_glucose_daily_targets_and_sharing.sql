-- Per-pet glucose targets and short-lived, read-only glucose sharing.
-- Targets are caregiver-entered values transcribed from veterinary guidance;
-- they are descriptive only and are never used to approve treatment.

create table public.pet_glucose_target_ranges (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets(id) on delete restrict,
  lower_mg_dl numeric not null check (lower_mg_dl > 0),
  upper_mg_dl numeric not null check (upper_mg_dl > lower_mg_dl),
  source_label text not null check (length(btrim(source_label)) between 1 and 160),
  effective_on date not null,
  set_by uuid not null references public.app_users(user_id),
  created_at timestamptz not null default clock_timestamp(),
  superseded_at timestamptz,
  superseded_by uuid references public.app_users(user_id),
  check ((superseded_at is null) = (superseded_by is null))
);
create unique index pet_glucose_target_ranges_one_current
  on public.pet_glucose_target_ranges(pet_id) where superseded_at is null;
create index pet_glucose_target_ranges_pet_history
  on public.pet_glucose_target_ranges(pet_id, effective_on desc, created_at desc);
alter table public.pet_glucose_target_ranges enable row level security;
create policy glucose_target_ranges_pet_read on public.pet_glucose_target_ranges
  for select to authenticated using (private.can_access_pet(pet_id, false));
revoke all on public.pet_glucose_target_ranges from anon, authenticated;
grant select on public.pet_glucose_target_ranges to authenticated;

create or replace function public.set_pet_glucose_target_range(
  p_pet_id uuid, p_lower_mg_dl numeric, p_upper_mg_dl numeric,
  p_source_label text, p_effective_on date
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_old_id uuid;
begin
  if auth.uid() is null or not private.can_access_pet(p_pet_id, true) then
    raise exception 'PET_PROFILE_ACCESS_DENIED' using errcode='42501';
  end if;
  if p_lower_mg_dl is null or p_upper_mg_dl is null or p_lower_mg_dl <= 0 or p_upper_mg_dl <= p_lower_mg_dl
     or p_source_label is null or length(btrim(p_source_label)) not between 1 and 160
     or p_effective_on is null then
    raise exception 'GLUCOSE_TARGET_INVALID' using errcode='22023';
  end if;
  perform 1 from public.pets where id=p_pet_id for update;
  if not found then raise exception 'PET_NOT_FOUND' using errcode='P0002'; end if;
  update public.pet_glucose_target_ranges
     set superseded_at=clock_timestamp(), superseded_by=auth.uid()
   where pet_id=p_pet_id and superseded_at is null returning id into v_old_id;
  insert into public.pet_glucose_target_ranges(pet_id,lower_mg_dl,upper_mg_dl,source_label,effective_on,set_by)
    values(p_pet_id,p_lower_mg_dl,p_upper_mg_dl,btrim(p_source_label),p_effective_on,auth.uid()) returning id into v_id;
  insert into public.audit_log(actor_id,action,target_type,target_id,result,reason_code)
    values(auth.uid(),'GLUCOSE_TARGET_RANGE_SET','pet',p_pet_id,'SUCCESS',case when v_old_id is null then 'INITIAL' else 'REPLACED' end);
  return v_id;
end;
$$;
revoke all on function public.set_pet_glucose_target_range(uuid,numeric,numeric,text,date) from public, anon;
grant execute on function public.set_pet_glucose_target_range(uuid,numeric,numeric,text,date) to authenticated;

create table public.glucose_share_links (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets(id) on delete restrict,
  created_by uuid not null references public.app_users(user_id),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  from_date date not null,
  to_date date not null,
  include_care_times boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references public.app_users(user_id),
  check (to_date >= from_date and to_date <= from_date + 365),
  check (expires_at > created_at and expires_at <= created_at + interval '7 days'),
  check ((revoked_at is null) = (revoked_by is null))
);
create index glucose_share_links_pet_active on public.glucose_share_links(pet_id,expires_at desc)
  where revoked_at is null;
alter table public.glucose_share_links enable row level security;
revoke all on public.glucose_share_links from public, anon, authenticated;

create table public.glucose_share_access_log (
  id bigint generated always as identity primary key,
  share_id uuid not null references public.glucose_share_links(id) on delete restrict,
  accessed_at timestamptz not null default clock_timestamp()
);
create index glucose_share_access_log_share on public.glucose_share_access_log(share_id,accessed_at desc);
alter table public.glucose_share_access_log enable row level security;
revoke all on public.glucose_share_access_log from public, anon, authenticated;

create or replace function public.create_glucose_share_link(
  p_pet_id uuid, p_token_hash text, p_from_date date, p_to_date date,
  p_expires_at timestamptz, p_include_care_times boolean default false
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
     or p_expires_at is null or p_expires_at <= v_now or p_expires_at > v_now + interval '7 days' then
    raise exception 'GLUCOSE_SHARE_INVALID' using errcode='22023';
  end if;
  insert into public.glucose_share_links(pet_id,created_by,token_hash,from_date,to_date,include_care_times,expires_at)
    values(p_pet_id,auth.uid(),p_token_hash,p_from_date,p_to_date,coalesce(p_include_care_times,false),p_expires_at)
    returning glucose_share_links.id,glucose_share_links.expires_at into v_id,v_exp;
  insert into public.audit_log(actor_id,action,target_type,target_id,result,reason_code)
    values(auth.uid(),'GLUCOSE_SHARE_CREATED','glucose_share',v_id,'SUCCESS','READ_ONLY_LIMITED_RANGE');
  id := v_id; expires_at := v_exp; return next;
end;
$$;
revoke all on function public.create_glucose_share_link(uuid,text,date,date,timestamptz,boolean) from public, anon;
grant execute on function public.create_glucose_share_link(uuid,text,date,date,timestamptz,boolean) to authenticated;

create or replace function public.list_my_glucose_share_links(p_pet_id uuid)
returns table(id uuid,from_date date,to_date date,created_at timestamptz,expires_at timestamptz,revoked_at timestamptz,include_care_times boolean)
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can_access_pet(p_pet_id,true) then
    raise exception 'PET_SHARE_ACCESS_DENIED' using errcode='42501';
  end if;
  return query select s.id,s.from_date,s.to_date,s.created_at,s.expires_at,s.revoked_at,s.include_care_times
    from public.glucose_share_links s where s.pet_id=p_pet_id order by s.created_at desc limit 50;
end;
$$;
revoke all on function public.list_my_glucose_share_links(uuid) from public, anon;
grant execute on function public.list_my_glucose_share_links(uuid) to authenticated;

create or replace function public.revoke_glucose_share_link(p_share_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_pet_id uuid;
begin
  select pet_id into v_pet_id from public.glucose_share_links where id=p_share_id for update;
  if not found or auth.uid() is null or not private.can_access_pet(v_pet_id,true) then
    raise exception 'PET_SHARE_ACCESS_DENIED' using errcode='42501';
  end if;
  update public.glucose_share_links set revoked_at=clock_timestamp(),revoked_by=auth.uid()
    where id=p_share_id and revoked_at is null;
  if found then
    insert into public.audit_log(actor_id,action,target_type,target_id,result,reason_code)
      values(auth.uid(),'GLUCOSE_SHARE_REVOKED','glucose_share',p_share_id,'SUCCESS','CAREGIVER_REVOKED');
  end if;
  return true;
end;
$$;
revoke all on function public.revoke_glucose_share_link(uuid) from public, anon;
grant execute on function public.revoke_glucose_share_link(uuid) to authenticated;

-- Callable only by the server Edge Function. The 256-bit token is sent in a POST
-- body, hashed there, and never placed in a query string or database access log.
create or replace function public.resolve_glucose_share_link(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_share public.glucose_share_links%rowtype; v_pet public.pets%rowtype; v_result jsonb;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then return null; end if;
  select * into v_share from public.glucose_share_links s
   where s.token_hash=p_token_hash and s.revoked_at is null and s.expires_at>clock_timestamp();
  if not found then return null; end if;
  select * into v_pet from public.pets p where p.id=v_share.pet_id;
  if not found then return null; end if;
  insert into public.glucose_share_access_log(share_id) values(v_share.id);
  select jsonb_build_object(
    'pet_name',v_pet.name,'timezone',v_pet.timezone,'from_date',v_share.from_date,'to_date',v_share.to_date,
    'created_at',v_share.created_at,'expires_at',v_share.expires_at,
    'target_range',(select jsonb_build_object('lower_mg_dl',t.lower_mg_dl,'upper_mg_dl',t.upper_mg_dl,
      'source_label',t.source_label,'effective_on',t.effective_on)
      from public.pet_glucose_target_ranges t where t.pet_id=v_pet.id and t.superseded_at is null),
    'measurements',coalesce((
      select jsonb_agg(jsonb_build_object('id',e.id,'occurred_at',e.occurred_at,'recorded_at',e.recorded_at,
        'value',jsonb_strip_nulls(jsonb_build_object(
          'observed_value',coalesce(r.patch->'value'->'observed_value',r.patch->'observed_value',e.value->'observed_value'),
          'measurement_condition',coalesce(r.patch->'value'->'measurement_condition',r.patch->'measurement_condition',e.value->'measurement_condition'),
          'measurement_source',coalesce(r.patch->'value'->'measurement_source',r.patch->'measurement_source',e.value->'measurement_source')
        )),
        'unit',coalesce(r.patch->>'unit',e.unit),'revision_kind',r.revision_kind)
        order by e.occurred_at,e.id)
      from public.health_events e
      left join lateral (select hr.patch,hr.revision_kind from public.health_event_revisions hr
        where hr.event_id=e.id order by hr.revision_no desc limit 1) r on true
      where e.pet_id=v_pet.id and e.event_type='glucose' and coalesce(r.revision_kind,'')<>'VOID'
        and e.unit='mg/dL'
        and e.occurred_at >= (v_share.from_date::timestamp at time zone v_pet.timezone)
        and e.occurred_at < ((v_share.to_date + 1)::timestamp at time zone v_pet.timezone)
    ),'[]'::jsonb),
    'care_times',case when v_share.include_care_times then coalesce((
      select jsonb_agg(jsonb_build_object('event_type',e.event_type,'occurred_at',e.occurred_at) order by e.occurred_at,e.id)
      from public.health_events e where e.pet_id=v_pet.id and e.event_type in ('meal','insulin')
        and coalesce((select hr.revision_kind from public.health_event_revisions hr
          where hr.event_id=e.id order by hr.revision_no desc limit 1),'CORRECT')<>'VOID'
        and e.occurred_at >= (v_share.from_date::timestamp at time zone v_pet.timezone)
        and e.occurred_at < ((v_share.to_date + 1)::timestamp at time zone v_pet.timezone)
    ),'[]'::jsonb) else '[]'::jsonb end
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.resolve_glucose_share_link(text) from public, anon, authenticated;
grant execute on function public.resolve_glucose_share_link(text) to service_role;

comment on table public.pet_glucose_target_ranges is
  'Append-only history of caregiver-entered glucose targets received from veterinary guidance; descriptive only.';
comment on table public.glucose_share_links is
  'Short-lived, revocable, read-only capability links for explicitly scoped glucose records.';
comment on function public.resolve_glucose_share_link(text) is
  'Server-only resolver. Returns only the selected mg/dL measurements, optional meal/insulin timestamps without doses, and the current descriptive target range.';
