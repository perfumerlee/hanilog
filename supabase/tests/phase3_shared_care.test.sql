begin;
select plan(22);

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ('00000000-0000-4000-8000-000000000031','authenticated','authenticated','phase3-primary@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-4000-8000-000000000032','authenticated','authenticated','phase3-caregiver@example.test','',now(),'{}','{}',now(),now());

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000031","role":"authenticated","email":"phase3-primary@example.test"}',true);
select set_config('test.hh',public.create_household('Phase 3 synthetic household')::text,true);
select set_config('test.pet',public.create_pet(current_setting('test.hh')::uuid,'Phase 3 synthetic pet','Asia/Seoul')::text,true);
select set_config('test.invite',public.create_household_invitation(current_setting('test.hh')::uuid,'phase3-caregiver@example.test','CAREGIVER',array[current_setting('test.pet')::uuid],null)->>'token',true);
select ok(current_setting('test.invite')<>'','manager receives one-time invitation token');
select is((select token_hash from public.household_invitations where invitee_email='phase3-caregiver@example.test'),
  encode(extensions.digest(convert_to(current_setting('test.invite'),'UTF8'),'sha256'),'hex'),'database stores only the invitation token digest');

select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000032","role":"authenticated","email":"different@example.test"}',true);
select throws_ok(format('select public.resolve_household_invitation(%L,true)',current_setting('test.invite')),
  '42501','INVITATION_INVALID_OR_USED','logged-in email mismatch cannot accept the invitation');
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000032","role":"authenticated","email":"phase3-caregiver@example.test"}',true);
select is(public.resolve_household_invitation(current_setting('test.invite'),true)->>'status','ACCEPTED','invitee accepts invitation with matching email');
select is((select count(*)::integer from public.pets where id=current_setting('test.pet')::uuid),1,'accepted Pet grant becomes visible through RLS');
select throws_ok(format('select public.resolve_household_invitation(%L,true)',current_setting('test.invite')),
  '42501','INVITATION_INVALID_OR_USED','accepted token cannot be reused');

select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000031","role":"authenticated","email":"phase3-primary@example.test"}',true);
select set_config('test.routine',public.save_care_routine(
  current_setting('test.pet')::uuid,null,'Personal synthetic routine','Asia/Seoul',
  jsonb_build_array(extract(dow from (clock_timestamp() at time zone 'Asia/Seoul')::date)::integer),
  '["12:00"]'::jsonb,
  '[{"key":"meal","event_type":"meal","predecessor_step_keys":[]},{"key":"insulin","event_type":"insulin","predecessor_step_keys":["meal"]}]'::jsonb,null
)::text,true);
select is(public.ensure_routine_occurrences(current_setting('test.pet')::uuid,(clock_timestamp() at time zone 'Asia/Seoul')::date),2,'server expands configured routine into two scheduled step slots');
select set_config('test.insulin_occurrence',(select id::text from public.routine_occurrences where pet_id=current_setting('test.pet')::uuid and event_type='insulin' and status='SCHEDULED' order by created_at desc limit 1),true);
select set_config('test.evaluation',public.evaluate_routine_occurrence(current_setting('test.insulin_occurrence')::uuid)->>'evaluation_id',true);
select ok((select result_codes @> array['ROUTINE_ORDER_UNCONFIRMED','MEAL_UNCONFIRMED','PLAN_UNVERIFIED']
  and not (result_codes @> array['PRECONDITION_UNCONFIRMED']) from public.safety_evaluations where id=current_setting('test.evaluation')::uuid),
  'server evaluation labels personal step order as nonclinical and does not infer clinician-approved preconditions');
select is(public.evaluate_routine_occurrence(current_setting('test.insulin_occurrence')::uuid)->>'evaluation_id',current_setting('test.evaluation'),'same evidence reuses the existing evaluation snapshot');
select ok(public.acknowledge_safety_evaluation(current_setting('test.evaluation')::uuid,array['MEAL_UNCONFIRMED']) is not null,'caregiver can acknowledge a returned warning');
select set_config('test.meal_occurrence',(select id::text from public.routine_occurrences where pet_id=current_setting('test.pet')::uuid and event_type='meal' and status='SCHEDULED' order by created_at desc limit 1),true);
select set_config('test.occurred_at',((select scheduled_at from public.routine_occurrences where id=current_setting('test.meal_occurrence')::uuid)-interval '1 hour')::text,true);
select set_config('test.meal_response',public.record_health_event(current_setting('test.pet')::uuid,'meal',current_setting('test.occurred_at')::timestamptz,
  current_setting('test.meal_occurrence')::uuid,'{"meal_status":"REFUSED"}'::jsonb,null,'10000000-0000-4000-8000-000000000041'::uuid,'Asia/Seoul')::text,true);
