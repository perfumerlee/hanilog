begin;
select plan(20);

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ('00000000-0000-4000-8000-000000000001','authenticated','authenticated','caregiver-a@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-4000-8000-000000000002','authenticated','authenticated','caregiver-b@example.test','',now(),'{}','{}',now(),now());

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select set_config('test.household_id',public.create_household('Synthetic household')::text,true);
select ok(current_setting('test.household_id') <> '', 'primary caregiver can create a household');
select is(public.rename_household(current_setting('test.household_id')::uuid,'Updated synthetic household'),
  'Updated synthetic household','primary caregiver can update the household name');
select is((select name from public.households where id=current_setting('test.household_id')::uuid),
  'Updated synthetic household','household name update is persisted');
select throws_ok(
  $$select count(*)::integer from public.audit_log where action='HOUSEHOLD_RENAMED' and target_id=current_setting('test.household_id')::uuid$$,
  '42501','permission denied for table audit_log','caregivers cannot directly read the internal audit log'
);
reset role;
select is((select count(*)::integer from public.audit_log where action='HOUSEHOLD_RENAMED' and target_id=current_setting('test.household_id')::uuid),
  1,'household name update has an audit entry');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select set_config('test.pet_id',public.create_pet(current_setting('test.household_id')::uuid,'Synthetic pet','Asia/Seoul')::text,true);
select ok(current_setting('test.pet_id') <> '', 'primary caregiver can create a pet and receives a pet grant');
select is((select count(*)::integer from public.pets),1,'owner can read the granted pet');

select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select is((select count(*)::integer from public.pets),0,'unrelated user cannot read another household pet');
select throws_ok(
  $$select public.create_pet(current_setting('test.household_id')::uuid,'Unauthorized pet','Asia/Seoul')$$,
  '42501', 'FORBIDDEN', 'unrelated user cannot create a pet in another household'
);
select throws_ok(
  $$select public.rename_household(current_setting('test.household_id')::uuid,'Unauthorized rename')$$,
  '42501', 'FORBIDDEN', 'non-member cannot rename another household'
);

reset role;
insert into public.household_memberships(household_id,user_id,role,status,created_by)
values(current_setting('test.household_id')::uuid,'00000000-0000-4000-8000-000000000002','CAREGIVER','ACTIVE','00000000-0000-4000-8000-000000000001');
insert into public.pet_access_grants(pet_id,user_id,access_role,status,granted_by)
values(current_setting('test.pet_id')::uuid,'00000000-0000-4000-8000-000000000002','CAREGIVER','ACTIVE','00000000-0000-4000-8000-000000000001');
insert into public.care_plans(id,pet_id,plan_type,created_by)
values('20000000-0000-4000-8000-000000000001',current_setting('test.pet_id')::uuid,'PERSONAL_ROUTINE','00000000-0000-4000-8000-000000000001');
insert into public.care_plan_versions(id,care_plan_id,pet_id,version_no,source,author_id,approval_status,content,content_hash)
values('20000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001',current_setting('test.pet_id')::uuid,1,'USER_ENTERED',
  '00000000-0000-4000-8000-000000000001','USER_ENTERED_UNVERIFIED','{"synthetic":true}','synthetic-hash');
insert into public.care_routines(id,pet_id,care_plan_id,timezone,created_by)
values('30000000-0000-4000-8000-000000000001',current_setting('test.pet_id')::uuid,
  '20000000-0000-4000-8000-000000000001','Asia/Seoul','00000000-0000-4000-8000-000000000001');
insert into public.care_routine_versions(id,routine_id,pet_id,care_plan_id,version_no,care_plan_version_id,recurrence,steps,created_by)
values('30000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001',current_setting('test.pet_id')::uuid,
  '20000000-0000-4000-8000-000000000001',1,
  '20000000-0000-4000-8000-000000000002','{"synthetic":true}','[{"step":"meal"},{"step":"insulin"}]',
  '00000000-0000-4000-8000-000000000001');
insert into public.routine_occurrences(id,pet_id,routine_version_id,care_plan_version_id,care_plan_id,occurrence_key,step_key,event_type,
  scheduled_local_date,scheduled_local_time,timezone,disambiguation,scheduled_at)
