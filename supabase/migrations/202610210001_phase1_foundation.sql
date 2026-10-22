-- HaniLog Phase 1 foundation. Synthetic data only; no clinical defaults.
create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create table public.app_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);
create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  created_by uuid not null references public.app_users(user_id),
  created_at timestamptz not null default now()
);
create table public.household_memberships (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete restrict,
  user_id uuid not null references public.app_users(user_id) on delete restrict,
  role text not null check (role in ('PRIMARY_CAREGIVER', 'CAREGIVER', 'READ_ONLY')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'REVOKED')),
  created_by uuid not null references public.app_users(user_id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check ((status = 'ACTIVE' and revoked_at is null) or (status = 'REVOKED' and revoked_at is not null))
);
create unique index household_memberships_one_active_user on public.household_memberships(household_id,user_id) where status='ACTIVE';
create unique index household_memberships_one_primary on public.household_memberships(household_id) where status='ACTIVE' and role='PRIMARY_CAREGIVER';

create table public.pets (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete restrict,
  name text not null check (length(trim(name)) between 1 and 120),
  timezone text not null,
  created_by uuid not null references public.app_users(user_id),
  created_at timestamptz not null default now()
);
create index pets_household_idx on public.pets(household_id,created_at);
create table public.pet_access_grants (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets(id) on delete restrict,
  user_id uuid not null references public.app_users(user_id) on delete restrict,
  access_role text not null check (access_role in ('CAREGIVER','READ_ONLY')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','REVOKED')),
  granted_by uuid not null references public.app_users(user_id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check ((status='ACTIVE' and revoked_at is null) or (status='REVOKED' and revoked_at is not null))
);
create unique index pet_access_grants_one_active on public.pet_access_grants(pet_id,user_id) where status='ACTIVE';
create index pet_access_grants_user_idx on public.pet_access_grants(user_id,status,pet_id);

create table public.care_team_links (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets(id) on delete restrict,
  clinician_id uuid not null references public.app_users(user_id) on delete restrict,
  scopes text[] not null default '{}',
  status text not null check (status in ('INVITED','ACCEPTED','APPROVED','REVOKED','EXPIRED')),
  invited_by uuid not null references public.app_users(user_id),
  approved_by uuid references public.app_users(user_id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check ((status='APPROVED' and approved_by is not null and approved_at is not null) or status<>'APPROVED')
);
create unique index care_team_links_one_active on public.care_team_links(pet_id,clinician_id) where status in ('INVITED','ACCEPTED','APPROVED');

create table public.care_plans (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets(id) on delete restrict,
  plan_type text not null,
  created_by uuid not null references public.app_users(user_id),
  created_at timestamptz not null default now(),
  unique(id,pet_id)
);
create index care_plans_pet_idx on public.care_plans(pet_id,created_at);
create table public.care_plan_versions (
  id uuid primary key default gen_random_uuid(),
  care_plan_id uuid not null references public.care_plans(id) on delete restrict,
  pet_id uuid not null,
  version_no integer not null check (version_no>0),
  source text not null check (source in ('USER_ENTERED','CLINICIAN_DOCUMENTED','IMPORTED')),
  author_id uuid not null references public.app_users(user_id),
  approval_status text not null default 'USER_ENTERED_UNVERIFIED' check (approval_status in ('USER_ENTERED_UNVERIFIED','CLINICIAN_CONFIRMED','REVOKED')),
  approved_by uuid references public.app_users(user_id),
  approved_at timestamptz,
  valid_from timestamptz,
  valid_to timestamptz,
  content jsonb not null default '{}'::jsonb check (jsonb_typeof(content)='object'),
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique(care_plan_id,version_no),
  unique(id,care_plan_id),
  unique(id,pet_id),
  foreign key(care_plan_id,pet_id) references public.care_plans(id,pet_id) on delete restrict,
  check (valid_to is null or valid_from is null or valid_to>valid_from),
  check ((approval_status='CLINICIAN_CONFIRMED' and approved_by is not null and approved_at is not null) or approval_status<>'CLINICIAN_CONFIRMED')
);
create table public.care_routines (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets(id) on delete restrict,
  care_plan_id uuid not null references public.care_plans(id) on delete restrict,
  timezone text not null,
  active_from date,
  active_to date,
  created_by uuid not null references public.app_users(user_id),
  created_at timestamptz not null default now(),
  unique(id,pet_id),
  unique(id,care_plan_id),
  foreign key(care_plan_id,pet_id) references public.care_plans(id,pet_id) on delete restrict,
  check (active_to is null or active_from is null or active_to>=active_from)
);
create table public.care_routine_versions (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references public.care_routines(id) on delete restrict,
  pet_id uuid not null,
  care_plan_id uuid not null,
  version_no integer not null check (version_no>0),
  care_plan_version_id uuid not null references public.care_plan_versions(id) on delete restrict,
  recurrence jsonb not null check (jsonb_typeof(recurrence)='object'),
  steps jsonb not null check (jsonb_typeof(steps)='array'),
  valid_from date,
  valid_to date,
  created_by uuid not null references public.app_users(user_id),
  created_at timestamptz not null default now(),
  unique(routine_id,version_no),
  unique(id,pet_id),
  unique(id,care_plan_id),
  foreign key(routine_id,pet_id) references public.care_routines(id,pet_id) on delete restrict,
  foreign key(routine_id,care_plan_id) references public.care_routines(id,care_plan_id) on delete restrict,
  foreign key(care_plan_version_id,care_plan_id) references public.care_plan_versions(id,care_plan_id) on delete restrict,
  foreign key(care_plan_version_id,pet_id) references public.care_plan_versions(id,pet_id) on delete restrict,
  check (valid_to is null or valid_from is null or valid_to>=valid_from)
);
create table public.routine_occurrences (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets(id) on delete restrict,
  routine_version_id uuid not null references public.care_routine_versions(id) on delete restrict,
  care_plan_version_id uuid not null references public.care_plan_versions(id) on delete restrict,
  care_plan_id uuid not null,
  occurrence_key text not null,
  step_key text not null,
  event_type text not null check (event_type in ('meal','insulin','glucose','elimination','exercise','water','weight','symptom','medication')),
  scheduled_local_date date not null,
  scheduled_local_time time not null,
  timezone text not null,
  disambiguation text check (disambiguation in ('EARLIER','LATER','NOT_AMBIGUOUS')),
  scheduled_at timestamptz,
  status text not null default 'SCHEDULED' check (status in ('SCHEDULED','CANCELLED','SUPERSEDED','SCHEDULE_TIME_UNRESOLVED')),
  supersedes_id uuid references public.routine_occurrences(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique(routine_version_id,occurrence_key,step_key),
  unique(id,pet_id),
  foreign key(routine_version_id,pet_id) references public.care_routine_versions(id,pet_id) on delete restrict,
  foreign key(care_plan_version_id,care_plan_id) references public.care_plan_versions(id,care_plan_id) on delete restrict,
  foreign key(care_plan_version_id,pet_id) references public.care_plan_versions(id,pet_id) on delete restrict
);
create index routine_occurrences_pet_scheduled_idx on public.routine_occurrences(pet_id,scheduled_at);

create table public.health_events (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets(id) on delete restrict,
  event_type text not null check (event_type in ('meal','insulin','glucose','elimination','exercise','water','weight','symptom','medication')),
  occurred_at timestamptz not null,
  client_timezone text,
  recorded_at timestamptz not null default clock_timestamp(),
  actor_id uuid not null references public.app_users(user_id),
  performer_id uuid references public.app_users(user_id),
  source text not null default 'USER_ENTERED' check (source in ('USER_ENTERED','IMPORTED')),
  value jsonb not null default '{}'::jsonb check (jsonb_typeof(value)='object'),
  unit text,
  occurrence_id uuid,
  plan_version_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  foreign key(occurrence_id,pet_id) references public.routine_occurrences(id,pet_id) on delete restrict,
  foreign key(plan_version_id,pet_id) references public.care_plan_versions(id,pet_id) on delete restrict
);
create index health_events_pet_occurred_idx on public.health_events(pet_id,occurred_at desc);
create index health_events_occurrence_type_idx on public.health_events(pet_id,occurrence_id,event_type);
create table public.health_event_revisions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.health_events(id) on delete restrict,
  revision_no integer not null check (revision_no>0),
  revision_kind text not null check (revision_kind in ('CORRECT','VOID')),
  patch jsonb not null default '{}'::jsonb check (jsonb_typeof(patch)='object'),
  reason_code text not null,
  actor_id uuid not null references public.app_users(user_id),
  recorded_at timestamptz not null default clock_timestamp(),
  unique(event_id,revision_no)
);
create table public.idempotency_records (
  actor_id uuid not null references public.app_users(user_id),
  operation text not null,
  idempotency_key uuid not null,
  request_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(actor_id,operation,idempotency_key)
);
create table public.safety_evaluations (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets(id) on delete restrict,
  occurrence_id uuid references public.routine_occurrences(id) on delete restrict,
  evaluation_status text not null check (evaluation_status in ('CURRENT','STALE','UNAVAILABLE','NOT_APPLICABLE')),
  result_codes text[] not null default '{}',
  evidence_event_ids uuid[] not null default '{}',
  evidence_revision_ids uuid[] not null default '{}',
  plan_version_id uuid references public.care_plan_versions(id) on delete restrict,
  evaluator_version text not null,
  evaluated_at timestamptz not null default clock_timestamp()
);
create index safety_evaluations_pet_time_idx on public.safety_evaluations(pet_id,evaluated_at desc);
create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references public.app_users(user_id),
  action text not null,
  target_type text not null,
  target_id uuid,
  request_id uuid,
  result text not null,
  reason_code text,
  created_at timestamptz not null default clock_timestamp()
);
create index audit_log_target_idx on public.audit_log(target_type,target_id,created_at desc);

create or replace function private.can_access_pet(p_pet_id uuid, p_write boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.pets p
    join public.household_memberships hm on hm.household_id=p.household_id
      and hm.user_id=auth.uid() and hm.status='ACTIVE'
    join public.pet_access_grants pag on pag.pet_id=p.id
      and pag.user_id=auth.uid() and pag.status='ACTIVE'
    where p.id=p_pet_id
      and (not p_write or (hm.role in ('PRIMARY_CAREGIVER','CAREGIVER') and pag.access_role='CAREGIVER'))
  );
$$;
revoke all on function private.can_access_pet(uuid,boolean) from public;
grant execute on function private.can_access_pet(uuid,boolean) to authenticated;

create or replace function private.can_manage_household(p_household_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.household_memberships hm
    where hm.household_id=p_household_id and hm.user_id=auth.uid()
      and hm.status='ACTIVE' and hm.role='PRIMARY_CAREGIVER');
$$;
revoke all on function private.can_manage_household(uuid) from public;
grant execute on function private.can_manage_household(uuid) to authenticated;

create or replace function private.is_household_member(p_household_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.household_memberships hm
    where hm.household_id=p_household_id and hm.user_id=auth.uid() and hm.status='ACTIVE');
$$;
revoke all on function private.is_household_member(uuid) from public;
grant execute on function private.is_household_member(uuid) to authenticated;

create or replace function private.can_be_recorded_performer(p_pet_id uuid,p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.pets p
    join public.household_memberships hm on hm.household_id=p.household_id and hm.user_id=p_user_id and hm.status='ACTIVE'
    join public.pet_access_grants pag on pag.pet_id=p.id and pag.user_id=p_user_id and pag.status='ACTIVE' and pag.access_role='CAREGIVER'
    where p.id=p_pet_id and hm.role in ('PRIMARY_CAREGIVER','CAREGIVER'));
$$;
revoke all on function private.can_be_recorded_performer(uuid,uuid) from public;

create or replace function private.ensure_app_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.app_users(user_id,display_name)
  values(new.id,nullif(new.raw_user_meta_data->>'display_name','')) on conflict(user_id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.ensure_app_user();

create or replace function public.create_household(p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  insert into public.app_users(user_id) values(auth.uid()) on conflict(user_id) do nothing;
  insert into public.households(name,created_by) values(trim(p_name),auth.uid()) returning id into v_id;
  insert into public.household_memberships(household_id,user_id,role,status,created_by)
    values(v_id,auth.uid(),'PRIMARY_CAREGIVER','ACTIVE',auth.uid());
  insert into public.audit_log(actor_id,action,target_type,target_id,result)
    values(auth.uid(),'HOUSEHOLD_CREATED','household',v_id,'SUCCESS');
  return v_id;
end;
$$;
revoke all on function public.create_household(text) from public;
grant execute on function public.create_household(text) to authenticated;

create or replace function public.create_pet(p_household_id uuid,p_name text,p_timezone text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null or not private.can_manage_household(p_household_id) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=p_timezone) then raise exception 'INVALID_TIMEZONE' using errcode='22023'; end if;
  insert into public.pets(household_id,name,timezone,created_by) values(p_household_id,trim(p_name),p_timezone,auth.uid()) returning id into v_id;
  insert into public.pet_access_grants(pet_id,user_id,access_role,status,granted_by) values(v_id,auth.uid(),'CAREGIVER','ACTIVE',auth.uid());
  insert into public.audit_log(actor_id,action,target_type,target_id,result) values(auth.uid(),'PET_CREATED','pet',v_id,'SUCCESS');
  return v_id;
end;
$$;
revoke all on function public.create_pet(uuid,text,text) from public;
grant execute on function public.create_pet(uuid,text,text) to authenticated;

create or replace function public.grant_pet_access(p_pet_id uuid,p_user_id uuid,p_access_role text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_household_id uuid;
begin
  select household_id into v_household_id from public.pets where id=p_pet_id;
  if v_household_id is null or not private.can_manage_household(v_household_id) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if p_access_role not in ('CAREGIVER','READ_ONLY') then raise exception 'INVALID_ROLE' using errcode='22023'; end if;
  if not exists(select 1 from public.household_memberships where household_id=v_household_id and user_id=p_user_id and status='ACTIVE') then
    raise exception 'ACTIVE_MEMBERSHIP_REQUIRED' using errcode='42501';
  end if;
  insert into public.pet_access_grants(pet_id,user_id,access_role,status,granted_by)
    values(p_pet_id,p_user_id,p_access_role,'ACTIVE',auth.uid()) returning id into v_id;
  insert into public.audit_log(actor_id,action,target_type,target_id,result) values(auth.uid(),'PET_ACCESS_GRANTED','pet_access_grant',v_id,'SUCCESS');
  return v_id;
end;
$$;
revoke all on function public.grant_pet_access(uuid,uuid,text) from public;
grant execute on function public.grant_pet_access(uuid,uuid,text) to authenticated;

create or replace function public.record_health_event(
  p_pet_id uuid,p_event_type text,p_occurred_at timestamptz,p_occurrence_id uuid,
  p_value jsonb,p_unit text,p_idempotency_key uuid,p_client_timezone text default null,p_performer_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text; v_existing public.idempotency_records%rowtype; v_event_id uuid; v_eval_id uuid;
  v_result_codes text[] := '{}'; v_evidence uuid[] := '{}'; v_plan_version_id uuid;
  v_status text := 'NOT_APPLICABLE'; v_count integer := 0; v_response jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  if not private.can_access_pet(p_pet_id,true) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if p_performer_id is not null and not private.can_be_recorded_performer(p_pet_id,p_performer_id) then
    raise exception 'PERFORMER_NOT_AUTHORIZED' using errcode='42501';
  end if;
  if p_event_type is null or p_event_type not in ('meal','insulin','glucose','elimination','exercise','water','weight','symptom','medication') then raise exception 'INVALID_EVENT_TYPE' using errcode='22023'; end if;
  if p_value is null or jsonb_typeof(p_value)<>'object' then raise exception 'INVALID_VALUE' using errcode='22023'; end if;
  if p_idempotency_key is null then raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode='22023'; end if;
  if p_client_timezone is not null and not exists(select 1 from pg_catalog.pg_timezone_names where name=p_client_timezone) then
    raise exception 'INVALID_CLIENT_TIMEZONE' using errcode='22023';
  end if;
  if p_occurrence_id is not null and not exists(
    select 1 from public.routine_occurrences where id=p_occurrence_id and pet_id=p_pet_id and event_type=p_event_type
  ) then
    raise exception 'OCCURRENCE_PET_OR_TYPE_MISMATCH' using errcode='23503';
  end if;
  v_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'pet_id',p_pet_id,'event_type',p_event_type,'occurred_at',p_occurred_at,'occurrence_id',p_occurrence_id,
    'value',p_value,'unit',p_unit,'client_timezone',p_client_timezone,'performer_id',p_performer_id)::text,'UTF8'),'sha256'),'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text||':record_health_event:'||p_idempotency_key::text,0));
  select * into v_existing from public.idempotency_records
    where actor_id=auth.uid() and operation='record_health_event' and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.request_hash<>v_hash then raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='23505'; end if;
    return v_existing.response;
  end if;
  if p_occurrence_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_pet_id::text||':'||p_occurrence_id::text||':'||p_event_type,0));
    select care_plan_version_id into v_plan_version_id from public.routine_occurrences where id=p_occurrence_id and pet_id=p_pet_id;
    v_status := 'CURRENT';
  end if;
  insert into public.health_events(pet_id,event_type,occurred_at,client_timezone,actor_id,performer_id,value,unit,occurrence_id,plan_version_id)
    values(p_pet_id,p_event_type,p_occurred_at,p_client_timezone,auth.uid(),p_performer_id,p_value,p_unit,p_occurrence_id,v_plan_version_id)
    returning id into v_event_id;
  if p_occurrence_id is not null and p_event_type='insulin' then
    select count(*)::integer,coalesce(array_agg(he.id),'{}') into v_count,v_evidence
      from public.health_events he where he.pet_id=p_pet_id and he.occurrence_id=p_occurrence_id and he.event_type='insulin'
      and not exists(select 1 from public.health_event_revisions r where r.event_id=he.id and r.revision_kind='VOID'
        and r.revision_no=(select max(r2.revision_no) from public.health_event_revisions r2 where r2.event_id=he.id));
    if v_count>1 then v_result_codes:=array_append(v_result_codes,'DUPLICATE_POSSIBLE'); end if;
    if exists(select 1 from public.care_plan_versions where id=v_plan_version_id and approval_status<>'CLINICIAN_CONFIRMED') then
      v_result_codes:=array_append(v_result_codes,'PLAN_UNVERIFIED');
    end if;
    if exists(select 1 from public.routine_occurrences meal_slot
      where meal_slot.pet_id=p_pet_id
        and meal_slot.routine_version_id=(select routine_version_id from public.routine_occurrences where id=p_occurrence_id)
        and meal_slot.occurrence_key=(select occurrence_key from public.routine_occurrences where id=p_occurrence_id)
        and meal_slot.event_type='meal'
        and not exists(select 1 from public.health_events meal_event where meal_event.occurrence_id=meal_slot.id and meal_event.event_type='meal'
          and not exists(select 1 from public.health_event_revisions r where r.event_id=meal_event.id and r.revision_kind='VOID'
            and r.revision_no=(select max(r2.revision_no) from public.health_event_revisions r2 where r2.event_id=meal_event.id)))) then
      v_result_codes:=array_append(v_result_codes,'MEAL_UNCONFIRMED');
    end if;
  end if;
  insert into public.safety_evaluations(pet_id,occurrence_id,evaluation_status,result_codes,evidence_event_ids,plan_version_id,evaluator_version)
    values(p_pet_id,p_occurrence_id,v_status,v_result_codes,
      case when p_event_type='insulin' then v_evidence else array[v_event_id] end,v_plan_version_id,'phase1-data-guard-1') returning id into v_eval_id;
  insert into public.audit_log(actor_id,action,target_type,target_id,request_id,result,reason_code)
    values(auth.uid(),'HEALTH_EVENT_RECORDED','health_event',v_event_id,p_idempotency_key,'SUCCESS',p_event_type);
  v_response:=jsonb_build_object('event_id',v_event_id,'evaluation_id',v_eval_id,'evaluation_status',v_status,
    'result_codes',to_jsonb(v_result_codes),'recorded_at',clock_timestamp());
  insert into public.idempotency_records(actor_id,operation,idempotency_key,request_hash,response)
    values(auth.uid(),'record_health_event',p_idempotency_key,v_hash,v_response);
  return v_response;
end;
$$;
revoke all on function public.record_health_event(uuid,text,timestamptz,uuid,jsonb,text,uuid,text,uuid) from public;
grant execute on function public.record_health_event(uuid,text,timestamptz,uuid,jsonb,text,uuid,text,uuid) to authenticated;

create or replace function public.revise_health_event(
  p_event_id uuid,p_expected_revision integer,p_revision_kind text,p_patch jsonb,p_reason_code text,p_idempotency_key uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_event public.health_events%rowtype; v_latest integer; v_revision_id uuid; v_hash text;
  v_existing public.idempotency_records%rowtype; v_response jsonb;
begin
  select * into v_event from public.health_events where id=p_event_id;
  if not found or not private.can_access_pet(v_event.pet_id,true) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if p_idempotency_key is null then raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode='22023'; end if;
  if p_revision_kind not in ('CORRECT','VOID') or p_patch is null or jsonb_typeof(p_patch)<>'object' then raise exception 'INVALID_REVISION' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text||':revise_health_event:'||p_idempotency_key::text,0));
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('event_id',p_event_id,'expected',p_expected_revision,
    'kind',p_revision_kind,'patch',p_patch,'reason',p_reason_code)::text,'UTF8'),'sha256'),'hex');
  select * into v_existing from public.idempotency_records where actor_id=auth.uid() and operation='revise_health_event' and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.request_hash<>v_hash then raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='23505'; end if;
    return (v_existing.response->>'revision_id')::uuid;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_event_id::text,1));
  select coalesce(max(revision_no),0) into v_latest from public.health_event_revisions where event_id=p_event_id;
  if v_latest<>p_expected_revision then raise exception 'REVISION_CONFLICT' using errcode='40001'; end if;
  insert into public.health_event_revisions(event_id,revision_no,revision_kind,patch,reason_code,actor_id)
    values(p_event_id,v_latest+1,p_revision_kind,p_patch,p_reason_code,auth.uid()) returning id into v_revision_id;
  update public.safety_evaluations set evaluation_status='STALE' where pet_id=v_event.pet_id and evaluation_status='CURRENT';
  insert into public.audit_log(actor_id,action,target_type,target_id,request_id,result,reason_code)
    values(auth.uid(),'HEALTH_EVENT_REVISED','health_event',p_event_id,p_idempotency_key,'SUCCESS',p_revision_kind);
  v_response:=jsonb_build_object('revision_id',v_revision_id);
  insert into public.idempotency_records(actor_id,operation,idempotency_key,request_hash,response)
    values(auth.uid(),'revise_health_event',p_idempotency_key,v_hash,v_response);
  return v_revision_id;
