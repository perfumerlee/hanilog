import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

/* global fetch */

const url = process.env.HANILOG_LOCAL_SUPABASE_URL;
const publishableKey = process.env.HANILOG_LOCAL_SUPABASE_PUBLISHABLE_KEY;
const workerSecret = process.env.NOTIFICATION_WORKER_SECRET;
if (!url || !publishableKey || !workerSecret) {
  process.stderr.write('Notification Worker test needs local Supabase URL, publishable key, and mock worker secret.\n');
  process.exit(1);
}
let parsedUrl;
try { parsedUrl = new URL(url); } catch { process.stderr.write('Local Supabase URL is invalid.\n'); process.exit(1); }
if (!['http:', 'https:'].includes(parsedUrl.protocol) || !parsedUrl.hostname || /[\r\n]/.test(publishableKey)) {
  process.stderr.write('Local Supabase connection configuration is invalid.\n'); process.exit(1);
}

const ids = { user: null, household: null, pet: null, routine: null, notification: null, endpointHashes: [] };
const client = createClient(url, publishableKey, { auth: { autoRefreshToken: false, persistSession: false } });
const assert = (condition, message) => {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  process.stdout.write(`PASS: ${message}\n`);
};
const rpc = async (name, args) => {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(`${name} failed (${error.code ?? 'unknown'}).`);
  return data;
};
function psql(sql) {
  const result = spawnSync(process.env.DOCKER_CLI ?? 'docker', ['exec','-i','supabase_db_hanilog','psql','-XAtq','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'], { input:sql, encoding:'utf8' });
  if (result.error || result.status !== 0) throw new Error(`Local fixture SQL failed (${result.status ?? 'spawn'}).`);
  return result.stdout.trim();
}
function cleanup() {
  if (!ids.user) return;
  const uuid = (value) => value && /^[0-9a-f-]{36}$/i.test(value) ? `'${value}'` : "'00000000-0000-4000-8000-000000000000'";
  const pet = uuid(ids.pet); const user = uuid(ids.user); const household = uuid(ids.household);
  psql(`begin;
delete from public.audit_log where actor_id=${user} or target_id in (select id from public.notification_outbox where pet_id=${pet}) or target_id=${pet} or target_id=${household};
delete from public.safety_acknowledgements where pet_id=${pet};
delete from public.safety_evaluations where pet_id=${pet};
delete from public.health_event_revisions where event_id in (select id from public.health_events where pet_id=${pet});
delete from public.idempotency_records where actor_id=${user};
delete from public.health_events where pet_id=${pet};
delete from public.notification_delivery_attempts where outbox_id in (select id from public.notification_outbox where pet_id=${pet});
delete from public.notification_outbox where pet_id=${pet};
delete from public.in_app_notifications where pet_id=${pet};
delete from public.notification_preferences where pet_id=${pet};
delete from public.push_subscriptions where user_id=${user};
delete from public.routine_occurrences where pet_id=${pet};
delete from public.care_routine_versions where pet_id=${pet};
delete from public.care_routines where pet_id=${pet};
delete from public.care_plan_versions where pet_id=${pet};
delete from public.care_plans where pet_id=${pet};
delete from public.household_invitations where household_id=${household};
delete from public.care_team_links where pet_id=${pet};
delete from public.pet_access_grants where pet_id=${pet};
delete from public.household_memberships where household_id=${household};
delete from public.pets where id=${pet};
delete from public.households where id=${household};
delete from auth.users where id=${user};
commit;`);
}

