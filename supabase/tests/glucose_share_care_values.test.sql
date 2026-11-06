begin;
select plan(10);

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
  ('00000000-0000-4000-8000-000000000301','authenticated','authenticated','share-owner@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-4000-8000-000000000302','authenticated','authenticated','share-outsider@example.test','',now(),'{}','{}',now(),now());
select is((select include_care_values from public.glucose_share_links limit 1),null::boolean,
  'No share link has been created yet');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000301","role":"authenticated"}',true);
select set_config('test.share_household',public.create_household('Synthetic share household')::text,true);
select set_config('test.share_pet',public.create_pet(current_setting('test.share_household')::uuid,'Synthetic share pet','Asia/Seoul')::text,true);
select public.record_health_event(current_setting('test.share_pet')::uuid,'meal','2026-11-03T00:00:00Z',null,
  '{"meal_status":"FULL","observed_value":35,"note":"must not appear"}'::jsonb,'g',
  '10000000-0000-4000-8000-000000000301'::uuid,'Asia/Seoul');
select public.record_health_event(current_setting('test.share_pet')::uuid,'insulin','2026-11-03T01:00:00Z',null,
  '{"administered_dose_value":2.5,"administered_dose_unit":"U","insulin_product_label":"Synthetic","note":"must not appear"}'::jsonb,'U',
  '10000000-0000-4000-8000-000000000302'::uuid,'Asia/Seoul');

select public.create_glucose_share_link(current_setting('test.share_pet')::uuid,repeat('a',64),'2026-11-03','2026-11-03',now()+interval '1 day',true);
select public.create_glucose_share_link_v2(current_setting('test.share_pet')::uuid,repeat('b',64),'2026-11-03','2026-11-03',now()+interval '1 day',true,true);
select is((select count(*)::integer from public.list_my_glucose_share_links_v2(current_setting('test.share_pet')::uuid) where include_care_values),1,
  'Only the explicit new link shares care values');
select throws_ok($$select public.create_glucose_share_link_v2(current_setting('test.share_pet')::uuid,repeat('c',64),'2026-11-03','2026-11-03',now()+interval '1 day',false,true)$$,
  '22023','GLUCOSE_SHARE_INVALID','Care values cannot be shared without opting into care times');
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000302","role":"authenticated"}',true);
select throws_ok($$select public.create_glucose_share_link_v2(current_setting('test.share_pet')::uuid,repeat('d',64),'2026-11-03','2026-11-03',now()+interval '1 day',true,true)$$,
  '42501','PET_SHARE_ACCESS_DENIED','Unrelated user cannot create a care value share');

set local role service_role;
select is((public.resolve_glucose_share_link(repeat('a',64))->'care_times'->0 ? 'amount'),false,
  'Existing time-only link does not reveal meal quantity');
select is((public.resolve_glucose_share_link(repeat('a',64))->>'include_care_values'),'false',
  'Existing link is explicitly marked time-only');
select is((public.resolve_glucose_share_link(repeat('b',64))->'care_times'->0->>'amount'),'35',
  'Explicit link shows recorded meal quantity');
select is((public.resolve_glucose_share_link(repeat('b',64))->'care_times'->1->>'amount'),'2.5',
  'Explicit link shows recorded insulin dose');
select is((public.resolve_glucose_share_link(repeat('b',64))->'care_times'->1->>'unit'),'U',
  'Explicit link retains insulin dose unit');
select is((public.resolve_glucose_share_link(repeat('b',64))->'care_times'->1 ? 'note'),false,
  'Care notes are excluded from the shared payload');

select * from finish();
rollback;
