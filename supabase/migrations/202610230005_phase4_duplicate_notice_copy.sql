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
