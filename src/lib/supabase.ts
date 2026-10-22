import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabase = url && publishableKey ? createClient(url, publishableKey) : null;
export const isSupabaseConfigured = Boolean(supabase);

export function userFacingError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return '요청을 완료하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.';
}
