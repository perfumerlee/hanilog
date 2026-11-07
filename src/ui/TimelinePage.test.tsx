import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelinePage } from './App';

function SearchProbe() {
  const [params] = useSearchParams();
  return <output aria-label="현재 필터">{params.toString()}</output>;
}

describe('TimelinePage filters', () => {
  afterEach(() => cleanup());

  it('defaults to key records and keeps date and chosen types in the URL', () => {
    const events = [
      { id: 'g1', pet_id: 'pet-1', actor_id: 'user-1', performer_id: 'user-1', event_type: 'glucose' as const,
        occurred_at: '2026-11-04T02:00:00.000Z', recorded_at: '2026-11-04T02:01:00.000Z', occurrence_id: null, plan_version_id: null,
        value: { observed_value: 164 }, unit: 'mg/dL' },
      { id: 'i1', pet_id: 'pet-1', actor_id: 'user-1', performer_id: 'user-1', event_type: 'insulin' as const,
        occurred_at: '2026-11-04T03:00:00.000Z', recorded_at: '2026-11-04T03:01:00.000Z', occurrence_id: null, plan_version_id: null,
        value: { product_name: '합성 예시' }, unit: null },
      { id: 'm1', pet_id: 'pet-1', actor_id: 'user-1', performer_id: 'user-1', event_type: 'meal' as const,
        occurred_at: '2026-11-04T04:00:00.000Z', recorded_at: '2026-11-04T04:01:00.000Z', occurrence_id: null, plan_version_id: null,
        value: { food: '합성 예시' }, unit: null },
    ];
    render(<MemoryRouter initialEntries={['/timeline?date=2026-11-04']}>
      <TimelinePage pet={{ id: 'pet-1', household_id: 'house-1', name: '합성 반려견', timezone: 'Asia/Seoul' }}
        events={events} revisions={[]} userId="user-1" dateFilter="2026-11-04" setDateFilter={vi.fn()} loading={false} />
      <SearchProbe />
    </MemoryRouter>);

    expect(screen.getByLabelText('날짜 선택')).toHaveValue('2026-11-04');
    expect(screen.getByRole('heading', { name: '혈당' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '인슐린' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '식사' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /주요 기록/ }));
    expect(screen.getByLabelText('현재 필터')).toHaveTextContent('date=2026-11-04');
    expect(screen.getByLabelText('현재 필터')).toHaveTextContent('types=glucose%2Cinsulin%2Celimination%2Cmeal');
  });
});
