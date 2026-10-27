import { describe, expect, it } from 'vitest';
import { effectiveGlucoseValue, inPeriod, localDateKey, longGaps, measuredLineSegments, mgDlSamples, monthlyCounts,
  sortSamples, trendLineSegments, trendPoints, type GlucoseSample } from './health-trends';

function sample(id: string, occurredAt: string, value = 150, unit: string | null = 'mg/dL'): GlucoseSample {
  return { id, occurredAt, recordedAt: occurredAt, value, unit, actorId: 'synthetic-user', performerId: 'synthetic-user' };
}

describe('health trend data handling', () => {
  it('sorts reverse input, preserves same-day and same-instant measurements as separate samples', () => {
    const result = sortSamples([
      sample('later', '2026-10-23T10:00:00+09:00'),
      sample('same-time-b', '2026-10-23T09:00:00+09:00', 155),
      sample('same-time-a', '2026-10-23T09:00:00+09:00', 149),
    ]);
    expect(result.map((item) => item.id)).toEqual(['same-time-a', 'same-time-b', 'later']);
  });

  it('filters mg/dL without converting incompatible legacy units and removes voided corrections', () => {
    const result = mgDlSamples([
      sample('legacy', '2026-01-01T00:00:00Z', 8.2, 'mmol/L'),
      { ...sample('void', '2026-01-02T00:00:00Z'), revisionKind: 'VOID' },
      sample('valid', '2026-01-03T00:00:00Z'),
    ]);
    expect(result.valid.map((item) => item.id)).toEqual(['valid']);
    expect(result.excluded.map((item) => item.id)).toEqual(['legacy']);
    expect(result.excluded[0].value).toBe(8.2);
  });

  it('applies the latest correction value without changing the original event', () => {
    const original = { observed_value: 151, note: 'synthetic' };
    expect(effectiveGlucoseValue(original, { observed_value: 154 })).toBe(154);
    expect(effectiveGlucoseValue(original, { value: { observed_value: 155 } })).toBe(155);
    expect(original.observed_value).toBe(151);
  });

  it('uses real timestamps for range membership and leaves unmeasured gaps empty', () => {
    const now = new Date('2026-10-24T00:00:00Z');
    const records = [sample('old', '2026-07-01T00:00:00Z'), sample('recent', '2026-10-20T00:00:00Z')];
    expect(inPeriod(records, '90d', now).map((item) => item.id)).toEqual(['recent']);
    expect(longGaps(records, 30)).toEqual([{ from: records[0].occurredAt, to: records[1].occurredAt, days: 111 }]);
  });

  it('counts actual monthly measurements with the pet timezone across a UTC date boundary', () => {
    const records = [sample('a', '2026-09-30T15:30:00Z'), sample('b', '2026-09-30T16:00:00Z'), sample('c', '2026-10-02T01:00:00Z')];
    expect(monthlyCounts(records, 'Asia/Seoul')).toEqual([{ month: '2026-10', count: 3 }]);
    expect(localDateKey('2026-09-30T15:30:00Z', 'Asia/Seoul')).toBe('2026-10-01');
  });

  it('handles 90 daily samples, 15-day and monthly cadence, 3+ month gaps, and 1,000 samples', () => {
    const start = Date.parse('2026-01-01T00:00:00Z');
    const daily = Array.from({ length: 90 }, (_, index) => sample(`d${index}`, new Date(start + index * 86_400_000).toISOString()));
    const fortnightly = Array.from({ length: 8 }, (_, index) => sample(`f${index}`, new Date(start + index * 15 * 86_400_000).toISOString()));
    const monthly = Array.from({ length: 12 }, (_, index) => sample(`m${index}`, new Date(Date.UTC(2026, index, 15)).toISOString()));
    const large = Array.from({ length: 1000 }, (_, index) => sample(`l${index}`, new Date(start + index * 60_000).toISOString()));
    expect(daily).toHaveLength(90);
    expect(longGaps(fortnightly, 14)).toHaveLength(7);
    expect(monthlyCounts(monthly, 'UTC')).toHaveLength(12);
    expect(longGaps([monthly[0], monthly[11]], 90)[0].days).toBeGreaterThan(300);
    expect(sortSamples([...large].reverse())).toHaveLength(1000);
  });

  it('connects actual daily measurements with straight segments and breaks long gaps', () => {
    const daily = Array.from({ length: 90 }, (_, index) => sample(`d${index}`, new Date(Date.parse('2026-01-01T00:00:00Z') + index * 86_400_000).toISOString(), 100 + index));
    const withMissingDays = daily.filter((_, index) => !(index >= 30 && index <= 37) && index !== 70);
    const segments = measuredLineSegments(withMissingDays);
    expect(segments.flat().map((item) => item.id)).toEqual(withMissingDays.map((item) => item.id));
    expect(segments.every((segment) => segment.length > 1)).toBe(true);
    expect(segments.some((segment) => segment.some((item) => item.id === 'd29')
      && segment.some((item) => item.id === 'd38'))).toBe(false);
    expect(measuredLineSegments(daily).every((segment) => segment.length > 1)).toBe(true);
  });

  it('keeps fortnightly and monthly measurements as independent observed points', () => {
    const start = Date.parse('2026-01-01T00:00:00Z');
    const fortnightly = Array.from({ length: 8 }, (_, index) => sample(`f${index}`, new Date(start + index * 15 * 86_400_000).toISOString()));
    const monthly = Array.from({ length: 6 }, (_, index) => sample(`m${index}`, new Date(Date.UTC(2026, index, 15)).toISOString()));
    expect(measuredLineSegments(fortnightly).every((segment) => segment.length === 1)).toBe(true);
    expect(measuredLineSegments(monthly).every((segment) => segment.length === 1)).toBe(true);
    expect(measuredLineSegments([sample('before', '2026-01-01T00:00:00Z'), sample('after', '2026-05-02T00:00:00Z')]))
      .toEqual([[expect.objectContaining({ id: 'before' })], [expect.objectContaining({ id: 'after' })]]);
  });

  it('uses seven-day median buckets and suppresses trend when fewer than three buckets exist', () => {
    const daily = Array.from({ length: 90 }, (_, index) => sample(`d${index}`, new Date(Date.parse('2026-01-01T00:00:00Z') + index * 86_400_000).toISOString(), 100 + index));
    const trend = trendPoints(daily, '90d', 'UTC');
    expect(trend.length).toBeGreaterThanOrEqual(12);
    expect(trend.reduce((sum, point) => sum + point.count, 0)).toBe(90);
    expect(trend[0].value).toBe(103);
    expect(trendLineSegments(trend, '90d').flat()).toHaveLength(trend.length);
    expect(trendPoints(daily.slice(0, 14), '90d', 'UTC')).toEqual([]);
  });

  it('uses Pet-local monthly medians, respects gaps, and leaves duplicate instants as real samples', () => {
    const monthly = Array.from({ length: 12 }, (_, index) => sample(`m${index}`, new Date(Date.UTC(2026, index, 15)).toISOString(), 120 + index));
    const trend = trendPoints(monthly, 'all', 'Asia/Seoul');
    expect(trend).toHaveLength(12);
    expect(trend.every((point) => point.count === 1)).toBe(true);
    expect(trendLineSegments(trend, 'all')).toHaveLength(1);
    const sparse = [monthly[0], monthly[1], monthly[7], monthly[8], monthly[9]];
    expect(trendLineSegments(trendPoints(sparse, 'all', 'UTC'), 'all').length).toBeGreaterThan(1);
    const duplicates = [sample('same-a', '2026-10-01T00:00:00Z', 140), sample('same-b', '2026-10-01T00:00:00Z', 160), ...monthly];
    expect(sortSamples(duplicates).filter((item) => item.occurredAt === '2026-10-01T00:00:00Z')).toHaveLength(2);
  });

  it('does not create derived values for incompatible units or voided samples', () => {
    const incompatible = [sample('a', '2026-01-01T00:00:00Z', 8.2, 'mmol/L'), sample('b', '2026-01-08T00:00:00Z', 8.4, 'mmol/L'), sample('c', '2026-01-15T00:00:00Z', 8.6, 'mmol/L')];
    expect(trendPoints(mgDlSamples(incompatible).valid, '30d', 'UTC')).toEqual([]);
    const voided = incompatible.map((item) => ({ ...item, unit: 'mg/dL', revisionKind: 'VOID' as const }));
    expect(mgDlSamples(voided).valid).toEqual([]);
  });
});
