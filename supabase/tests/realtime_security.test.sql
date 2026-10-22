begin;
select plan(11);

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ('00000000-0000-4000-8000-000000000031','authenticated','authenticated','realtime-owner@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-4000-8000-000000000032','authenticated','authenticated','realtime-outsider@example.test','',now(),'{}','{}',now(),now());

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000031","role":"authenticated"}',true);
select set_config('test.household_id',public.create_household('Synthetic Realtime policy household')::text,true);
select set_config('test.pet_id',public.create_pet(current_setting('test.household_id')::uuid,'Synthetic Realtime policy pet','Asia/Seoul')::text,true);

select ok(private.can_receive_hanilog_topic('hanilog.user.'||auth.uid()::text),'user topic is restricted to the signed-in user');
select ok(not private.can_receive_hanilog_topic('hanilog.user.00000000-0000-4000-8000-000000000032'),'user topic cannot be impersonated');
select ok(private.can_receive_hanilog_topic('hanilog.pet.'||current_setting('test.pet_id')),'active Pet grant authorizes its private topic');
select ok(private.can_receive_hanilog_topic('hanilog.household.'||current_setting('test.household_id')),'active Household member authorizes its private topic');
select ok(not private.can_receive_hanilog_topic('hanilog.pet.00000000-0000-4000-8000-000000000000'),'unrelated Pet topic is denied');
select ok(not private.can_receive_hanilog_topic('public-room'),'unrecognized public-style topic is denied');

select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000032","role":"authenticated"}',true);
select ok(not private.can_receive_hanilog_topic('hanilog.pet.'||current_setting('test.pet_id')),'ungranted user cannot subscribe to Pet topic');
select ok(not private.can_receive_hanilog_topic('hanilog.household.'||current_setting('test.household_id')),'non-member cannot subscribe to Household topic');

reset role;
select ok(exists(select 1 from pg_catalog.pg_policy where polrelid='realtime.messages'::regclass and polname='hanilog_private_broadcast_read' and polcmd='r'),
  'Realtime receive policy is SELECT-only');
select ok(not exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public'
  and tablename in ('health_events','routine_occurrences','safety_evaluations')),
  'clinical tables are not replicated over Postgres Changes');

select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000031","role":"authenticated"}',true);
select set_config('test.event_id',(public.record_health_event(current_setting('test.pet_id')::uuid,'meal',clock_timestamp(),null,'{"synthetic":true}'::jsonb,
  null::text,'10000000-0000-4000-8000-000000000031'::uuid,'Asia/Seoul')->>'event_id'),true);
insert into public.health_event_revisions(event_id,revision_no,revision_kind,patch,reason_code,actor_id)
values(current_setting('test.event_id')::uuid,1,'CORRECT','{"synthetic_correction":true}'::jsonb,'TEST_CORRECTION','00000000-0000-4000-8000-000000000031');
select is((select count(*)::integer from public.health_event_revisions where event_id=current_setting('test.event_id')::uuid),1,
  'Health Event revision change resolves its Pet through the parent event and succeeds');

select * from finish();
rollback;
