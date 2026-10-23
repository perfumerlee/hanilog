import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockState = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], calls: [] as string[], rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      mockState.calls.push(table);
      const query = {
        select: () => query, eq: () => query, is: () => query, lte: () => query, gte: () => query, order: () => query, limit: () => query,
        upsert: () => Promise.resolve({ error: null }),
        then: (resolve: (value: unknown) => void) => Promise.resolve({ data: table === 'in_app_notifications' ? mockState.rows : [], error: null }).then(resolve),
      };
      return query;
    },
    rpc: (...args: unknown[]) => mockState.rpc(...args),
    functions: { invoke: () => Promise.resolve({ data: { subscriptions: [] }, error: null }) },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: () => Promise.resolve('ok'),
  },
}));
import { NotificationsPage } from './NotificationsPage';

describe('NotificationsPage', () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    const now = Date.now();
    mockState.rows = [{ id: 'notice-1', pet_id: 'pet-1', notification_type: 'CARE_DUE', title: '돌봄 일정 안내',
      body: '예정된 돌봄 일정을 확인해 주세요.', action_path: '/notifications', created_at: new Date(now).toISOString(),
      expires_at: new Date(now + 86_400_000).toISOString(), read_at: null, invalidated_at: null }];
    mockState.calls = [];
    mockState.rpc.mockReset().mockResolvedValue({ data: true, error: null });
  });

  it('shows server notices as attention state, never as proof of care', async () => {
    render(<MemoryRouter><NotificationsPage pets={[{ id: 'pet-1', name: 'Synthetic pet', timezone: 'Asia/Seoul' }]} userId="user-1" online /></MemoryRouter>);
    expect(await screen.findByText('돌봄 일정 안내')).toBeInTheDocument();
    expect(screen.getByText(/알림 열람은 케어 수행이나 수신을 증명하지 않습니다/)).toBeInTheDocument();
    expect(screen.queryByText(/알림 없음은 케어 미수행을 뜻하지 않습니다/)).not.toBeInTheDocument();
  });

  it('acknowledges only a notification and does not create a Health Event', async () => {
    render(<MemoryRouter><NotificationsPage pets={[{ id: 'pet-1', name: 'Synthetic pet', timezone: 'Asia/Seoul' }]} userId="user-1" online /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: '알림 확인' }));
    await waitFor(() => expect(mockState.rpc).toHaveBeenCalledWith('mark_notification_read', { p_notification_id: 'notice-1' }));
    expect(mockState.calls).not.toContain('health_events');
  });

  it('hides cached notice rows while offline and labels the state unverified', () => {
    render(<MemoryRouter><NotificationsPage pets={[{ id: 'pet-1', name: 'Synthetic pet', timezone: 'Asia/Seoul' }]} userId="user-1" online={false} /></MemoryRouter>);
    expect(screen.getByText(/UNVERIFIED/)).toBeInTheDocument();
    expect(screen.queryByText('돌봄 일정 안내')).not.toBeInTheDocument();
  });
});
