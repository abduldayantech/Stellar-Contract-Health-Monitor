import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { resolveTheme, THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from '@/lib/theme';

let systemDark = false;
beforeEach(() => {
  systemDark = false;
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: systemDark,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.style.colorScheme = '';
});
afterEach(() => vi.unstubAllGlobals());

const isDark = () => document.documentElement.classList.contains('dark');
const runInitScript = () => new Function(THEME_INIT_SCRIPT)();

describe('theme', () => {
  it('resolves system to the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('applies the stored choice before paint, defaulting to the system theme', () => {
    systemDark = true;
    runInitScript();
    expect(isDark()).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');

    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    runInitScript();
    expect(isDark()).toBe(false);
  });

  it('persists the choice and applies it immediately', () => {
    render(<ThemeSwitcher />);
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(isDark()).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: 'System' }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(isDark()).toBe(false);
  });

  it('restores a saved choice on mount', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    render(<ThemeSwitcher />);
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
  });
});
