import { describe, expect, it, vi } from 'vitest';
import { callGlucoseShare, normalizeGuardianPhone } from './glucose-share';
import type { SupabaseClient } from '@supabase/supabase-js';

const clientWithError = (status: number, errorCode?: string) => ({
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'synthetic-test-token', expires_at: 4_102_444_800 } }, error: null }),
    refreshSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
  },
  functions: { invoke: vi.fn().mockResolvedValue({
    data: null,
    error: { context: new Response(JSON.stringify(errorCode ? { error: errorCode } : { message: 'unavailable' }), { status }) },
  }) },
}) as unknown as SupabaseClient;

describe('glucose share errors', () => {
  it('distinguishes a missing deployed function from an expired share', async () => {
    await expect(callGlucoseShare(clientWithError(404), { action: 'create' }))
      .rejects.toMatchObject({ code: 'SHARE_FUNCTION_NOT_DEPLOYED', status: 404 });
  });

  it('preserves the safe schema-not-applied code returned by the function', async () => {
    await expect(callGlucoseShare(clientWithError(503, 'SHARE_SCHEMA_UNAVAILABLE'), { action: 'create' }))
      .rejects.toMatchObject({ code: 'SHARE_SCHEMA_UNAVAILABLE', status: 503 });
  });
});

describe('guardian contact phone', () => {
  it('normalizes Korean phone numbers to E.164', () => {
    expect(normalizeGuardianPhone('010-1234-5678')).toBe('+821012345678');
    expect(normalizeGuardianPhone('+1 (415) 555-2671')).toBe('+14155552671');
  });

  it('rejects incomplete or ambiguous phone numbers', () => {
    expect(normalizeGuardianPhone('1234')).toBeNull();
    expect(normalizeGuardianPhone('010-123-')).toBeNull();
  });
});
