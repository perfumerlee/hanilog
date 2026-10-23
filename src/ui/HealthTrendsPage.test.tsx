import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { HealthTrendsPage } from './HealthTrendsPage';

describe('HealthTrendsPage', () => {
  afterEach(() => cleanup());
  it('shows the mg/dL demo trend, actual measurement details, period controls and accessible data list', () => {
    const events = Array.from({ length: 3 }, (_, index) => ({
      id: `synthetic-${index}`, occurred_at: new Date(Date.now() - index * 86_400_000).toISOString(),
      event_type: 'glucose',
      recorded_at: new Date(Date.now() - index * 86_400_000 + 60_000).toISOString(), actor_id: 'synthetic-user',
      performer_id: 'synthetic-user', value: { observed_value: 140 + index, measurement_condition: '합성 예시 조건' },
      unit: 'mg/dL', source: 'USER_ENTERED', occurrence_id: null,
    }));
    render(<MemoryRouter><HealthTrendsPage pet={{ id: 'synthetic-pet', name: '합성 반려견', timezone: 'Asia/Seoul' }}
      userId="synthetic-user" online demoEvents={events} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: '합성 반려견의 혈당 기록' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '추세 기간' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /실제 측정 시각과 mg\/dL 값 산점도/ })).toBeInTheDocument();
    expect(screen.getByText('측정 조건')).toBeInTheDocument();
    expect(screen.getAllByText(/mg\/dL/).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: '혈당 기록 추가' })).toHaveAttribute('href', '/record?event=glucose');
  });

  it('shows UNVERIFIED and no last-known chart when offline', () => {
    render(<MemoryRouter><HealthTrendsPage pet={{ id: 'synthetic-pet', name: '합성 반려견', timezone: 'Asia/Seoul' }}
      userId="synthetic-user" online={false} /></MemoryRouter>);
    expect(screen.getByRole('alert')).toHaveTextContent('UNVERIFIED');
    expect(screen.queryByRole('img', { name: /산점도/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/mg\/dL$/)).not.toBeInTheDocument();
  });
});
