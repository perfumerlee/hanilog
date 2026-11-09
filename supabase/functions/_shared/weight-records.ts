export type WeightEvent = { id: string; event_type: string; occurred_at: string; value: Record<string, unknown>; unit: string | null };
export type WeightRevision = { event_id: string; revision_no: number; revision_kind: string; patch: Record<string, unknown> };
export function weightSamples(events: WeightEvent[], revisions: WeightRevision[]) {
  const latest = new Map<string, WeightRevision>();
  for (const revision of revisions) if ((latest.get(revision.event_id)?.revision_no ?? -1) < revision.revision_no) latest.set(revision.event_id, revision);
  let excluded = 0;
  const samples = [...new Map(events.map(event => [event.id, event])).values()].filter(event => event.event_type === 'weight').flatMap(event => {
    const revision = latest.get(event.id);
    if (revision?.revision_kind === 'VOID') return [];
    const patch = revision?.patch ?? {};
    const value = { ...event.value, ...(typeof patch.value === 'object' && patch.value ? patch.value : {}), ...patch };
    const amount = value.observed_value;
    const occurredAt = typeof patch.occurred_at === 'string' ? patch.occurred_at : event.occurred_at;
    if ((patch.unit ?? event.unit) !== 'kg' || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(Date.parse(occurredAt))) { excluded++; return []; }
    const target = value.target_weight_kg;
    return [{ id: event.id, occurredAt, value: amount, target: typeof target === 'number' && Number.isFinite(target) && target > 0 ? target : null }];
  }).sort((a,b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id));
  return { samples, excluded, target: [...samples].reverse().find(sample => sample.target !== null)?.target ?? null };
}

/** Return only explicitly allowed fields and only records inside the resolved share's Pet/date scope. */
export function sharedWeightEvents(events: (WeightEvent & { pet_id: string })[], revisions: WeightRevision[], scope: { petId: string; from: string; to: string; timezone: string }) {
  const scoped = events.filter(event => event.pet_id === scope.petId);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: scope.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return weightSamples(scoped, revisions).samples.filter(sample => {
    const parts = formatter.formatToParts(new Date(sample.occurredAt));
    const part = (key: string) => parts.find(value => value.type === key)?.value;
    const day = `${part('year')}-${part('month')}-${part('day')}`;
    return day >= scope.from && day <= scope.to;
  }).map(sample => ({ id: sample.id, event_type: 'weight', occurred_at: sample.occurredAt, unit: 'kg',
    value: { observed_value: sample.value, ...(sample.target !== null ? { target_weight_kg: sample.target } : {}) } }));
}
