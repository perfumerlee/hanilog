alter table public.pets
  add column default_insulin_product text;

alter table public.pets
  add constraint pets_default_insulin_product_check
    check (
      default_insulin_product is null
      or (
        length(btrim(default_insulin_product)) between 1 and 120
        and default_insulin_product = btrim(default_insulin_product)
      )
    );

comment on column public.pets.default_insulin_product is
  'Caregiver-entered label for the pet''s prescribed insulin product; no dose or clinical guidance.';

create or replace function public.update_pet_default_insulin_product(
  p_pet_id uuid,
  p_product text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product text := nullif(btrim(p_product), '');
  v_previous text;
begin
  if auth.uid() is null
     or not private.can_access_pet(p_pet_id, true) then
    raise exception using errcode = '42501', message = 'PET_PROFILE_ACCESS_DENIED';
  end if;
  if p_product is not null and (v_product is null or length(v_product) > 120) then
    raise exception using errcode = '22023', message = 'PET_INSULIN_PRODUCT_INVALID';
  end if;

  select p.default_insulin_product
    into v_previous
    from public.pets p
   where p.id = p_pet_id
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'PET_NOT_FOUND';
  end if;

  update public.pets
     set default_insulin_product = v_product
   where id = p_pet_id;

  if v_previous is distinct from v_product then
    insert into public.audit_log(actor_id, action, target_type, target_id, result, reason_code)
    values (auth.uid(), 'PET_INSULIN_PRODUCT_UPDATED', 'pet', p_pet_id, 'SUCCESS', 'PET_INSULIN_DEFAULT_CHANGED');
  end if;

  return v_product;
end;
$$;

revoke all on function public.update_pet_default_insulin_product(uuid, text)
  from public, anon;
grant execute on function public.update_pet_default_insulin_product(uuid, text)
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

drop trigger if exists pets_profile_private_invalidation on public.pets;
create trigger pets_profile_private_invalidation
  after update of profile_avatar_id, profile_photo_object_path, profile_revision, default_insulin_product
  on public.pets
  for each row execute function private.broadcast_pet_profile_invalidation();
