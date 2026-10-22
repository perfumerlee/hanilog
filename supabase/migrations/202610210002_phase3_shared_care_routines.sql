-- Phase 3: invitation, Pet grants, versioned routines and guard acknowledgement.
-- Invitation secrets are returned once and only their SHA-256 digests are stored.

alter table public.care_routines add column if not exists name text not null default 'Care Routine';

create table public.household_invitations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete restrict,
  invitee_email text not null,
  membership_role text not null check (membership_role in ('CAREGIVER','READ_ONLY')),
  pet_ids uuid[] not null check (cardinality(pet_ids)>0),
  token_hash text not null unique,
  status text not null default 'PENDING' check (status in ('PENDING','ACCEPTED','REJECTED','REVOKED','EXPIRED')),
  invited_by uuid not null references public.app_users(user_id),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  resolved_at timestamptz,
  resolved_by uuid references public.app_users(user_id),
  check (expires_at>created_at),
  check ((status='PENDING' and resolved_at is null) or (status<>'PENDING' and resolved_at is not null))
);
create index household_invitations_household_status_idx on public.household_invitations(household_id,status,expires_at);
alter table public.household_invitations enable row level security;
create policy invitations_household_manager_read on public.household_invitations
  for select to authenticated using(private.can_manage_household(household_id));
revoke all on public.household_invitations from anon,authenticated;
grant select on public.household_invitations to authenticated;

alter table public.safety_evaluations add constraint safety_evaluations_id_pet_unique unique(id,pet_id);

create table public.safety_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets(id) on delete restrict,
  evaluation_id uuid not null references public.safety_evaluations(id) on delete restrict,
  actor_id uuid not null references public.app_users(user_id),
  acknowledged_codes text[] not null check (cardinality(acknowledged_codes)>0),
  acknowledged_at timestamptz not null default clock_timestamp(),
  foreign key(evaluation_id,pet_id) references public.safety_evaluations(id,pet_id) on delete restrict
);

alter table public.safety_acknowledgements enable row level security;
create policy safety_acknowledgements_pet_read on public.safety_acknowledgements
  for select to authenticated using(private.can_access_pet(pet_id,false));
revoke all on public.safety_acknowledgements from anon,authenticated;
grant select on public.safety_acknowledgements to authenticated;

