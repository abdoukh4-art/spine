import { render, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useApi } from './api';
import { useAuth } from './auth/AuthProvider';
import { formatDateTime, formatDuration, formatPercent, formatRelative, humanize } from './format';
import { applyTheme, readThemePreference, THEME_STORAGE_KEY, useTheme } from './theme';

describe('format', () => {
  it('formats durations compactly', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(42.4)).toBe('42s');
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(252)).toBe('4m 12s');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(7_500)).toBe('2h 5m');
    expect(formatDuration(86_400)).toBe('1d');
    expect(formatDuration(3 * 86_400 + 4 * 3600)).toBe('3d 4h');
  });

  it('formats timestamps in UTC', () => {
    expect(formatDateTime('2026-10-28T12:00:00.000Z')).toBe('28 Oct 2026, 12:00:00 UTC');
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('not a date')).toBe('not a date');
  });

  it('formats relative times, percentages and enum values', () => {
    const now = Date.parse('2026-10-28T12:00:00.000Z');
    expect(formatRelative('2026-10-28T11:55:00.000Z', now)).toBe('5m ago');
    expect(formatRelative('2026-10-28T15:00:00.000Z', now)).toBe('in 3h');
    expect(formatRelative('2026-10-28T12:00:01.000Z', now)).toBe('just now');
    expect(formatPercent(0.8734)).toBe('87.3 %');
    expect(formatPercent(null)).toBe('—');
    expect(humanize('false_positive')).toBe('False positive');
    expect(humanize('firewall.block')).toBe('Firewall block');
  });
});

describe('theme', () => {
  it('reads and applies the stored preference', () => {
    expect(readThemePreference()).toBe('system');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(readThemePreference()).toBe('dark');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    expect(readThemePreference()).toBe('system');
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    applyTheme('system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('falls back to "system" when storage is blocked', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readThemePreference()).toBe('system');
    spy.mockRestore();
  });
});

describe('context hooks fail loudly outside their providers', () => {
  it.each([
    ['useApi', useApi, /ApiProvider/],
    ['useAuth', useAuth, /AuthProvider/],
    ['useTheme', useTheme, /ThemeProvider/],
  ] as const)('%s', (_name, hook, message) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => hook())).toThrow(message);
  });

  it('renders nothing surprising for a bare component', () => {
    const { container } = render(<p>ok</p>);
    expect(container).toHaveTextContent('ok');
  });
});
