import { describe, expect, it } from 'vitest';
import { formatGlucoseValue, GLUCOSE_MEASUREMENT_CONDITIONS, GLUCOSE_UNIT, glucoseMeasurementConditionLabel,
  validateEventEntry, type EventEntryFields } from './event-entry';

const base: EventEntryFields = {
  eventType: 'insulin',
  occurredLocal: '2026-01-01T09:30',
  note: '',
  numericValue: '',
  unit: '',
  mealStatus: '',
  eliminationType: '',
  description: '',
};

describe('health event form validation', () => {
  it('requires and stores the actually reported insulin amount in U', () => {
    expect(validateEventEntry(base).error).toContain('0보다 큰 U 값');
    const result = validateEventEntry({ ...base, doseAmount: '2.5', doseUnit: 'U',
      insulinProductLabel: '합성 제품명' });
    expect(result.value?.value).toMatchObject({
      administered_dose_value: 2.5, administered_dose_unit: 'U', insulin_product_label: '합성 제품명',
    });
  });

  it('requires a positive insulin dose, the U unit and a product label', () => {
    expect(validateEventEntry({ ...base, doseUnit: 'U' }).error).toContain('0보다 큰 U 값');
    expect(validateEventEntry({ ...base, doseAmount: '2', doseUnit: '' }).error).toContain('단위는 U');
    expect(validateEventEntry({ ...base, doseAmount: '2', doseUnit: 'U' }).error).toContain('제품');
    expect(validateEventEntry({ ...base, doseAmount: '0', doseUnit: 'U', insulinProductLabel: '합성' }).error).toContain('0보다 큰 U 값');
    expect(validateEventEntry({ ...base, doseAmount: '-2', doseUnit: 'U', insulinProductLabel: '합성' }).error).toContain('0보다 큰 U 값');
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

  it('supports exercise context without translating or interpreting it as a clinical rule', () => {
    for (const condition of GLUCOSE_MEASUREMENT_CONDITIONS.filter((item) => item.value.includes('EXERCISE'))) {
      const result = validateEventEntry({ ...base, eventType: 'glucose', numericValue: '150', measurementCondition: condition.value });
      expect(result.value?.value.measurement_condition).toBe(condition.value);
      expect(glucoseMeasurementConditionLabel(condition.value)).toBe(condition.label);
    }
    expect(glucoseMeasurementConditionLabel(undefined)).toBe('미기록');
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
