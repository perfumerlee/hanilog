begin;
select plan(9);

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ('00000000-0000-4000-8000-000000000181','authenticated','authenticated','time-owner@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-4000-8000-000000000182','authenticated','authenticated','time-outsider@example.test','',now(),'{}','{}',now(),now());

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000181","role":"authenticated"}',true);
select set_config('test.time_household',public.create_household('Synthetic time correction household')::text,true);
select set_config('test.time_pet',public.create_pet(current_setting('test.time_household')::uuid,'Synthetic time correction pet','Asia/Seoul')::text,true);
select set_config('test.time_event',(public.record_health_event(
  current_setting('test.time_pet')::uuid,'glucose','2026-11-01T01:00:00Z',null,
  '{"observed_value":164}'::jsonb,'mg/dL','00000000-0000-4000-8000-000000000183'::uuid,'Asia/Seoul'
)->>'event_id'),true);
select ok(current_setting('test.time_event')<>'' ,'synthetic glucose event saved');
select set_config('test.time_revision',public.correct_health_event_time(
  current_setting('test.time_event')::uuid,0,'2026-11-01T02:00:00Z',
  '00000000-0000-4000-8000-000000000184'::uuid)::text,true);
select ok(current_setting('test.time_revision')<>'' ,'time correction returns a revision');
select is((select occurred_at from public.health_events where id=current_setting('test.time_event')::uuid),
  '2026-11-01T02:00:00Z'::timestamptz,'current event time changes for all readers');
select is((select patch->>'previous_occurred_at' from public.health_event_revisions where id=current_setting('test.time_revision')::uuid),
  '2026-11-01T01:00:00+00:00','original time remains in immutable revision history');
select is(public.correct_health_event_time(current_setting('test.time_event')::uuid,0,
  '2026-11-01T02:00:00Z','00000000-0000-4000-8000-000000000184'::uuid),
  current_setting('test.time_revision')::uuid,'same idempotency key does not repeat correction');
select throws_ok($$select public.correct_health_event_time(current_setting('test.time_event')::uuid,0,
  '2026-11-01T03:00:00Z','00000000-0000-4000-8000-000000000185'::uuid)$$,
  '40001','REVISION_CONFLICT','stale revision cannot overwrite a correction');
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000182","role":"authenticated"}',true);
select throws_ok($$select public.correct_health_event_time(current_setting('test.time_event')::uuid,1,
  '2026-11-01T03:00:00Z','00000000-0000-4000-8000-000000000186'::uuid)$$,
  '42501','FORBIDDEN','unrelated caregiver cannot change another pet');
reset role;
select is((select count(*)::integer from public.audit_log where target_id=current_setting('test.time_event')::uuid
  and reason_code='USER_OCCURRENCE_TIME_CORRECTED'),1,'correction leaves one audit entry');
select is((select count(*)::integer from public.health_event_revisions where event_id=current_setting('test.time_event')::uuid),
  1,'idempotent correction adds exactly one revision');

select * from finish();
rollback;
