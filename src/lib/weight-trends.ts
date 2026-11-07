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
