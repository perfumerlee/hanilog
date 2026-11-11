import type { SupabaseClient } from '@supabase/supabase-js';

export type GlucoseShareRange = {
  id: string;
  from_date: string;
  to_date: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  include_care_times: boolean;
  include_care_values?: boolean;
  include_symptoms?: boolean;
  guardian_contact_phone?: string | null;
};
export type GlucoseSharePayload = {
  pet_name: string;
  timezone: string;
  from_date: string;
  to_date: string;
  created_at: string;
  expires_at: string;
  guardian_contact_phone?: string | null;
  target_range: null | { lower_mg_dl: number; upper_mg_dl: number; source_label: string; effective_on: string };
  include_care_values?: boolean;
  include_symptoms?: boolean;
  weights?: import('./weight-trends').WeightEvent[];
  weight_target_kg?: number | null;
  measurements: { id: string; occurred_at: string; recorded_at: string; value: Record<string, unknown>; unit: string; revision_kind: string | null }[];
  care_times: { event_type: 'meal' | 'insulin'; occurred_at: string; amount?: number | null; unit?: string | null; detail?: string | null; product_label?: string | null }[];
  symptom_records?: { id: string; occurred_at: string; note?: string | null; revision_kind?: string | null }[];
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

/** Converts common Korean mobile/landline input to E.164; rejects ambiguous values. */
export function normalizeGuardianPhone(value: string): string | null {
  const compact = value.trim().replace(/[\s()-]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  const digits = compact.replace(/\D/g, '');
  if (/^0\d{8,10}$/.test(digits)) return `+82${digits.slice(1)}`;
  return null;
}

export async function callGlucoseShare<T>(client: SupabaseClient, body: Record<string, unknown>): Promise<T> {
  const isPublicAction = body.action === 'resolve' || body.action === 'photo';
  let headers: Record<string, string> | undefined;
  if (!isPublicAction) {
    // Resolve the current session explicitly. Functions.invoke normally adds the
    // stored token, but a stale page can otherwise send an expired/missing bearer.
    let { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError || !sessionData.session) {
      const refreshed = await client.auth.refreshSession();
      sessionData = refreshed.data;
      sessionError = refreshed.error;
    } else if (sessionData.session.expires_at && sessionData.session.expires_at * 1000 <= Date.now() + 30_000) {
      const refreshed = await client.auth.refreshSession();
      sessionData = refreshed.data;
      sessionError = refreshed.error;
    }
    const accessToken = sessionData.session?.access_token;
    if (sessionError || !accessToken) throw new GlucoseShareRequestError('UNAUTHENTICATED', 401);
    headers = { Authorization: `Bearer ${accessToken}` };
  }

  let result = await client.functions.invoke('glucose-share', { body, headers });
  if (!isPublicAction && result.error && result.error.context instanceof Response && result.error.context.status === 401) {
    // A long-lived app tab may hold a revoked/stale token even when the local
    // session still looks present. Refresh once, then retry the same operation.
    const refreshed = await client.auth.refreshSession();
    const refreshedToken = refreshed.data.session?.access_token;
    if (!refreshed.error && refreshedToken) {
      result = await client.functions.invoke('glucose-share', {
        body,
        headers: { Authorization: `Bearer ${refreshedToken}` },
      });
    }
  }
  const { data, error } = result;
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
