begin;
select plan(9);

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ('00000000-0000-4000-8000-000000000051','authenticated','authenticated','cleanup-test@example.test','',now(),'{}','{}',now(),now());

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000051","role":"authenticated"}',true);
select set_config('test.cleanup_household',public.create_household('Synthetic cleanup household')::text,true);
select set_config('test.cleanup_pet',public.create_pet(current_setting('test.cleanup_household')::uuid,'Synthetic cleanup pet','Asia/Seoul')::text,true);
reset role;

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select is(public.enqueue_pet_profile_cleanup(
  current_setting('test.cleanup_pet')::uuid,
  current_setting('test.cleanup_pet') || '/0123456789abcdef0123456789abcdef.jpg'
),true,'service role can enqueue an unreferenced object for compensation');
select is((select count(*)::integer from public.pet_profile_cleanup_outbox
  where pet_id=current_setting('test.cleanup_pet')::uuid and completed_at is null),1,
  'cleanup job is persisted');
select is(public.enqueue_pet_profile_cleanup(
  current_setting('test.cleanup_pet')::uuid,
  current_setting('test.cleanup_pet') || '/0123456789abcdef0123456789abcdef.jpg'
),true,'retrying enqueue is accepted idempotently');
select is((select count(*)::integer from public.pet_profile_cleanup_outbox
  where pet_id=current_setting('test.cleanup_pet')::uuid and completed_at is null),1,
  'duplicate retry does not create another pending job');
select set_config('test.cleanup_claimed_id',(
  select id::text from public.claim_pet_profile_cleanup(10,current_setting('test.cleanup_pet')::uuid) limit 1
),true);
select isnt(current_setting('test.cleanup_claimed_id'),'','cleanup job can be claimed');
select is((select count(*)::integer from public.claim_pet_profile_cleanup(10,current_setting('test.cleanup_pet')::uuid)),0,
  'a second worker cannot claim a currently leased job');
select lives_ok(
  $$select public.finish_pet_profile_cleanup(current_setting('test.cleanup_claimed_id')::uuid,true,null)$$,
  'service role can complete a cleanup job');
select is((select count(*)::integer from public.pet_profile_cleanup_outbox
  where id=current_setting('test.cleanup_claimed_id')::uuid and completed_at is not null),1,
  'completed cleanup is no longer pending');

reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000051","role":"authenticated"}',true);
select throws_ok(
  $$select public.enqueue_pet_profile_cleanup(current_setting('test.cleanup_pet')::uuid,current_setting('test.cleanup_pet') || '/1123456789abcdef0123456789abcdef.jpg')$$,
  '42501','permission denied for function enqueue_pet_profile_cleanup','authenticated users cannot execute service cleanup jobs'
);

select * from finish();
rollback;
