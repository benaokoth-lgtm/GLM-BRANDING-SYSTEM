import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

// Working inside a module. Most modules have sub-items (tabs) of their own; once someone has clicked one, the row of modules above is
// dimmed — still visible, still clickable, and back to full strength when the mouse is over it — so the eye stays on what they are working
// in. Clicking a module brings the row back to full strength and returns that module to its starting view.

interface SubNav {
  /** True while a sub-item of the current module has been chosen. */
  dim: boolean;
  /** Called when someone clicks a sub-item. */
  mark: () => void;
  /** Called when someone clicks a module in the top row. */
  goHome: () => void;
  /** Changes every time a module is clicked — a page returns to its starting view when it sees it change. */
  homeSignal: number;
}

const Ctx = createContext<SubNav | null>(null);

export function SubNavProvider({ children }: { children: ReactNode }) {
  const [dim, setDim] = useState(false);
  const [homeSignal, setHomeSignal] = useState(0);
  const { pathname } = useLocation();
  // arriving at another page starts it undimmed
  useEffect(() => setDim(false), [pathname]);
  const mark = useCallback(() => setDim(true), []);
  const goHome = useCallback(() => {
    setDim(false);
    setHomeSignal((n) => n + 1);
  }, []);
  const value = useMemo(() => ({ dim, mark, goHome, homeSignal }), [dim, mark, goHome, homeSignal]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSubNav(): SubNav {
  return useContext(Ctx) ?? { dim: false, mark: () => undefined, goHome: () => undefined, homeSignal: 0 };
}

/** Runs `onHome` whenever the module itself is clicked in the top row. */
export function useModuleHome(onHome: () => void) {
  const { homeSignal } = useSubNav();
  const latest = useRef(onHome);
  latest.current = onHome;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    latest.current();
  }, [homeSignal]);
}

/**
 * A drop-in for useState on a module's sub-item (tab): choosing one dims the module row, and clicking the module returns to `initial`.
 */
export function useSubTab<T>(initial: T): [T, (value: T) => void] {
  const { mark } = useSubNav();
  const [tab, setTab] = useState<T>(initial);
  const home = useRef(initial);
  home.current = initial;
  useModuleHome(() => setTab(home.current));
  const choose = useCallback(
    (value: T) => {
      setTab(value);
      mark();
    },
    [mark],
  );
  return [tab, choose];
}
