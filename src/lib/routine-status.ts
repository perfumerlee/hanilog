export type RoutineDisplayStatus = 'recorded' | 'exception' | 'scheduled' | 'unconfirmed' | 'cancelled' | 'superseded' | 'time_unresolved';

export function routineDisplayStatus(input: {
  hasRecord: boolean;
  exceptionReported?: boolean;
  occurrenceStatus: string;
  scheduledAt: string | null;
  now: number;
}): RoutineDisplayStatus {
  if (input.hasRecord) return input.exceptionReported ? 'exception' : 'recorded';
  if (input.occurrenceStatus === 'CANCELLED') return 'cancelled';
  if (input.occurrenceStatus === 'SUPERSEDED') return 'superseded';
  if (input.occurrenceStatus === 'SCHEDULE_TIME_UNRESOLVED' || !input.scheduledAt) return 'time_unresolved';
  if (input.occurrenceStatus === 'SCHEDULED' && Date.parse(input.scheduledAt) > input.now) return 'scheduled';
  return 'unconfirmed';
}
