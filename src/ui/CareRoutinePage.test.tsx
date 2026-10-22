import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CareRoutinePage } from './CareRoutinePage';

afterEach(cleanup);

describe('CareRoutinePage', () => {
  it('labels disconnected routine state UNVERIFIED and does not present a confirmed schedule', async () => {
    render(<CareRoutinePage pet={{ id: 'synthetic-pet', household_id: 'synthetic-household', name: '합성 반려견', timezone: 'Asia/Seoul' }} online={false} userId="synthetic-user" />);
    expect(screen.getByRole('alert')).toHaveTextContent('UNVERIFIED');
    expect(screen.getByText(/이전 표시값은 현재 상태를 보증하지 않습니다/)).toBeInTheDocument();
    expect(await screen.findByText(/오늘 생성된 일정이 없습니다/)).toBeInTheDocument();
  });

  it('keeps care routine editing unavailable until the server verifies write access', () => {
    render(<CareRoutinePage pet={{ id: 'synthetic-pet', household_id: 'synthetic-household', name: '합성 반려견', timezone: 'Asia/Seoul' }} online userId="synthetic-user" />);
    expect(screen.getByRole('button', { name: '새 루틴' })).toBeDisabled();
  });
});
