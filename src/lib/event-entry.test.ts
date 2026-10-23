import { describe, expect, it } from 'vitest';
import { formatGlucoseValue, GLUCOSE_UNIT, validateEventEntry, type EventEntryFields } from './event-entry';

const base: EventEntryFields = {
  eventType: 'insulin',
  occurredLocal: '2026-01-01T09:30',
  note: '',
  numericValue: '',
  unit: '',
  mealStatus: '',
  eliminationType: '',
  description: '',
  confirmedAlreadyOccurred: false,
};

describe('health event form validation', () => {
  it('requires an explicit confirmation that an insulin event already happened', () => {
    expect(validateEventEntry(base).error).toContain('이미 실제로 발생한 투여 사실');
    const result = validateEventEntry({ ...base, confirmedAlreadyOccurred: true });
    expect(result.value?.value).toEqual({});
    expect(result.value?.unit).toBeNull();
  });

  it('does not add or infer an insulin dose', () => {
    const result = validateEventEntry({ ...base, confirmedAlreadyOccurred: true, note: '합성 관찰 메모' });
    expect(result.value?.value).toEqual({ note: '합성 관찰 메모' });
    expect(JSON.stringify(result.value)).not.toMatch(/dose|용량/i);
  });

  it('requires a numeric glucose observation and fixes new measurements to mg/dL without thresholds', () => {
    expect(validateEventEntry({ ...base, eventType: 'glucose', numericValue: 'NaN' }).error).toContain('측정값');
    const result = validateEventEntry({ ...base, eventType: 'glucose', numericValue: '0', unit: 'synthetic-unit' });
    expect(result.value?.value.observed_value).toBe(0);
    expect(result.value?.unit).toBe(GLUCOSE_UNIT);
  });

  it('stores optional synthetic measurement source and condition as descriptive metadata', () => {
    const result = validateEventEntry({ ...base, eventType: 'glucose', numericValue: '150',
      measurementSource: '합성 기기', measurementCondition: 'BEFORE_MEAL' });
    expect(result.value?.value).toMatchObject({ observed_value: 150, measurement_source: '합성 기기', measurement_condition: 'BEFORE_MEAL' });
  });

  it('does not relabel legacy glucose values stored in another unit', () => {
    expect(formatGlucoseValue(8.2, 'mmol/L')).toContain('mmol/L');
    expect(formatGlucoseValue(8.2, 'mmol/L')).toContain('변환 안 됨');
    expect(formatGlucoseValue(164, 'mg/dL')).toBe('164 mg/dL');
  });

  it('requires a reported meal observation and keeps intake amount optional', () => {
    expect(validateEventEntry({ ...base, eventType: 'meal' }).error).toContain('식사 상태');
    const result = validateEventEntry({ ...base, eventType: 'meal', mealStatus: 'PARTIAL', numericValue: '12.5', unit: 'synthetic-unit' });
    expect(result.value?.value).toEqual({ meal_status: 'PARTIAL', observed_value: 12.5 });
  });

  it('keeps the actual occurrence instant in UTC and rejects invalid timestamps or overlong notes', () => {
    const result = validateEventEntry({ ...base, eventType: 'symptom', occurredLocal: '2026-01-01T09:30', description: '' });
    expect(result.value?.occurredAt).toMatch(/Z$/);
    expect(validateEventEntry({ ...base, occurredLocal: 'not-a-date' }).error).toContain('발생 시각');
    expect(validateEventEntry({ ...base, note: 'x'.repeat(1001) }).error).toContain('1,000자');
  });
});
