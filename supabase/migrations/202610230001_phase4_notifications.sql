-- Notifications are delivery/attention records only. They never represent care performed.
create table public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  notification_type text not null check (notification_type in ('CARE_DUE','RECORD_UNCONFIRMED','CARE_RECORDED','DUPLICATE_REVIEW','ROUTINE_CHANGED')),
  in_app_enabled boolean not null default true,
  push_enabled boolean not null default false,
  email_enabled boolean not null default false,
  lead_minutes integer check (lead_minutes is null or lead_minutes between 0 and 10080),
  unconfirmed_after_minutes integer check (unconfirmed_after_minutes is null or unconfirmed_after_minutes between 1 and 10080),
  repeat_every_minutes integer check (repeat_every_minutes is null or repeat_every_minutes between 15 and 10080),
  quiet_start time,
  quiet_end time,
  timezone text not null,
  updated_at timestamptz not null default now(),
  unique (pet_id,user_id,notification_type)
);

create table public.in_app_notifications (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  notification_type text not null check (notification_type in ('CARE_DUE','RECORD_UNCONFIRMED','CARE_RECORDED','DUPLICATE_REVIEW','ROUTINE_CHANGED')),
  occurrence_id uuid references public.routine_occurrences(id) on delete set null,
  health_event_id uuid references public.health_events(id) on delete set null,
  dedupe_key text not null unique,
  title text not null check (length(title) <= 120),
  body text not null check (length(body) <= 240),
  action_path text not null default '/notifications' check (action_path like '/%'),
  created_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  expires_at timestamptz not null,
  read_at timestamptz,
  invalidated_at timestamptz
);
create index in_app_notifications_recipient_idx on public.in_app_notifications(recipient_user_id,available_at desc) where invalidated_at is null;

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  endpoint_hash text not null unique,
  p256dh text not null,
  auth_secret text not null,
  expiration_time timestamptz,
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  revoked_at timestamptz
);

create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.in_app_notifications(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  pet_id uuid not null references public.pets(id) on delete cascade,
  channel text not null check (channel in ('PUSH','EMAIL')),
  idempotency_key text not null unique,
  status text not null default 'PENDING' check (status in ('PENDING','PROCESSING','ACCEPTED','FAILED','FAILED_PERMANENT','SUPPRESSED','EXPIRED')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default now(),
  expires_at timestamptz not null,
  lease_until timestamptz,
  provider_message_id text,
  last_error_code text,
  updated_at timestamptz not null default now(),
  unique (notification_id,channel)
);
create index notification_outbox_claim_idx on public.notification_outbox(available_at,id) where status in ('PENDING','FAILED');

create table public.notification_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references public.notification_outbox(id) on delete cascade,
  attempt_no integer not null,
  channel text not null check (channel in ('PUSH','EMAIL')),
  result text not null check (result in ('ACCEPTED','RETRYABLE_FAILURE','PERMANENT_FAILURE','SUPPRESSED','MOCK_ACCEPTED')),
  error_code text,
  provider_message_id text,
  attempted_at timestamptz not null default now(),
  unique(outbox_id,attempt_no)
);

alter table public.notification_preferences enable row level security;
alter table public.in_app_notifications enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.notification_delivery_attempts enable row level security;

create policy notification_preferences_self_read on public.notification_preferences for select to authenticated using(user_id=auth.uid() and private.can_access_pet(pet_id,false));
create policy notification_preferences_self_insert on public.notification_preferences for insert to authenticated with check(user_id=auth.uid() and private.can_access_pet(pet_id,false));
create policy notification_preferences_self_update on public.notification_preferences for update to authenticated using(user_id=auth.uid() and private.can_access_pet(pet_id,false)) with check(user_id=auth.uid() and private.can_access_pet(pet_id,false));
create policy in_app_notifications_self_read on public.in_app_notifications for select to authenticated using(recipient_user_id=auth.uid() and private.can_access_pet(pet_id,false));
create policy in_app_notifications_self_update on public.in_app_notifications for update to authenticated using(recipient_user_id=auth.uid() and private.can_access_pet(pet_id,false)) with check(recipient_user_id=auth.uid() and private.can_access_pet(pet_id,false));

