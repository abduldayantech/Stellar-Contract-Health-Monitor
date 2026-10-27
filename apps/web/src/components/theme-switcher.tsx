'use client';

import { useEffect, useState } from 'react';
import { cn } from '@stellar-health/ui';
import {
  applyTheme,
  readThemeChoice,
  THEME_CHOICES,
  THEME_STORAGE_KEY,
  type ThemeChoice,
} from '@/lib/theme';

const LABELS: Record<ThemeChoice, string> = { system: 'System', light: 'Light', dark: 'Dark' };

/** System / Light / Dark segmented control. The choice is stored in localStorage. */
export function ThemeSwitcher({ className }: { className?: string }) {
  const [choice, setChoice] = useState<ThemeChoice>('system');

  useEffect(() => {
    setChoice(readThemeChoice());
  }, []);

  // While following the system, react to OS theme changes without a reload.
  useEffect(() => {
    if (choice !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [choice]);

  function select(next: ThemeChoice) {
    setChoice(next);
    try {
      if (next === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage blocked: the choice still applies until the page reloads.
    }
    applyTheme(next);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cn(
        'inline-flex rounded-md bg-slate-100 p-0.5 text-xs dark:bg-slate-800',
        className,
      )}
    >
      {THEME_CHOICES.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={choice === c}
          onClick={() => select(c)}
          className={cn(
            'flex-1 rounded px-2 py-1 font-medium',
            choice === c
              ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-slate-100'
              : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white',
          )}
        >
          {LABELS[c]}
        </button>
      ))}
    </div>
  );
}
