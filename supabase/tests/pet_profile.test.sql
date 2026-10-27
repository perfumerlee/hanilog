begin;
select plan(15);

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ('00000000-0000-4000-8000-000000000041','authenticated','authenticated','profile-a@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-4000-8000-000000000042','authenticated','authenticated','profile-b@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-4000-8000-000000000043','authenticated','authenticated','profile-outsider@example.test','',now(),'{}','{}',now(),now());

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000041","role":"authenticated"}',true);
select set_config('test.profile_household',public.create_household('Synthetic profile household')::text,true);
select set_config('test.profile_pet',public.create_pet(current_setting('test.profile_household')::uuid,'Synthetic profile pet','Asia/Seoul')::text,true);

select is((select profile_avatar_id from public.pets where id=current_setting('test.profile_pet')::uuid),'dog-1',
  'existing/new pets receive the safe default avatar');
select is((select profile_photo_object_path from public.pets where id=current_setting('test.profile_pet')::uuid),null::text,
  'profile photo is absent by default');
select is((select profile_revision from public.pets where id=current_setting('test.profile_pet')::uuid),0::bigint,
  'profile revision starts at zero');

select set_config('test.profile_result',(
  select row_to_json(result)::text from public.update_pet_profile(
    current_setting('test.profile_pet')::uuid,'dog-32',null,0
  ) as result
),true);
select is((current_setting('test.profile_result')::jsonb->>'profile_avatar_id'),'dog-32',
  'caregiver can persist a whitelisted avatar');
select is((current_setting('test.profile_result')::jsonb->>'profile_revision')::bigint,1::bigint,
  'successful profile update increments revision');
select throws_ok(
  $$select count(*)::integer from public.audit_log where action='PET_PROFILE_UPDATED' and target_id=current_setting('test.profile_pet')::uuid$$,
  '42501','permission denied for table audit_log','caregivers cannot directly read the internal audit log'
);
reset role;
select is((select count(*)::integer from public.audit_log where action='PET_PROFILE_UPDATED'
  and target_id=current_setting('test.profile_pet')::uuid),1,'profile change is audited');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000041","role":"authenticated"}',true);
select throws_ok(
  $$select * from public.update_pet_profile(current_setting('test.profile_pet')::uuid,'dog-99',null,1)$$,
  '22023','PET_PROFILE_AVATAR_INVALID','unknown avatar IDs are rejected by the server'
);
select throws_ok(
  $$select * from public.update_pet_profile(current_setting('test.profile_pet')::uuid,'dog-2',null,0)$$,
  'PT409','PET_PROFILE_VERSION_CONFLICT','stale profile revisions cannot overwrite newer state'
);
select is((select profile_revision from public.pets where id=current_setting('test.profile_pet')::uuid),1::bigint,
  'conflict does not increment the stored revision');

reset role;
select is((select count(*)::integer from public.audit_log where action='PET_PROFILE_UPDATED'
  and target_id=current_setting('test.profile_pet')::uuid),1,'conflict does not append a successful audit entry');
insert into public.household_memberships(household_id,user_id,role,status,created_by)
values(current_setting('test.profile_household')::uuid,'00000000-0000-4000-8000-000000000042','CAREGIVER','ACTIVE','00000000-0000-4000-8000-000000000041');
insert into public.pet_access_grants(pet_id,user_id,access_role,status,granted_by)
values(current_setting('test.profile_pet')::uuid,'00000000-0000-4000-8000-000000000042','READ_ONLY','ACTIVE','00000000-0000-4000-8000-000000000041');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000042","role":"authenticated"}',true);
select is((select count(*)::integer from public.pets where id=current_setting('test.profile_pet')::uuid),1,
  'authorized read-only caregiver can read profile');
select throws_ok(
  $$select * from public.update_pet_profile(current_setting('test.profile_pet')::uuid,'dog-2',null,1)$$,
  '42501','PET_PROFILE_ACCESS_DENIED','read-only caregiver cannot modify profile');

reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000043","role":"authenticated"}',true);
select is((select count(*)::integer from public.pets where id=current_setting('test.profile_pet')::uuid),0,
  'unrelated user cannot read another Pet profile');
select throws_ok(
  $$select * from public.update_pet_profile(current_setting('test.profile_pet')::uuid,'dog-3',null,1)$$,
  '42501','PET_PROFILE_ACCESS_DENIED','unrelated user cannot modify another Pet profile');

select * from finish();
rollback;
