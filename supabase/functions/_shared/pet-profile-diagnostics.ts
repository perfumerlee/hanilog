export type ProfileStage = 'auth' | 'body' | 'permission' | 'profile_read' | 'image' | 'upload' | 'save' | 'enqueue' | 'cleanup_claim' | 'cleanup_read' | 'cleanup_remove' | 'cleanup_finish';

/** Only timings and fixed error codes leave the function; never request data or exceptions. */
export function createProfileDiagnostics(now: () => number = () => performance.now()) {
  const started = now();
  const timings: Partial<Record<ProfileStage, number>> = {};
  return {
    async measure<T>(stage: ProfileStage, operation: () => T | Promise<T>): Promise<T> {
      const start = now();
      try { return await operation(); }
      finally { timings[stage] = (timings[stage] ?? 0) + Math.round(now() - start); }
    },
    summary(status: number, code: unknown) {
      return {
        event: 'profile_request_finished', status,
        code: typeof code === 'string' && /^(PROFILE_|PET_PROFILE_|AUTH_|BODY_)[A-Z_]+$/.test(code) ? code : null,
        duration_ms: Math.round(now() - started), stages_ms: { ...timings },
      };
    },
  };
}

export function profileSaveFailure(code?: string): { status: number; error: string } {
  // Legacy compatibility while migration/function are deployed in sequence.
  if (code === 'PT409' || code === '40001') return { status: 409, error: 'PROFILE_VERSION_CONFLICT' };
  if (code === '42501') return { status: 403, error: 'PET_PROFILE_ACCESS_DENIED' };
  return { status: 503, error: 'PROFILE_SAVE_FAILED' };
}
