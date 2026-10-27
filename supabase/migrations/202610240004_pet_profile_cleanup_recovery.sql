-- Add recoverable, serialized cleanup for profile-photo objects.
alter table public.pet_profile_cleanup_outbox
  add column locked_until timestamptz;

create index pet_profile_cleanup_active_path_idx
  on public.pet_profile_cleanup_outbox(pet_id, object_path)
  where completed_at is null;
create index pet_profile_cleanup_active_pet_time_idx
  on public.pet_profile_cleanup_outbox(pet_id, created_at)
  where completed_at is null;

-- Replace the profile RPC to prevent reattaching an object while its cleanup is queued.
create or replace function public.update_pet_profile(
  p_pet_id uuid,
  p_profile_avatar_id text,
  p_profile_photo_object_path text,
  p_expected_revision bigint
)
returns table (
  profile_avatar_id text,
  profile_photo_object_path text,
  profile_revision bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_path text;
  v_revision bigint;
begin
  if auth.uid() is null or not private.can_access_pet(p_pet_id, true) then
    raise exception using errcode = '42501', message = 'PET_PROFILE_ACCESS_DENIED';
  end if;
  if p_profile_avatar_id !~ '^dog-(3[0-2]|[12][0-9]|[1-9])$' then
    raise exception using errcode = '22023', message = 'PET_PROFILE_AVATAR_INVALID';
  end if;

  select p.profile_photo_object_path, p.profile_revision
    into v_old_path, v_revision
    from public.pets p
    where p.id = p_pet_id
    for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'PET_NOT_FOUND';
  end if;
  if v_revision <> p_expected_revision then
    raise exception using errcode = '40001', message = 'PET_PROFILE_VERSION_CONFLICT';
  end if;
  if p_profile_photo_object_path is not null and (
       p_profile_photo_object_path !~ ('^' || p_pet_id::text || '/[0-9a-f]{32}[.]jpg$')
       or not exists (
         select 1 from storage.objects o
          where o.bucket_id = 'pet-profile-images'
            and o.name = p_profile_photo_object_path
       )
       or exists (
         select 1 from public.pet_profile_cleanup_outbox q
          where q.pet_id = p_pet_id
            and q.object_path = p_profile_photo_object_path
            and q.completed_at is null
       )
     ) then
    raise exception using errcode = '22023', message = 'PET_PROFILE_PHOTO_INVALID';
  end if;

  update public.pets p
     set profile_avatar_id = p_profile_avatar_id,
         profile_photo_object_path = p_profile_photo_object_path,
         profile_revision = p.profile_revision + 1
   where p.id = p_pet_id;

  if v_old_path is not null and v_old_path is distinct from p_profile_photo_object_path then
    if not exists (
      select 1 from public.pet_profile_cleanup_outbox q
       where q.pet_id = p_pet_id and q.object_path = v_old_path and q.completed_at is null
    ) then
      insert into public.pet_profile_cleanup_outbox(pet_id, object_path)
      values (p_pet_id, v_old_path);
    end if;
  end if;

  insert into public.audit_log(actor_id, action, target_type, target_id, result, reason_code)
  values (
    auth.uid(), 'PET_PROFILE_UPDATED', 'pet', p_pet_id, 'SUCCESS',
    case
      when v_old_path is distinct from p_profile_photo_object_path and p_profile_photo_object_path is null then 'PHOTO_REMOVED'
      when v_old_path is distinct from p_profile_photo_object_path and p_profile_photo_object_path is not null then 'PHOTO_REPLACED'
      else 'AVATAR_UPDATED'
    end
  );

  return query
    select p.profile_avatar_id, p.profile_photo_object_path, p.profile_revision
      from public.pets p where p.id = p_pet_id;
end;
$$;
revoke all on function public.update_pet_profile(uuid, text, text, bigint) from public, anon;
grant execute on function public.update_pet_profile(uuid, text, text, bigint) to authenticated;

create or replace function public.enqueue_pet_profile_cleanup(p_pet_id uuid, p_object_path text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_path text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'PET_PROFILE_CLEANUP_FORBIDDEN';
  end if;
  if p_object_path !~ ('^' || p_pet_id::text || '/[0-9a-f]{32}[.]jpg$') then
    raise exception using errcode = '22023', message = 'PET_PROFILE_CLEANUP_PATH_INVALID';
  end if;

  select p.profile_photo_object_path into v_current_path
    from public.pets p where p.id = p_pet_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'PET_NOT_FOUND';
  end if;
  if v_current_path = p_object_path then return false; end if;

  if not exists (
    select 1 from public.pet_profile_cleanup_outbox q
     where q.pet_id = p_pet_id and q.object_path = p_object_path and q.completed_at is null
  ) then
    insert into public.pet_profile_cleanup_outbox(pet_id, object_path)
    values (p_pet_id, p_object_path);
  end if;
  return true;
end;
$$;
revoke all on function public.enqueue_pet_profile_cleanup(uuid, text) from public, anon, authenticated;
grant execute on function public.enqueue_pet_profile_cleanup(uuid, text) to service_role;

create or replace function public.claim_pet_profile_cleanup(p_limit integer default 10, p_pet_id uuid default null)
returns table (id uuid, pet_id uuid, object_path text, attempts integer)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'PET_PROFILE_CLEANUP_FORBIDDEN';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 10 then
    raise exception using errcode = '22023', message = 'PET_PROFILE_CLEANUP_LIMIT_INVALID';
  end if;

  return query
  with candidates as (
    select q.id
      from public.pet_profile_cleanup_outbox q
      where q.completed_at is null
        and (q.locked_until is null or q.locked_until < clock_timestamp())
        and (p_pet_id is null or q.pet_id = p_pet_id)
      order by q.created_at
      for update skip locked
      limit p_limit
  )
  update public.pet_profile_cleanup_outbox q
     set locked_until = clock_timestamp() + interval '2 minutes',
         attempts = q.attempts + 1
    from candidates c
   where q.id = c.id
  returning q.id, q.pet_id, q.object_path, q.attempts;
end;
$$;
revoke all on function public.claim_pet_profile_cleanup(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_pet_profile_cleanup(integer, uuid) to service_role;

create or replace function public.finish_pet_profile_cleanup(
  p_id uuid,
  p_completed boolean,
  p_error_code text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'PET_PROFILE_CLEANUP_FORBIDDEN';
  end if;
  if p_error_code is not null and p_error_code not in ('STORAGE_DELETE_FAILED','OBJECT_STILL_REFERENCED','STORAGE_STATUS_UNKNOWN') then
    raise exception using errcode = '22023', message = 'PET_PROFILE_CLEANUP_ERROR_INVALID';
  end if;

  update public.pet_profile_cleanup_outbox q
     set completed_at = case when p_completed then clock_timestamp() else null end,
         last_error_code = case when p_completed then null else coalesce(p_error_code, 'STORAGE_STATUS_UNKNOWN') end,
         locked_until = null
   where q.id = p_id and q.completed_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'PET_PROFILE_CLEANUP_JOB_NOT_FOUND';
  end if;
end;
$$;
revoke all on function public.finish_pet_profile_cleanup(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.finish_pet_profile_cleanup(uuid, boolean, text) to service_role;
