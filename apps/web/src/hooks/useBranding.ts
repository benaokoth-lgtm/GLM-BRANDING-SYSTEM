import { useEffect, useState } from 'react';
import { api } from '../api/client';

// The company name and logo (Master Data → Company), available before sign-in so the login page can show it too. Fetched once and
// shared; Master Data announces a change with notifyBrandingChanged() so the header and tab icon update without a reload.

export interface Branding {
  companyName: string;
  logoDataUrl: string | null;
}

const EVENT = 'glm-branding-changed';
let cache: Branding | null = null;
let inflight: Promise<Branding | null> | null = null;

function applyFavicon(b: Branding | null) {
  if (typeof document === 'undefined') return;
  // the browser tab's title follows the company name set in Master Data
  if (b?.companyName) document.title = `${b.companyName} — Order & POS`;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!b?.logoDataUrl) {
    link?.remove();
    return;
  }
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = b.logoDataUrl;
}

function load(force = false): Promise<Branding | null> {
  if (cache && !force) return Promise.resolve(cache);
  if (!inflight || force) {
    inflight = api
      .get<Branding>(force ? `/auth/branding?v=${Date.now()}` : '/auth/branding') // (a saved change must not come back from the browser's 5-minute cache)
      .then((b) => {
        cache = b;
        applyFavicon(b);
        return b;
      })
      .catch(() => cache)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function notifyBrandingChanged() {
  load(true).then(() => window.dispatchEvent(new Event(EVENT)));
}

export function useBranding(): Branding | null {
  const [b, setB] = useState<Branding | null>(cache);
  useEffect(() => {
    let live = true;
    load().then((x) => live && setB(x));
    const onChange = () => setB(cache);
    window.addEventListener(EVENT, onChange);
    return () => {
      live = false;
      window.removeEventListener(EVENT, onChange);
    };
  }, []);
  return b;
}
