export type GlucoseSample = {
  id: string;
  occurredAt: string;
  recordedAt: string;
  value: number | string;
  unit: string | null;
  source?: string;
  condition?: string;
  performerId?: string | null;
  actorId?: string;
  note?: string;
  revisionKind?: 'CORRECT' | 'VOID';
};

export type TrendPeriod = '7d' | '30d' | '90d' | '1y' | 'all';
export type NumericGlucoseSample = Omit<GlucoseSample, 'value'> & { value: number };
export type TrendPoint = { occurredAt: string; value: number; count: number };

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** Connect only observed values no more than seven elapsed days apart. */
export function measuredLineSegments<T extends GlucoseSample>(samples: T[], maximumGapDays = 7): T[][] {
  const sorted = sortSamples(samples);
  const segments: T[][] = [];
  let segment: T[] = [];
  for (const sample of sorted) {
    const previous = segment.at(-1);
    if (previous && (Date.parse(sample.occurredAt) - Date.parse(previous.occurredAt)) / DAY_MS > maximumGapDays) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    segment.push(sample);
  }
  if (segment.length) segments.push(segment);
  return segments;
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

/**
 * Build time-based median summaries. Short views use elapsed seven-day buckets;
 * year/all views use the Pet-local calendar month. Empty buckets stay absent.
 */
export function trendPoints<T extends GlucoseSample>(samples: T[], period: TrendPeriod, timezone: string): TrendPoint[] {
  const sorted = sortSamples(samples).filter((sample) => Number.isFinite(Number(sample.value)));
  if (sorted.length < 3) return [];
  const monthly = period === '1y' || period === 'all';
  const anchor = Date.parse(sorted[0].occurredAt);
  const buckets = new Map<string, T[]>();
  for (const sample of sorted) {
    const key = monthly
      ? localDateKey(sample.occurredAt, timezone).slice(0, 7)
      : String(Math.floor((Date.parse(sample.occurredAt) - anchor) / WEEK_MS));
    const bucket = buckets.get(key) ?? [];
    bucket.push(sample);
    buckets.set(key, bucket);
  }
  const points = [...buckets.values()].map((bucket) => {
    const value = median(bucket.map((sample) => Number(sample.value)));
    const occurredAt = median(bucket.map((sample) => Date.parse(sample.occurredAt)));
    return { occurredAt: new Date(occurredAt).toISOString(), value, count: bucket.length };
  }).sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  return points.length >= 3 ? points : [];
}

/** Split derived summaries at missing time intervals; never bridge long gaps. */
export function trendLineSegments(points: TrendPoint[], period: TrendPeriod): TrendPoint[][] {
  const maximumGapDays = period === '1y' || period === 'all' ? 45 : 10;
  const segments: TrendPoint[][] = [];
  let segment: TrendPoint[] = [];
  for (const point of points) {
    const previous = segment.at(-1);
    if (previous && (Date.parse(point.occurredAt) - Date.parse(previous.occurredAt)) / DAY_MS > maximumGapDays) {
      if (segment.length >= 2) segments.push(segment);
      segment = [];
    }
    segment.push(point);
  }
  if (segment.length >= 2) segments.push(segment);
  return segments;
}

export function effectiveGlucoseValue(value: Record<string, unknown>, patch?: Record<string, unknown>): unknown {
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'observed_value')) return patch.observed_value;
  const changed = patch?.value;
  if (changed && typeof changed === 'object' && !Array.isArray(changed)) {
    return (changed as Record<string, unknown>).observed_value;
  }
  return typeof changed === 'number' || typeof changed === 'string' ? changed : value.observed_value;
}

export function sortSamples<T extends GlucoseSample>(samples: T[]): T[] {
  return [...samples].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt)
    || a.id.localeCompare(b.id));
}

export function mgDlSamples(samples: GlucoseSample[]) {
  const valid: NumericGlucoseSample[] = [];
  const excluded: GlucoseSample[] = [];
  for (const sample of samples) {
    const parsed = typeof sample.value === 'number' ? sample.value : sample.value.trim() ? Number(sample.value) : Number.NaN;
    if (sample.revisionKind === 'VOID') continue;
    if (sample.unit !== 'mg/dL' || !Number.isFinite(parsed)) excluded.push(sample);
    else valid.push({ ...sample, value: parsed });
  }
  return { valid: sortSamples(valid), excluded: sortSamples(excluded) };
}

export function periodStart(period: TrendPeriod, now: Date, samples: GlucoseSample[]): number | null {
  const end = now.getTime();
  if (period === 'all') return samples.length ? Date.parse(samples[0].occurredAt) : end - 365 * 86_400_000;
  const days = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : 365;
  return end - days * 86_400_000;
}

export function inPeriod<T extends GlucoseSample>(samples: T[], period: TrendPeriod, now: Date): T[] {
  const start = periodStart(period, now, samples);
  if (start === null) return [];
  return samples.filter((sample) => {
    const instant = Date.parse(sample.occurredAt);
    return instant >= start && instant <= now.getTime();
  });
}

export function localDateKey(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function monthlyCounts(samples: GlucoseSample[], timezone: string): { month: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const sample of samples) {
    const month = localDateKey(sample.occurredAt, timezone).slice(0, 7);
    counts.set(month, (counts.get(month) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([month, count]) => ({ month, count }));
}

export function longGaps(samples: GlucoseSample[], minimumDays: number): { from: string; to: string; days: number }[] {
  const sorted = sortSamples(samples);
  const gaps: { from: string; to: string; days: number }[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const days = (Date.parse(sorted[index].occurredAt) - Date.parse(sorted[index - 1].occurredAt)) / 86_400_000;
    if (days >= minimumDays) gaps.push({ from: sorted[index - 1].occurredAt, to: sorted[index].occurredAt, days: Math.floor(days) });
  }
  return gaps;
}
