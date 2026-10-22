import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { clearTimeout, setTimeout as scheduleTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.HANILOG_LOCAL_SUPABASE_URL;
const publishableKey = process.env.HANILOG_LOCAL_SUPABASE_PUBLISHABLE_KEY;
if (!supabaseUrl || !publishableKey) {
  process.stderr.write('Set the local Supabase URL and publishable key before running this test.\n');
  process.exit(1);
}

const docker = process.env.DOCKER_CLI ?? 'docker';
const timeoutMs = 12_000;
const ids = { household: null, pets: [], users: [], channels: [] };
const clients = [];

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  process.stdout.write(`PASS: ${message}\n`);
}

async function createSignedInClient(label) {
  const suffix = randomUUID();
  const email = `phase33-realtime-${label}-${suffix}@example.test`;
  const password = `HaniLog-${randomUUID()}-Synthetic`;
  const client = createClient(supabaseUrl, publishableKey, { auth: { autoRefreshToken: false, persistSession: false } });
  clients.push(client);
  const signup = await client.auth.signUp({ email, password });
  if (signup.error || !signup.data.user) throw signup.error ?? new Error(`${label} signup returned no user`);
  const login = await client.auth.signInWithPassword({ email, password });
  if (login.error || !login.data.session) throw login.error ?? new Error(`${label} login returned no session`);
  return { client, email, userId: login.data.user.id };
}

async function rpc(client, name, args) {
  const result = await client.rpc(name, args);
  if (result.error) throw new Error(`${name}: ${result.error.message}`);
  return result.data;
}

async function subscribe(client, topic, event, expectedKind, messages, statuses, onMessage = () => {}) {
  return new Promise((resolve, reject) => {
    const timer = scheduleTimeout(() => reject(new Error('Realtime subscription timed out')), timeoutMs);
    const channel = client.channel(topic, { config: { private: true } })
      .on('broadcast', { event }, (message) => {
        const payload = message.payload;
        messages.push(payload);
        const payloadKeys = Object.keys(payload ?? {}).sort().join(',');
        if (payload?.kind !== expectedKind || payloadKeys !== 'id,kind' || typeof payload.id !== 'string') {
          process.stderr.write(`Unexpected Realtime payload envelopeKeys=${Object.keys(message).join(',')} payloadKeys=${Object.keys(payload ?? {}).join(',')} kindType=${typeof payload?.kind}\n`);
        }
        onMessage(payload);
      })
      .subscribe((status, error) => {
        statuses.push(status);
        if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(channel); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          clearTimeout(timer);
          reject(error ?? new Error(`Realtime subscription ended: ${status}`));
        }
      });
  });
}

