import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('Supabase environment separation', () => {
  it('keeps Demo disconnected even if Supabase credentials are present', async () => {
    vi.stubEnv('MODE', 'demo');
    vi.stubEnv('VITE_DEMO_MODE', 'true');
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_synthetic_test_key');

    const { isSupabaseConfigured, supabase } = await import('./supabase');

    expect(supabase).toBeNull();
    expect(isSupabaseConfigured).toBe(false);
  });

  it('rejects a server secret without printing the supplied value', async () => {
    vi.stubEnv('MODE', 'staging');
    vi.stubEnv('VITE_DEMO_MODE', 'false');
    vi.stubEnv('VITE_SUPABASE_URL', 'https://vxgdewxqtbuychrvunjr.supabase.co');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_secret_synthetic_test_only');

    const { isSupabaseConfigured, supabase, supabaseConfigurationError } = await import('./supabase');

    expect(supabase).toBeNull();
    expect(isSupabaseConfigured).toBe(false);
    expect(supabaseConfigurationError).toContain('서버 비밀키');
    expect(supabaseConfigurationError).not.toContain('sb_secret_synthetic_test_only');
  });

  it('rejects a Staging URL that does not match the approved project', async () => {
    vi.stubEnv('MODE', 'staging');
    vi.stubEnv('VITE_DEMO_MODE', 'false');
    vi.stubEnv('VITE_SUPABASE_URL', 'https://other-project.supabase.co');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_synthetic_test_key');

    const { isSupabaseConfigured, supabase, supabaseConfigurationError } = await import('./supabase');

    expect(supabase).toBeNull();
    expect(isSupabaseConfigured).toBe(false);
    expect(supabaseConfigurationError).toContain('hanilog-staging');
  });
});

it('rejects Staging in a Production build', async () => {
  vi.stubEnv('MODE', 'production');
  vi.stubEnv('VITE_DEMO_MODE', 'false');
  vi.stubEnv('VITE_SUPABASE_URL', 'https://vxgdewxqtbuychrvunjr.supabase.co');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_synthetic');
  const { supabase, supabaseConfigurationError } = await import('./supabase');
  expect(supabase).toBeNull();
  expect(supabaseConfigurationError).toContain('hanilog-production');
});
