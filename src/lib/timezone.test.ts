import { describe, expect, it } from 'vitest';
import { detectBrowserTimezone, formatTimezoneLabel, timezoneOptionsFor } from './timezone';

describe('timezone onboarding labels', () => {
  it('shows Seoul as a human-readable location with its current offset', () => {
    expect(formatTimezoneLabel('Asia/Seoul')).toBe('대한민국 (서울, UTC+09:00)');
  });

  it('keeps a detected non-default timezone selectable', () => {
    expect(timezoneOptionsFor('America/Toronto')[0]).toMatchObject({ value: 'America/Toronto' });
  });

  it('detects a browser timezone or returns empty instead of guessing', () => {
    const timezone = detectBrowserTimezone();
    expect(typeof timezone).toBe('string');
    if (timezone) expect(() => new Intl.DateTimeFormat('en-US', { timeZone: timezone })).not.toThrow();
  });
});