async function waitFor(predicate, description) {
  const endAt = Date.now() + timeoutMs;
  while (Date.now() < endAt) {
    if (predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function psql(sql) {
  const result = spawnSync(docker, ['exec', '-i', 'supabase_db_hanilog', 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], { input: sql, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`Local synthetic fixture cleanup failed: ${result.stderr || result.error?.message || result.status}`);
}

async function cleanup() {
  for (const channel of ids.channels) await channel.unsubscribe();
  for (const client of clients) { await client.auth.signOut(); client.realtime.disconnect(); }
  if (!ids.users.length && !ids.household && !ids.pets.length) return;

  const users = ids.users.length ? ids.users.map((id) => `'${id}'`).join(',') : "'00000000-0000-4000-8000-000000000000'";
  const pets = ids.pets.length ? ids.pets.map((id) => `'${id}'`).join(',') : "'00000000-0000-4000-8000-000000000000'";
  const household = ids.household ? `'${ids.household}'` : "'00000000-0000-4000-8000-000000000000'";
  psql(`begin;
delete from public.audit_log where actor_id in (${users}) or target_id in (${household},${pets});
delete from public.safety_acknowledgements where pet_id in (${pets});
delete from public.safety_evaluations where pet_id in (${pets});
delete from public.health_event_revisions where event_id in (select id from public.health_events where pet_id in (${pets}));
delete from public.idempotency_records where actor_id in (${users});
delete from public.health_events where pet_id in (${pets});
delete from public.routine_occurrences where pet_id in (${pets});
delete from public.care_routine_versions where pet_id in (${pets});
delete from public.care_routines where pet_id in (${pets});
delete from public.care_plan_versions where pet_id in (${pets});
delete from public.care_plans where pet_id in (${pets});
delete from public.household_invitations where household_id=${household};
delete from public.pet_access_grants where pet_id in (${pets});
delete from public.household_memberships where household_id=${household};
delete from public.pets where id in (${pets});
delete from public.households where id=${household};
delete from auth.users where id in (${users});
commit;`);
}

let testError;
try {
  const primary = await createSignedInClient('owner');
  ids.users.push(primary.userId);
  const caregiver = await createSignedInClient('caregiver');
  ids.users.push(caregiver.userId);

  ids.household = await rpc(primary.client, 'create_household', { p_name: 'Synthetic Phase 3.3 household' });
  const petId = await rpc(primary.client, 'create_pet', { p_household_id: ids.household, p_name: 'Synthetic Phase 3.3 pet', p_timezone: 'Asia/Seoul' });
  ids.pets.push(petId);
  const otherPetId = await rpc(primary.client, 'create_pet', { p_household_id: ids.household, p_name: 'Synthetic unrelated pet', p_timezone: 'Asia/Seoul' });
  ids.pets.push(otherPetId);

  const invitation = await rpc(primary.client, 'create_household_invitation', {
    p_household_id: ids.household, p_invitee_email: caregiver.email, p_membership_role: 'CAREGIVER', p_pet_ids: [petId], p_expires_at: null,
  });
  const accepted = await rpc(caregiver.client, 'resolve_household_invitation', { p_token: invitation.token, p_accept: true });
  assert(accepted.status === 'ACCEPTED', 'caregiver accepted the synthetic Pet grant');

  const primaryMessages = await caregiver.client.from('pets').select('id').eq('id', petId);
  if (primaryMessages.error) throw primaryMessages.error;
  assert(primaryMessages.data.length === 1, 'caregiver can query the granted Pet before revocation');

  const petMessages = [];
  const userMessages = [];
  const statuses = [];
  let cachedPrivateRows = ['synthetic private row'];
  let cacheClearedOnRevoke = false;
  ids.channels.push(await subscribe(caregiver.client, `hanilog.pet.${petId}`, 'invalidate', 'invalidate', petMessages, statuses));
  ids.channels.push(await subscribe(caregiver.client, `hanilog.user.${caregiver.userId}`, 'access_changed', 'access_changed', userMessages, [], () => {
    cachedPrivateRows = [];
    cacheClearedOnRevoke = true;
  }));

  let ungrantedJoinDenied = false;
  try {
    const channel = await subscribe(caregiver.client, `hanilog.pet.${otherPetId}`, 'invalidate', 'invalidate', [], []);
    ids.channels.push(channel);
  } catch { ungrantedJoinDenied = true; }
  assert(ungrantedJoinDenied, 'ungranted second Pet private channel is denied');

  const record = (client, petId, name) => rpc(client, 'record_health_event', {
    p_pet_id: petId, p_event_type: 'meal', p_occurred_at: new Date().toISOString(), p_occurrence_id: null,
    p_value: { synthetic_test: name }, p_unit: null, p_idempotency_key: randomUUID(), p_client_timezone: 'Asia/Seoul', p_performer_id: null,
  });
  const initialEvent = await record(primary.client, petId, 'phase33_realtime_before_revoke');
  await waitFor(() => petMessages.length > 0, 'Pet invalidation delivery');
  assert(petMessages.every((item) => item?.kind === 'invalidate' && Object.keys(item).sort().join(',') === 'id,kind' && typeof item.id === 'string'),
    'Pet channel carries only the non-sensitive invalidation kind');
  const beforeRevisionMessages = petMessages.length;
  await rpc(primary.client, 'revise_health_event', {
    p_event_id: initialEvent.event_id, p_expected_revision: 0, p_revision_kind: 'CORRECT',
    p_patch: { synthetic_correction: true }, p_reason_code: 'SYNTHETIC_TEST', p_idempotency_key: randomUUID(),
  });
  await waitFor(() => petMessages.length > beforeRevisionMessages, 'Health Event revision invalidation');
  assert(petMessages.slice(beforeRevisionMessages).every((item) => item?.kind === 'invalidate' && Object.keys(item).sort().join(',') === 'id,kind'),
    'revision changes notify only through a generic invalidation without clinical details');

  const revoke = await rpc(primary.client, 'manage_pet_access', { p_pet_id: petId, p_user_id: caregiver.userId, p_access_role: 'CAREGIVER', p_revoke: true });
  assert(Boolean(revoke), 'primary caregiver revoked the Pet grant');
  await waitFor(() => userMessages.length > 0, 'separate user-specific access-change notification');
  assert(userMessages.every((item) => item?.kind === 'access_changed' && Object.keys(item).sort().join(',') === 'id,kind' && typeof item.id === 'string'),
    'user-specific access channel contains only the access-changed signal');
  assert(cacheClearedOnRevoke && cachedPrivateRows.length === 0, 'user-specific signal clears the test client private cache');

  const deniedRead = await caregiver.client.from('health_events').select('id').eq('pet_id', petId);
  if (deniedRead.error) throw deniedRead.error;
  assert(deniedRead.data.length === 0, 'revoked caregiver cannot read Pet events through RLS');
  const deniedWrite = await caregiver.client.rpc('record_health_event', {
    p_pet_id: petId, p_event_type: 'meal', p_occurred_at: new Date().toISOString(), p_occurrence_id: null,
    p_value: { synthetic_test: 'phase33_revoked_write' }, p_unit: null, p_idempotency_key: randomUUID(),
    p_client_timezone: 'Asia/Seoul', p_performer_id: null,
  });
  assert(Boolean(deniedWrite.error), 'revoked caregiver write is rejected by the server RPC');

  const priorPetMessages = petMessages.length;
  await record(primary.client, petId, 'phase33_after_revoke');
  let staleChannelMessage = false;
  try { await waitFor(() => petMessages.length > priorPetMessages, 'existing channel behavior after revocation'); staleChannelMessage = true; } catch { /* A Realtime version may eagerly re-check and stop delivery. */ }
  if (staleChannelMessage) {
    assert(petMessages.slice(priorPetMessages).every((item) => item?.kind === 'invalidate' && Object.keys(item).sort().join(',') === 'id,kind' && typeof item.id === 'string'),
      'cached Pet-channel authorization exposes only a generic invalidation');
    process.stdout.write('STALE_CHANNEL_AFTER_REVOKE=GENERIC_INVALIDATION_ONLY\n');
  } else {
    assert(true, 'existing Pet channel delivered no message after revocation in this run');
    process.stdout.write('STALE_CHANNEL_AFTER_REVOKE=NO_MESSAGE_OBSERVED\n');
  }

  const refreshed = await caregiver.client.auth.refreshSession();
  if (refreshed.error || !refreshed.data.session) throw refreshed.error ?? new Error('JWT refresh returned no session');
  await caregiver.client.realtime.setAuth(refreshed.data.session.access_token);
  const petChannel = ids.channels.shift();
  if (petChannel) await caregiver.client.removeChannel(petChannel);
  let rejoinDenied = false;
  try {
    const channel = await subscribe(caregiver.client, `hanilog.pet.${petId}`, 'invalidate', 'invalidate', [], []);
    ids.channels.push(channel);
  } catch { rejoinDenied = true; }
  assert(rejoinDenied, 'after JWT refresh and rejoin, the revoked Pet channel is denied');

  const otherPetBefore = petMessages.length;
  await record(primary.client, otherPetId, 'phase33_other_pet');
  await delay(500);
  assert(petMessages.length === otherPetBefore, 'other Pet event did not appear on the first Pet channel');
} catch (error) {
  testError = error;
} finally {
  try { await cleanup(); process.stdout.write('TEST_FIXTURE_CLEANUP=PASS (only this run synthetic IDs)\n'); }
  catch (error) { testError ??= error; process.stderr.write(`TEST_FIXTURE_CLEANUP=FAIL ${error.message}\n`); }
}

if (testError) process.stderr.write(`${testError.stack ?? testError.message}\n`, () => process.exit(1));
else process.stdout.write('REALTIME_PERMISSION_REGRESSION=PASS\n', () => process.exit(0));
