create or replace function private.notification_preference_trigger()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (old.push_enabled and not new.push_enabled) or (old.email_enabled and not new.email_enabled) then
   update public.notification_outbox o set status='SUPPRESSED',lease_until=null,updated_at=now(),last_error_code='CHANNEL_DISABLED'
   from public.in_app_notifications n where n.id=o.notification_id and n.pet_id=new.pet_id and n.recipient_user_id=new.user_id
     and n.notification_type=new.notification_type and o.status in ('PENDING','FAILED','PROCESSING')
     and ((o.channel='PUSH' and not new.push_enabled) or (o.channel='EMAIL' and not new.email_enabled));
 end if;
 return new;
end; $$;
revoke all on function private.notification_preference_trigger() from public,anon,authenticated;
create trigger notification_preference_channels_changed after update of push_enabled,email_enabled on public.notification_preferences
for each row execute function private.notification_preference_trigger();
