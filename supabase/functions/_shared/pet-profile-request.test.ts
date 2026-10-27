// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  PROFILE_JSON_BODY_MAX_BYTES,
  PROFILE_MULTIPART_BODY_MAX_BYTES,
  parseBoundedProfileRequest,
  photoUploadIsDisabled,
  readBoundedBody,
} from './pet-profile-request';

function chunks(values: Uint8Array[], delay?: number) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const value of values) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        controller.enqueue(value);
      }
      controller.close();
    },
  });
}

const utf8 = (value: string) => new TextEncoder().encode(value);

describe('bounded profile request parsing', () => {
  it('fails closed on multipart photo requests when uploads are disabled', () => {
    const request = new Request('https://local.test/profile', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=synthetic' },
      body: 'synthetic multipart body',
    });
    expect(photoUploadIsDisabled(request, false)).toBe(true);
    expect(photoUploadIsDisabled(request, true)).toBe(false);
    expect(photoUploadIsDisabled(new Request('https://local.test/profile', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }), false)).toBe(false);
  });
  it('accepts exactly the multipart body limit without Content-Length', async () => {
    const body = new Uint8Array(PROFILE_MULTIPART_BODY_MAX_BYTES);
    await expect(readBoundedBody(chunks([body]), PROFILE_MULTIPART_BODY_MAX_BYTES, null)).resolves.toHaveLength(body.length);
  });

  it('rejects a declared body above the limit before reading', async () => {
    await expect(readBoundedBody(chunks([]), 4, '5')).rejects.toMatchObject({ code: 'BODY_TOO_LARGE', status: 413 });
  });

  it('rejects a false Content-Length after checking actual streamed bytes', async () => {
    await expect(readBoundedBody(chunks([utf8('123456')]), 10, '3')).rejects.toMatchObject({ code: 'BODY_MALFORMED', status: 400 });
  });

  it('rejects chunked input as soon as accumulated bytes cross the cap', async () => {
    await expect(readBoundedBody(chunks([utf8('123'), utf8('456')]), 5, null))
      .rejects.toMatchObject({ code: 'BODY_TOO_LARGE', status: 413 });
  });

  it('bounds pathological tiny-chunk counts even below the byte cap', async () => {
    const many = new Uint8Array(4097);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < many.length; i++) controller.enqueue(many.subarray(i, i + 1));
        controller.close();
      },
    });
    await expect(readBoundedBody(body, 5000, null)).rejects.toMatchObject({ code: 'BODY_TOO_COMPLEX', status: 413 });
  });

  it('does not wait for an Edge request stream cancellation to settle', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(utf8('too large')); },
      cancel() { return new Promise<void>(() => {}); },
    });
    const started = performance.now();
    await expect(readBoundedBody(body, 2, null)).rejects.toMatchObject({ code: 'BODY_TOO_LARGE', status: 413 });
    expect(performance.now() - started).toBeLessThan(300);
  });

  it('returns 408 on a chunk idle timeout and initiates cancellation', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(utf8('partial')); },
      pull() { return new Promise<void>(() => {}); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    });
    const stages: string[] = [];
    const started = performance.now();
    await expect(readBoundedBody(body, 100, null, undefined, 500, (stage) => stages.push(stage), 10))
      .rejects.toMatchObject({ code: 'BODY_IDLE_TIMEOUT', status: 408 });
    expect(performance.now() - started).toBeLessThan(300);
    expect(cancelled).toBe(true);
    expect(stages).toContain('cancel_pending');
  });

  it('rejects malformed Content-Length values', async () => {
    await expect(readBoundedBody(chunks([]), 20, '1.5')).rejects.toMatchObject({ code: 'BODY_LENGTH_INVALID', status: 400 });
  });

  it('times out a stream that stops yielding bytes', async () => {
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    await expect(readBoundedBody(stalled, 10, null, undefined, 5))
      .rejects.toMatchObject({ code: 'BODY_TIMEOUT', status: 408 });
  });

  it('cancels an interrupted request', async () => {
    const controller = new AbortController();
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    const pending = readBoundedBody(stalled, 10, null, controller.signal, 1000);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'BODY_ABORTED', status: 400 });
  });

  it('rejects JSON that exceeds its smaller independent limit', async () => {
    const oversized = new Uint8Array(PROFILE_JSON_BODY_MAX_BYTES + 1);
    await expect(readBoundedBody(chunks([oversized]), PROFILE_JSON_BODY_MAX_BYTES, null))
      .rejects.toMatchObject({ code: 'BODY_TOO_LARGE', status: 413 });
  });

  it('parses a valid multipart request without trusting a file MIME header alone', async () => {
    const boundary = 'hanilog-test-boundary';
    const fields = ['action=save', 'petId=00000000-0000-4000-8000-000000000001', 'avatarId=dog-1', 'revision=0'];
    const prefix = fields.map((field) => {
      const [name, value] = field.split('=');
      return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    }).join('') + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fake.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`;
    const suffix = `\r\n--${boundary}--\r\n`;
    const prefixBytes = utf8(prefix);
    const suffixBytes = utf8(suffix);
    const body = new Uint8Array(prefixBytes.length + 3 + suffixBytes.length);
    body.set(prefixBytes);
    body.set([1, 2, 3], prefixBytes.length);
    body.set(suffixBytes, prefixBytes.length + 3);
    const request = new Request('https://local.test/profile', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const parsed = await parseBoundedProfileRequest(request);
    expect(parsed.file?.type).toBe('image/jpeg');
    expect(parsed.file?.size).toBe(3);
    // JPEG byte signature and decoding are validated later by the server image processor.
    expect(Array.from(new Uint8Array(await parsed.file!.arrayBuffer()))).not.toEqual([0xff, 0xd8, 0xff, 0xd9]);
  });

  it('rejects malformed multipart and unsupported media types', async () => {
    const malformed = new Request('https://local.test/profile', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=broken' },
      body: 'not a multipart body',
    });
    await expect(parseBoundedProfileRequest(malformed)).rejects.toMatchObject({ code: 'BODY_MALFORMED' });
    const unsupported = new Request('https://local.test/profile', { method: 'POST', body: 'x' });
    await expect(parseBoundedProfileRequest(unsupported)).rejects.toMatchObject({ code: 'CONTENT_TYPE_UNSUPPORTED', status: 415 });
  });

  it('rejects an incomplete multipart body after bounded receipt', async () => {
    const boundary = 'incomplete';
    const request = new Request('https://local.test/profile', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: `--${boundary}\r\nContent-Disposition: form-data; name="action"\r\nsave`,
    });
    await expect(parseBoundedProfileRequest(request)).rejects.toMatchObject({ code: 'BODY_MALFORMED', status: 400 });
  });
});
