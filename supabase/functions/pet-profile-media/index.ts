import { createClient } from 'npm:@supabase/supabase-js@2';
import { ImageMagick, initializeImageMagick, MagickFormat } from 'npm:@imagemagick/magick-wasm@0.0.45';
import { enqueueProfileOrphan, processProfileCleanupJobs, type CleanupErrorCode } from '../_shared/pet-profile-cleanup.ts';
import { jpegDimensions, PROFILE_IMAGE_MAX_BYTES, PROFILE_IMAGE_SIDE, stripJpegMetadataSegments, validateProfileImageInput } from '../_shared/pet-profile-image.ts';
import { parseBoundedProfileRequest, photoUploadIsDisabled, ProfileRequestError } from '../_shared/pet-profile-request.ts';
import { createProfileDiagnostics, profileSaveFailure } from '../_shared/pet-profile-diagnostics.ts';

const BUCKET = 'pet-profile-images';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
let imageMagickReady = false;
const wasmStarted = performance.now();
try {
  const wasm = await Deno.readFile(new URL('./magick.wasm', import.meta.url));
  await initializeImageMagick(wasm);
  imageMagickReady = true;
  console.info(JSON.stringify({ event: 'profile_image_runtime_ready', duration_ms: Math.round(performance.now() - wasmStarted) }));
} catch (error) {
  // Keep deployment diagnostics useful without logging filesystem paths or request data.
  const code = error instanceof Deno.errors.NotFound ? 'WASM_ASSET_NOT_FOUND' : 'WASM_INITIALIZATION_FAILED';
  console.error(JSON.stringify({ event: 'profile_image_runtime_init_failed', code }));
}

type Profile = { profile_avatar_id: string; profile_photo_object_path: string | null; profile_revision: number };

