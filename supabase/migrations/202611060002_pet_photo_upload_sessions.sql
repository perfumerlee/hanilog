-- Review before remote application. No existing rows or policies are removed.
create table public.pet_photo_uploads (
  id uuid primary key default gen_random_uuid(),
  pet_id uuid not null references public.pets(id),
  actor_id uuid not null references auth.users(id),
  avatar_id text not null check (avatar_id ~ '^dog-(3[0-2]|[12][0-9]|[1-9])$'),
  expected_revision bigint not null check (expected_revision >= 0),
  object_path text not null unique,
  output_path text not null unique,
  state text not null default 'pending' check (state in ('pending','processing','completed','failed')),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '10 minutes'),
  completed_at timestamptz,
  cleanup_at timestamptz,
  result jsonb
);
alter table public.pet_photo_uploads enable row level security;
revoke all on public.pet_photo_uploads from anon, authenticated;
grant select on public.pet_photo_uploads to authenticated;
grant select, update on public.pet_photo_uploads to service_role;
create policy pet_photo_upload_owner_read on public.pet_photo_uploads for select to authenticated
using (actor_id = auth.uid() and private.can_access_pet(pet_id, false));
create index pet_photo_upload_cleanup on public.pet_photo_uploads(expires_at) where cleanup_at is null;
create index pet_photo_upload_actor on public.pet_photo_uploads(actor_id, created_at);

create function public.begin_pet_photo_upload(p_pet_id uuid, p_avatar_id text, p_revision bigint)
returns public.pet_photo_uploads language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_row public.pet_photo_uploads; v_revision bigint;
begin
  perform public.assert_pet_profile_write(p_pet_id);
  -- Serialize the per-user quota check without exposing an unbounded upload capability.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text, 16));
  select profile_revision into v_revision from public.pets where id = p_pet_id for update;
  if p_revision is null or v_revision <> p_revision then
    raise exception using errcode='PT409', message='PET_PROFILE_VERSION_CONFLICT';
  end if;
  if (select count(*) from public.pet_photo_uploads where actor_id=auth.uid()
      and created_at > clock_timestamp() - interval '1 hour') >= 20 then
    raise exception using errcode='PT429', message='PHOTO_UPLOAD_RATE_LIMIT';
  end if;
  insert into public.pet_photo_uploads(id,pet_id,actor_id,avatar_id,expected_revision,object_path,output_path)
  values(v_id,p_pet_id,auth.uid(),p_avatar_id,p_revision,
    p_pet_id::text || '/' || v_id::text || '.jpg',
    p_pet_id::text || '/' || replace(v_id::text,'-','') || '.jpg') returning * into v_row;
  return v_row;
end; $$;
revoke all on function public.begin_pet_photo_upload(uuid,text,bigint) from public,anon;
grant execute on function public.begin_pet_photo_upload(uuid,text,bigint) to authenticated;

create function public.claim_pet_photo_upload(p_id uuid)
returns public.pet_photo_uploads language plpgsql security definer set search_path = '' as $$
declare v_row public.pet_photo_uploads;
begin
  select * into v_row from public.pet_photo_uploads where id=p_id and actor_id=auth.uid() for update;
  if not found then raise exception using errcode='42501', message='PHOTO_UPLOAD_ACCESS_DENIED'; end if;
  perform public.assert_pet_profile_write(v_row.pet_id);
  if v_row.state='completed' then return v_row; end if;
  if v_row.state <> 'pending' or v_row.expires_at <= clock_timestamp() then
    raise exception using errcode='PT409', message='PHOTO_UPLOAD_EXPIRED_OR_BUSY';
  end if;
  if not exists(select 1 from storage.objects where bucket_id='pet-photo-incoming' and name=v_row.object_path) then
    raise exception using errcode='PT409', message='PHOTO_UPLOAD_NOT_READY';
  end if;
  update public.pet_photo_uploads set state='processing' where id=p_id returning * into v_row;
  return v_row;
end; $$;
revoke all on function public.claim_pet_photo_upload(uuid) from public,anon;
grant execute on function public.claim_pet_photo_upload(uuid) to authenticated;

