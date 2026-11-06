begin;
select plan(12);
insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values
('00000000-0000-4000-8000-000000000601','authenticated','authenticated','photo-owner@example.test','',now(),'{}','{}',now(),now()),
('00000000-0000-4000-8000-000000000602','authenticated','authenticated','photo-outsider@example.test','',now(),'{}','{}',now(),now());
select is((select public from storage.buckets where id='pet-photo-incoming'),false,'Incoming images are private');
select is((select file_size_limit from storage.buckets where id='pet-photo-incoming'),1048576::bigint,'Incoming files capped at 1 MiB');
select ok(not has_function_privilege('anon','public.begin_pet_photo_upload(uuid,text,bigint)','execute'),'Anonymous cannot prepare an upload');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000601","role":"authenticated"}',true);
select set_config('test.photo_h',public.create_household('Synthetic photo home')::text,true);
select set_config('test.photo_p',public.create_pet(current_setting('test.photo_h')::uuid,'Synthetic photo pet','Asia/Seoul')::text,true);
select set_config('test.photo_u',(public.begin_pet_photo_upload(current_setting('test.photo_p')::uuid,'dog-2',0)).id::text,true);
select is((select state from public.pet_photo_uploads where id=current_setting('test.photo_u')::uuid),'pending','Upload starts pending');
select throws_ok($$select public.claim_pet_photo_upload(current_setting('test.photo_u')::uuid)$$,'PT409','PHOTO_UPLOAD_NOT_READY','No processing before upload exists');
insert into storage.objects(bucket_id,name) select 'pet-photo-incoming',object_path from public.pet_photo_uploads where id=current_setting('test.photo_u')::uuid;
select is((select count(*)::integer from storage.objects where bucket_id='pet-photo-incoming'),0,'Client cannot read unvalidated images');
select is((public.claim_pet_photo_upload(current_setting('test.photo_u')::uuid)).state,'processing','Uploaded object can be claimed');
select throws_ok($$select public.claim_pet_photo_upload(current_setting('test.photo_u')::uuid)$$,'PT409','PHOTO_UPLOAD_EXPIRED_OR_BUSY','Concurrent claim is rejected');
select throws_ok($$select public.complete_pet_photo_upload(current_setting('test.photo_u')::uuid)$$,'22023','PET_PROFILE_PHOTO_INVALID','Unvalidated source cannot become the profile');
reset role;
insert into storage.buckets(id,name,public) values('pet-profile-images','pet-profile-images',false) on conflict(id) do nothing;
insert into storage.objects(bucket_id,name) select 'pet-profile-images',output_path from public.pet_photo_uploads where id=current_setting('test.photo_u')::uuid;
set local role authenticated;
select is((public.complete_pet_photo_upload(current_setting('test.photo_u')::uuid)->>'profile_revision'),'1','Validated server output commits once');
select is((public.complete_pet_photo_upload(current_setting('test.photo_u')::uuid)->>'profile_revision'),'1','Repeated completion returns the original result');
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000602","role":"authenticated"}',true);
select throws_ok($$select public.complete_pet_photo_upload(current_setting('test.photo_u')::uuid)$$,'42501','PHOTO_UPLOAD_ACCESS_DENIED','Other users cannot finalize or retrieve the intent');
select * from finish();
rollback;
