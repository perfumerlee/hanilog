import { describe, expect, it } from 'vitest';
import { createProfileDiagnostics, profileSaveFailure } from './pet-profile-diagnostics';

describe('profile diagnostics and retry classification', () => {
  it('returns an application conflict without retrying and keeps permissions distinct', () => {
    expect(profileSaveFailure('PT409')).toEqual({ status: 409, error: 'PROFILE_VERSION_CONFLICT' });
    expect(profileSaveFailure('40001').status).toBe(409);
    expect(profileSaveFailure('42501').status).toBe(403);
    expect(profileSaveFailure('NETWORK_ERROR').status).toBe(503);
  });
  it('records failed stage duration without exposing exceptions or caller content', async () => {
    let time = 0;
    const trace = createProfileDiagnostics(() => time);
    await expect(trace.measure('save', async () => { time = 12; throw new Error('private payload'); })).rejects.toThrow();
    const summary = trace.summary(503, 'secret-token-with-user-data');
    expect(summary).toEqual({ event: 'profile_request_finished', status: 503, code: null, duration_ms: 12, stages_ms: { save: 12 } });
    expect(JSON.stringify(summary)).not.toContain('private payload');
  });
});
