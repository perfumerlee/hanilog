import { createClient } from 'npm:@supabase/supabase-js@2';
import { ImageMagick, initializeImageMagick, MagickFormat } from 'npm:@imagemagick/magick-wasm@0.0.45';
import { jpegDimensions, stripJpegMetadataSegments, validateProfileImageInput } from '../_shared/pet-profile-image.ts';
import { readBoundedBody, ProfileRequestError } from '../_shared/pet-profile-request.ts';

const INCOMING = 'pet-photo-incoming';
const FINAL = 'pet-profile-images';
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
const reply = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers });
let initialization: Promise<void> | undefined;
function initialize() {
  // Reuse the existing licensed asset. Load only for an authenticated, claimed upload.
  return initialization ??= Deno.readFile(new URL('../pet-profile-media/magick.wasm', import.meta.url))
    .then((bytes) => initializeImageMagick(bytes));
}
function encode(bytes: Uint8Array) {
  const dimensions = jpegDimensions(bytes);
  if (!dimensions || validateProfileImageInput({ contentType: 'image/jpeg', bytes, ...dimensions })) throw new Error('INVALID_IMAGE');
  const encoded = ImageMagick.read(bytes, (image) => {
    if (image.format !== MagickFormat.Jpeg || image.width !== 512 || image.height !== 512) throw new Error('INVALID_IMAGE');
    image.quality = 85;
    return image.write(MagickFormat.Jpeg, (output) => output);
  });
  const clean = stripJpegMetadataSegments(encoded);
  if (!clean || validateProfileImageInput({ contentType: 'image/jpeg', bytes: clean, width: 512, height: 512 })) throw new Error('INVALID_IMAGE');
  return clean;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return reply(405, { error: 'METHOD_NOT_ALLOWED' });
  if (Deno.env.get('PET_PHOTO_V2_ENABLED') !== 'true') return reply(503, { error: 'PHOTO_UNAVAILABLE' });
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return reply(415, { error: 'JSON_REQUIRED' });
  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const authorization = request.headers.get('authorization');
  if (!url || !anon || !secret) return reply(503, { error: 'PHOTO_UNAVAILABLE' });
  if (!authorization?.startsWith('Bearer ')) return reply(401, { error: 'AUTH_REQUIRED' });
  const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) });
  const user = createClient(url, anon, { global: { headers: { Authorization: authorization }, fetch: timedFetch }, auth: { persistSession: false } });
  const admin = createClient(url, secret, { global: { fetch: timedFetch }, auth: { persistSession: false } });
  let upload: { id: string; pet_id: string; object_path: string; output_path: string; state: string; result: unknown } | undefined;
  try {
    const auth = await user.auth.getUser();
    if (auth.error || !auth.data.user) return reply(401, { error: 'AUTH_REQUIRED' });
    const bytes = await readBoundedBody(request.body, 1024, request.headers.get('content-length'), request.signal, 5000, undefined, 2000);
    let body;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return reply(400, { error: 'INVALID_REQUEST' }); }
    if (!body || Object.keys(body).length !== 1 || typeof body.uploadId !== 'string'
        || !/^[0-9a-f-]{36}$/i.test(body.uploadId)) return reply(400, { error: 'INVALID_REQUEST' });
    const claim = await user.rpc('claim_pet_photo_upload', { p_id: body.uploadId });
    if (claim.error) return reply(claim.error.code === '42501' ? 403 : 409, { error: 'PHOTO_UPLOAD_NOT_AVAILABLE' });
    upload = claim.data;
    if (!upload) return reply(409, { error: 'PHOTO_UPLOAD_NOT_AVAILABLE' });
    if (upload.state === 'completed') return reply(200, { ok: true, profile: upload.result });
    await initialize();
    // Read the Storage response with a hard byte cap, independent of metadata/MIME claims.
    const objectUrl = `${url}/storage/v1/object/authenticated/${INCOMING}/${upload.object_path}`;
    const source = await timedFetch(objectUrl, { headers: { Authorization: `Bearer ${secret}`, apikey: secret } });
    if (!source.ok) throw new Error('SOURCE_UNAVAILABLE');
    const sourceBytes = await readBoundedBody(source.body, 1048576, source.headers.get('content-length'), undefined, 10_000);
    const clean = encode(sourceBytes);
    const stored = await admin.storage.from(FINAL).upload(upload.output_path, clean, { contentType: 'image/jpeg', cacheControl: '0', upsert: false });
    if (stored.error) throw new Error('OUTPUT_UNAVAILABLE');
    // This transaction rechecks the current Pet permission and revision, and records
    // both the profile update and successful intent together for response-loss recovery.
    const saved = await user.rpc('complete_pet_photo_upload', { p_id: upload.id });
    if (saved.error) throw new Error(saved.error.code === 'PT409' ? 'CONFLICT' : 'SAVE_UNVERIFIED');
    const removed = await admin.storage.from(INCOMING).remove([upload.object_path]);
    if (!removed.error) await admin.from('pet_photo_uploads').update({ cleanup_at: new Date().toISOString() }).eq('id', upload.id);
    return reply(200, { ok: true, profile: saved.data, cleanupPending: true });
  } catch (error) {
    if (upload) {
      // A lost DB response may have committed. Recover via RLS before deciding failure.
      const current = await user.from('pet_photo_uploads').select('state,result').eq('id', upload.id).maybeSingle().then((result) => result, () => null);
      if (current?.data?.state === 'completed') return reply(200, { ok: true, profile: current.data.result, cleanupPending: true });
      await admin.from('pet_photo_uploads').update({ state: 'failed' }).eq('id', upload.id).eq('state', 'processing').then(() => undefined, () => undefined);
      // Enqueue locks Pet and refuses current references, including an ambiguous commit.
      await admin.rpc('enqueue_pet_profile_cleanup', { p_pet_id: upload.pet_id, p_object_path: upload.output_path }).then(() => undefined, () => undefined);
    }
    if (error instanceof ProfileRequestError) return reply(error.status, { error: error.code });
    const code = error instanceof Error ? error.message : '';
    return reply(code === 'INVALID_IMAGE' ? 400 : code === 'CONFLICT' ? 409 : 502,
      { error: code === 'INVALID_IMAGE' ? 'INVALID_IMAGE' : code === 'CONFLICT' ? 'PROFILE_VERSION_CONFLICT' : 'PHOTO_SAVE_UNVERIFIED' });
  }
});
