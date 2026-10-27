import { describe, expect, it } from 'vitest';
import { authCallbackPurpose, authFailureMessage, authLinkErrorMessage, authRedirectTo } from './auth-redirect';

describe('Auth callback URLs', () => {
  it('uses the live HTTPS origin and dynamic port without HashRouter fragments', () => {
    expect(authRedirectTo('confirm', 'https://localhost:7404')).toBe('https://localhost:7404/?auth_callback=confirm');
    expect(authRedirectTo('recovery', 'https://127.0.0.1:10529')).toBe('https://127.0.0.1:10529/?auth_callback=recovery');
    expect(authRedirectTo('confirm', 'https://perfumerlee.github.io', '/hanilog/'))
      .toBe('https://perfumerlee.github.io/hanilog/?auth_callback=confirm');
  });

  it('recognizes only known callback purposes', () => {
    expect(authCallbackPurpose('?auth_callback=recovery&code=synthetic')).toBe('recovery');
    expect(authCallbackPurpose('?auth_callback=unexpected')).toBeNull();
  });

  it('shows a safe resend message for expired or already-used links', () => {
    const message = authLinkErrorMessage('https://localhost:7404/#error=access_denied&error_code=otp_expired&error_description=private');
    expect(message).toContain('새 인증 메일');
    expect(message).not.toContain('private');
    expect(authLinkErrorMessage('https://localhost:7404/?error_code=otp_expired')).toContain('새 인증 메일');
    expect(authLinkErrorMessage('https://localhost:7404/#/login?error_code=otp_expired')).toContain('새 인증 메일');
    expect(authFailureMessage({ code: 'otp_expired' })).toContain('새 링크');
  });

  it('does not show provider error text or credentials', () => {
    expect(authFailureMessage(new Error('token=synthetic-secret'))).not.toContain('synthetic-secret');
  });
});
