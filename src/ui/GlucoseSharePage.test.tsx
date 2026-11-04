import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { GlucoseSharePage } from './GlucoseSharePage';
vi.mock('../lib/supabase', () => ({ supabase: {} }));
vi.mock('../lib/glucose-share', async (original) => ({ ...await original<typeof import('../lib/glucose-share')>(), callGlucoseShare: vi.fn(async () => ({ share: {
 pet_name: '합성 반려동물', timezone: 'Asia/Seoul', from_date: '2026-11-01', to_date: '2026-11-03', expires_at: '2026-11-10T00:00:00Z', target_range: {lower_mg_dl:70,upper_mg_dl:180}, care_times: [],
 measurements: [{id:'a',occurred_at:'2026-11-01T23:00:00Z',recorded_at:'2026-11-01T23:00:00Z',unit:'mg/dL',value:{observed_value:164}}, {id:'b',occurred_at:'2026-11-03T00:00:00Z',recorded_at:'2026-11-03T00:00:00Z',unit:'mg/dL',value:{observed_value:550}}],
} })) }));
afterEach(cleanup);
it('opens latest measured local day, preserves values above 500, and filters list on date navigation', async () => {
 render(<MemoryRouter initialEntries={['/share/'+'a'.repeat(43)]}><Routes><Route path="/share/:token" element={<GlucoseSharePage />} /></Routes></MemoryRouter>);
 await waitFor(() => expect(screen.getByLabelText('날짜')).toHaveValue('2026-11-03'));
 expect(screen.getByRole('heading',{name:'이날 측정값 (1건)'})).toBeInTheDocument();
 expect(screen.getAllByText('550 mg/dL').length).toBeGreaterThan(0);
 expect(document.querySelectorAll('.chart-axis-label').length).toBeGreaterThanOrEqual(17);
 fireEvent.click(screen.getByRole('button',{name:'이전'}));
 expect(screen.getByLabelText('날짜')).toHaveValue('2026-11-02');
 expect(screen.getAllByText('164 mg/dL').length).toBeGreaterThan(0);
 expect(screen.queryByText('550 mg/dL')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'이전'}));
 expect(screen.getByText('이 날짜에 기록된 혈당 측정값이 없습니다.')).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'이전'})).toBeDisabled();
});
