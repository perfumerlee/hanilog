import type { SupabaseClient } from '@supabase/supabase-js';

export type GlucoseShareRange = {
  id: string;
  from_date: string;
  to_date: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  include_care_times: boolean;
};
export type GlucoseSharePayload = {
  pet_name: string;
  timezone: string;
  from_date: string;
  to_date: string;
  created_at: string;
  expires_at: string;
  target_range: null | { lower_mg_dl: number; upper_mg_dl: number; source_label: string; effective_on: string };
  measurements: { id: string; occurred_at: string; recorded_at: string; value: Record<string, unknown>; unit: string; revision_kind: string | null }[];
  care_times: { event_type: 'meal' | 'insulin'; occurred_at: string }[];
};
export type GlucoseShareAction = 'create' | 'list' | 'revoke' | 'resolve';

export class GlucoseShareRequestError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code);
    this.name = 'GlucoseShareRequestError';
  }
}

export function createShareToken(): { token: string; tokenHash: Promise<string> } {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const tokenHash = crypto.subtle.digest('SHA-256', bytes).then((digest) =>
    [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join(''));
  return { token, tokenHash };
}

export function glucoseShareUrl(token: string): string {
  const base = `${window.location.origin}${import.meta.env.BASE_URL}`;
  return `${base}#/glucose-share/${token}`;
}

export async function callGlucoseShare<T>(client: SupabaseClient, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.functions.invoke('glucose-share', { body });
  if (error) {
    const context = error.context;
    const status = context instanceof Response ? context.status : undefined;
    let responseCode: unknown;
    if (context instanceof Response) {
      try {
        const payload: unknown = await context.clone().json();
        if (payload && typeof payload === 'object' && 'error' in payload) responseCode = payload.error;
      } catch { /* A gateway error may not have a JSON response. */ }
    }
    const code = typeof responseCode === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(responseCode)
      ? responseCode
      : status === 404 ? 'SHARE_FUNCTION_NOT_DEPLOYED'
        : status && status >= 500 ? 'SHARE_SERVICE_UNAVAILABLE' : 'SHARE_REQUEST_FAILED';
    throw new GlucoseShareRequestError(code, status);
  }
  if (!data || typeof data !== 'object') throw new Error('GLUCOSE_SHARE_RESPONSE_INVALID');
  if (typeof data.error === 'string') throw new Error(data.error);
  return data as T;
}