end;
$$;
revoke all on function public.revise_health_event(uuid,integer,text,jsonb,text,uuid) from public;
grant execute on function public.revise_health_event(uuid,integer,text,jsonb,text,uuid) to authenticated;

alter table public.app_users enable row level security;
alter table public.households enable row level security;
alter table public.household_memberships enable row level security;
alter table public.pets enable row level security;
alter table public.pet_access_grants enable row level security;
alter table public.care_team_links enable row level security;
alter table public.care_plans enable row level security;
alter table public.care_plan_versions enable row level security;
alter table public.care_routines enable row level security;
alter table public.care_routine_versions enable row level security;
alter table public.routine_occurrences enable row level security;
alter table public.health_events enable row level security;
alter table public.health_event_revisions enable row level security;
alter table public.idempotency_records enable row level security;
alter table public.safety_evaluations enable row level security;
alter table public.audit_log enable row level security;

create policy app_users_self_select on public.app_users for select to authenticated using(user_id=auth.uid());
create policy app_users_self_update on public.app_users for update to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
create policy households_member_select on public.households for select to authenticated using(private.is_household_member(id));
create policy memberships_household_member_select on public.household_memberships for select to authenticated using(private.is_household_member(household_id));
create policy pets_granted_select on public.pets for select to authenticated using(private.can_access_pet(id,false));
create policy pet_grants_granted_select on public.pet_access_grants for select to authenticated using(private.can_access_pet(pet_id,false));
create policy care_team_pet_read on public.care_team_links for select to authenticated using(private.can_access_pet(pet_id,false));
create policy care_plans_pet_read on public.care_plans for select to authenticated using(private.can_access_pet(pet_id,false));
create policy care_plan_versions_pet_read on public.care_plan_versions for select to authenticated using(
  exists(select 1 from public.care_plans cp where cp.id=care_plan_id and private.can_access_pet(cp.pet_id,false))
);
create policy care_routines_pet_read on public.care_routines for select to authenticated using(private.can_access_pet(pet_id,false));
create policy care_routine_versions_pet_read on public.care_routine_versions for select to authenticated using(
  exists(select 1 from public.care_routines cr where cr.id=routine_id and private.can_access_pet(cr.pet_id,false))
);
create policy occurrences_pet_read on public.routine_occurrences for select to authenticated using(private.can_access_pet(pet_id,false));
create policy health_events_pet_read on public.health_events for select to authenticated using(private.can_access_pet(pet_id,false));
create policy event_revisions_pet_read on public.health_event_revisions for select to authenticated using(
  exists(select 1 from public.health_events he where he.id=event_id and private.can_access_pet(he.pet_id,false))
);
create policy evaluations_pet_read on public.safety_evaluations for select to authenticated using(private.can_access_pet(pet_id,false));

revoke all on all tables in schema public from anon,authenticated;
grant select on public.app_users,public.households,public.household_memberships,public.pets,public.pet_access_grants,
  public.care_team_links,public.care_plans,public.care_plan_versions,public.care_routines,
  public.care_routine_versions,public.routine_occurrences,public.health_events,
  public.health_event_revisions,public.safety_evaluations to authenticated;
grant update(display_name) on public.app_users to authenticated;
revoke insert,update,delete,truncate,references,trigger on all tables in schema public from anon,authenticated;
