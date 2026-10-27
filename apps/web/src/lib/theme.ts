export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'schm-theme';
export const THEME_CHOICES: ThemeChoice[] = ['system', 'light', 'dark'];

export function readThemeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): 'light' | 'dark' {
  return choice === 'system' ? (systemDark ? 'dark' : 'light') : choice;
}

/** Sets the `dark` class and `color-scheme` on <html> so Tailwind's dark: variants follow. */
export function applyTheme(choice: ThemeChoice): void {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = resolveTheme(choice, systemDark);
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

/**
 * Runs in <head> before the page paints, so the stored theme applies without a flash.
 * Kept dependency-free and in sync with applyTheme above.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var c=localStorage.getItem('${THEME_STORAGE_KEY}');var d=c==='dark'||(c!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;
