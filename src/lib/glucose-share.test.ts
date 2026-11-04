import { describe, expect, it, vi } from 'vitest';
import { callGlucoseShare } from './glucose-share';
import type { SupabaseClient } from '@supabase/supabase-js';

const clientWithError = (status: number, errorCode?: string) => ({
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
