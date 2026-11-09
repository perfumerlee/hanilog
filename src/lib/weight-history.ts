import type { SupabaseClient } from '@supabase/supabase-js';
import { weightSamples, type WeightEvent, type WeightRevision } from './weight-trends';

/** Dedicated paginated query: infrequent weight records may be outside the timeline's 120 rows. */
export async function loadWeightTarget(client: SupabaseClient, petId: string) {
  const events: WeightEvent[] = [];
  const revisions: WeightRevision[] = [];
  for (let offset = 0; ; offset += 500) {
    const result = await client.from('health_events').select('id,event_type,occurred_at,value,unit')
      .eq('pet_id', petId).eq('event_type', 'weight').order('id').range(offset, offset + 499);
    if (result.error) throw result.error;
    const rows = result.data as WeightEvent[];
    events.push(...rows);
    if (rows.length) {
      for (let start = 0; ; start += 500) {
        const history = await client.from('health_event_revisions').select('event_id,revision_no,revision_kind,patch')
          .in('event_id', rows.map(row => row.id)).order('event_id').order('revision_no').range(start, start + 499);
        if (history.error) throw history.error;
        revisions.push(...history.data as WeightRevision[]);
        if (history.data.length < 500) break;
      }
    }
    if (rows.length < 500) break;
  }
  return weightSamples(events, revisions).target;
}
