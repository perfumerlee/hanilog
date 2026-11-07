import { describe, expect, it } from 'vitest';
import { weightSamples, type WeightEvent } from './weight-trends';
const event = (id: string, date: string, value = 8): WeightEvent => ({ id, event_type: 'weight', occurred_at: date, value: { observed_value: value }, unit: 'kg' });
describe('weight trends', () => {
  it('preserves irregular measurement dates, sorts and deduplicates', () => {
    const a = event('a','2026-01-01T00:00:00Z');
    const b = event('b','2026-04-01T00:00:00Z');
    expect(weightSamples([b,a,a],[]).samples.map(row => row.id)).toEqual(['a','b']);
  });
  it('uses latest corrections and excludes void and legacy units', () => {
    const a = event('a','2026-01-01T00:00:00Z');
    const result = weightSamples([a, {...a,id:'b',unit:'lb'}, {...a,id:'c'}], [
      { event_id:'a', revision_no:2, revision_kind:'CORRECT',patch:{value:{observed_value:9,target_weight_kg:10}} },
      { event_id:'a', revision_no:1, revision_kind:'CORRECT',patch:{observed_value:7} },
      { event_id:'c', revision_no:1, revision_kind:'VOID',patch:{} },
    ]);
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0].value).toBe(9);
    expect(result.target).toBe(10);
    expect(result.excluded).toBe(1);
  });
  it('retains previous target when subsequent measurement omits it', () => {
    expect(weightSamples([{...event('a','2026-01-01T00:00:00Z'),value:{observed_value:8,target_weight_kg:10}},event('b','2026-02-01T00:00:00Z',9)],[]).target).toBe(10);
  });
});