create function public.complete_pet_photo_upload(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.pet_photo_uploads; v_result jsonb;
begin
  select * into v_row from public.pet_photo_uploads where id=p_id and actor_id=auth.uid() for update;
  if not found then raise exception using errcode='42501', message='PHOTO_UPLOAD_ACCESS_DENIED'; end if;
  perform public.assert_pet_profile_write(v_row.pet_id);
  if v_row.state='completed' then return v_row.result; end if;
  if v_row.state <> 'processing' or v_row.expires_at <= clock_timestamp() then
    raise exception using errcode='PT409', message='PHOTO_UPLOAD_EXPIRED_OR_BUSY';
  end if;
  -- The output bucket has no client INSERT/UPDATE policy; only validated server output can exist here.
  select to_jsonb(p) into v_result from public.update_pet_profile(
    v_row.pet_id,v_row.avatar_id,v_row.output_path,v_row.expected_revision) p;
  update public.pet_photo_uploads set state='completed',completed_at=clock_timestamp(),result=v_result where id=p_id;
  return v_result;
end; $$;
revoke all on function public.complete_pet_photo_upload(uuid) from public,anon;
grant execute on function public.complete_pet_photo_upload(uuid) to authenticated;

-- Finalization and cleanup use service-role access. Clients may INSERT exactly one
-- object per live intent, but cannot list/read/overwrite unvalidated images.
-- The final bucket is also provisioned here because earlier profile migrations
-- intentionally created policies without creating a bucket. Keep both buckets
-- private and reject a pre-existing bucket with a broader/different contract.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('pet-profile-images','pet-profile-images',false,1048576,array['image/jpeg']) on conflict(id) do nothing;
do $$ begin
  if not exists(select 1 from storage.buckets where id='pet-profile-images' and public=false
    and file_size_limit=1048576 and allowed_mime_types=array['image/jpeg']) then
    raise exception 'EXISTING_PROFILE_BUCKET_CONFIGURATION_MISMATCH';
  end if;
end; $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('pet-photo-incoming','pet-photo-incoming',false,1048576,array['image/jpeg']) on conflict(id) do nothing;
do $$ begin
  if not exists(select 1 from storage.buckets where id='pet-photo-incoming' and public=false
    and file_size_limit=1048576 and allowed_mime_types=array['image/jpeg']) then
    raise exception 'EXISTING_INCOMING_BUCKET_CONFIGURATION_MISMATCH';
  end if;
end; $$;
create policy pet_photo_incoming_insert on storage.objects for insert to authenticated with check (
  bucket_id='pet-photo-incoming' and exists (
    select 1 from public.pet_photo_uploads u where u.object_path=name and u.actor_id=auth.uid()
      and u.state='pending' and u.expires_at > clock_timestamp() and private.can_access_pet(u.pet_id,true)
  )
);

create function public.collect_pet_photo_upload_cleanup()
returns table(id uuid, object_path text) language plpgsql security definer set search_path='' as $$
declare r public.pet_photo_uploads;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise insufficient_privilege; end if;
  for r in select u.* from public.pet_photo_uploads u where u.cleanup_at is null
    and u.expires_at < clock_timestamp() - interval '1 hour'
    order by u.created_at for update skip locked limit 20
  loop
    if r.state <> 'completed' then
      update public.pet_photo_uploads set state='failed' where pet_photo_uploads.id=r.id;
      perform public.enqueue_pet_profile_cleanup(r.pet_id,r.output_path);
    end if;
    return query select r.id,r.object_path;
  end loop;
end; $$;
revoke all on function public.collect_pet_photo_upload_cleanup() from public,anon,authenticated;
grant execute on function public.collect_pet_photo_upload_cleanup() to service_role;

create function public.read_pet_photo_cleanup_reference(p_pet_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare v_path text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise insufficient_privilege; end if;
  select profile_photo_object_path into v_path from public.pets where id=p_pet_id;
  if not found then raise exception 'PET_NOT_FOUND'; end if;
  return v_path;
end; $$;
revoke all on function public.read_pet_photo_cleanup_reference(uuid) from public,anon,authenticated;
grant execute on function public.read_pet_photo_cleanup_reference(uuid) to service_role;
