-- A stale application revision cannot succeed by retrying the same transaction.
-- PT409 maps to HTTP 409 without PostgREST's serialization_failure retry loop.
-- No table, grant, RLS, Storage policy, or existing row changes.
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
    raise exception using errcode = 'PT409', message = 'PET_PROFILE_VERSION_CONFLICT';
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
