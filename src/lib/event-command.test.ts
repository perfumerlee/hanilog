import { describe, expect, it, vi } from 'vitest';
import {
  createHealthEventCommand,
  eventSubmissionFailure,
  petAccessRefreshLabel,
  retryOrCreateHealthEventCommand,
  safetyResultLabel,
  safetyStatusLabel,
} from './event-command';

describe('health event commands', () => {
  it('creates a client idempotency key without changing the actual event fields', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'synthetic-idempotency-key' });
    const command = createHealthEventCommand({
      petId: 'synthetic-pet-id',
      eventType: 'insulin',
      occurredAt: '2026-01-01T00:00:00.000Z',
      occurrenceId: null,
      value: {},
      unit: null,
      clientTimezone: 'Asia/Seoul',
      performerId: null,
    });
    expect(command.idempotencyKey).toBe('synthetic-idempotency-key');
    expect(command.eventType).toBe('insulin');
    expect(command.value).toEqual({});
  });

  it('uses an explicit unverified label for unavailable server state', () => {
    expect(safetyStatusLabel('UNAVAILABLE')).toContain('최신 상태를 확인하지 못했습니다');
  });

  it('explains a missing meal record without asserting the meal was skipped', () => {
    expect(safetyResultLabel('MEAL_UNCONFIRMED')).toContain('실제 미실시를 뜻하지 않습니다');
  });

  it('labels a user configured routine order as nonclinical guidance', () => {
    const label = safetyResultLabel('ROUTINE_ORDER_UNCONFIRMED');
    expect(label).toContain('실제 미실시');
    expect(label).toContain('임상적 선행 조건을 뜻하지 않습니다');
  });

  it('shows a duplicate possibility as a warning after the event is stored', () => {
    expect(safetyResultLabel('DUPLICATE_POSSIBLE')).toContain('실제 발생 기록은 저장했습니다');
  });

  it('keeps permission errors separate from unverified server failures', () => {
    expect(eventSubmissionFailure('42501').kind).toBe('error');
    expect(eventSubmissionFailure('42501').text).toContain('접근권한');
    expect(eventSubmissionFailure('08006').kind).toBe('unverified');
    expect(eventSubmissionFailure('08006').text).toContain('UNVERIFIED');
  });

  it('describes access refresh without claiming an inaccessible Pet is still available', () => {
    expect(petAccessRefreshLabel()).toContain('접근 범위가 변경');
  });

  it('reuses the idempotency key only when a pending retry has the same payload', () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValueOnce('first-key').mockReturnValueOnce('new-key') });
    const input = { petId: 'pet', eventType: 'insulin' as const, occurredAt: '2026-01-01T00:00:00Z', occurrenceId: null, value: {}, unit: null, clientTimezone: 'Asia/Seoul', performerId: null };
    const first = createHealthEventCommand(input);
    expect(retryOrCreateHealthEventCommand(input, first).idempotencyKey).toBe('first-key');
    expect(retryOrCreateHealthEventCommand({ ...input, occurredAt: '2026-01-01T00:01:00Z' }, first).idempotencyKey).toBe('new-key');
  });
});