create or replace function public.create_household_invitation(
  p_household_id uuid,p_invitee_email text,p_membership_role text,p_pet_ids uuid[],p_expires_at timestamptz default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_token text; v_expiry timestamptz;
begin
  if auth.uid() is null or not private.can_manage_household(p_household_id) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if p_membership_role not in ('CAREGIVER','READ_ONLY') or p_invitee_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    or p_pet_ids is null or cardinality(p_pet_ids)=0 then raise exception 'INVALID_INVITATION' using errcode='22023'; end if;
  if exists(select 1 from unnest(p_pet_ids) x where not exists(select 1 from public.pets p where p.id=x and p.household_id=p_household_id)) then
    raise exception 'PET_OUTSIDE_HOUSEHOLD' using errcode='23503'; end if;
  v_expiry:=coalesce(p_expires_at,clock_timestamp()+interval '7 days');
  if v_expiry<=clock_timestamp() or v_expiry>clock_timestamp()+interval '30 days' then raise exception 'INVALID_EXPIRY' using errcode='22023'; end if;
  v_token:=rtrim(translate(encode(extensions.gen_random_bytes(32),'base64'),'+/','-_'),'=');
  insert into public.household_invitations(household_id,invitee_email,membership_role,pet_ids,token_hash,invited_by,expires_at)
    values(p_household_id,lower(trim(p_invitee_email)),p_membership_role,p_pet_ids,
      encode(extensions.digest(convert_to(v_token,'UTF8'),'sha256'),'hex'),auth.uid(),v_expiry) returning id into v_id;
  insert into public.audit_log(actor_id,action,target_type,target_id,result,reason_code)
    values(auth.uid(),'HOUSEHOLD_INVITATION_CREATED','household_invitation',v_id,'SUCCESS',p_membership_role);
  return jsonb_build_object('invitation_id',v_id,'token',v_token,'expires_at',v_expiry);
end;
$$;
revoke all on function public.create_household_invitation(uuid,text,text,uuid[],timestamptz) from public;
grant execute on function public.create_household_invitation(uuid,text,text,uuid[],timestamptz) to authenticated;

create or replace function public.resolve_household_invitation(p_token text,p_accept boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_inv public.household_invitations%rowtype; v_user_email text; v_membership_id uuid; v_pet uuid;
begin
  if auth.uid() is null or coalesce(length(p_token),0)<40 then raise exception 'INVITATION_INVALID' using errcode='42501'; end if;
  select lower(coalesce(auth.jwt()->>'email','')) into v_user_email;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(encode(extensions.digest(convert_to(p_token,'UTF8'),'sha256'),'hex'),0));
  select * into v_inv from public.household_invitations
    where token_hash=encode(extensions.digest(convert_to(p_token,'UTF8'),'sha256'),'hex') for update;
  if not found or v_inv.status<>'PENDING' or v_inv.invitee_email<>v_user_email then raise exception 'INVITATION_INVALID_OR_USED' using errcode='42501'; end if;
  if v_inv.expires_at<=clock_timestamp() then
    update public.household_invitations set status='EXPIRED',resolved_at=clock_timestamp(),resolved_by=auth.uid() where id=v_inv.id;
    insert into public.audit_log(actor_id,action,target_type,target_id,result,reason_code)
      values(auth.uid(),'HOUSEHOLD_INVITATION_EXPIRED','household_invitation',v_inv.id,'EXPIRED','TOKEN_EXPIRED');
    return jsonb_build_object('status','EXPIRED');
  end if;
  if not p_accept then
    update public.household_invitations set status='REJECTED',resolved_at=clock_timestamp(),resolved_by=auth.uid() where id=v_inv.id;
    insert into public.audit_log(actor_id,action,target_type,target_id,result) values(auth.uid(),'HOUSEHOLD_INVITATION_REJECTED','household_invitation',v_inv.id,'SUCCESS');
    return jsonb_build_object('status','REJECTED');
  end if;
  if exists(select 1 from public.household_memberships where household_id=v_inv.household_id and user_id=auth.uid() and status='ACTIVE') then
    raise exception 'ACTIVE_MEMBERSHIP_EXISTS' using errcode='23505'; end if;
  insert into public.app_users(user_id) values(auth.uid()) on conflict(user_id) do nothing;
  insert into public.household_memberships(household_id,user_id,role,status,created_by)
    values(v_inv.household_id,auth.uid(),v_inv.membership_role,'ACTIVE',v_inv.invited_by) returning id into v_membership_id;
  foreach v_pet in array v_inv.pet_ids loop
    insert into public.pet_access_grants(pet_id,user_id,access_role,status,granted_by)
      values(v_pet,auth.uid(),case when v_inv.membership_role='READ_ONLY' then 'READ_ONLY' else 'CAREGIVER' end,'ACTIVE',v_inv.invited_by);
  end loop;
  update public.household_invitations set status='ACCEPTED',resolved_at=clock_timestamp(),resolved_by=auth.uid() where id=v_inv.id;
  insert into public.audit_log(actor_id,action,target_type,target_id,result,reason_code)
    values(auth.uid(),'HOUSEHOLD_INVITATION_ACCEPTED','household_invitation',v_inv.id,'SUCCESS',v_inv.membership_role);
  return jsonb_build_object('status','ACCEPTED','membership_id',v_membership_id);
end;
$$;
revoke all on function public.resolve_household_invitation(text,boolean) from public;
grant execute on function public.resolve_household_invitation(text,boolean) to authenticated;

create or replace function public.revoke_household_invitation(p_invitation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_inv public.household_invitations%rowtype;
begin
  select * into v_inv from public.household_invitations where id=p_invitation_id for update;
  if not found or not private.can_manage_household(v_inv.household_id) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if v_inv.status<>'PENDING' then raise exception 'INVITATION_NOT_PENDING' using errcode='22023'; end if;
  update public.household_invitations set status='REVOKED',resolved_at=clock_timestamp(),resolved_by=auth.uid() where id=v_inv.id;
  insert into public.audit_log(actor_id,action,target_type,target_id,result) values(auth.uid(),'HOUSEHOLD_INVITATION_REVOKED','household_invitation',v_inv.id,'SUCCESS');
end;
$$;
revoke all on function public.revoke_household_invitation(uuid) from public;
grant execute on function public.revoke_household_invitation(uuid) to authenticated;

create or replace function public.manage_pet_access(p_pet_id uuid,p_user_id uuid,p_access_role text,p_revoke boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_household uuid; v_grant uuid;
begin
  select household_id into v_household from public.pets where id=p_pet_id;
  if v_household is null or not private.can_manage_household(v_household) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if p_user_id=auth.uid() or p_access_role not in ('CAREGIVER','READ_ONLY') then raise exception 'INVALID_GRANT' using errcode='22023'; end if;
  if not exists(select 1 from public.household_memberships where household_id=v_household and user_id=p_user_id and status='ACTIVE' and role<>'PRIMARY_CAREGIVER') then
    raise exception 'ACTIVE_NON_PRIMARY_MEMBERSHIP_REQUIRED' using errcode='42501'; end if;
  if p_access_role='CAREGIVER' and exists(select 1 from public.household_memberships where household_id=v_household and user_id=p_user_id and status='ACTIVE' and role='READ_ONLY') then
    raise exception 'MEMBERSHIP_ROLE_READ_ONLY' using errcode='42501'; end if;
  select id into v_grant from public.pet_access_grants where pet_id=p_pet_id and user_id=p_user_id and status='ACTIVE' for update;
  if p_revoke then
    if v_grant is null then raise exception 'ACTIVE_GRANT_REQUIRED' using errcode='P0002'; end if;
    update public.pet_access_grants set status='REVOKED',revoked_at=clock_timestamp() where id=v_grant;
    insert into public.audit_log(actor_id,action,target_type,target_id,result,reason_code)
      values(auth.uid(),'PET_ACCESS_REVOKED','pet_access_grant',v_grant,'SUCCESS','CAREGIVER_REQUEST');
    return v_grant;
  end if;
  if v_grant is not null then
    update public.pet_access_grants set access_role=p_access_role where id=v_grant returning id into v_grant;
  else
    insert into public.pet_access_grants(pet_id,user_id,access_role,status,granted_by)
      values(p_pet_id,p_user_id,p_access_role,'ACTIVE',auth.uid()) returning id into v_grant;
  end if;
  insert into public.audit_log(actor_id,action,target_type,target_id,result,reason_code)
    values(auth.uid(),'PET_ACCESS_GRANTED','pet_access_grant',v_grant,'SUCCESS',p_access_role);
  return v_grant;
end;
$$;
revoke all on function public.manage_pet_access(uuid,uuid,text,boolean) from public;
grant execute on function public.manage_pet_access(uuid,uuid,text,boolean) to authenticated;

create or replace function public.revoke_household_member(p_household_id uuid,p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_membership public.household_memberships%rowtype; v_grant uuid;
begin
  if not private.can_manage_household(p_household_id) or p_user_id=auth.uid() then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into v_membership from public.household_memberships where household_id=p_household_id and user_id=p_user_id and status='ACTIVE' for update;
  if not found or v_membership.role='PRIMARY_CAREGIVER' then raise exception 'MEMBERSHIP_NOT_REVOCABLE' using errcode='42501'; end if;
  update public.household_memberships set status='REVOKED',revoked_at=clock_timestamp() where id=v_membership.id;
  for v_grant in select id from public.pet_access_grants pag join public.pets p on p.id=pag.pet_id
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

create or replace function public.save_care_routine(
  p_pet_id uuid,p_routine_id uuid,p_name text,p_timezone text,p_days jsonb,p_times jsonb,p_steps jsonb,p_care_plan_version_id uuid default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_routine uuid; v_plan uuid; v_plan_version uuid; v_version uuid; v_next integer; v_today date;
begin
  if not private.can_access_pet(p_pet_id,true) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if length(trim(coalesce(p_name,''))) not between 1 and 100 or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_timezone)
    or p_days is null or jsonb_typeof(p_days) is distinct from 'array'
    or p_times is null or jsonb_typeof(p_times) is distinct from 'array'
    or p_steps is null or jsonb_typeof(p_steps) is distinct from 'array' then raise exception 'INVALID_ROUTINE' using errcode='22023'; end if;
  if jsonb_array_length(p_days)=0 or jsonb_array_length(p_days)>7 or jsonb_array_length(p_times)=0 or jsonb_array_length(p_times)>12
    or jsonb_array_length(p_steps)=0 or jsonb_array_length(p_steps)>20 then
    raise exception 'INVALID_ROUTINE' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements_text(p_days) as d(day_no) where d.day_no !~ '^[0-6]$')
    or exists(select 1 from jsonb_array_elements_text(p_times) as t(time_text) where t.time_text !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
    or exists(select 1 from jsonb_array_elements(p_steps) as s(step) where coalesce(s.step->>'key','') !~ '^[a-z0-9_-]{1,40}$'
      or coalesce(s.step->>'event_type','') not in ('meal','insulin','glucose','elimination','exercise','water','weight','symptom','medication')) then
    raise exception 'INVALID_ROUTINE_SHAPE' using errcode='22023'; end if;
  if (select count(distinct s.step->>'key') from jsonb_array_elements(p_steps) as s(step))<>jsonb_array_length(p_steps)
    or exists(select 1 from jsonb_array_elements(p_steps) with ordinality as s(step,ord)
      cross join lateral jsonb_array_elements_text(coalesce(s.step->'predecessor_step_keys','[]'::jsonb)) as pred(predecessor_key)
      where not exists(select 1 from jsonb_array_elements(p_steps) with ordinality prior(value,ord)
        where prior.ord<s.ord and prior.value->>'key'=pred.predecessor_key)) then raise exception 'INVALID_STEP_DEPENDENCY' using errcode='22023'; end if;
  if p_care_plan_version_id is not null and not exists(select 1 from public.care_plan_versions cpv where cpv.id=p_care_plan_version_id and cpv.pet_id=p_pet_id) then
    raise exception 'PLAN_VERSION_PET_MISMATCH' using errcode='23503'; end if;
  if p_routine_id is not null and not exists(select 1 from public.care_routines where id=p_routine_id and pet_id=p_pet_id) then raise exception 'ROUTINE_NOT_FOUND' using errcode='42501'; end if;
  v_today:=(clock_timestamp() at time zone p_timezone)::date;
  if p_routine_id is null then
    if p_care_plan_version_id is not null then
      select care_plan_id into v_plan from public.care_plan_versions where id=p_care_plan_version_id and pet_id=p_pet_id;
      v_plan_version:=p_care_plan_version_id;
    else
      insert into public.care_plans(pet_id,plan_type,created_by) values(p_pet_id,'PERSONAL_ROUTINE',auth.uid()) returning id into v_plan;
      insert into public.care_plan_versions(care_plan_id,pet_id,version_no,source,author_id,approval_status,content,content_hash)
        values(v_plan,p_pet_id,1,'USER_ENTERED',auth.uid(),'USER_ENTERED_UNVERIFIED','{}',encode(extensions.digest(convert_to('{}','UTF8'),'sha256'),'hex')) returning id into v_plan_version;
    end if;
    insert into public.care_routines(pet_id,care_plan_id,timezone,active_from,created_by,name)
      values(p_pet_id,v_plan,p_timezone,v_today,auth.uid(),trim(p_name)) returning id into v_routine;
  else
    select cr.care_plan_id into v_plan from public.care_routines cr where cr.id=p_routine_id and cr.pet_id=p_pet_id for update;
    if p_care_plan_version_id is not null and not exists(select 1 from public.care_plan_versions where id=p_care_plan_version_id and pet_id=p_pet_id and care_plan_id=v_plan) then
      raise exception 'PLAN_VERSION_ROUTINE_MISMATCH' using errcode='23503'; end if;
    select id into v_plan_version from public.care_plan_versions where care_plan_id=v_plan and pet_id=p_pet_id order by version_no desc limit 1;
    v_routine:=p_routine_id;
    update public.care_routines set name=trim(p_name),timezone=p_timezone where id=v_routine;
  end if;
  if p_care_plan_version_id is not null then v_plan_version:=p_care_plan_version_id; end if;
  select coalesce(max(version_no),0)+1 into v_next from public.care_routine_versions where routine_id=v_routine;
  update public.care_routine_versions set valid_to=v_today-1 where routine_id=v_routine and valid_to is null and valid_from<v_today;
  update public.routine_occurrences set status='SUPERSEDED' where routine_version_id in (select id from public.care_routine_versions where routine_id=v_routine)
    and status='SCHEDULED' and scheduled_local_date>=v_today;
  insert into public.care_routine_versions(routine_id,pet_id,care_plan_id,version_no,care_plan_version_id,recurrence,steps,valid_from,created_by)
    values(v_routine,p_pet_id,v_plan,v_next,v_plan_version,jsonb_build_object('days',p_days,'times',p_times),p_steps,v_today,auth.uid()) returning id into v_version;
  insert into public.audit_log(actor_id,action,target_type,target_id,result,reason_code)
    values(auth.uid(),'CARE_ROUTINE_VERSION_CREATED','care_routine_version',v_version,'SUCCESS',case when p_routine_id is null then 'CREATE' else 'UPDATE' end);
  return v_routine;
end;
$$;
revoke all on function public.save_care_routine(uuid,uuid,text,text,jsonb,jsonb,jsonb,uuid) from public;
grant execute on function public.save_care_routine(uuid,uuid,text,text,jsonb,jsonb,jsonb,uuid) to authenticated;

create or replace function public.ensure_routine_occurrences(p_pet_id uuid,p_local_date date)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer:=0; r record; d record; tm record; st record; v_local timestamp; v_candidate timestamptz; v_matches integer;
begin
  if not private.can_access_pet(p_pet_id,true) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if p_local_date < (clock_timestamp() at time zone 'UTC')::date - 2 or p_local_date > (clock_timestamp() at time zone 'UTC')::date + 31 then
    raise exception 'DATE_OUT_OF_RANGE' using errcode='22023'; end if;
  for r in select cr.id routine_id,cr.pet_id,cr.care_plan_id,cr.timezone,cr.name,rv.id version_id,rv.care_plan_version_id,rv.recurrence,rv.steps
    from public.care_routines cr join lateral (select * from public.care_routine_versions x where x.routine_id=cr.id
      and (x.valid_from is null or x.valid_from<=p_local_date) and (x.valid_to is null or x.valid_to>=p_local_date)
      order by x.version_no desc limit 1) rv on true where cr.pet_id=p_pet_id loop
    for tm in select value time_text from jsonb_array_elements_text(r.recurrence->'times') loop
      for d in select value day_text from jsonb_array_elements_text(r.recurrence->'days') loop
        if extract(dow from p_local_date)::integer=d.day_text::integer then
          v_local:=p_local_date + tm.time_text::time; v_candidate:=v_local at time zone r.timezone; v_matches:=0;
          for st in select generate_series(-180,180,15) offset_minutes loop
            if (v_candidate + make_interval(mins=>st.offset_minutes)) at time zone r.timezone = v_local then v_matches:=v_matches+1; end if;
          end loop;
          if (v_candidate at time zone r.timezone)<>v_local then v_matches:=0; end if;
          for st in select value step_value from jsonb_array_elements(r.steps) loop
            insert into public.routine_occurrences(pet_id,routine_version_id,care_plan_version_id,care_plan_id,occurrence_key,step_key,event_type,
              scheduled_local_date,scheduled_local_time,timezone,disambiguation,scheduled_at,status)
            values(r.pet_id,r.version_id,r.care_plan_version_id,r.care_plan_id,to_char(p_local_date,'YYYY-MM-DD')||':'||tm.time_text,
              st.step_value->>'key',st.step_value->>'event_type',p_local_date,tm.time_text::time,r.timezone,
              case when v_matches=1 then 'NOT_AMBIGUOUS' when v_matches>1 then null else null end,
              case when v_matches=1 then v_candidate else null end,
              case when v_matches=1 then 'SCHEDULED' else 'SCHEDULE_TIME_UNRESOLVED' end)
            on conflict(routine_version_id,occurrence_key,step_key) do nothing;
            if found then v_count:=v_count+1; end if;
          end loop;
        end if;
      end loop;
    end loop;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.ensure_routine_occurrences(uuid,date) from public;
grant execute on function public.ensure_routine_occurrences(uuid,date) to authenticated;

create or replace function public.acknowledge_safety_evaluation(p_evaluation_id uuid,p_acknowledged_codes text[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_pet uuid; v_id uuid;
begin
  select pet_id into v_pet from public.safety_evaluations where id=p_evaluation_id;
  if v_pet is null or not private.can_access_pet(v_pet,true) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if p_acknowledged_codes is null or cardinality(p_acknowledged_codes)=0 or exists(select 1 from unnest(p_acknowledged_codes) c
    where not exists(select 1 from public.safety_evaluations se where se.id=p_evaluation_id and c=any(se.result_codes))) then
    raise exception 'ACKNOWLEDGEMENT_CODES_MISMATCH' using errcode='22023'; end if;
  insert into public.safety_acknowledgements(pet_id,evaluation_id,actor_id,acknowledged_codes)
    values(v_pet,p_evaluation_id,auth.uid(),p_acknowledged_codes) returning id into v_id;
  insert into public.audit_log(actor_id,action,target_type,target_id,result)
    values(auth.uid(),'SAFETY_WARNING_ACKNOWLEDGED','safety_evaluation',p_evaluation_id,'SUCCESS');
  return v_id;
end;
$$;
revoke all on function public.acknowledge_safety_evaluation(uuid,text[]) from public;
grant execute on function public.acknowledge_safety_evaluation(uuid,text[]) to authenticated;

create or replace function public.evaluate_routine_occurrence(p_occurrence_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_occ public.routine_occurrences%rowtype; v_steps jsonb; v_step jsonb; v_prior jsonb; v_prior_occ uuid;
  v_codes text[]:='{}'; v_evidence uuid[]:='{}'; v_eval uuid; v_status text:='CURRENT'; v_event record; v_meal_status text;
  v_existing public.safety_evaluations%rowtype;
begin
  select * into v_occ from public.routine_occurrences where id=p_occurrence_id;
  if not found or not private.can_access_pet(v_occ.pet_id,true) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select steps into v_steps from public.care_routine_versions where id=v_occ.routine_version_id;
  select value into v_step from jsonb_array_elements(v_steps) where value->>'key'=v_occ.step_key limit 1;
  if v_occ.status='SCHEDULE_TIME_UNRESOLVED' then
    v_status:='NOT_APPLICABLE'; v_codes:=array_append(v_codes,'SCHEDULE_TIME_UNRESOLVED');
  end if;
  if exists(select 1 from public.care_plan_versions where id=v_occ.care_plan_version_id and approval_status<>'CLINICIAN_CONFIRMED') then
    v_codes:=array_append(v_codes,'PLAN_UNVERIFIED');
  end if;
  for v_prior in select value from jsonb_array_elements(coalesce(v_step->'predecessor_step_keys','[]'::jsonb)) loop
    select id into v_prior_occ from public.routine_occurrences where routine_version_id=v_occ.routine_version_id
      and occurrence_key=v_occ.occurrence_key and step_key=v_prior#>>'{}' limit 1;
    if v_prior_occ is null or not exists(select 1 from public.health_events he where he.occurrence_id=v_prior_occ
      and not exists(select 1 from public.health_event_revisions rev where rev.event_id=he.id and rev.revision_no=(select max(r2.revision_no) from public.health_event_revisions r2 where r2.event_id=he.id) and rev.revision_kind='VOID')) then
      v_codes:=array_append(v_codes,'ROUTINE_ORDER_UNCONFIRMED');
      if exists(select 1 from public.routine_occurrences where id=v_prior_occ and event_type='meal') then v_codes:=array_append(v_codes,'MEAL_UNCONFIRMED'); end if;
    else
      select he.value->>'meal_status' into v_meal_status from public.health_events he where he.occurrence_id=v_prior_occ and he.event_type='meal'
        and not exists(select 1 from public.health_event_revisions rev where rev.event_id=he.id and rev.revision_no=(select max(r2.revision_no) from public.health_event_revisions r2 where r2.event_id=he.id) and rev.revision_kind='VOID')
        order by he.recorded_at desc limit 1;
      if v_meal_status in ('PARTIAL','REFUSED') then v_codes:=array_append(v_codes,'MEAL_EXCEPTION_REPORTED'); end if;
      v_meal_status:=null;
    end if;
  end loop;
  if v_occ.event_type='insulin' then
    select count(*) into v_event from public.health_events he where he.occurrence_id=v_occ.id and he.event_type='insulin'
      and not exists(select 1 from public.health_event_revisions rev where rev.event_id=he.id and rev.revision_no=(select max(r2.revision_no) from public.health_event_revisions r2 where r2.event_id=he.id) and rev.revision_kind='VOID');
    if v_event.count>1 then v_codes:=array_append(v_codes,'DUPLICATE_POSSIBLE'); end if;
    if exists(select 1 from public.routine_occurrences meal_slot where meal_slot.routine_version_id=v_occ.routine_version_id
      and meal_slot.occurrence_key=v_occ.occurrence_key and meal_slot.event_type='meal'
      and not exists(select 1 from public.health_events he where he.occurrence_id=meal_slot.id and he.event_type='meal'
        and not exists(select 1 from public.health_event_revisions rev where rev.event_id=he.id
          and rev.revision_no=(select max(r2.revision_no) from public.health_event_revisions r2 where r2.event_id=he.id) and rev.revision_kind='VOID'))) then
      v_codes:=array_append(v_codes,'MEAL_UNCONFIRMED');
    end if;
  end if;
  select coalesce(array_agg(he.id order by he.id),'{}') into v_evidence from public.health_events he where he.occurrence_id in (
    select id from public.routine_occurrences where routine_version_id=v_occ.routine_version_id and occurrence_key=v_occ.occurrence_key)
    and not exists(select 1 from public.health_event_revisions rev where rev.event_id=he.id and rev.revision_no=(select max(r2.revision_no) from public.health_event_revisions r2 where r2.event_id=he.id) and rev.revision_kind='VOID');
  select * into v_existing from public.safety_evaluations where occurrence_id=v_occ.id order by evaluated_at desc limit 1;
  if found and v_existing.evaluation_status=v_status and v_existing.result_codes=v_codes
    and v_existing.evidence_event_ids=v_evidence and v_existing.plan_version_id=v_occ.care_plan_version_id then
    return jsonb_build_object('evaluation_id',v_existing.id,'occurrence_id',v_occ.id,'evaluation_status',v_status,
      'result_codes',to_jsonb(v_codes),'evidence_event_ids',to_jsonb(v_evidence),'evaluated_at',v_existing.evaluated_at);
  end if;
  insert into public.safety_evaluations(pet_id,occurrence_id,evaluation_status,result_codes,evidence_event_ids,plan_version_id,evaluator_version)
    values(v_occ.pet_id,v_occ.id,v_status,v_codes,v_evidence,v_occ.care_plan_version_id,'phase3-routine-guard-1') returning id into v_eval;
  insert into public.audit_log(actor_id,action,target_type,target_id,result,reason_code)
    values(auth.uid(),'SAFETY_EVALUATION_CREATED','safety_evaluation',v_eval,'SUCCESS','ROUTINE_OCCURRENCE_REFRESH');
  return jsonb_build_object('evaluation_id',v_eval,'occurrence_id',v_occ.id,'evaluation_status',v_status,'result_codes',to_jsonb(v_codes),'evidence_event_ids',to_jsonb(v_evidence),'evaluated_at',clock_timestamp());
end;
$$;
revoke all on function public.evaluate_routine_occurrence(uuid) from public;
grant execute on function public.evaluate_routine_occurrence(uuid) to authenticated;

create or replace function private.mark_related_safety_evaluations_stale()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.occurrence_id is not null then
    update public.safety_evaluations se set evaluation_status='STALE'
    where se.pet_id=new.pet_id and se.evaluation_status='CURRENT' and se.occurrence_id in (
      select ro.id from public.routine_occurrences source
      join public.routine_occurrences ro on ro.routine_version_id=source.routine_version_id and ro.occurrence_key=source.occurrence_key
      where source.id=new.occurrence_id
    );
  end if;
  return new;
end;
$$;
revoke all on function private.mark_related_safety_evaluations_stale() from public,anon,authenticated;
create trigger health_events_stale_related_evaluations after insert on public.health_events
  for each row execute function private.mark_related_safety_evaluations_stale();

do $$
begin
  if exists(select 1 from pg_catalog.pg_publication where pubname='supabase_realtime') then
    if not exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='health_events') then
      alter publication supabase_realtime add table public.health_events;
    end if;
    if not exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='routine_occurrences') then
      alter publication supabase_realtime add table public.routine_occurrences;
    end if;
    if not exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='safety_evaluations') then
      alter publication supabase_realtime add table public.safety_evaluations;
    end if;
  end if;
end $$;
