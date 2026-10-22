import { createClient } from 'npm:@supabase/supabase-js@2';

const allowedOrigins = (Deno.env.get('APP_ALLOWED_ORIGINS') ?? 'https://localhost:5173,http://localhost:5173,http://127.0.0.1:5173')
  .split(',').map((value) => value.trim()).filter(Boolean);
const cors = (origin: string | null) => ({
  ...(origin && allowedOrigins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
});
const endpointAllowed = (value: string) => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (host === 'fcm.googleapis.com' || host.endsWith('.push.services.mozilla.com') ||
       host.endsWith('.notify.windows.com') || host.endsWith('.push.apple.com'));
  } catch { return false; }
};
const hex = (bytes: Uint8Array) => [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');

Deno.serve(async (request) => {
  const origin = request.headers.get('origin');
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors(origin) });
  const headers = { ...cors(origin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (origin && !allowedOrigins.includes(origin)) return Response.json({ error: 'ORIGIN_NOT_ALLOWED' }, { status: 403, headers });
  if (request.method !== 'POST') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405, headers });
  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  if (!token || !url || !anonKey) return Response.json({ error: 'AUTH_CONFIGURATION_INVALID' }, { status: 401, headers });
  try {
    const client = createClient(url, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: userResult, error: authError } = await client.auth.getUser(token);
    if (authError || !userResult.user) return Response.json({ error: 'UNAUTHENTICATED' }, { status: 401, headers });
    const payload = await request.json();
    if (payload?.action === 'list') {
      const { data, error } = await client.rpc('list_my_push_subscriptions');
      if (error) return Response.json({ error: 'SUBSCRIPTION_LIST_FAILED' }, { status: error.code === '42501' ? 403 : 500, headers });
      return Response.json({ subscriptions: data ?? [] }, { headers });
    }
    if (payload?.action === 'revoke') {
      if (typeof payload.endpoint_hash !== 'string' || !/^[a-f0-9]{64}$/.test(payload.endpoint_hash)) return Response.json({ error: 'INVALID_REQUEST' }, { status: 400, headers });
      const { data, error } = await client.rpc('revoke_push_subscription', { p_endpoint_hash: payload.endpoint_hash });
      if (error) return Response.json({ error: 'SUBSCRIPTION_REVOKE_FAILED' }, { status: error.code === '42501' ? 403 : 400, headers });
      return Response.json({ revoked: Boolean(data) }, { headers });
    }
    const { endpoint, endpoint_hash, p256dh, auth, expiration_time } = payload ?? {};
    if (typeof endpoint !== 'string' || !endpointAllowed(endpoint) || typeof endpoint_hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(endpoint_hash) || typeof p256dh !== 'string' || typeof auth !== 'string' ||
      p256dh.length > 256 || auth.length > 256 || (expiration_time !== null && expiration_time !== undefined && Number.isNaN(Date.parse(expiration_time)))) {
      return Response.json({ error: 'INVALID_SUBSCRIPTION' }, { status: 400, headers });
    }
    const expected = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))));
    if (expected !== endpoint_hash) return Response.json({ error: 'SUBSCRIPTION_HASH_MISMATCH' }, { status: 400, headers });
    const { error } = await client.rpc('register_push_subscription', {
      p_endpoint: endpoint, p_endpoint_hash: endpoint_hash, p_p256dh: p256dh, p_auth: auth,
      p_expiration_time: expiration_time ?? null,
    });
    if (error) return Response.json({ error: 'SUBSCRIPTION_REGISTER_FAILED' }, { status: error.code === '42501' ? 403 : 400, headers });
    return Response.json({ registered: true }, { headers });
  } catch {
    return Response.json({ error: 'REQUEST_PROCESSING_FAILED' }, { status: 400, headers });
  }
});
