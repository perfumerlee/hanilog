create or replace function private.notification_occurrence_trigger()
returns trigger language plpgsql security definer set search_path='' as $$
declare g record;
begin
 if tg_op='UPDATE' and (new.status in ('CANCELLED','SUPERSEDED') or new.routine_version_id<>old.routine_version_id) then
   update public.in_app_notifications set invalidated_at=now() where occurrence_id=new.id and invalidated_at is null;
   update public.notification_outbox o set status='SUPPRESSED',lease_until=null,updated_at=now(),last_error_code='OCCURRENCE_CHANGED'
   from public.in_app_notifications n where n.id=o.notification_id and n.occurrence_id=new.id
     and o.status in ('PENDING','FAILED','PROCESSING');
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
