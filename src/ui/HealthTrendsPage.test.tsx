import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { HealthTrendsPage } from './HealthTrendsPage';

describe('HealthTrendsPage', () => {
  afterEach(() => cleanup());
  it('shows the mg/dL demo trend, actual measurement details, period controls and accessible data list', () => {
    const events = Array.from({ length: 21 }, (_, index) => ({
      id: `synthetic-${index}`, occurred_at: new Date(Date.now() - index * 86_400_000).toISOString(),
      event_type: 'glucose',
      recorded_at: new Date(Date.now() - index * 86_400_000 + 60_000).toISOString(), actor_id: 'synthetic-user',
      performer_id: 'synthetic-user', value: { observed_value: 140 + index, measurement_condition: '합성 예시 조건' },
      unit: 'mg/dL', source: 'USER_ENTERED', occurrence_id: null,
    }));
    render(<MemoryRouter initialEntries={['/trends?view=period']}><HealthTrendsPage pet={{ id: 'synthetic-pet', name: '합성 반려견', timezone: 'Asia/Seoul' }}
      userId="synthetic-user" online demoEvents={events} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: '합성 반려견의 혈당 기록' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '추세 기간' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /기간별 실제 측정 기록 21건과 mg\/dL 값/ })).toBeInTheDocument();
    const measurementDetails = screen.getByText('측정 상세 정보').closest('details');
    expect(document.querySelector('.trends-panel > .measurement-list')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '하루 타임라인 열기' })).toHaveClass('timeline-link');
    expect(screen.getByRole('link', { name: '하루 타임라인 열기' }).querySelector('svg')).toBeInTheDocument();
    expect(document.querySelector('.timeline-link-panel')).not.toBeInTheDocument();
    expect(measurementDetails).not.toHaveAttribute('open');
    fireEvent.click(measurementDetails!.querySelector('summary')!);
    expect(screen.getByText('측정 출처')).toBeInTheDocument();
    expect(document.querySelector('.share-selected-value')).toBeInTheDocument();
    expect(screen.getAllByText(/mg\/dL/).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: '혈당 기록 추가' })).toHaveAttribute('href', '/record?event=glucose');
    expect(document.querySelectorAll('.actual-series-line').length).toBeGreaterThan(0);
    expect(document.querySelector('.glucose-point-tooltip')).toHaveTextContent('140 mg/dL');
    expect(document.querySelectorAll('.chart-axis-label').length).toBeGreaterThan(13);
    expect(document.querySelectorAll('.derived-trend-line')).toHaveLength(0);
    expect(screen.queryByRole('checkbox', { name: '계산 추세 보기' })).not.toBeInTheDocument();
  });

  it('shows UNVERIFIED and no last-known chart when offline', () => {
    render(<MemoryRouter><HealthTrendsPage pet={{ id: 'synthetic-pet', name: '합성 반려견', timezone: 'Asia/Seoul' }}
      userId="synthetic-user" online={false} /></MemoryRouter>);
    expect(screen.getByRole('alert')).toHaveTextContent('UNVERIFIED');
    expect(screen.queryByRole('img', { name: /그래프/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/mg\/dL$/)).not.toBeInTheDocument();
  });

  it('opens day view by default and keeps target/share tools compact until requested', () => {
    const events = [{
      id: 'today-synthetic', occurred_at: new Date().toISOString(), event_type: 'glucose',
      recorded_at: new Date().toISOString(), actor_id: 'synthetic-user', performer_id: 'synthetic-user',
      value: { observed_value: 164 }, unit: 'mg/dL', source: 'synthetic', occurrence_id: null,
    }];
    render(<MemoryRouter initialEntries={['/trends']}><HealthTrendsPage
      pet={{ id: 'synthetic-pet', name: '합성 반려견', timezone: 'Asia/Seoul' }}
      userId="synthetic-user" online demoEvents={events} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: '하루 보기' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: /시간대별 혈당/ })).toBeInTheDocument();
    expect(document.querySelector('.share-selected-value')).toHaveTextContent('164 mg/dL');
    expect(document.querySelector('.glucose-point-tooltip')).toHaveTextContent('164 mg/dL');
    expect(screen.getByText('실제 측정값 : 1건')).toBeInTheDocument();
    expect(screen.queryByText(/이 날짜의 식사·인슐린 기록/)).not.toBeInTheDocument();
    const shareDisclosure = screen.getByText('주치의와 혈당 공유').closest('details');
    expect(shareDisclosure).not.toHaveAttribute('open');
    fireEvent.click(shareDisclosure!.querySelector('summary')!);
    expect(shareDisclosure).toHaveAttribute('open');
    expect(screen.getByText('DEMO에서는 공유 링크가 생성되지 않습니다.')).toBeInTheDocument();
  });
});
