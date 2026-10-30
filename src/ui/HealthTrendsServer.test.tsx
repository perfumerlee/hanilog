import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase', () => ({
  supabase: { from(table: string) {
    let columns = '';
    const query = {
      select(value: string) { columns = value; return query; },
      eq() { return query; }, order() { return query; }, in() { return query; },
      gte() { return query; }, lt() { return query; },
      range() {
        const event: Record<string, unknown> = {
          id: 'synthetic-event', event_type: 'glucose',
          occurred_at: new Date().toISOString(), recorded_at: new Date().toISOString(),
          actor_id: 'synthetic-user', performer_id: null, value: { observed_value: 164 },
          unit: 'mg/dL', source: 'MANUAL', occurrence_id: null,
        };
        return Promise.resolve({ data: table === 'health_events'
          ? [Object.fromEntries(columns.split(',').map((key) => [key, event[key]]))] : [], error: null });
      },
      then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
        return Promise.resolve({ data: [], error: null }).then(resolve);
      },
    };
    return query;
  } },
}));

afterEach(cleanup);
it('renders server-projected glucose records, not only Demo records', async () => {
  const { HealthTrendsPage } = await import('./HealthTrendsPage');
  render(<MemoryRouter><HealthTrendsPage pet={{ id: 'synthetic-pet', name: 'Synthetic pet', timezone: 'Asia/Seoul' }} userId="synthetic-user" online /></MemoryRouter>);
  expect((await screen.findAllByText(/164 mg\/dL/)).length).toBeGreaterThan(0);
});