values
  ('40000000-0000-4000-8000-000000000001',current_setting('test.pet_id')::uuid,'30000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','synthetic-slot','meal','meal','2026-01-01','08:00','Asia/Seoul','NOT_AMBIGUOUS','2025-12-31T23:00:00Z'),
  ('40000000-0000-4000-8000-000000000002',current_setting('test.pet_id')::uuid,'30000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','synthetic-slot','insulin','insulin','2026-01-01','08:05','Asia/Seoul','NOT_AMBIGUOUS','2025-12-31T23:05:00Z');
select set_config('test.occurrence_id','40000000-0000-4000-8000-000000000002',true);

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select set_config('test.first_response',public.record_health_event(
  current_setting('test.pet_id')::uuid,'insulin','2026-01-01T00:00:00Z',current_setting('test.occurrence_id')::uuid,'{}'::jsonb,null::text,
  '10000000-0000-4000-8000-000000000001'::uuid,'Asia/Seoul')::text,true);
select ok((current_setting('test.first_response')::jsonb->'result_codes') @> '["MEAL_UNCONFIRMED"]'::jsonb,
  'missing meal record is reported as unconfirmed, not as not performed');
select ok((current_setting('test.first_response')::jsonb->'result_codes') @> '["PLAN_UNVERIFIED"]'::jsonb,
  'user-entered routine is not represented as clinician approved');

select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select set_config('test.second_response',public.record_health_event(
  current_setting('test.pet_id')::uuid,'insulin','2026-01-01T00:01:00Z',current_setting('test.occurrence_id')::uuid,'{}'::jsonb,null::text,
  '10000000-0000-4000-8000-000000000002'::uuid,'Asia/Seoul')::text,true);
select ok((current_setting('test.second_response')::jsonb->'result_codes') @> '["DUPLICATE_POSSIBLE"]'::jsonb,
  'second caregiver receives a duplicate possibility warning');
select is((select count(*)::integer from public.health_events where occurrence_id=current_setting('test.occurrence_id')::uuid),2,
  'both separately reported real events are preserved');
select is(public.record_health_event(
  current_setting('test.pet_id')::uuid,'insulin','2026-01-01T00:01:00Z',current_setting('test.occurrence_id')::uuid,'{}'::jsonb,null::text,
  '10000000-0000-4000-8000-000000000002'::uuid,'Asia/Seoul')->>'event_id',
  (current_setting('test.second_response')::jsonb)->>'event_id', 'same idempotency key returns the original event');
select is((select count(*)::integer from public.health_events where occurrence_id=current_setting('test.occurrence_id')::uuid),2,
  'idempotent retry does not create another event');
select set_config('test.glucose_response',public.record_health_event(
  current_setting('test.pet_id')::uuid,'glucose',clock_timestamp(),null,'{"observed_value":164}'::jsonb,'mg/dL',
  '10000000-0000-4000-8000-000000000003'::uuid,'Asia/Seoul')::text,true);
select is((select unit from public.health_events where id=(current_setting('test.glucose_response')::jsonb->>'event_id')::uuid),
  'mg/dL','new glucose events persist the fixed mg/dL unit');
select is((select value->>'observed_value' from public.health_events
  where id=(current_setting('test.glucose_response')::jsonb->>'event_id')::uuid),'164',
  'fixed-unit glucose event preserves the submitted numeric value');
select throws_ok(
  $$select public.record_health_event(current_setting('test.pet_id')::uuid,'glucose',clock_timestamp(),null,'{"observed_value":8.2}'::jsonb,'mmol/L','10000000-0000-4000-8000-000000000004'::uuid,'Asia/Seoul')$$,
  '22023','GLUCOSE_UNIT_MUST_BE_MG_DL','new glucose events using another unit are rejected without conversion'
);
select throws_ok(
  $$select public.record_health_event(current_setting('test.pet_id')::uuid,'insulin','2026-01-01T00:01:00Z',current_setting('test.occurrence_id')::uuid,'{"note":"different request"}'::jsonb,null::text,'10000000-0000-4000-8000-000000000002'::uuid,'Asia/Seoul')$$,
  '23505', 'IDEMPOTENCY_KEY_REUSED', 'same key with a changed payload is rejected'
);

select * from finish();
rollback;