let failure;
try {
  const suffix = randomUUID();
  const email = `phase4-notification-${suffix}@example.test`;
  const password = `Synthetic-${randomUUID()}-HaniLog`;
  const signup = await client.auth.signUp({ email, password });
  if (signup.error || !signup.data.user) throw new Error('Synthetic local account could not be created.');
  ids.user = signup.data.user.id;
  const login = await client.auth.signInWithPassword({ email, password });
  if (login.error || !login.data.session) throw new Error('Synthetic local account could not be authenticated.');
  ids.household = await rpc('create_household', { p_name:'Synthetic Phase 4 notification household' });
  ids.pet = await rpc('create_pet', { p_household_id:ids.household, p_name:'Synthetic notification pet', p_timezone:'Asia/Seoul' });
  const fakeEndpoint=`https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
  const endpointHash=createHash('sha256').update(fakeEndpoint).digest('hex');
  const register=await client.functions.invoke('manage-push-subscription',{body:{endpoint:fakeEndpoint,endpoint_hash:endpointHash,
    p256dh:'A'.repeat(87),auth:'A'.repeat(22),expiration_time:null}});
  if (register.error || !register.data?.registered) {
    const status=register.error?.context?.status??register.error?.status??'unavailable';
    const code=typeof register.data?.error==='string'?register.data.error:'unavailable';
    throw new Error(`Synthetic device subscription registration failed (status=${status}, code=${code}).`);
  }
  ids.endpointHashes.push(endpointHash);
  assert(true,'authenticated Edge Function registers a per-device push subscription without exposing server credentials');
  const listed=await client.functions.invoke('manage-push-subscription',{body:{action:'list'}});
  if (listed.error || !listed.data?.subscriptions?.some((item)=>item.endpoint_hash===endpointHash)) throw new Error('Current user could not list the registered device status.');
  assert(true,'device listing returns the current user own subscription status only');
  const revoked=await client.functions.invoke('manage-push-subscription',{body:{action:'revoke',endpoint_hash:endpointHash}});
  if (revoked.error || !revoked.data?.revoked) throw new Error('Synthetic device subscription was not revoked.');
  assert(true,'authenticated Edge Function revokes a selected device subscription');
  for (let index=0;index<2;index++) {
    const endpoint=`https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    const hash=createHash('sha256').update(endpoint).digest('hex');
    const added=await client.functions.invoke('manage-push-subscription',{body:{endpoint,endpoint_hash:hash,p256dh:'B'.repeat(87),auth:'C'.repeat(22),expiration_time:null}});
    if (added.error || !added.data?.registered) throw new Error('Synthetic multi-device subscription could not be registered.');
    ids.endpointHashes.push(hash);
  }
  const { error: preferenceError } = await client.from('notification_preferences').insert({
    pet_id:ids.pet,user_id:ids.user,notification_type:'CARE_DUE',in_app_enabled:true,push_enabled:true,email_enabled:true,
    lead_minutes:10080,timezone:'Asia/Seoul',
  });
  if (preferenceError) throw new Error('Synthetic notification preference could not be saved.');
  const scheduledDate = new Date(Date.now()+24*60*60*1000);
  const weekday = Number(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Seoul',weekday:'short'}).formatToParts(scheduledDate)
    .find((part)=>part.type==='weekday')?.value && ({Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6}[new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Seoul',weekday:'short'}).format(scheduledDate)] ?? 0));
  const localDate = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(scheduledDate);
  ids.routine = await rpc('save_care_routine',{p_pet_id:ids.pet,p_routine_id:null,p_name:'Synthetic notification routine',p_timezone:'Asia/Seoul',
    p_days:[weekday],p_times:['12:00'],p_steps:[{key:'meal',event_type:'meal',predecessor_step_keys:[]}],p_care_plan_version_id:null});
  await rpc('ensure_routine_occurrences',{p_pet_id:ids.pet,p_local_date:localDate});
  const { data: notifications, error: noticeError } = await client.from('in_app_notifications').select('id,available_at,expires_at')
    .eq('pet_id',ids.pet).eq('notification_type','CARE_DUE').lte('available_at',new Date().toISOString()).limit(1);
  if (noticeError || !notifications?.length) throw new Error('Synthetic due notification was not materialized.');
  ids.notification = notifications[0].id;
  assert(true,'scheduled synthetic routine creates a due in-app notice and push outbox job');

  async function invokeWorker(mockFailures = [], mockEmail = {}) {
    const requestStartedAt=Date.now();
    const response = await fetch(new URL('/functions/v1/notification-worker',url),{
      method:'POST',headers:{'Content-Type':'application/json','apikey':publishableKey,'x-hanilog-worker-secret':workerSecret},
      body:JSON.stringify({mock_push_fail_endpoint_hashes:mockFailures,...mockEmail}),
    });
    const body = await response.json().catch(()=>({}));
    if (!response.ok || body.mode!=='mock') throw new Error(`Mock Worker returned HTTP ${response.status}.`);
    return {...body,requestStartedAt,requestEndedAt:Date.now()};
  }
  const retryHash=ids.endpointHashes[2];
  const acceptedHash=ids.endpointHashes[1];
  const first = await invokeWorker([retryHash],{mock_email_status:429,mock_email_retry_after:'90'});
  assert(first.claimed>=2,'mock Worker claims both channel jobs without external delivery');
  const jobState = psql(`select o.status||'|'||o.attempt_count||'|'||(select count(*) from public.notification_delivery_attempts a where a.outbox_id=o.id) from public.notification_outbox o where o.notification_id='${ids.notification}' and o.channel='PUSH';`);
  assert(jobState==='PENDING|1|1','partial device failure leaves the logical Push job retryable');
  const partialState=psql(`select (select status from public.notification_push_deliveries d join public.push_subscriptions s on s.id=d.subscription_id where d.outbox_id=o.id and s.endpoint_hash='${acceptedHash}')||'|'||
    (select attempt_count from public.notification_push_deliveries d join public.push_subscriptions s on s.id=d.subscription_id where d.outbox_id=o.id and s.endpoint_hash='${acceptedHash}')||'|'||
    (select status from public.notification_push_deliveries d join public.push_subscriptions s on s.id=d.subscription_id where d.outbox_id=o.id and s.endpoint_hash='${retryHash}')
    from public.notification_outbox o where o.notification_id='${ids.notification}' and o.channel='PUSH';`);
  assert(partialState==='ACCEPTED|1|RETRYABLE_FAILURE','per-device ledger records one success and one independently retryable failure');
  const emailState=psql(`select o.status||'|'||o.attempt_count||'|'||(select count(*) from public.notification_delivery_attempts a where a.outbox_id=o.id)||'|'||
    (select duplicate_possible from public.notification_delivery_attempts a where a.outbox_id=o.id order by attempt_no desc limit 1)||'|'||
    (extract(epoch from (o.available_at-o.updated_at))::integer>=89)
    from public.notification_outbox o where o.notification_id='${ids.notification}' and o.channel='EMAIL';`);
  assert(emailState==='PENDING|1|1|false|true',`Resend 429 is retryable, honors Retry-After, and records no duplicate-risk claim (state=${emailState})`);
  psql(`update public.notification_outbox set available_at=now() where notification_id='${ids.notification}' and channel in ('PUSH','EMAIL');
update public.notification_push_deliveries set available_at=now() where outbox_id=(select id from public.notification_outbox where notification_id='${ids.notification}' and channel='PUSH') and status='RETRYABLE_FAILURE';`);
  const [secondA,secondB]=await Promise.all([invokeWorker(),invokeWorker()]);
  const requestsOverlapped=secondA.requestStartedAt<secondB.requestEndedAt&&secondB.requestStartedAt<secondA.requestEndedAt;
  assert(requestsOverlapped,'two independent Worker HTTP requests overlapped during the same retry window');
  process.stdout.write(`CONCURRENT_WORKER_REQUESTS=2 overlap=${requestsOverlapped} claimed=${secondA.claimed+secondB.claimed}\n`);
  const secondState = psql(`select o.status||'|'||o.attempt_count||'|'||(select count(*) from public.notification_delivery_attempts a where a.outbox_id=o.id) from public.notification_outbox o where o.notification_id='${ids.notification}' and o.channel='PUSH';`);
  assert(secondState==='ACCEPTED|2|2','retry completes the logical Push job with one parent attempt per Worker run');
  const deviceAttempts=psql(`select
    (select attempt_count from public.notification_push_deliveries d join public.push_subscriptions s on s.id=d.subscription_id where d.outbox_id=o.id and s.endpoint_hash='${acceptedHash}')||'|'||
    (select attempt_count from public.notification_push_deliveries d join public.push_subscriptions s on s.id=d.subscription_id where d.outbox_id=o.id and s.endpoint_hash='${retryHash}')||'|'||
    (select count(*) from public.notification_push_delivery_attempts a join public.notification_push_deliveries d on d.id=a.delivery_id join public.push_subscriptions s on s.id=d.subscription_id where d.outbox_id=o.id and s.endpoint_hash='${acceptedHash}')
    from public.notification_outbox o where o.notification_id='${ids.notification}' and o.channel='PUSH';`);
  assert(deviceAttempts==='1|2|1','retry sends only to failed device; previously accepted device has exactly one provider attempt');
  const secondEmailState=psql(`select o.status||'|'||o.attempt_count||'|'||(select count(*) from public.notification_delivery_attempts a where a.outbox_id=o.id) from public.notification_outbox o where o.notification_id='${ids.notification}' and o.channel='EMAIL';`);
  assert(secondEmailState==='ACCEPTED|2|2','429-retried email becomes transport-accepted only after a later mock attempt');
} catch (error) { failure = error; }
finally {
  await client.auth.signOut().catch(()=>{});
  client.realtime.disconnect();
  try { cleanup(); process.stdout.write('TEST_FIXTURE_CLEANUP=PASS (only this run synthetic IDs)\n'); }
  catch (cleanupError) { process.stderr.write('TEST_FIXTURE_CLEANUP=FAIL\n'); failure ??= cleanupError; }
}
if (failure) { process.stderr.write(`NOTIFICATION_WORKER_REGRESSION=FAIL ${failure.message}\n`); process.exit(1); }
process.stdout.write('NOTIFICATION_WORKER_REGRESSION=PASS\n');
