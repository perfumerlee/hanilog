import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { GlucoseSharePage } from './GlucoseSharePage';
vi.mock('../lib/supabase', () => ({ supabase: { functions: { invoke: vi.fn(async () => ({
 data: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'application/octet-stream' }), error: null,
})) } } }));
vi.mock('../lib/glucose-share', async (original) => ({ ...await original<typeof import('../lib/glucose-share')>(), callGlucoseShare: vi.fn(async () => ({ share: {
 pet_name: '합성 반려동물', timezone: 'Asia/Seoul', from_date: '2026-11-01', to_date: '2026-11-03', expires_at: '2026-11-10T00:00:00Z', include_care_values: true, target_range: {lower_mg_dl:70,upper_mg_dl:180}, weights: [], care_times: [
  { event_type: 'insulin', occurred_at: '2026-11-03T00:05:00Z', amount: 2.5, unit: 'U' },
  { event_type: 'meal', occurred_at: '2026-11-03T00:05:00Z', amount: 20, unit: 'g' },
  { event_type: 'meal', occurred_at: '2026-11-03T00:15:00Z', amount: 35, unit: 'g' },
  { event_type: 'meal', occurred_at: '2026-11-03T01:15:00Z' },
 ],
 measurements: [{id:'a',occurred_at:'2026-11-01T23:00:00Z',recorded_at:'2026-11-01T23:00:00Z',unit:'mg/dL',value:{observed_value:164}}, {id:'b',occurred_at:'2026-11-03T00:00:00Z',recorded_at:'2026-11-03T00:00:00Z',unit:'mg/dL',value:{observed_value:550,measurement_condition:'UNRELATED_TO_MEAL'}}],
} })) }));
afterEach(cleanup);
it('opens latest measured local day, preserves values above 500, and filters list on date navigation', async () => {
 Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:synthetic-photo') });
 Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
 render(<MemoryRouter initialEntries={['/share/'+'a'.repeat(43)]}><Routes><Route path="/share/:token" element={<GlucoseSharePage />} /></Routes></MemoryRouter>);
 await waitFor(() => expect(screen.getByLabelText('날짜')).toHaveValue('2026-11-03'));
 await waitFor(() => expect(screen.getByRole('img', { name: '합성 반려동물 프로필' })).toHaveAttribute('src', 'blob:synthetic-photo'));
 expect(screen.getAllByText('식사와 무관').length).toBeGreaterThan(0);
 expect(document.querySelector('.share-care-timeline-item.meal')?.textContent).toContain('식사20 g');
 expect(document.querySelector('.share-care-timeline-item.meal .share-care-icon')).toBeInTheDocument();
 expect(document.querySelector('.share-care-timeline-item.meal time')?.textContent).toContain('2026. 11. 3.');
 expect(document.querySelector('.share-care-timeline-item.meal time')?.textContent).toContain('오전 9:05');
 expect(screen.getByText(/이 링크에는 보호자 연락처가 포함되지 않았습니다/)).toBeInTheDocument();
 expect(screen.getByText('실제 측정값 : 1건')).toBeInTheDocument();
 expect(screen.getByRole('heading',{name:'측정값 목록 : 1건'})).toBeInTheDocument();
 expect(screen.getByText('직전 측정 비교')).toBeInTheDocument();
 expect(screen.getByText('+386 mg/dL')).toBeInTheDocument();
 const sections = [...document.querySelectorAll('.public-glucose-share > section')];
 expect(sections.map((section) => section.className)).toEqual([
  'panel trends-summary', 'panel trends-panel', 'panel weight-trends', 'panel', 'panel share-validity', 'panel share-guardian-contact',
 ]);
 expect(document.querySelector('.trends-panel > .measurement-list')).toBeInTheDocument();
 expect(document.querySelector('.glucose-point-tooltip')).toHaveTextContent('550 mg/dL');
 expect(screen.getByText('2.5 U')).toBeInTheDocument();
 expect(screen.getByText('35 g')).toBeInTheDocument();
 expect(screen.getByText('수치 미기록')).toBeInTheDocument();
 expect(screen.getAllByText('550 mg/dL').length).toBeGreaterThan(0);
 fireEvent.click(document.querySelector('.chart-point')!);
 expect(screen.getByRole('status')).toHaveTextContent('550 mg/dL');
 expect(screen.getByRole('status')).toHaveTextContent('오전 9:00:00');
 fireEvent.keyDown(document.querySelector('.chart-point')!, { key: 'Escape' });
 expect(screen.queryByRole('status')).not.toBeInTheDocument();
 expect(document.querySelectorAll('.chart-axis-label').length).toBeGreaterThanOrEqual(17);
 fireEvent.click(screen.getByRole('button',{name:'이전'}));
 expect(screen.getByLabelText('날짜')).toHaveValue('2026-11-02');
 expect(screen.getAllByText('164 mg/dL').length).toBeGreaterThan(0);
 expect(document.querySelector('.measurement-list')).not.toHaveTextContent('550 mg/dL');
 fireEvent.click(screen.getByRole('button',{name:'이전'}));
 expect(screen.getByText('이 날짜에 기록된 혈당 측정값이 없습니다.')).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'이전'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button', { name: '기간 추세' }));
 expect(screen.getByRole('heading', { name: '측정값 목록 : 2건' })).toBeInTheDocument();
 expect(document.querySelectorAll('.chart-point')).toHaveLength(2);
 expect(document.querySelectorAll('.chart-axis-label').length).toBeGreaterThan(13);
 expect(screen.queryByRole('checkbox', { name: '계산 추세 보기' })).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button', { name: '기간 지정' }));
 fireEvent.change(screen.getByLabelText('시작일'), { target: { value: '2026-11-03' } });
 fireEvent.change(screen.getByLabelText('종료일'), { target: { value: '2026-11-03' } });
 expect(document.querySelectorAll('.chart-point')).toHaveLength(1);
});
