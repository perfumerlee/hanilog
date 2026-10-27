import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const demoBuild = import.meta.env.MODE === 'demo' || import.meta.env.VITE_DEMO_MODE === 'true';
const stagingBuild = import.meta.env.MODE === 'staging';
const stagingUrl = 'https://vxgdewxqtbuychrvunjr.supabase.co';

function isServerSecret(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true;
  const tokenParts = key.split('.');
  if (tokenParts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(tokenParts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

const wrongStagingUrl = stagingBuild && Boolean(url) && url !== stagingUrl;
const forbiddenBrowserKey = Boolean(publishableKey) && isServerSecret(publishableKey);

export const supabaseConfigurationError = demoBuild ? ''
  : wrongStagingUrl ? 'Staging 빌드 대상 URL이 승인된 hanilog-staging 프로젝트와 일치하지 않습니다.'
    : forbiddenBrowserKey ? '서버 비밀키는 브라우저에서 사용할 수 없습니다. Publishable Key만 설정해 주세요.'
      : '';

export const supabase = !demoBuild && !supabaseConfigurationError && url && publishableKey
  ? createClient(url, publishableKey, {
    auth: {
      flowType: 'pkce',
      detectSessionInUrl: true,
    },
  })
  : null;
export const isSupabaseConfigured = Boolean(supabase);

export function userFacingError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return '요청을 완료하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.';
}
