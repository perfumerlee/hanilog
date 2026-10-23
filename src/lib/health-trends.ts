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
