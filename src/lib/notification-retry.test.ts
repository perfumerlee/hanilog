import { describe, expect, it } from 'vitest';
import { classifyResendResponse, parseRetryAfter, retryDelaySeconds } from '../../supabase/functions/_shared/notification-retry';

describe('notification retry policy', () => {
  it('parses Retry-After seconds and HTTP dates without exceeding the expiry window', () => {
    expect(parseRetryAfter('17')).toBe(17);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:01:00 GMT', 0)).toBe(60);
    expect(parseRetryAfter('999999')).toBe(86400);
    expect(parseRetryAfter('invalid')).toBeNull();
  });

  it('uses bounded exponential backoff with jitter and honors a longer Retry-After', () => {
    expect(retryDelaySeconds(2, null, () => 0)).toBe(120);
    expect(retryDelaySeconds(2, null, () => 0.99)).toBe(143);
    expect(retryDelaySeconds(0, 90, () => 0)).toBe(90);
    expect(retryDelaySeconds(10, 200000, () => 0)).toBe(86400);
  });

  it('treats 429, timeout, and server errors as retryable while rejecting ordinary client errors', () => {
    expect(classifyResendResponse(429)).toBe('RETRYABLE');
    expect(classifyResendResponse(408)).toBe('RETRYABLE');
    expect(classifyResendResponse(503)).toBe('RETRYABLE');
    expect(classifyResendResponse(422)).toBe('PERMANENT');
  });
});
