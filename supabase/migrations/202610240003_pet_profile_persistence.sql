alter table public.pets
  add column profile_avatar_id text not null default 'dog-1',
  add column profile_photo_object_path text,
  add column profile_revision bigint not null default 0;

alter table public.pets
  add constraint pets_profile_avatar_id_check
    check (profile_avatar_id ~ '^dog-(3[0-2]|[12][0-9]|[1-9])$'),
  add constraint pets_profile_revision_check
    check (profile_revision >= 0),
  add constraint pets_profile_photo_path_check
    check (
      profile_photo_object_path is null
      or profile_photo_object_path ~
        ('^' || id::text || '/[0-9a-f]{32}[.]jpg$')
    );

create table public.pet_profile_cleanup_outbox (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets(id) on delete restrict,
  bucket_id text not null default 'pet-profile-images'
    check (bucket_id = 'pet-profile-images'),
  object_path text not null,
  created_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  completed_at timestamptz,
  last_error_code text,
  constraint pet_profile_cleanup_path_check
    check (object_path ~ ('^' || pet_id::text || '/[0-9a-f]{32}[.]jpg$'))
);
create index pet_profile_cleanup_pending_idx
  on public.pet_profile_cleanup_outbox(created_at)
  where completed_at is null;
alter table public.pet_profile_cleanup_outbox enable row level security;
revoke all on public.pet_profile_cleanup_outbox from anon, authenticated;
grant select, update on public.pet_profile_cleanup_outbox to service_role;

create or replace function public.assert_pet_profile_write(p_pet_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
     or not private.can_access_pet(p_pet_id, true) then
    raise exception using errcode = '42501', message = 'PET_PROFILE_ACCESS_DENIED';
  end if;
end;
$$;
revoke all on function public.assert_pet_profile_write(uuid) from public, anon;
grant execute on function public.assert_pet_profile_write(uuid) to authenticated;

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
  if auth.uid() is null
     or not private.can_access_pet(p_pet_id, true) then
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
       p_profile_photo_object_path !~
         ('^' || p_pet_id::text || '/[0-9a-f]{32}[.]jpg$')
       or not exists (
         select 1 from storage.objects o
          where o.bucket_id = 'pet-profile-images'
            and o.name = p_profile_photo_object_path
       )
     ) then
    raise exception using errcode = '22023', message = 'PET_PROFILE_PHOTO_INVALID';
  end if;

  update public.pets p
     set profile_avatar_id = p_profile_avatar_id,
         profile_photo_object_path = p_profile_photo_object_path,
         profile_revision = p.profile_revision + 1
   where p.id = p_pet_id;

  if v_old_path is not null
     and v_old_path is distinct from p_profile_photo_object_path then
    insert into public.pet_profile_cleanup_outbox(pet_id, object_path)
    values (p_pet_id, v_old_path);
  end if;

  insert into public.audit_log(actor_id, action, target_type, target_id, result, reason_code)
  values (
    auth.uid(), 'PET_PROFILE_UPDATED', 'pet', p_pet_id, 'SUCCESS',
    case
      when v_old_path is distinct from p_profile_photo_object_path
        and p_profile_photo_object_path is null then 'PHOTO_REMOVED'
      when v_old_path is distinct from p_profile_photo_object_path
        and p_profile_photo_object_path is not null then 'PHOTO_REPLACED'
      else 'AVATAR_UPDATED'
    end
  );

  return query
    select p.profile_avatar_id, p.profile_photo_object_path, p.profile_revision
      from public.pets p where p.id = p_pet_id;
end;
$$;
revoke all on function public.update_pet_profile(uuid, text, text, bigint)
  from public, anon;
grant execute on function public.update_pet_profile(uuid, text, text, bigint)
  to authenticated;

create or replace function private.broadcast_pet_profile_invalidation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.emit_hanilog_invalidation(
    'hanilog.pet.' || new.id::text, 'invalidate', 'invalidate'
  );
  return null;
end;
$$;
revoke all on function private.broadcast_pet_profile_invalidation()
  from public, anon, authenticated;
create trigger pets_profile_private_invalidation
  after update of profile_avatar_id, profile_photo_object_path, profile_revision
  on public.pets
  for each row execute function private.broadcast_pet_profile_invalidation();

create policy pet_profile_images_read
  on storage.objects for select to authenticated
  using (
    bucket_id = 'pet-profile-images'
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{32}[.]jpg$'
    and case
      when split_part(name, '/', 1) ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then private.can_access_pet(split_part(name, '/', 1)::uuid, false)
      else false
    end
  );
