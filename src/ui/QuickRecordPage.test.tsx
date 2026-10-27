import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByRole('radio', { name: /배변·배뇨/ })).toBeInTheDocument();
  });

  it('offers and stores exercise-before/after glucose context as descriptive metadata', async () => {
    const onSubmit = vi.fn().mockResolvedValue(false);
    render(<QuickRecordPage {...props} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText('측정값'), { target: { value: '150' } });
    const condition = screen.getByLabelText('측정 조건 (선택)');
    expect(screen.getByRole('option', { name: '운동 전' })).toHaveValue('BEFORE_EXERCISE');
    expect(screen.getByRole('option', { name: '운동 후' })).toHaveValue('AFTER_EXERCISE');
    fireEvent.change(condition, { target: { value: 'BEFORE_EXERCISE' } });
    fireEvent.click(screen.getByRole('button', { name: '기록 저장' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'glucose', measurementCondition: 'BEFORE_EXERCISE' }), null, false));
  });

  it('requires a post-event confirmation and does not invite a new insulin action', () => {
    render(<QuickRecordPage {...props} />);
    fireEvent.click(screen.getByRole('radio', { name: /인슐린/ }));
    expect(screen.getByRole('heading', { name: '이미 발생한 투여 사실' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '이미 발생한 투여 사실 저장' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '이미 발생한 투여 사실 저장' }));
    expect(screen.getByRole('alert')).toHaveTextContent('이미 실제로 발생한 투여 사실');
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('allows an actual insulin record to be submitted after confirmation, even without a linked occurrence', async () => {
    const onSubmit = vi.fn().mockResolvedValue(false);
    render(<QuickRecordPage {...props} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('radio', { name: /인슐린/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /이미 실제로 발생한 투여 사실을 기록합니다/ }));
    fireEvent.click(screen.getByRole('button', { name: '이미 발생한 투여 사실 저장' }));
    expect(await screen.findByText(/일정 연결 없음/)).toBeInTheDocument();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'insulin', confirmedAlreadyOccurred: true }),
      null,
      true,
    );
  });

  it('records optional actual insulin amount, unit and product label and presents safety help', async () => {
    const onSubmit = vi.fn().mockResolvedValue(false);
    render(<QuickRecordPage {...props} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('radio', { name: /인슐린/ }));
    fireEvent.change(screen.getByLabelText(/실제 투여량/), { target: { value: '5.5' } });
    fireEvent.change(screen.getByLabelText(/제품명·농도 표기/), { target: { value: '합성 라벨 U-40' } });
    expect(screen.getAllByText(/U\(인슐린 단위·‘칸’\)와 mL\(부피\)는 다른 단위/)).toHaveLength(2);
    fireEvent.click(screen.getByText('처음 인슐린을 준비하는 보호자 도움말'));
    expect(screen.getByText(/기포가 보이거나 눈금의 실제 양을 확신할 수 없다면/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'UC Davis 수의대 보호자 안내' })).toHaveAttribute('target', '_blank');
    fireEvent.click(screen.getByRole('checkbox', { name: /이미 실제로 발생한 투여 사실을 기록합니다/ }));
    fireEvent.click(screen.getByRole('button', { name: '이미 발생한 투여 사실 저장' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'insulin', doseAmount: '5.5', doseUnit: 'mL', insulinProductLabel: '합성 라벨 U-40' }),
      null,
      true,
    ));
  });

  it('keeps offline input unconfirmed and does not allow a server save', () => {
    render(<QuickRecordPage {...props} online={false} />);
    expect(screen.getByRole('button', { name: '기록 저장' })).toBeDisabled();
    expect(screen.getByText(/오프라인에서는 서버 저장을 시도하지 않습니다/)).toBeInTheDocument();
  });
});
