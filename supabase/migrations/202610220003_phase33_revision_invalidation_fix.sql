-- Resolve the Pet through the immutable parent Health Event for revision rows.
create or replace function private.broadcast_pet_invalidation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_pet_id uuid; v_event_id uuid;
begin
  if tg_table_name='health_event_revisions' then
    v_event_id:=case when tg_op='DELETE' then old.event_id else new.event_id end;
    select pet_id into v_pet_id from public.health_events where id=v_event_id;
  else
    v_pet_id:=case when tg_op='DELETE' then old.pet_id else new.pet_id end;
  end if;

  if v_pet_id is not null then
    perform private.emit_hanilog_invalidation('hanilog.pet.'||v_pet_id::text,'invalidate','invalidate');
  end if;
  return null;
end;
$$;
revoke all on function private.broadcast_pet_invalidation() from public,anon,authenticated;
