-- Correct the displayed occurrence time atomically while retaining its original value in the revision history.
create or replace function public.correct_health_event_time(
  p_event_id uuid, p_expected_revision integer, p_occurred_at timestamptz, p_idempotency_key uuid
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_event public.health_events%rowtype;
  v_latest integer;
  v_last_kind text;
  v_revision_id uuid;
  v_hash text;
  v_existing public.idempotency_records%rowtype;
begin
  if auth.uid() is null or p_idempotency_key is null or p_occurred_at is null then
    raise exception 'INVALID_TIME_CORRECTION' using errcode='22023';
  end if;
  select * into v_event from public.health_events where id=p_event_id;
  if not found or not private.can_access_pet(v_event.pet_id,true) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text||':correct_health_event_time:'||p_idempotency_key::text,0));
  v_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'event_id',p_event_id,'expected',p_expected_revision,'occurred_at',p_occurred_at)::text,'UTF8'),'sha256'),'hex');
  select * into v_existing from public.idempotency_records
    where actor_id=auth.uid() and operation='correct_health_event_time' and idempotency_key=p_idempotency_key;
  if found then
    if v_existing.request_hash<>v_hash then raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode='23505'; end if;
    return (v_existing.response->>'revision_id')::uuid;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_event_id::text,1));
  select * into v_event from public.health_events where id=p_event_id for update;
  if not found or not private.can_access_pet(v_event.pet_id,true) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  select revision_no,revision_kind into v_latest,v_last_kind from public.health_event_revisions
    where event_id=p_event_id order by revision_no desc limit 1;
  if coalesce(v_latest,0)<>p_expected_revision then raise exception 'REVISION_CONFLICT' using errcode='40001'; end if;
  if v_last_kind='VOID' then raise exception 'EVENT_VOIDED' using errcode='22023'; end if;
  if v_event.occurred_at=p_occurred_at then raise exception 'TIME_UNCHANGED' using errcode='22023'; end if;
  insert into public.health_event_revisions(event_id,revision_no,revision_kind,patch,reason_code,actor_id)
    values(p_event_id,coalesce(v_latest,0)+1,'CORRECT',
      jsonb_build_object('previous_occurred_at',v_event.occurred_at,'occurred_at',p_occurred_at),
      'USER_OCCURRENCE_TIME_CORRECTED',auth.uid()) returning id into v_revision_id;
  update public.health_events set occurred_at=p_occurred_at where id=p_event_id;
  update public.safety_evaluations set evaluation_status='STALE'
    where pet_id=v_event.pet_id and evaluation_status='CURRENT';
  insert into public.audit_log(actor_id,action,target_type,target_id,request_id,result,reason_code)
    values(auth.uid(),'HEALTH_EVENT_REVISED','health_event',p_event_id,p_idempotency_key,'SUCCESS','USER_OCCURRENCE_TIME_CORRECTED');
  insert into public.idempotency_records(actor_id,operation,idempotency_key,request_hash,response)
    values(auth.uid(),'correct_health_event_time',p_idempotency_key,v_hash,jsonb_build_object('revision_id',v_revision_id));
  return v_revision_id;
end;
$$;
revoke all on function public.correct_health_event_time(uuid,integer,timestamptz,uuid) from public;
grant execute on function public.correct_health_event_time(uuid,integer,timestamptz,uuid) to authenticated;