select is((select occurred_at::text from public.health_events where id=(current_setting('test.meal_response')::jsonb->>'event_id')::uuid),current_setting('test.occurred_at'),'late event stores the actual occurred_at supplied by the caregiver');
select ok((public.evaluate_routine_occurrence(current_setting('test.insulin_occurrence')::uuid)->'result_codes') @> '["MEAL_EXCEPTION_REPORTED"]'::jsonb
  and not ((public.evaluate_routine_occurrence(current_setting('test.insulin_occurrence')::uuid)->'result_codes') @> '["MEAL_UNCONFIRMED"]'::jsonb),
  'server evaluator reports meal exception after a late meal record without labeling it unconfirmed');
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000032","role":"authenticated","email":"phase3-caregiver@example.test"}',true);
select ok(public.acknowledge_safety_evaluation(current_setting('test.evaluation')::uuid,array['MEAL_UNCONFIRMED']) is not null,'second caregiver acknowledgement is independently recorded');
select is((select count(*)::integer from public.safety_acknowledgements where evaluation_id=current_setting('test.evaluation')::uuid),2,'acknowledgement history is append-only per actor');

select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000031","role":"authenticated","email":"phase3-primary@example.test"}',true);
select public.save_care_routine(current_setting('test.pet')::uuid,current_setting('test.routine')::uuid,'Personal synthetic routine v2','Asia/Seoul',
  jsonb_build_array(extract(dow from (clock_timestamp() at time zone 'Asia/Seoul')::date)::integer),
  '["13:00"]'::jsonb,'[{"key":"meal","event_type":"meal","predecessor_step_keys":[]}]'::jsonb,null);
select is((select count(*)::integer from public.care_routine_versions where routine_id=current_setting('test.routine')::uuid),2,'routine edits create a new version');
select is((select count(*)::integer from public.routine_occurrences where routine_version_id=(select id from public.care_routine_versions where routine_id=current_setting('test.routine')::uuid and version_no=1) and status='SUPERSEDED'),2,'future slots from the old version are preserved as superseded');
select is(public.ensure_routine_occurrences(current_setting('test.pet')::uuid,(clock_timestamp() at time zone 'Asia/Seoul')::date),1,'new routine version creates only its configured step slot');

reset role;
insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-4000-8000-000000000033','authenticated','authenticated','phase3-expired@example.test','',now(),'{}','{}',now(),now());
insert into public.household_invitations(household_id,invitee_email,membership_role,pet_ids,token_hash,status,invited_by,created_at,expires_at)
values(current_setting('test.hh')::uuid,'phase3-expired@example.test','READ_ONLY',array[current_setting('test.pet')::uuid],
  encode(extensions.digest(convert_to('synthetic expired token 0000000000000000','UTF8'),'sha256'),'hex'),'PENDING',
  '00000000-0000-4000-8000-000000000031',clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000033","role":"authenticated","email":"phase3-expired@example.test"}',true);
select is(public.resolve_household_invitation('synthetic expired token 0000000000000000',true)->>'status','EXPIRED','expired invitation is resolved without granting access');
reset role;
select is((select status from public.household_invitations where invitee_email='phase3-expired@example.test'),'EXPIRED','expired state is persisted');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000031","role":"authenticated","email":"phase3-primary@example.test"}',true);
select public.revoke_household_member(current_setting('test.hh')::uuid,'00000000-0000-4000-8000-000000000032');
select is((select status from public.household_memberships where household_id=current_setting('test.hh')::uuid and user_id='00000000-0000-4000-8000-000000000032'),'REVOKED','manager can revoke a non-primary member');
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000032","role":"authenticated","email":"phase3-caregiver@example.test"}',true);
select is((select count(*)::integer from public.pets where id=current_setting('test.pet')::uuid),0,'revoked membership loses Pet read access immediately');
select throws_ok(
  $$select public.record_health_event(current_setting('test.pet')::uuid,'meal',now(),null,'{}'::jsonb,null,'10000000-0000-4000-8000-000000000099'::uuid)$$,
  '42501','FORBIDDEN','revoked member cannot submit a Health Event');
select * from finish();
rollback;
