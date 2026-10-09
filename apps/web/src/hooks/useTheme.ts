import { useCallback, useState } from 'react';

export const THEMES = [
  ['organic', 'Organic'],
  ['nocturne', 'Nocturne'],
  ['industrial', 'Industrial'],
] as const;
export type Theme = (typeof THEMES)[number][0];
const KEY = 'glm_theme';
const BAR: Record<Theme, string> = { organic: '#F1EDE0', nocturne: '#0E1014', industrial: '#F6F1EA' };

function current(): Theme {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'ivory') return 'industrial'; // what Industrial used to be called
  return THEMES.some(([id]) => id === t) ? (t as Theme) : 'organic';
}

// The look of the screens: Organic (the default: soft and rounded, green), Industrial (the original: square, framed, black on ivory) or Nocturne (dark). The choice is remembered in this browser; index.html
// applies it before the first paint so there is no flash.
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(current);
  const choose = useCallback((next: Theme) => {
    document.documentElement.setAttribute('data-theme', next);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BAR[next]);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode: the choice just isn't remembered */
    }
    setTheme(next);
  }, []);
  return { theme, choose };
}
