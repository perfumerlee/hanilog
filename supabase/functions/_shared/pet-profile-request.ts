export const PROFILE_MULTIPART_BODY_MAX_BYTES = 1024 * 1024 + 64 * 1024;
export const PROFILE_JSON_BODY_MAX_BYTES = 16 * 1024;
export const PROFILE_BODY_TOTAL_TIMEOUT_MS = 15_000;
export const PROFILE_BODY_IDLE_TIMEOUT_MS = 5_000;
const PROFILE_BODY_CANCEL_GRACE_MS = 100;
const PROFILE_BODY_MAX_CHUNKS = 4096;

export type ProfileBodyStage = 'read_started' | 'first_chunk' | 'read_complete' | 'parse_complete' | 'cancel_started' | 'cancel_settled' | 'cancel_pending';
export type ProfileBodyObserver = (stage: ProfileBodyStage, elapsedMs: number) => void;

export function photoUploadIsDisabled(request: Request, enabled: boolean): boolean {
  if (enabled) return false;
  const contentType = request.headers.get('content-type') ?? '';
  return /^\s*multipart\/form-data(?:\s*;|\s*$)/i.test(contentType);
}

export class ProfileRequestError extends Error {
  constructor(
    readonly code: 'BODY_TOO_LARGE' | 'BODY_TOO_COMPLEX' | 'BODY_TIMEOUT' | 'BODY_IDLE_TIMEOUT' | 'BODY_ABORTED' | 'BODY_LENGTH_INVALID' | 'BODY_MALFORMED' | 'CONTENT_TYPE_UNSUPPORTED',
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  contentLengthHeader: string | null,
  signal?: AbortSignal,
  timeoutMs = PROFILE_BODY_TOTAL_TIMEOUT_MS,
  onStage?: ProfileBodyObserver,
  idleTimeoutMs = PROFILE_BODY_IDLE_TIMEOUT_MS,
): Promise<Uint8Array> {
  let declaredLength: number | null = null;
  if (contentLengthHeader !== null) {
    if (!/^\d+$/.test(contentLengthHeader.trim())) throw new ProfileRequestError('BODY_LENGTH_INVALID', 400);
    declaredLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(declaredLength)) throw new ProfileRequestError('BODY_LENGTH_INVALID', 400);
    if (declaredLength > maxBytes) throw new ProfileRequestError('BODY_TOO_LARGE', 413);
  }
  if (!body) {
    if (declaredLength && declaredLength !== 0) throw new ProfileRequestError('BODY_MALFORMED', 400);
    return new Uint8Array();
  }
  if (signal?.aborted) throw new ProfileRequestError('BODY_ABORTED', 400);

  const reader = body.getReader();
  const boundedBytes = new Uint8Array(maxBytes);
  const startedAt = Date.now();
  let total = 0;
  let chunkCount = 0;
  let firstChunk = true;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let releaseWhenDrained = false;
  const report = (stage: ProfileBodyStage) => {
    try { onStage?.(stage, Math.max(0, Date.now() - startedAt)); } catch { /* diagnostics must not affect request handling */ }
  };
  try {
    report('read_started');
    const totalTimeout = new Promise<never>((_, reject) => {
      totalTimer = setTimeout(() => reject(new ProfileRequestError('BODY_TIMEOUT', 408)), timeoutMs);
    });
    const aborted = signal ? new Promise<never>((_, reject) => {
      abortHandler = () => reject(new ProfileRequestError('BODY_ABORTED', 400));
      signal.addEventListener('abort', abortHandler, { once: true });
    }) : null;
    while (true) {
      if (signal?.aborted) throw new ProfileRequestError('BODY_ABORTED', 400);
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const idleTimeout = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(() => reject(new ProfileRequestError('BODY_IDLE_TIMEOUT', 408)), idleTimeoutMs);
      });
      pendingRead = reader.read();
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race(aborted ? [pendingRead, totalTimeout, idleTimeout, aborted] : [pendingRead, totalTimeout, idleTimeout]);
      } finally {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
      }
      pendingRead = undefined;
      if (result.done) break;
      if (firstChunk) { firstChunk = false; report('first_chunk'); }
      chunkCount++;
      if (chunkCount > PROFILE_BODY_MAX_CHUNKS) throw new ProfileRequestError('BODY_TOO_COMPLEX', 413);
      total += result.value.byteLength;
      if (total > maxBytes) throw new ProfileRequestError('BODY_TOO_LARGE', 413);
      boundedBytes.set(result.value, total - result.value.byteLength);
    }
    if (declaredLength !== null && declaredLength !== total) throw new ProfileRequestError('BODY_MALFORMED', 400);
    report('read_complete');
    return boundedBytes.subarray(0, total);
  } catch (error) {
    // Cancel upstream immediately, but don't wait indefinitely for an Edge body stream.
    // Keep the lock until any pending read/cancel settles; the HTTP error response is independent.
    report('cancel_started');
    let cancelPromise: Promise<void>;
    try { cancelPromise = reader.cancel().catch(() => undefined); }
    catch { cancelPromise = Promise.resolve(); }
    const drained = Promise.allSettled([...(pendingRead ? [pendingRead] : []), cancelPromise]).then(() => undefined);
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      drained.then(() => true),
      new Promise<false>((resolve) => { graceTimer = setTimeout(() => resolve(false), PROFILE_BODY_CANCEL_GRACE_MS); }),
    ]);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (settled) {
      try { reader.releaseLock(); } catch { /* already released by the stream */ }
      report('cancel_settled');
    } else {
      releaseWhenDrained = true;
      report('cancel_pending');
      void drained.then(() => {
        if (releaseWhenDrained) {
          releaseWhenDrained = false;
          try { reader.releaseLock(); } catch { /* stream may already be closed */ }
        }
      });
    }
    if (error instanceof ProfileRequestError) throw error;
    throw new ProfileRequestError('BODY_MALFORMED', 400);
  } finally {
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    if (!releaseWhenDrained) {
      try { reader.releaseLock(); } catch { /* pending read owns the lock until cancellation settles */ }
    }
  }
}

