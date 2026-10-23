-- Phase 5.0.1: durable per-device Push delivery state and retry certainty.
-- Existing outbox/attempt rows remain intact; Push targets are snapshotted once.
alter table public.notification_outbox
  add column if not exists push_targets_initialized_at timestamptz;

alter table public.notification_delivery_attempts
  add column if not exists duplicate_possible boolean not null default false;

create table public.notification_push_deliveries (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references public.notification_outbox(id) on delete cascade,
  subscription_id uuid references public.push_subscriptions(id) on delete set null,
  subscription_key text not null,
  status text not null default 'PENDING' check (status in ('PENDING','PROCESSING','ACCEPTED','RETRYABLE_FAILURE','PERMANENT_FAILURE')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  provider_message_id text,
  last_error_code text,
  duplicate_possible boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (outbox_id, subscription_key)
);
create index notification_push_deliveries_claim_idx
  on public.notification_push_deliveries(outbox_id,available_at,id)
  where status in ('PENDING','RETRYABLE_FAILURE','PROCESSING');

create table public.notification_push_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.notification_push_deliveries(id) on delete cascade,
  attempt_no integer not null,
  result text not null check (result in ('ACCEPTED','MOCK_ACCEPTED','RETRYABLE_FAILURE','PERMANENT_FAILURE','SUPPRESSED')),
  error_code text,
  provider_message_id text,
  duplicate_possible boolean not null default false,
  attempted_at timestamptz not null default now(),
  unique(delivery_id,attempt_no)
);

alter table public.notification_push_deliveries enable row level security;
alter table public.notification_push_delivery_attempts enable row level security;
revoke all on public.notification_push_deliveries from anon,authenticated;
revoke all on public.notification_push_delivery_attempts from anon,authenticated;
grant all on public.notification_push_deliveries,public.notification_push_delivery_attempts to service_role;

