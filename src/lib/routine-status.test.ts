import { describe, expect, it } from 'vitest';
import { routineDisplayStatus } from './routine-status';

const now = Date.parse('2026-10-24T03:00:00Z');

describe('Care Routine display status', () => {
  it('separates a future scheduled occurrence from missing records', () => {
    expect(routineDisplayStatus({ hasRecord: false, occurrenceStatus: 'SCHEDULED', scheduledAt: '2026-10-24T04:00:00Z', now })).toBe('scheduled');
    expect(routineDisplayStatus({ hasRecord: false, occurrenceStatus: 'SCHEDULED', scheduledAt: '2026-10-24T02:00:00Z', now })).toBe('unconfirmed');
  });

  it('distinguishes a completed record and a reported exception', () => {
    expect(routineDisplayStatus({ hasRecord: true, occurrenceStatus: 'SCHEDULED', scheduledAt: null, now })).toBe('recorded');
    expect(routineDisplayStatus({ hasRecord: true, exceptionReported: true, occurrenceStatus: 'SCHEDULED', scheduledAt: null, now })).toBe('exception');
  });

  it('does not imply non-performance when a schedule time is unresolved', () => {
    expect(routineDisplayStatus({ hasRecord: false, occurrenceStatus: 'SCHEDULE_TIME_UNRESOLVED', scheduledAt: null, now })).toBe('time_unresolved');
  });
});
