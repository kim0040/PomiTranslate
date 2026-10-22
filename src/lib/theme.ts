import { setMenuTheme, setWindowTheme } from './native';

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'pomi.theme.v1';

function systemPrefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  return choice === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : choice;
}

export function storedTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

/** Set the theme attribute, with transitions off for one frame so the switch snaps instead of smearing. */
export function applyTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // Storage can be unavailable. The choice still applies for this session.
  }
  const root = document.documentElement;
  const resolved = resolveTheme(choice);
  // The native title bar and the window behind the page follow too, so a dark start never flashes white.
  const background = resolved === 'dark' ? '#0e0f11' : '#fafafa';
  void setWindowTheme(choice, background);
  void setMenuTheme(choice);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
  if (root.dataset.theme === resolved) return;
  const style = document.createElement('style');
  style.textContent = '*,*::before,*::after{transition:none !important}';
  document.head.appendChild(style);
  root.dataset.theme = resolved;
  void root.offsetWidth;
  requestAnimationFrame(() => style.remove());
}

/** Follow the operating system while the choice is "system". */
export function watchSystemTheme(getChoice: () => ThemeChoice): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const query = matchMedia('(prefers-color-scheme: dark)');
  const listener = () => {
    if (getChoice() === 'system') applyTheme('system');
  };
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}
