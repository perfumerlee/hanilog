import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelinePage } from './App';

function SearchProbe() {
  const [params] = useSearchParams();
  return <output aria-label="현재 필터">{params.toString()}</output>;
}

describe('TimelinePage filters', () => {
  afterEach(() => cleanup());

  it('automatically includes recorded types and preserves explicit filters in the URL', async () => {
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
      { id: 'w1', pet_id: 'pet-1', actor_id: 'user-1', performer_id: 'user-1', event_type: 'weight' as const,
        occurred_at: '2026-11-04T05:00:00.000Z', recorded_at: '2026-11-04T05:01:00.000Z', occurrence_id: null, plan_version_id: null,
        value: { observed_value: 17.6 }, unit: 'kg' },
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
    expect(await screen.findByRole('heading', { name: '체중' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /주요 기록/ }));
    expect(screen.getByLabelText('현재 필터')).toHaveTextContent('date=2026-11-04');
    expect(screen.getByLabelText('현재 필터')).toHaveTextContent('types=glucose%2Cinsulin%2Celimination%2Cmeal');
  });

  it('shows direct weight correction and deletion with an audit-preserving void request', async () => {
    const onReviseEvent = vi.fn().mockResolvedValue(true);
    render(<MemoryRouter initialEntries={['/timeline?date=2026-11-04']}>
      <TimelinePage pet={{ id: 'pet-1', household_id: 'house-1', name: '합성 반려견', timezone: 'Asia/Seoul' }}
        events={[{ id: 'w1', pet_id: 'pet-1', actor_id: 'user-1', performer_id: 'user-1', event_type: 'weight',
          occurred_at: '2026-11-04T05:00:00.000Z', recorded_at: '2026-11-04T05:01:00.000Z', occurrence_id: null, plan_version_id: null,
          value: { observed_value: 17.6 }, unit: 'kg' }]}
        revisions={[]} userId="user-1" dateFilter="2026-11-04" setDateFilter={vi.fn()} loading={false}
        onReviseEvent={onReviseEvent} />
    </MemoryRouter>);
    expect(screen.getByRole('button', { name: '체중' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '수정' }));
    fireEvent.change(screen.getByLabelText('기록값'), { target: { value: '17.8' } });
    fireEvent.click(screen.getByRole('button', { name: '값·메모 저장' }));
    await waitFor(() => expect(onReviseEvent).toHaveBeenCalledWith('w1', 0, 'CORRECT', expect.objectContaining({ value: expect.objectContaining({ observed_value: 17.8 }) })));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(onReviseEvent).toHaveBeenCalledWith('w1', 0, 'VOID', {}));
    confirm.mockRestore();
  });

  it('loads an older weight by its measurement date when it is outside the recent-events cache', async () => {
    const olderWeight = {
      id: 'older-weight', pet_id: 'pet-1', actor_id: 'user-1', performer_id: 'user-1', event_type: 'weight' as const,
      occurred_at: '2026-11-05T08:40:00.000Z', recorded_at: '2026-11-06T01:00:00.000Z',
      occurrence_id: null, plan_version_id: null, value: { observed_value: 17.6 }, unit: 'kg',
    };
    const loadDayEvents = vi.fn().mockResolvedValue({ events: [olderWeight], revisions: [] });
    render(<MemoryRouter initialEntries={['/timeline?date=2026-11-05']}>
      <TimelinePage pet={{ id: 'pet-1', household_id: 'house-1', name: '합성 반려견', timezone: 'Asia/Seoul' }}
        events={[]} revisions={[]} userId="user-1" dateFilter="2026-11-05" setDateFilter={vi.fn()} loading={false}
        loadDayEvents={loadDayEvents} />
    </MemoryRouter>);

    await waitFor(() => expect(loadDayEvents).toHaveBeenCalledWith('pet-1', '2026-11-05', 'Asia/Seoul'));
    expect(await screen.findByRole('heading', { name: '체중' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '체중' })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByRole('heading', { name: '체중' })).toBeInTheDocument();
    expect(screen.getByText('17.6 kg')).toBeInTheDocument();
    expect(screen.getByText('오후 05:40')).toBeInTheDocument();
  });
});
