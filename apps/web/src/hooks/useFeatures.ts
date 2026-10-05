import { useEffect, useState } from 'react';
import { api } from '../api/client';

// Which optional parts of the system an Admin has switched on (today: sales commission). Read fresh from the server when the app opens and
// again whenever the Master Data switch is flipped (notifyFeaturesChanged), so menus and forms follow without a reload.

export interface Features {
  commission: boolean;
}

const EVENT = 'glm-features-changed';
let cache: Features | null = null;
let inflight: Promise<Features | null> | null = null;

function load(force = false): Promise<Features | null> {
  if (cache && !force) return Promise.resolve(cache);
  if (!inflight || force) {
    inflight = api
      .get<Features>('/auth/features')
      .then((f) => (cache = f))
      .catch(() => cache)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function notifyFeaturesChanged() {
  load(true).then(() => window.dispatchEvent(new Event(EVENT)));
}

/** Forget what was read (on sign-out, so the next person sees their own system's switches). */
export function resetFeatures() {
  cache = null;
}

/** null until it has been read; treat that as "off" so nothing about commission flashes on screen first. */
export function useFeatures(): Features | null {
  const [f, setF] = useState<Features | null>(cache);
  useEffect(() => {
    let live = true;
    load().then((x) => live && setF(x));
    const onChange = () => setF(cache);
    window.addEventListener(EVENT, onChange);
    return () => {
      live = false;
      window.removeEventListener(EVENT, onChange);
    };
  }, []);
  return f;
}
