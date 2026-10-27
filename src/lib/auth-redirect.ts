export type AuthCallbackPurpose = 'confirm' | 'recovery';

export function authRedirectTo(
  purpose: AuthCallbackPurpose,
  origin = window.location.origin,
  basePath = import.meta.env.BASE_URL,
): string {
  const url = new URL(origin);
  url.pathname = `/${basePath.replace(/^\/+|\/+$/g, '')}${basePath.replace(/^\/+|\/+$/g, '') ? '/' : ''}`;
  url.search = '';
  url.hash = '';
  url.searchParams.set('auth_callback', purpose);
  return url.toString();
}

export function authCallbackPurpose(search: string): AuthCallbackPurpose | null {
  const purpose = new URLSearchParams(search).get('auth_callback');
  return purpose === 'confirm' || purpose === 'recovery' ? purpose : null;
}

export function authLinkErrorMessage(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  const rawHash = url.hash.slice(1);
  const hash = rawHash.startsWith('/') ? rawHash.slice(rawHash.indexOf('?') + 1) : rawHash;
  const params = [url.searchParams, new URLSearchParams(hash)];
  const code = params.map((item) => item.get('error_code') || item.get('error')).find(Boolean);

  if (code === 'otp_expired' || code === 'flow_state_expired') {
    return '인증 링크가 만료되었거나 이미 사용되었습니다. 새 인증 메일을 요청하고, 같은 브라우저에서 새 링크를 한 번만 열어 주세요.';
  }
  if (code) {
    return '인증 링크를 확인할 수 없습니다. 새 인증 메일을 요청하거나 비밀번호 재설정을 다시 시작해 주세요.';
  }
  return null;
}

export function authFailureMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';
  if (code === 'otp_expired' || code === 'flow_state_expired') {
    return '인증 링크가 만료되었거나 이미 사용되었습니다. 새 링크를 요청해 주세요.';
  }
  return '인증 요청을 완료하지 못했습니다. 연결과 입력 내용을 확인한 뒤 다시 시도해 주세요.';
}
