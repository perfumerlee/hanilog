import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { WeightTrends } from './WeightTrends';
afterEach(cleanup);
it('uses 3 kg grid lines, switches the selected measurement, and hides writes for sharing', () => {
  const date = new Date().toISOString();
  const { container } = render(<MemoryRouter><WeightTrends readOnly timezone="Asia/Seoul" revisions={[]} events={[
    { id:'a', event_type:'weight', occurred_at:date, value:{observed_value:8,target_weight_kg:12},unit:'kg' },
    { id:'b', event_type:'weight', occurred_at:date, value:{observed_value:9},unit:'kg' },
  ]}/></MemoryRouter>);
  expect(screen.queryByRole('link', {name:'체중 기록'})).not.toBeInTheDocument();
  expect(container.querySelector('details')).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText('체중 흐름 보기'));
  expect(screen.getByRole('button', {name:'90일'})).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', {name:'전체'}));
  expect(screen.getByRole('heading', {name:'측정값 목록 : 2건'})).toBeInTheDocument();
  expect(container.querySelector('.weight-chart')).toBeInTheDocument();
  expect(container.querySelector('.weight-target-marker')).toHaveTextContent('목표 12 kg');
  expect(container.querySelector('.weight-target-marker line')).toHaveAttribute('stroke-dasharray', '7 5');
  expect(container.querySelector('svg')?.textContent).toContain('30');
  expect(container.querySelectorAll('svg line').length).toBeGreaterThanOrEqual(11);
  fireEvent.click(screen.getByRole('button', {name:/8 kg/}));
  expect(container.querySelector('.weight-tooltip')).toHaveTextContent('8 kg');
  expect(screen.getByRole('button', {name:/8 kg/})).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', {name:/9 kg/})).toHaveAttribute('aria-pressed', 'false');
});
it('shows a separately shared target when its source measurement falls outside the share range', () => {
  const { container } = render(<MemoryRouter><WeightTrends readOnly sharedTarget={21} timezone="Asia/Seoul" revisions={[]} events={[
    { id:'recent', event_type:'weight', occurred_at:new Date().toISOString(), value:{observed_value:17.6}, unit:'kg' },
  ]}/></MemoryRouter>);
  expect(screen.getByText('21 kg')).toBeInTheDocument();
  fireEvent.click(screen.getByText('체중 흐름 보기'));
  expect(container.querySelector('.weight-target-marker')).toHaveTextContent('목표 21 kg');
});
