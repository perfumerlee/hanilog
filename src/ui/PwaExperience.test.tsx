import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PwaExperience } from './PwaExperience';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

it('hides the entire update notice immediately after applying an available worker', async () => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false })) });
  const postMessage = vi.fn();
  const worker = { postMessage, addEventListener: vi.fn() };
  const registration = { waiting: worker, addEventListener: vi.fn() };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
    controller: {}, getRegistration: vi.fn(async () => registration),
  } });
  const { container } = render(<PwaExperience />);
  const button = await screen.findByRole('button', { name: '업데이트 적용' });
  fireEvent.click(button);
  await waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }));
  expect(container.querySelector('.pwa-notice')).toBeNull();
  expect(sessionStorage.getItem('hanilog:pwa-update-dismissed')).toBe('1');
});