revoke all on public.push_subscriptions, public.notification_outbox, public.notification_delivery_attempts from anon, authenticated;
grant select,insert,update on public.notification_preferences to authenticated;
grant select on public.in_app_notifications to authenticated;
grant all on public.push_subscriptions, public.notification_outbox, public.notification_delivery_attempts to service_role;
grant select,insert on public.in_app_notifications to service_role;

create or replace function public.register_push_subscription(p_endpoint text,p_endpoint_hash text,p_p256dh text,p_auth text,p_expiration_time timestamptz default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
 if auth.uid() is null then raise exception 'UNAUTHENTICATED' using errcode='28000'; end if;
 if p_endpoint !~ '^https://' or length(p_endpoint)>4096 or length(p_endpoint_hash)<>64 or length(p_p256dh)>256 or length(p_auth)>256 then
   raise exception 'INVALID_SUBSCRIPTION' using errcode='22023'; end if;
 insert into public.push_subscriptions(user_id,endpoint,endpoint_hash,p256dh,auth_secret,expiration_time,revoked_at)
 values(auth.uid(),p_endpoint,p_endpoint_hash,p_p256dh,p_auth,p_expiration_time,null)
 on conflict(endpoint_hash) do update set user_id=excluded.user_id,endpoint=excluded.endpoint,p256dh=excluded.p256dh,
   auth_secret=excluded.auth_secret,expiration_time=excluded.expiration_time,revoked_at=null
 where public.push_subscriptions.user_id=auth.uid()
 returning id into v_id;
 if v_id is null then raise exception 'SUBSCRIPTION_OWNED_BY_ANOTHER_USER' using errcode='42501'; end if;
 return v_id;
end; $$;
revoke all on function public.register_push_subscription(text,text,text,text,timestamptz) from public,anon;
grant execute on function public.register_push_subscription(text,text,text,text,timestamptz) to authenticated;

create or replace function public.revoke_push_subscription(p_endpoint_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'UNAUTHENTICATED' using errcode='28000'; end if;
 update public.push_subscriptions set revoked_at=now() where user_id=auth.uid() and endpoint_hash=p_endpoint_hash and revoked_at is null;
 return found;
end; $$;
revoke all on function public.revoke_push_subscription(text) from public,anon;
grant execute on function public.revoke_push_subscription(text) to authenticated;

create or replace function public.mark_notification_read(p_notification_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'UNAUTHENTICATED' using errcode='28000'; end if;
 update public.in_app_notifications set read_at=coalesce(read_at,now()) where id=p_notification_id and recipient_user_id=auth.uid()
   and invalidated_at is null and private.can_access_pet(pet_id,false);
 return found;
end; $$;
revoke all on function public.mark_notification_read(uuid) from public,anon;
grant execute on function public.mark_notification_read(uuid) to authenticated;

create or replace function public.enqueue_notification(p_pet_id uuid,p_recipient uuid,p_type text,p_occurrence uuid,p_event uuid,p_dedupe text,p_title text,p_body text,p_available timestamptz,p_expires timestamptz)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; pref record;
begin
 select * into pref from public.notification_preferences where pet_id=p_pet_id and user_id=p_recipient and notification_type=p_type;
 if not found then
   pref.in_app_enabled:=true; pref.push_enabled:=false; pref.email_enabled:=false;
 end if;
 if not coalesce(pref.in_app_enabled,true) and not coalesce(pref.push_enabled,false) and not coalesce(pref.email_enabled,false) then return null; end if;
 insert into public.in_app_notifications(pet_id,recipient_user_id,notification_type,occurrence_id,health_event_id,dedupe_key,title,body,available_at,expires_at)
 values(p_pet_id,p_recipient,p_type,p_occurrence,p_event,p_dedupe,p_title,p_body,p_available,p_expires)
 on conflict(dedupe_key) do nothing returning id into v_id;
 if v_id is null then return null; end if;
 if coalesce(pref.push_enabled,false) then
   insert into public.notification_outbox(notification_id,recipient_user_id,pet_id,channel,idempotency_key,expires_at,available_at)
   values(v_id,p_recipient,p_pet_id,'PUSH',p_dedupe||':PUSH',p_expires,p_available) on conflict do nothing;
 end if;
 if coalesce(pref.email_enabled,false) then
   insert into public.notification_outbox(notification_id,recipient_user_id,pet_id,channel,idempotency_key,expires_at,available_at)
   values(v_id,p_recipient,p_pet_id,'EMAIL',p_dedupe||':EMAIL',p_expires,p_available) on conflict do nothing;
 end if;
 return v_id;
end; $$;
revoke all on function public.enqueue_notification(uuid,uuid,text,uuid,uuid,text,text,text,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.enqueue_notification(uuid,uuid,text,uuid,uuid,text,text,text,timestamptz,timestamptz) to service_role;

create or replace function public.claim_notification_outbox(p_limit integer default 50)
returns setof public.notification_outbox language plpgsql security definer set search_path='' as $$
begin
 if auth.role()<>'service_role' then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 return query with candidates as (
   select o.id from public.notification_outbox o join public.in_app_notifications n on n.id=o.notification_id
   join public.pet_access_grants g on g.pet_id=o.pet_id and g.user_id=o.recipient_user_id and g.status='ACTIVE'
   join public.notification_preferences p on p.pet_id=o.pet_id and p.user_id=o.recipient_user_id and p.notification_type=n.notification_type
   where o.status in ('PENDING','FAILED') and o.available_at<=now() and o.expires_at>now() and n.invalidated_at is null
     and ((o.channel='PUSH' and p.push_enabled) or (o.channel='EMAIL' and p.email_enabled))
     and not (p.quiet_start is not null and p.quiet_end is not null and p.quiet_start<>p.quiet_end and (
       (p.quiet_start<p.quiet_end and (now() at time zone p.timezone)::time>=p.quiet_start and (now() at time zone p.timezone)::time<p.quiet_end)
       or (p.quiet_start>p.quiet_end and ((now() at time zone p.timezone)::time>=p.quiet_start or (now() at time zone p.timezone)::time<p.quiet_end))))
     and (o.status<>'PROCESSING' or o.lease_until<now())
   order by o.available_at,o.id for update of o skip locked limit greatest(1,least(p_limit,100))
 ) update public.notification_outbox o set status='PROCESSING',lease_until=now()+interval '2 minutes',updated_at=now()
   from candidates c where o.id=c.id returning o.*;
end; $$;
revoke all on function public.claim_notification_outbox(integer) from public,anon,authenticated;
grant execute on function public.claim_notification_outbox(integer) to service_role;

create or replace function public.finish_notification_delivery(p_outbox_id uuid,p_result text,p_error_code text default null,p_provider_message_id text default null,p_retry_seconds integer default null)
returns void language plpgsql security definer set search_path='' as $$
declare v_row public.notification_outbox;
begin
 if auth.role()<>'service_role' then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select * into v_row from public.notification_outbox where id=p_outbox_id for update;
 if not found or v_row.status<>'PROCESSING' then raise exception 'OUTBOX_NOT_LEASED' using errcode='55000'; end if;
 if v_row.expires_at<=now() then update public.notification_outbox set status='EXPIRED',lease_until=null,updated_at=now() where id=p_outbox_id; return; end if;
 if p_result not in ('ACCEPTED','RETRYABLE_FAILURE','PERMANENT_FAILURE','SUPPRESSED','MOCK_ACCEPTED') then raise exception 'INVALID_RESULT' using errcode='22023'; end if;
 insert into public.notification_delivery_attempts(outbox_id,attempt_no,channel,result,error_code,provider_message_id)
 values(p_outbox_id,v_row.attempt_count+1,v_row.channel,p_result,left(p_error_code,80),p_provider_message_id);
 update public.notification_outbox set attempt_count=attempt_count+1,lease_until=null,updated_at=now(),last_error_code=left(p_error_code,80),
   provider_message_id=p_provider_message_id,
   status=case when p_result in ('ACCEPTED','MOCK_ACCEPTED') then 'ACCEPTED' when p_result='SUPPRESSED' then 'SUPPRESSED'
     when p_result='PERMANENT_FAILURE' then 'FAILED_PERMANENT' when p_retry_seconds is null or attempt_count>=7 then 'FAILED_PERMANENT' else 'PENDING' end,
   available_at=case when p_result='RETRYABLE_FAILURE' and p_retry_seconds is not null then now()+make_interval(secs=>greatest(30,least(p_retry_seconds,86400))) else available_at end
 where id=p_outbox_id;
 if p_result in ('ACCEPTED','MOCK_ACCEPTED') and v_row.channel='PUSH' then update public.push_subscriptions set last_success_at=now() where user_id=v_row.recipient_user_id and revoked_at is null; end if;
 insert into public.audit_log(actor_id,action,target_type,target_id,request_id,result,reason_code)
 values(null,'NOTIFICATION_DELIVERY_ATTEMPT','NOTIFICATION_OUTBOX',p_outbox_id,p_outbox_id,
   case when p_result in ('ACCEPTED','MOCK_ACCEPTED') then 'SUCCESS' else 'FAILURE' end,left(coalesce(p_error_code,p_result),80));
end; $$;
revoke all on function public.finish_notification_delivery(uuid,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.finish_notification_delivery(uuid,text,text,text,integer) to service_role;

create or replace function public.reconcile_notification_outbox()
returns integer language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
 if auth.role()<>'service_role' then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 update public.notification_outbox o set status='SUPPRESSED',lease_until=null,updated_at=now(),last_error_code='ACCESS_OR_PREFERENCE_REVOKED'
 from public.in_app_notifications n where n.id=o.notification_id and o.status in ('PENDING','FAILED','PROCESSING')
   and (n.invalidated_at is not null or not exists(select 1 from public.pet_access_grants g where g.pet_id=o.pet_id and g.user_id=o.recipient_user_id and g.status='ACTIVE')
     or not exists(select 1 from public.notification_preferences p where p.pet_id=o.pet_id and p.user_id=o.recipient_user_id
       and p.notification_type=n.notification_type and ((o.channel='PUSH' and p.push_enabled) or (o.channel='EMAIL' and p.email_enabled))));
 get diagnostics v_count=row_count;
 update public.notification_outbox set status='EXPIRED',lease_until=null,updated_at=now() where status in ('PENDING','FAILED','PROCESSING') and expires_at<=now();
 return v_count;
end; $$;
revoke all on function public.reconcile_notification_outbox() from public,anon,authenticated;
grant execute on function public.reconcile_notification_outbox() to service_role;

-- Server job creates occurrence rows without requiring a caregiver browser session.
create or replace function public.ensure_routine_occurrences(p_pet_id uuid,p_local_date date)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer:=0; r record; d record; tm record; st record; v_local timestamp; v_candidate timestamptz; v_matches integer;
begin
  if auth.role()<>'service_role' and not private.can_access_pet(p_pet_id,true) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
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
              case when v_matches=1 then 'NOT_AMBIGUOUS' else null end,case when v_matches=1 then v_candidate else null end,
              case when v_matches=1 then 'SCHEDULED' else 'SCHEDULE_TIME_UNRESOLVED' end)
            on conflict(routine_version_id,occurrence_key,step_key) do nothing;
            if found then v_count:=v_count+1; end if;
          end loop;
        end if;
      end loop;
    end loop;
  end loop;
  return v_count;
end; $$;
revoke all on function public.ensure_routine_occurrences(uuid,date) from public,anon;
grant execute on function public.ensure_routine_occurrences(uuid,date) to authenticated,service_role;

create or replace function public.prepare_notification_occurrences(p_days integer default 7)
returns integer language plpgsql security definer set search_path='' as $$
declare r record; i integer; v_count integer:=0; v_date date;
begin
 if auth.role()<>'service_role' then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_days<0 or p_days>14 then raise exception 'DAYS_OUT_OF_RANGE' using errcode='22023'; end if;
 for r in select distinct cr.pet_id,cr.timezone from public.care_routines cr loop
   for i in 0..p_days loop
     v_date:=(now() at time zone r.timezone)::date+i;
     v_count:=v_count+public.ensure_routine_occurrences(r.pet_id,v_date);
   end loop;
 end loop;
 return v_count;
end; $$;
revoke all on function public.prepare_notification_occurrences(integer) from public,anon,authenticated;
grant execute on function public.prepare_notification_occurrences(integer) to service_role;

create or replace function public.materialize_unconfirmed_notifications()
returns integer language plpgsql security definer set search_path='' as $$
declare r record; v_created uuid; v_count integer:=0; v_bucket bigint;
begin
 if auth.role()<>'service_role' then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 for r in select o.*,p.user_id,p.unconfirmed_after_minutes,p.repeat_every_minutes from public.routine_occurrences o
   join public.notification_preferences p on p.pet_id=o.pet_id and p.notification_type='RECORD_UNCONFIRMED'
   join public.pet_access_grants g on g.pet_id=o.pet_id and g.user_id=p.user_id and g.status='ACTIVE'
   where o.status='SCHEDULED' and p.unconfirmed_after_minutes is not null and (p.in_app_enabled or p.push_enabled or p.email_enabled)
   and o.scheduled_at is not null and o.scheduled_at+make_interval(mins=>p.unconfirmed_after_minutes)<=now()
   and not exists(select 1 from public.health_events e where e.occurrence_id=o.id and e.event_type=o.event_type
     and coalesce((select r.revision_kind from public.health_event_revisions r where r.event_id=e.id order by r.revision_no desc limit 1),'CORRECT')<>'VOID') loop
   v_bucket:=case when r.repeat_every_minutes is null then 0 else floor(extract(epoch from (now()-r.scheduled_at))/ (r.repeat_every_minutes*60))::bigint end;
   v_created:=public.enqueue_notification(r.pet_id,r.user_id,'RECORD_UNCONFIRMED',r.id,null,
     'unconfirmed:'||r.id||':'||r.user_id||':'||v_bucket,'돌봄 기록이 아직 확인되지 않았습니다',
     '기록 미확인 상태입니다. 실제 수행 여부는 보호자에게 확인해 주세요.',now(),now()+interval '1 day');
   if v_created is not null then v_count:=v_count+1; end if;
 end loop;
 return v_count;
end; $$;
revoke all on function public.materialize_unconfirmed_notifications() from public,anon,authenticated;
grant execute on function public.materialize_unconfirmed_notifications() to service_role;

create or replace function private.invalidate_notifications_for_pet(p_pet_id uuid,p_user_id uuid default null)
returns void language plpgsql security definer set search_path='' as $$
begin
 update public.in_app_notifications set invalidated_at=now() where pet_id=p_pet_id and invalidated_at is null
   and (p_user_id is null or recipient_user_id=p_user_id);
 update public.notification_outbox set status='SUPPRESSED',lease_until=null,updated_at=now(),last_error_code='CARE_OR_ACCESS_CHANGED'
 where pet_id=p_pet_id and status in ('PENDING','FAILED','PROCESSING') and (p_user_id is null or recipient_user_id=p_user_id);
end; $$;
revoke all on function private.invalidate_notifications_for_pet(uuid,uuid) from public,anon,authenticated;

create or replace function private.notification_care_event_trigger()
returns trigger language plpgsql security definer set search_path='' as $$
declare g record; v_type text;
begin
 if tg_table_name='health_events' then
   if new.occurrence_id is not null then
     update public.in_app_notifications set invalidated_at=now() where occurrence_id=new.occurrence_id
       and notification_type in ('CARE_DUE','RECORD_UNCONFIRMED') and invalidated_at is null;
     update public.notification_outbox o set status='SUPPRESSED',lease_until=null,updated_at=now(),last_error_code='CARE_RECORDED'
       from public.in_app_notifications n where n.id=o.notification_id and n.occurrence_id=new.occurrence_id
       and n.notification_type in ('CARE_DUE','RECORD_UNCONFIRMED') and o.status in ('PENDING','FAILED','PROCESSING');
   end if;
   v_type:=case when exists(select 1 from public.health_events e where e.pet_id=new.pet_id and e.occurrence_id is not null
     and e.occurrence_id=new.occurrence_id and e.event_type='insulin' and e.id<>new.id
     and coalesce((select rev.revision_kind from public.health_event_revisions rev where rev.event_id=e.id order by rev.revision_no desc limit 1),'CORRECT')<>'VOID')
     and new.event_type='insulin' then 'DUPLICATE_REVIEW' else 'CARE_RECORDED' end;
   for g in select user_id from public.pet_access_grants where pet_id=new.pet_id and status='ACTIVE' and user_id<>new.actor_id loop
     perform public.enqueue_notification(new.pet_id,g.user_id,v_type,new.occurrence_id,new.id,'event:'||new.id||':'||g.user_id||':'||v_type,
       case when v_type='DUPLICATE_REVIEW' then '중복 가능성 확인이 필요합니다' else '공동 보호자 기록이 추가되었습니다' end,
       case when v_type='DUPLICATE_REVIEW' then '같은 일정에 여러 기록이 연결되어 있습니다. 서버 기록을 확인해 주세요.'
         else 'Pet 건강 기록이 갱신되었습니다. 앱에서 서버 기록을 확인해 주세요.' end,now(),now()+interval '7 days');
   end loop;
 end if;
 return new;
end; $$;
revoke all on function private.notification_care_event_trigger() from public,anon,authenticated;
create trigger notification_after_health_event after insert on public.health_events for each row execute function private.notification_care_event_trigger();

create or replace function private.notification_occurrence_trigger()
returns trigger language plpgsql security definer set search_path='' as $$
declare g record; p record; v_type text;
begin
 if tg_op='UPDATE' and (new.status in ('CANCELLED','SUPERSEDED') or new.routine_version_id<>old.routine_version_id) then
   perform private.invalidate_notifications_for_pet(new.pet_id,null);
 elsif tg_op='INSERT' and new.status='SCHEDULED' then
   for g in select pg.user_id,pre.lead_minutes from public.pet_access_grants pg
     left join public.notification_preferences pre on pre.pet_id=pg.pet_id and pre.user_id=pg.user_id and pre.notification_type='CARE_DUE'
     where pg.pet_id=new.pet_id and pg.status='ACTIVE' loop
     perform public.enqueue_notification(new.pet_id,g.user_id,'CARE_DUE',new.id,null,'occurrence:'||new.id||':'||g.user_id||':CARE_DUE',
       '돌봄 일정 안내','예정된 돌봄 일정을 확인해 주세요.',coalesce(new.scheduled_at,now())-make_interval(mins=>coalesce(g.lead_minutes,0)),
       coalesce(new.scheduled_at,now())+interval '1 day');
   end loop;
 end if;
 return new;
end; $$;
revoke all on function private.notification_occurrence_trigger() from public,anon,authenticated;
create trigger notification_after_occurrence_insert after insert on public.routine_occurrences for each row execute function private.notification_occurrence_trigger();
create trigger notification_after_occurrence_update after update of status,routine_version_id on public.routine_occurrences for each row execute function private.notification_occurrence_trigger();

create or replace function private.notification_grant_revoke_trigger()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.status='ACTIVE' and new.status<>'ACTIVE' then perform private.invalidate_notifications_for_pet(old.pet_id,old.user_id); end if;
 return new;
end; $$;
revoke all on function private.notification_grant_revoke_trigger() from public,anon,authenticated;
create trigger notification_after_grant_revoke after update of status on public.pet_access_grants for each row execute function private.notification_grant_revoke_trigger();

create or replace function private.notification_routine_change_trigger()
returns trigger language plpgsql security definer set search_path='' as $$
declare g record;
begin
 for g in select pg.user_id from public.pet_access_grants pg where pg.pet_id=new.pet_id and pg.status='ACTIVE'
   and pg.user_id<>auth.uid() loop
   perform public.enqueue_notification(new.pet_id,g.user_id,'ROUTINE_CHANGED',null,null,'routine-version:'||new.id||':'||g.user_id,
     '돌봄 루틴이 변경되었습니다','최신 루틴과 일정을 앱에서 확인해 주세요.',now(),now()+interval '7 days');
 end loop;
 return new;
end; $$;
revoke all on function private.notification_routine_change_trigger() from public,anon,authenticated;
create trigger notification_after_routine_version after insert on public.care_routine_versions for each row execute function private.notification_routine_change_trigger();

comment on table public.in_app_notifications is 'Attention and delivery metadata only; never evidence that care was performed.';
comment on table public.push_subscriptions is 'Push credentials; accessible only to service_role and user-scoped RPCs.';