function jsonReply(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function randomObjectName() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function processJpeg(bytes: Uint8Array, contentType: string) {
  const dimensions = jpegDimensions(bytes);
  if (!dimensions || dimensions.width !== PROFILE_IMAGE_SIDE || dimensions.height !== PROFILE_IMAGE_SIDE) {
    throw new Error('PROFILE_IMAGE_DIMENSIONS_INVALID');
  }
  const decoded = ImageMagick.read(bytes, (image) => {
    if (image.format !== MagickFormat.Jpeg || image.width !== PROFILE_IMAGE_SIDE || image.height !== PROFILE_IMAGE_SIDE) {
      throw new Error('PROFILE_IMAGE_DECODE_INVALID');
    }
    image.quality = 85;
    return image.write(MagickFormat.Jpeg, (output) => output);
  });
  const cleaned = stripJpegMetadataSegments(decoded);
  if (!cleaned) throw new Error('PROFILE_IMAGE_ENCODE_INVALID');
  const error = validateProfileImageInput({ contentType, bytes: cleaned, width: PROFILE_IMAGE_SIDE, height: PROFILE_IMAGE_SIDE });
  if (error) throw new Error(error);
  return cleaned;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  const diagnostic = createProfileDiagnostics();
  const requestId = crypto.randomUUID();
  const reply = (status: number, payload: Record<string, unknown>) => {
    console.info(JSON.stringify({ ...diagnostic.summary(status, payload.error), request_id: requestId }));
    const response = jsonReply(status, payload);
    response.headers.set('x-profile-request-id', requestId);
    return response;
  };
  if (request.method !== 'POST') return reply(405, { error: 'METHOD_NOT_ALLOWED' });
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return reply(401, { error: 'AUTH_REQUIRED' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return reply(503, { error: 'PROFILE_SERVICE_UNAVAILABLE' });

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userResult, error: authError } = await diagnostic.measure('auth', () => userClient.auth.getUser());
  if (authError || !userResult.user) return reply(401, { error: 'AUTH_REQUIRED' });

  // Pause multipart uploads while the hosted open-stream 503 remains unresolved.
  // JSON avatar updates remain available and the multipart body is not consumed.
  if (photoUploadIsDisabled(request, Deno.env.get('PET_PROFILE_PHOTO_UPLOAD_ENABLED') === 'true')) {
    return reply(503, { error: 'PROFILE_PHOTO_UPLOAD_TEMPORARILY_DISABLED' });
  }

  let payload;
  try {
    payload = await diagnostic.measure('body', () => parseBoundedProfileRequest(request, (stage, durationMs) => {
      console.info(JSON.stringify({ event: 'profile_body_stage', stage, duration_ms: durationMs, request_id: requestId }));
    }));
  } catch (error) {
    if (error instanceof ProfileRequestError) return reply(error.status, { error: error.code });
    return reply(400, { error: 'BODY_MALFORMED' });
  }
  const { action, petId, avatarId, expectedRevision, file } = payload;
  if (action !== 'save' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(petId)
      || !/^dog-(3[0-2]|[12][0-9]|[1-9])$/.test(avatarId)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return reply(400, { error: 'PROFILE_REQUEST_INVALID' });
  }
  if (file && (file.size > PROFILE_IMAGE_MAX_BYTES || file.type !== 'image/jpeg')) {
    return reply(413, { error: 'PROFILE_IMAGE_TYPE_OR_SIZE_INVALID' });
  }
  if (file && !imageMagickReady) return reply(503, { error: 'PROFILE_IMAGE_PROCESSOR_UNAVAILABLE' });

  try {
    const { error: permissionError } = await diagnostic.measure('permission', () => userClient.rpc('assert_pet_profile_write', { p_pet_id: petId }));
    if (permissionError) return reply(403, { error: 'PET_PROFILE_ACCESS_DENIED' });
  } catch {
    return reply(503, { error: 'PROFILE_PERMISSION_CHECK_UNAVAILABLE' });
  }

  // Reject an already stale revision before spending CPU or uploading an orphan.
  // The locked RPC still rechecks revision and permission against concurrent changes.
  const before = await diagnostic.measure('profile_read', () => userClient.from('pets')
    .select('profile_revision').eq('id', petId).maybeSingle());
  if (before.error) return reply(503, { error: 'PROFILE_STATE_UNVERIFIED' });
  if (!before.data) return reply(403, { error: 'PET_PROFILE_ACCESS_DENIED' });
  if (before.data.profile_revision !== expectedRevision) return reply(409, { error: 'PROFILE_VERSION_CONFLICT' });

  let nextPhotoPath: string | null = null;

  // A JSON avatar edit must preserve any existing photo. Multipart photo
  // changes are disabled in Staging while the hosted request-stream issue is open.
  nextPhotoPath = before.data.profile_photo_object_path ?? null;

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const enqueueOrphan = (path: string) => enqueueProfileOrphan(async () => {
    const { data, error } = await diagnostic.measure('enqueue', () => admin.rpc('enqueue_pet_profile_cleanup', { p_pet_id: petId, p_object_path: path }));
    return { queued: data === true, error: Boolean(error) };
  });
  const drainCleanup = async () => {
    try {
      const { data, error } = await diagnostic.measure('cleanup_claim', () => admin.rpc('claim_pet_profile_cleanup', { p_limit: 10, p_pet_id: petId }));
      if (error) return true;
      return await processProfileCleanupJobs(data ?? [], {
        currentPath: async (id) => {
          // service_role has no public.pets SELECT grant in this application.
          // RLS-authorized user read also fails closed if this caller is revoked.
          const result = await diagnostic.measure('cleanup_read', () => userClient.from('pets').select('profile_photo_object_path').eq('id', id).maybeSingle());
          return { path: result.data?.profile_photo_object_path ?? null, error: Boolean(result.error || !result.data) };
        },
        remove: async (path) => {
          const result = await diagnostic.measure('cleanup_remove', () => admin.storage.from(BUCKET).remove([path]));
          return { error: Boolean(result.error) };
        },
        finish: async (id, completed, errorCode: CleanupErrorCode | null) => {
          const result = await diagnostic.measure('cleanup_finish', () => admin.rpc('finish_pet_profile_cleanup', {
            p_id: id,
            p_completed: completed,
            p_error_code: errorCode,
          }));
          return { error: Boolean(result.error) };
        },
      });
    } catch {
      return true;
    }
  };

  if (file) {
    let cleanJpeg: Uint8Array;
    try {
      cleanJpeg = await diagnostic.measure('image', async () => processJpeg(new Uint8Array(await file.arrayBuffer()), file.type));
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const known = new Set([
        'PROFILE_IMAGE_FORMAT_INVALID', 'PROFILE_IMAGE_SIZE_INVALID', 'PROFILE_IMAGE_TYPE_INVALID',
        'PROFILE_IMAGE_DIMENSIONS_INVALID', 'PROFILE_IMAGE_DECODE_INVALID', 'PROFILE_IMAGE_ENCODE_INVALID',
      ]);
      return reply(400, { error: known.has(code) ? code : 'PROFILE_IMAGE_PROCESSING_FAILED' });
    }

    const objectPath = `${petId}/${randomObjectName()}.jpg`;
    let uploadFailed = false;
    try {
      const { error: uploadError } = await diagnostic.measure('upload', () => admin.storage.from(BUCKET).upload(objectPath, cleanJpeg, {
        contentType: 'image/jpeg', cacheControl: '0', upsert: false,
      }));
      uploadFailed = Boolean(uploadError);
    } catch {
      uploadFailed = true;
    }
    if (uploadFailed) {
      // A network error can make the Storage result ambiguous; enqueue before any deletion.
      const cleanup = await enqueueOrphan(objectPath);
      if (cleanup === 'failed') return reply(503, { error: 'PROFILE_UPLOAD_FAILED_CLEANUP_UNVERIFIED' });
      const cleanupPending = cleanup === 'queued' ? await drainCleanup() : false;
      return reply(502, { error: 'PROFILE_IMAGE_UPLOAD_FAILED', cleanupPending });
    }
    nextPhotoPath = objectPath;
  }

  let profileRows: unknown;
  let saveError: { code?: string } | null = null;
  try {
    const result = await diagnostic.measure('save', () => userClient.rpc('update_pet_profile', {
      p_pet_id: petId,
      p_profile_avatar_id: avatarId,
      p_profile_photo_object_path: nextPhotoPath,
      p_expected_revision: expectedRevision,
    }));
    profileRows = result.data;
    saveError = result.error;
  } catch {
    // The transaction outcome may be unknown; enqueue checks the current DB reference before cleanup.
    saveError = { code: 'NETWORK_ERROR' };
  }
  if (saveError || !Array.isArray(profileRows) || !profileRows[0]) {
    let cleanupPending = false;
    if (nextPhotoPath) {
      // This RPC locks the Pet and refuses to enqueue the currently referenced object.
      const cleanup = await enqueueOrphan(nextPhotoPath);
      if (cleanup === 'failed') return reply(503, { error: 'PROFILE_SAVE_FAILED_CLEANUP_UNVERIFIED' });
      if (cleanup === 'queued') cleanupPending = await drainCleanup();
    }
    const failure = profileSaveFailure(saveError?.code);
    return reply(failure.status, {
      error: failure.error,
      cleanupPending,
    });
  }

  const saved = profileRows[0] as Profile;
  const cleanupPending = await drainCleanup();
  return reply(200, { ok: true, profile: saved, cleanupPending });
});
