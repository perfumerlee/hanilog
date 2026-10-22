-- Phase 3.3: private, non-sensitive Realtime invalidation signals.
-- Realtime messages only tell clients to re-fetch through the normal RLS-protected API.

create or replace function private.can_access_household(p_household_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.household_memberships hm
    where hm.household_id=p_household_id and hm.user_id=auth.uid() and hm.status='ACTIVE'
  );
$$;
revoke all on function private.can_access_household(uuid) from public;
grant execute on function private.can_access_household(uuid) to authenticated;

create or replace function private.can_receive_hanilog_topic(p_topic text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then return false; end if;

  if p_topic ~ '^hanilog\.user\.[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return substring(p_topic from 14)::uuid=auth.uid();
  elsif p_topic ~ '^hanilog\.pet\.[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    v_id:=substring(p_topic from 13)::uuid;
    return private.can_access_pet(v_id,false);
  elsif p_topic ~ '^hanilog\.household\.[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    v_id:=substring(p_topic from 19)::uuid;
    return private.can_access_household(v_id);
  end if;
  return false;
end;
$$;
revoke all on function private.can_receive_hanilog_topic(text) from public;
grant execute on function private.can_receive_hanilog_topic(text) to authenticated;

drop policy if exists hanilog_private_broadcast_read on realtime.messages;
create policy hanilog_private_broadcast_read on realtime.messages
  for select to authenticated
  using (extension='broadcast' and private.can_receive_hanilog_topic(realtime.topic()));

create or replace function private.emit_hanilog_invalidation(p_topic text, p_event text, p_kind text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(jsonb_build_object('kind',p_kind),p_event,p_topic,true);
exception when others then
  -- Realtime is an optimization; a missing partition/service must not fail a clinical write.
  return;
end;
$$;
revoke all on function private.emit_hanilog_invalidation(text,text,text) from public,anon,authenticated;

create or replace function private.broadcast_pet_invalidation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_pet_id uuid;
begin
  v_pet_id:=case when tg_op='DELETE' then old.pet_id else new.pet_id end;
  perform private.emit_hanilog_invalidation('hanilog.pet.'||v_pet_id::text,'invalidate','invalidate');
  return null;
end;
$$;
revoke all on function private.broadcast_pet_invalidation() from public,anon,authenticated;

create trigger health_events_private_invalidation after insert or update or delete on public.health_events
  for each row execute function private.broadcast_pet_invalidation();
create trigger event_revisions_private_invalidation after insert or update or delete on public.health_event_revisions
  for each row execute function private.broadcast_pet_invalidation();
create trigger routine_occurrences_private_invalidation after insert or update or delete on public.routine_occurrences
  for each row execute function private.broadcast_pet_invalidation();
create trigger safety_evaluations_private_invalidation after insert or update or delete on public.safety_evaluations
  for each row execute function private.broadcast_pet_invalidation();

create or replace function private.broadcast_access_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid; v_household_id uuid; v_pet_id uuid;
begin
  if tg_table_name='pet_access_grants' then
    v_user_id:=case when tg_op='DELETE' then old.user_id else new.user_id end;
    v_pet_id:=case when tg_op='DELETE' then old.pet_id else new.pet_id end;
    select household_id into v_household_id from public.pets where id=v_pet_id;
    perform private.emit_hanilog_invalidation('hanilog.pet.'||v_pet_id::text,'invalidate','invalidate');
  else
    v_user_id:=case when tg_op='DELETE' then old.user_id else new.user_id end;
    v_household_id:=case when tg_op='DELETE' then old.household_id else new.household_id end;
  end if;
  perform private.emit_hanilog_invalidation('hanilog.user.'||v_user_id::text,'access_changed','access_changed');
  perform private.emit_hanilog_invalidation('hanilog.household.'||v_household_id::text,'invalidate','invalidate');
  return null;
end;
$$;
revoke all on function private.broadcast_access_change() from public,anon,authenticated;

create trigger pet_grants_private_invalidation after insert or update or delete on public.pet_access_grants
  for each row execute function private.broadcast_access_change();
create trigger memberships_private_invalidation after insert or update or delete on public.household_memberships
  for each row execute function private.broadcast_access_change();

-- Do not replicate clinical rows over Postgres Changes. Private Broadcast carries only {kind:"invalidate"}.
do $$
begin
  if exists(select 1 from pg_catalog.pg_publication where pubname='supabase_realtime') then
    if exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='health_events') then
      alter publication supabase_realtime drop table public.health_events;
    end if;
    if exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='routine_occurrences') then
      alter publication supabase_realtime drop table public.routine_occurrences;
    end if;
    if exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='safety_evaluations') then
      alter publication supabase_realtime drop table public.safety_evaluations;
    end if;
  end if;
end $$;
