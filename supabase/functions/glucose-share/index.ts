import { createClient } from 'npm:@supabase/supabase-js@2';

const allowedOrigins = (Deno.env.get('HANILOG_ALLOWED_ORIGINS') ??
  'https://perfumerlee.github.io,http://localhost:5173,https://localhost:5173')
  .split(',').map((item) => item.trim()).filter(Boolean);
const cors = (origin: string | null) => ({
  ...(origin && allowedOrigins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
});
const jsonHeaders = (origin: string | null) => ({ ...cors(origin), 'Content-Type': 'application/json',
  'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
const hex = (bytes: Uint8Array) => [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
const schemaUnavailable = (error: { code?: string } | null) => Boolean(error && ['42883', '42P01', '42703'].includes(error.code ?? ''));

async function readBoundedJson(request: Request, maxBytes = 4096) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('BODY_TOO_LARGE');
  if (!request.body) throw new Error('INVALID_BODY');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const startedAt = Date.now();
  try {
    while (true) {
      const remainingMs = 15_000 - (Date.now() - startedAt);
      if (remainingMs <= 0) throw new Error('BODY_TIMEOUT');
      let timeoutId = 0;
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => { timeoutId = setTimeout(() => reject(new Error('BODY_TIMEOUT')), Math.min(5_000, remainingMs)); }),
        ]);
      } finally { clearTimeout(timeoutId); }
      const { done, value } = result;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('BODY_TOO_LARGE');
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel(error instanceof Error ? error.message : 'BODY_READ_FAILED').catch(() => undefined);
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* A cancelled stream may already be unlocked. */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

Deno.serve(async (request) => {
  const origin = request.headers.get('origin');
  const headers = jsonHeaders(origin);
  if (request.method === 'OPTIONS') return new Response('ok', { headers });
  if (origin && !allowedOrigins.includes(origin)) return Response.json({ error: 'ORIGIN_NOT_ALLOWED' }, { status: 403, headers });
  if (request.method !== 'POST') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405, headers });

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) return Response.json({ error: 'SERVICE_UNAVAILABLE' }, { status: 503, headers });

  let payload: Record<string, unknown>;
  try {
    const parsed = await readBoundedJson(request);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_BODY');
    payload = parsed as Record<string, unknown>;
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === 'BODY_TOO_LARGE';
    const timedOut = error instanceof Error && error.message === 'BODY_TIMEOUT';
    return Response.json({ error: tooLarge ? 'REQUEST_TOO_LARGE' : timedOut ? 'REQUEST_BODY_TIMEOUT' : 'INVALID_REQUEST' },
      { status: tooLarge ? 413 : timedOut ? 408 : 400, headers });
  }

  try {
    if (payload.action === 'resolve' || payload.action === 'photo') {
      const token = payload.token;
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
        return Response.json({ error: 'SHARE_LINK_INVALID_OR_EXPIRED' }, { status: 404, headers });
      }
      const base64 = token.replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (char) => char.charCodeAt(0));
      if (bytes.byteLength !== 32) return Response.json({ error: 'SHARE_LINK_INVALID_OR_EXPIRED' }, { status: 404, headers });
      const tokenHash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
      const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await admin.rpc('resolve_glucose_share_link', { p_token_hash: tokenHash });
      if (error || !data) return Response.json({ error: 'SHARE_LINK_INVALID_OR_EXPIRED' }, { status: 404, headers });
      if (payload.action === 'photo') {
        const link = await admin.from('glucose_share_links').select('pet_id').eq('token_hash', tokenHash)
          .is('revoked_at', null).gt('expires_at', new Date().toISOString()).maybeSingle();
        if (link.error || !link.data) return Response.json({ error: 'SHARE_LINK_INVALID_OR_EXPIRED' }, { status: 404, headers });
        const pet = await admin.from('pets').select('profile_photo_object_path').eq('id', link.data.pet_id).maybeSingle();
        const path = pet.data?.profile_photo_object_path;
        if (pet.error || !path || !new RegExp(`^${link.data.pet_id}/[0-9a-f]{32}[.]jpg$`).test(path)) {
          return Response.json({ error: 'PHOTO_NOT_AVAILABLE' }, { status: 404, headers });
        }
        const image = await admin.storage.from('pet-profile-images').download(path);
        if (image.error || !image.data || image.data.size > 1048576 || image.data.type !== 'image/jpeg') {
          return Response.json({ error: 'PHOTO_NOT_AVAILABLE' }, { status: 404, headers });
        }
        return new Response(image.data, { status: 200, headers: { ...cors(origin), 'Content-Type': 'image/jpeg',
          'Cache-Control': 'no-store, private, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
      }
      return Response.json({ share: data }, { headers });
    }

    const authorization = request.headers.get('authorization') ?? '';
    const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!bearer) return Response.json({ error: 'UNAUTHENTICATED' }, { status: 401, headers });
    const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${bearer}` } } });
    const { data: authData, error: authError } = await client.auth.getUser(bearer);
    if (authError || !authData.user) return Response.json({ error: 'UNAUTHENTICATED' }, { status: 401, headers });

    if (payload.action === 'create') {
      const { pet_id, token_hash, from_date, to_date, include_care_times, include_care_values } = payload;
      // Server time avoids device clock skew at the maximum expiry boundary.
      const days = payload.expires_days;
      const expires_at = typeof days === 'number' && [1, 3, 7].includes(days)
        ? new Date(Date.now() + days * 86_400_000 - 60_000).toISOString()
        : payload.expires_at;
      if (typeof pet_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(pet_id) || typeof token_hash !== 'string' || !/^[a-f0-9]{64}$/.test(token_hash) ||
          typeof from_date !== 'string' || typeof to_date !== 'string' || typeof expires_at !== 'string' || typeof include_care_times !== 'boolean' ||
          (include_care_values !== undefined && typeof include_care_values !== 'boolean') || (include_care_values === true && !include_care_times)) {
        return Response.json({ error: 'INVALID_REQUEST' }, { status: 400, headers });
      }
      const { data, error } = await client.rpc('create_glucose_share_link_v2', {
        p_pet_id: pet_id, p_token_hash: token_hash, p_from_date: from_date, p_to_date: to_date,
        p_expires_at: expires_at, p_include_care_times: include_care_times, p_include_care_values: include_care_values === true,
      });
      if (error) return Response.json({ error: schemaUnavailable(error) ? 'SHARE_SCHEMA_UNAVAILABLE' : error.code === '42501' ? 'ACCESS_DENIED' : 'SHARE_CREATE_FAILED' },
        { status: schemaUnavailable(error) ? 503 : error.code === '42501' ? 403 : 400, headers });
      return Response.json({ share: Array.isArray(data) ? data[0] : data }, { headers });
    }
    if (payload.action === 'list') {
      if (typeof payload.pet_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.pet_id)) return Response.json({ error: 'INVALID_REQUEST' }, { status: 400, headers });
      const { data, error } = await client.rpc('list_my_glucose_share_links_v2', { p_pet_id: payload.pet_id });
      if (error) return Response.json({ error: schemaUnavailable(error) ? 'SHARE_SCHEMA_UNAVAILABLE' : error.code === '42501' ? 'ACCESS_DENIED' : 'SHARE_LIST_FAILED' },
        { status: schemaUnavailable(error) ? 503 : error.code === '42501' ? 403 : 400, headers });
      return Response.json({ shares: data ?? [] }, { headers });
    }
    if (payload.action === 'revoke') {
      if (typeof payload.share_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.share_id)) return Response.json({ error: 'INVALID_REQUEST' }, { status: 400, headers });
      const { error } = await client.rpc('revoke_glucose_share_link', { p_share_id: payload.share_id });
      if (error) return Response.json({ error: schemaUnavailable(error) ? 'SHARE_SCHEMA_UNAVAILABLE' : error.code === '42501' ? 'ACCESS_DENIED' : 'SHARE_REVOKE_FAILED' },
        { status: schemaUnavailable(error) ? 503 : error.code === '42501' ? 403 : 400, headers });
      return Response.json({ revoked: true }, { headers });
    }
    return Response.json({ error: 'INVALID_ACTION' }, { status: 400, headers });
  } catch {
    return Response.json({ error: 'REQUEST_PROCESSING_FAILED' }, { status: 400, headers });
  }
});
