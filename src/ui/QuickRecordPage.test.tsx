import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuickRecordPage } from './App';

afterEach(cleanup);

const props = {
  pet: { id: 'synthetic-pet', household_id: 'synthetic-household', name: '합성 반려견', timezone: 'Asia/Seoul' },
  userId: 'synthetic-user',
  occurrences: [],
  events: [],
  revisions: [],
  planApproval: {},
  online: true,
  onSubmit: vi.fn().mockResolvedValue(false),
};

describe('QuickRecordPage', () => {
  it('exposes the record types as accessible radio choices', () => {
    render(<QuickRecordPage {...props} />);
    expect(screen.getByRole('group', { name: '무엇을 기록할까요?' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /혈당/ })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: '무엇을 기록할까요?' })).getByRole('radio', { name: /식사/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /배변·배뇨/ })).toBeInTheDocument();
  });

  it('offers and stores exercise-before/after glucose context as descriptive metadata', async () => {
    const onSubmit = vi.fn().mockResolvedValue(false);
    render(<QuickRecordPage {...props} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText('측정값'), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('radio', { name: '운동 전' }));
    fireEvent.click(screen.getByRole('button', { name: '기록 저장' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'glucose', measurementCondition: 'BEFORE_EXERCISE' }), null));
  });

  it('shows insulin product and required U dose without a performed-event checkbox', () => {
    render(<QuickRecordPage {...props} />);
    fireEvent.click(screen.getByRole('radio', { name: /인슐린/ }));
    expect(screen.getByRole('heading', { name: '실제 투여 내용을 기록해요' })).toBeInTheDocument();
    expect(screen.getByLabelText('인슐린 제품')).toBeRequired();
    expect(screen.getByLabelText('실제 투여량')).toBeRequired();
    expect(screen.getByText('U')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /이미 실제로 발생한 투여 사실/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '기록 저장' }));
    expect(screen.getByRole('alert')).toHaveTextContent('0보다 큰 U 값');
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('defaults meal amounts to grams and keeps the food note visible', () => {
    render(<QuickRecordPage {...props} />);
    fireEvent.click(screen.getByRole('radio', { name: '식사' }));
    expect(screen.getByText('섭취량 단위')).toBeInTheDocument();
    expect(screen.getByText('g')).toBeInTheDocument();
    expect(screen.queryByLabelText('섭취량 단위')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /섭취 내용 \(선택\)/ })).toBeVisible();
    expect(screen.getByLabelText('실제 발생 시각')).toBeVisible();
    expect(screen.queryByText(/기록 시각/)).not.toBeInTheDocument();
  });

  it('submits insulin amount and product without marking the user as performer', async () => {
    const onSubmit = vi.fn().mockResolvedValue(false);
    render(<QuickRecordPage {...props} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('radio', { name: /인슐린/ }));
    fireEvent.change(screen.getByLabelText('인슐린 제품'), { target: { value: '캐니슐린' } });
    fireEvent.change(screen.getByLabelText('실제 투여량'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '기록 저장' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'insulin', doseAmount: '2', doseUnit: 'U', insulinProductLabel: '캐니슐린' }),
      null,
    ));
  });

  it('applies the saved per-pet product when profile data arrives after the form mounts', () => {
    const view = render(<QuickRecordPage {...props} />);
    fireEvent.click(screen.getByRole('radio', { name: /인슐린/ }));
    view.rerender(<QuickRecordPage {...props} pet={{ ...props.pet, default_insulin_product: '캐니슐린' }} />);
    expect(screen.getByLabelText('인슐린 제품')).toHaveValue('캐니슐린');
  });

  it('keeps insulin help and occurrence details collapsed until requested', () => {
    render(<QuickRecordPage {...props} />);
    fireEvent.click(screen.getByRole('radio', { name: /인슐린/ }));
    expect(screen.getByText('추가 정보 · 도움말').closest('details')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('처음 인슐린을 준비하는 보호자 도움말'));
    expect(screen.getByText(/기포가 보이거나 눈금의 실제 양을 확신할 수 없다면/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'UC Davis 수의대 보호자 안내' })).toHaveAttribute('target', '_blank');
  });

  it('keeps offline input unconfirmed and does not allow a server save', () => {
    render(<QuickRecordPage {...props} online={false} />);
    expect(screen.getByRole('button', { name: '기록 저장' })).toBeDisabled();
    expect(screen.getByText(/오프라인에서는 서버 저장을 시도하지 않습니다/)).toBeInTheDocument();
  });
});

it('preserves type-specific drafts without submitting when choices change', async () => {
  const onSubmit = vi.fn().mockResolvedValue(false);
  render(<QuickRecordPage {...props} onSubmit={onSubmit} />);
  fireEvent.change(screen.getByLabelText('측정값'), { target: { value: '164' } });
  fireEvent.click(screen.getByRole('button', { name: '다른 기록 종류 보기' }));
  fireEvent.click(screen.getByRole('radio', { name: '식사' }));
  fireEvent.click(screen.getByRole('radio', { name: '일부 섭취' }));
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('radio', { name: '혈당' }));
  expect(screen.getByLabelText('측정값')).toHaveValue(164);
  fireEvent.click(screen.getByRole('button', { name: '다른 기록 종류 보기' }));
  fireEvent.click(screen.getByRole('radio', { name: '식사' }));
  expect(screen.getByRole('radio', { name: /일부 섭취/ })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '기록 저장' }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ mealStatus: 'PARTIAL', numericValue: '' }), null));
});

it('updates the selected date without fabricating a different occurrence time', () => {
  render(<QuickRecordPage {...props} />);
  fireEvent.change(screen.getByLabelText('실제 발생 시각'), { target: { value: '2026-10-20T14:35' } });
  expect(screen.getByLabelText('실제 발생 시각')).toHaveValue('2026-10-20T14:35');
});

it('keeps the prescribed insulin product after switching record types', () => {
  render(<QuickRecordPage {...props} />);
  fireEvent.click(screen.getByRole('radio', { name: '인슐린' }));
  fireEvent.change(screen.getByLabelText('인슐린 제품'), { target: { value: '캐니슐린' } });
  fireEvent.click(screen.getByRole('radio', { name: '혈당' }));
  fireEvent.click(screen.getByRole('radio', { name: '인슐린' }));
  expect(screen.getByLabelText('인슐린 제품')).toHaveValue('캐니슐린');
});