create or replace function public.prepare_notification_push_deliveries(p_outbox_id uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare v_row public.notification_outbox; v_count integer;
begin
  if auth.role()<>'service_role' then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into v_row from public.notification_outbox where id=p_outbox_id and channel='PUSH' for update;
  if not found or v_row.status<>'PROCESSING' then raise exception 'OUTBOX_NOT_LEASED' using errcode='55000'; end if;
  update public.notification_push_deliveries d set status='PERMANENT_FAILURE',lease_until=null,updated_at=now(),last_error_code='SUBSCRIPTION_EXPIRED'
    where d.outbox_id=v_row.id and d.status in ('PENDING','RETRYABLE_FAILURE') and d.subscription_id in
      (select s.id from public.push_subscriptions s where s.user_id=v_row.recipient_user_id and s.expiration_time is not null and s.expiration_time<=now());
  update public.notification_push_deliveries d set status='PERMANENT_FAILURE',lease_until=null,updated_at=now(),last_error_code='SUBSCRIPTION_REVOKED'
    where d.outbox_id=v_row.id and d.status in ('PENDING','RETRYABLE_FAILURE') and d.subscription_id in
      (select s.id from public.push_subscriptions s where s.user_id=v_row.recipient_user_id and s.revoked_at is not null);
  update public.push_subscriptions set revoked_at=now()
    where user_id=v_row.recipient_user_id and revoked_at is null and expiration_time is not null and expiration_time<=now();
  if v_row.push_targets_initialized_at is null then
    insert into public.notification_push_deliveries(outbox_id,subscription_id)
      select v_row.id,s.id,s.endpoint_hash from public.push_subscriptions s
      where s.user_id=v_row.recipient_user_id and s.revoked_at is null
        and (s.expiration_time is null or s.expiration_time>now())
      on conflict(outbox_id,subscription_key) do nothing;
    update public.notification_outbox set push_targets_initialized_at=now() where id=v_row.id;
  end if;
  select count(*) into v_count from public.notification_push_deliveries where outbox_id=p_outbox_id;
  return v_count;
end; $$;
revoke all on function public.prepare_notification_push_deliveries(uuid) from public,anon,authenticated;
grant execute on function public.prepare_notification_push_deliveries(uuid) to service_role;

create or replace function public.claim_notification_push_deliveries(p_outbox_id uuid,p_limit integer default 50)
returns setof public.notification_push_deliveries language plpgsql security definer set search_path='' as $$
begin
  if auth.role()<>'service_role' then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  return query with candidates as (
    select d.id from public.notification_push_deliveries d
    join public.notification_outbox o on o.id=d.outbox_id
    join public.in_app_notifications n on n.id=o.notification_id
    join public.pet_access_grants g on g.pet_id=o.pet_id and g.user_id=o.recipient_user_id and g.status='ACTIVE'
    join public.notification_preferences p on p.pet_id=o.pet_id and p.user_id=o.recipient_user_id and p.notification_type=n.notification_type and p.push_enabled
    join public.push_subscriptions s on s.id=d.subscription_id and s.user_id=o.recipient_user_id and s.revoked_at is null
      and (s.expiration_time is null or s.expiration_time>now())
    where d.outbox_id=p_outbox_id and o.status='PROCESSING' and o.expires_at>now() and n.invalidated_at is null
      and d.status in ('PENDING','RETRYABLE_FAILURE','PROCESSING') and d.available_at<=now()
      and (d.status<>'PROCESSING' or d.lease_until<now())
    order by d.available_at,d.id for update of d skip locked limit greatest(1,least(p_limit,100))
  ) update public.notification_push_deliveries d set status='PROCESSING',attempt_count=d.attempt_count+1,
      lease_until=now()+interval '5 minutes',updated_at=now()
    from candidates c where d.id=c.id returning d.*;
end; $$;
revoke all on function public.claim_notification_push_deliveries(uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_notification_push_deliveries(uuid,integer) to service_role;

create or replace function public.finish_notification_push_delivery(
  p_delivery_id uuid,p_result text,p_error_code text default null,p_provider_message_id text default null,
  p_retry_seconds integer default null,p_duplicate_possible boolean default false
) returns void language plpgsql security definer set search_path='' as $$
declare v_row public.notification_push_deliveries;
begin
  if auth.role()<>'service_role' then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into v_row from public.notification_push_deliveries where id=p_delivery_id for update;
  if not found or v_row.status<>'PROCESSING' then raise exception 'PUSH_DELIVERY_NOT_LEASED' using errcode='55000'; end if;
  if p_result not in ('ACCEPTED','MOCK_ACCEPTED','RETRYABLE_FAILURE','PERMANENT_FAILURE','SUPPRESSED') then raise exception 'INVALID_RESULT' using errcode='22023'; end if;
  insert into public.notification_push_delivery_attempts(delivery_id,attempt_no,result,error_code,provider_message_id,duplicate_possible)
    values(p_delivery_id,v_row.attempt_count,p_result,left(p_error_code,80),p_provider_message_id,p_duplicate_possible);
  update public.notification_push_deliveries set status=case
      when p_result in ('ACCEPTED','MOCK_ACCEPTED') then 'ACCEPTED' when p_result='PERMANENT_FAILURE' then 'PERMANENT_FAILURE'
      when p_result='SUPPRESSED' then 'PERMANENT_FAILURE'
      when v_row.attempt_count>=8 then 'PERMANENT_FAILURE' else 'RETRYABLE_FAILURE' end,
    available_at=case when p_result='RETRYABLE_FAILURE' and v_row.attempt_count<8
      then now()+make_interval(secs=>greatest(1,least(coalesce(p_retry_seconds,60),86400))) else available_at end,
    lease_until=null,provider_message_id=p_provider_message_id,last_error_code=left(p_error_code,80),
    duplicate_possible=duplicate_possible or p_duplicate_possible,updated_at=now()
    where id=p_delivery_id;
  if p_result in ('PERMANENT_FAILURE','SUPPRESSED') then
    update public.push_subscriptions set revoked_at=now() where id=v_row.subscription_id and revoked_at is null;
  end if;
end; $$;
revoke all on function public.finish_notification_push_delivery(uuid,text,text,text,integer,boolean) from public,anon,authenticated;
grant execute on function public.finish_notification_push_delivery(uuid,text,text,text,integer,boolean) to service_role;

create or replace function public.finish_notification_delivery(
  p_outbox_id uuid,p_result text,p_error_code text,p_provider_message_id text,
  p_retry_seconds integer,p_duplicate_possible boolean
) returns void language plpgsql security definer set search_path='' as $$
declare v_row public.notification_outbox; v_result text:=p_result; v_retry integer:=p_retry_seconds;
  v_success integer; v_retryable integer; v_pending integer; v_terminal integer; v_next timestamptz;
begin
  if auth.role()<>'service_role' then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into v_row from public.notification_outbox where id=p_outbox_id for update;
  if not found or v_row.status<>'PROCESSING' then raise exception 'OUTBOX_NOT_LEASED' using errcode='55000'; end if;
  if v_row.expires_at<=now() then update public.notification_outbox set status='EXPIRED',lease_until=null,updated_at=now() where id=p_outbox_id; return; end if;
  if v_row.channel='PUSH' and v_row.push_targets_initialized_at is not null
      and p_result in ('ACCEPTED','MOCK_ACCEPTED','RETRYABLE_FAILURE','PERMANENT_FAILURE') then
    select count(*) filter(where status='ACCEPTED'),count(*) filter(where status='RETRYABLE_FAILURE'),
      count(*) filter(where status in ('PENDING','PROCESSING')),count(*) filter(where status in ('ACCEPTED','PERMANENT_FAILURE')),
      min(available_at) filter(where status='RETRYABLE_FAILURE')
      into v_success,v_retryable,v_pending,v_terminal,v_next
      from public.notification_push_deliveries where outbox_id=p_outbox_id;
    if coalesce(v_success,0)+coalesce(v_terminal,0)=0 and coalesce(v_retryable,0)+coalesce(v_pending,0)=0 then
      v_result:='PERMANENT_FAILURE';
    elsif coalesce(v_retryable,0)+coalesce(v_pending,0)>0 then
      v_result:='RETRYABLE_FAILURE';
      v_retry:=greatest(30,least(86400,ceil(extract(epoch from (coalesce(v_next,now()+interval '30 seconds')-now())))::integer));
    else v_result:='ACCEPTED'; end if;
    select coalesce(bool_or(duplicate_possible),false) into p_duplicate_possible
      from public.notification_push_deliveries where outbox_id=p_outbox_id;
  end if;
  if v_result not in ('ACCEPTED','RETRYABLE_FAILURE','PERMANENT_FAILURE','SUPPRESSED','MOCK_ACCEPTED') then raise exception 'INVALID_RESULT' using errcode='22023'; end if;
  insert into public.notification_delivery_attempts(outbox_id,attempt_no,channel,result,error_code,provider_message_id,duplicate_possible)
    values(p_outbox_id,v_row.attempt_count+1,v_row.channel,v_result,left(p_error_code,80),p_provider_message_id,coalesce(p_duplicate_possible,false));
  update public.notification_outbox set attempt_count=attempt_count+1,lease_until=null,updated_at=now(),last_error_code=left(p_error_code,80),
    provider_message_id=p_provider_message_id,
    status=case when v_result in ('ACCEPTED','MOCK_ACCEPTED') then 'ACCEPTED' when v_result='SUPPRESSED' then 'SUPPRESSED'
      when v_result='PERMANENT_FAILURE' then 'FAILED_PERMANENT' when v_retry is null or attempt_count>=7 then 'FAILED_PERMANENT' else 'PENDING' end,
    available_at=case when v_result='RETRYABLE_FAILURE' and v_retry is not null then now()+make_interval(secs=>greatest(30,least(v_retry,86400))) else available_at end
    where id=p_outbox_id;
  if v_result in ('ACCEPTED','MOCK_ACCEPTED') and v_row.channel='PUSH' then
    update public.push_subscriptions s set last_success_at=now() where s.id in
      (select d.subscription_id from public.notification_push_deliveries d where d.outbox_id=p_outbox_id and d.status='ACCEPTED');
  end if;
  insert into public.audit_log(actor_id,action,target_type,target_id,request_id,result,reason_code)
    values(null,'NOTIFICATION_DELIVERY_ATTEMPT','NOTIFICATION_OUTBOX',p_outbox_id,p_outbox_id,
      case when v_result in ('ACCEPTED','MOCK_ACCEPTED') then 'SUCCESS' else 'FAILURE' end,
      left(coalesce(p_error_code,v_result),80));
end; $$;
revoke all on function public.finish_notification_delivery(uuid,text,text,text,integer) from public,anon,authenticated;
revoke all on function public.finish_notification_delivery(uuid,text,text,text,integer,boolean) from public,anon,authenticated;
grant execute on function public.finish_notification_delivery(uuid,text,text,text,integer,boolean) to service_role;

-- Existing callers with five parameters remain compatible through this overload.
create or replace function public.finish_notification_delivery(p_outbox_id uuid,p_result text,p_error_code text default null,
  p_provider_message_id text default null,p_retry_seconds integer default null)
returns void language sql security definer set search_path='' as $$
  select public.finish_notification_delivery(p_outbox_id,p_result,p_error_code,p_provider_message_id,p_retry_seconds,false);
$$;
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
  update public.notification_push_deliveries d set status='PERMANENT_FAILURE',lease_until=null,updated_at=now(),last_error_code='OUTBOX_SUPPRESSED'
    from public.notification_outbox o where o.id=d.outbox_id and o.status='SUPPRESSED' and d.status in ('PENDING','RETRYABLE_FAILURE','PROCESSING');
  update public.notification_outbox set status='EXPIRED',lease_until=null,updated_at=now() where status in ('PENDING','FAILED','PROCESSING') and expires_at<=now();
  update public.notification_push_deliveries d set status='PERMANENT_FAILURE',lease_until=null,updated_at=now(),last_error_code='OUTBOX_EXPIRED'
    from public.notification_outbox o where o.id=d.outbox_id and o.status='EXPIRED' and d.status in ('PENDING','RETRYABLE_FAILURE','PROCESSING');
  return v_count;
end; $$;
revoke all on function public.reconcile_notification_outbox() from public,anon,authenticated;
grant execute on function public.reconcile_notification_outbox() to service_role;
