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
     and coalesce((select rev.revision_kind from public.health_event_revisions rev where rev.event_id=e.id order by rev.revision_no desc limit 1),'CORRECT')<>'VOID') loop
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
