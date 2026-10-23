const MAX_RETRY_SECONDS = 24 * 60 * 60;

export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.min(MAX_RETRY_SECONDS, Math.max(0, Math.ceil(Number(trimmed))));
  const retryAt = Date.parse(trimmed);
  if (!Number.isFinite(retryAt)) return null;
  return Math.min(MAX_RETRY_SECONDS, Math.max(0, Math.ceil((retryAt - nowMs) / 1000)));
}

export function retryDelaySeconds(attempt: number, retryAfterSeconds: number | null = null, random = Math.random): number {
  const backoff = Math.min(MAX_RETRY_SECONDS, 30 * 2 ** Math.min(Math.max(0, attempt), 10));
  const jitter = Math.floor(random() * Math.min(30, Math.max(1, Math.ceil(backoff * 0.2))));
  return Math.min(MAX_RETRY_SECONDS, retryAfterSeconds === null ? backoff + jitter : Math.max(backoff, retryAfterSeconds));
}

export function classifyResendResponse(status: number): 'RETRYABLE' | 'PERMANENT' {
  if (status === 408 || status === 429 || status >= 500) return 'RETRYABLE';
  return 'PERMANENT';
}