export type ProfileRequestPayload = {
  action: string;
  petId: string;
  avatarId: string;
  expectedRevision: number;
  file: File | null;
};

function isFilePart(value: FormDataEntryValue | null): value is File {
  return typeof value === 'object' && value !== null
    && typeof value.size === 'number'
    && typeof value.type === 'string'
    && typeof value.name === 'string'
    && typeof value.arrayBuffer === 'function';
}

export async function parseBoundedProfileRequest(request: Request, onStage?: ProfileBodyObserver): Promise<ProfileRequestPayload> {
  const contentType = request.headers.get('content-type') ?? '';
  const isMultipart = /^multipart\/form-data\s*;/i.test(contentType) && /(?:^|;)\s*boundary=(?:"[^"]+"|[^;\s]+)/i.test(contentType);
  const isJson = /^application\/json(?:\s*;|$)/i.test(contentType);
  if (!isMultipart && !isJson) throw new ProfileRequestError('CONTENT_TYPE_UNSUPPORTED', 415);
  const maxBytes = isMultipart ? PROFILE_MULTIPART_BODY_MAX_BYTES : PROFILE_JSON_BODY_MAX_BYTES;
  const bytes = await readBoundedBody(request.body, maxBytes, request.headers.get('content-length'), request.signal, PROFILE_BODY_TOTAL_TIMEOUT_MS, onStage);
  const parseStarted = Date.now();

  try {
    if (isMultipart) {
      const headers = new Headers(request.headers);
      headers.delete('content-length');
      const boundedRequest = new Request(request.url, { method: 'POST', headers, body: bytes });
      const form = await boundedRequest.formData();
      try { onStage?.('parse_complete', Math.max(0, Date.now() - parseStarted)); } catch { /* diagnostics must not affect parsing */ }
      const allowed = new Set(['action', 'petId', 'avatarId', 'revision', 'file']);
      if ([...form.keys()].some((key) => !allowed.has(key))) throw new ProfileRequestError('BODY_MALFORMED', 400);
      for (const key of ['action', 'petId', 'avatarId', 'revision']) {
        if (form.getAll(key).length !== 1 || typeof form.get(key) !== 'string') throw new ProfileRequestError('BODY_MALFORMED', 400);
      }
      if (form.getAll('file').length > 1) throw new ProfileRequestError('BODY_MALFORMED', 400);
      const file = form.get('file');
      if (file !== null && !isFilePart(file)) throw new ProfileRequestError('BODY_MALFORMED', 400);
      return {
        action: String(form.get('action')),
        petId: String(form.get('petId')),
        avatarId: String(form.get('avatarId')),
        expectedRevision: Number(form.get('revision')),
        file: isFilePart(file) ? file : null,
      };
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProfileRequestError('BODY_MALFORMED', 400);
    const record = body as Record<string, unknown>;
    if (Object.keys(record).some((key) => !['action', 'petId', 'avatarId', 'revision'].includes(key))) {
      throw new ProfileRequestError('BODY_MALFORMED', 400);
    }
    if (typeof record.action !== 'string' || typeof record.petId !== 'string' || typeof record.avatarId !== 'string'
        || typeof record.revision !== 'number') throw new ProfileRequestError('BODY_MALFORMED', 400);
    return { action: record.action, petId: record.petId, avatarId: record.avatarId, expectedRevision: record.revision, file: null };
  } catch (error) {
    if (error instanceof ProfileRequestError) throw error;
    throw new ProfileRequestError('BODY_MALFORMED', 400, { cause: error });
  }
}
