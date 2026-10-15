import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

// The menu badge of the approvals inbox: how many requests wait for this person's decision, plus the decisions on their own requests that they have not looked at yet. It is asked for every
// minute, when the window is brought back, and straight away when the inbox changes something.

const SEEN_KEY = 'glm_approvals_seen';
const EVENT = 'glm-approvals-changed';

const readSeen = (): string => {
  try {
    return localStorage.getItem(SEEN_KEY) ?? '';
  } catch {
    return '';
  }
};

/** The person has looked at the decisions on their own requests. */
export function markApprovalsSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, new Date().toISOString());
  } catch {
    /* the screen just shows them again */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Something changed in the inbox: ask again now. */
export function approvalsChanged(): void {
  window.dispatchEvent(new Event(EVENT));
}

export interface ApprovalsBadge {
  /** Waiting for this person's decision. */
  waiting: number;
  /** Decisions on their own requests they have not seen. */
  news: number;
  /** What the badge shows. */
  count: number;
  /** A new request has arrived since the last look: the text for a short notice, once. */
  notice: string;
  clearNotice: () => void;
}

export function useApprovalsBadge(enabled: boolean): ApprovalsBadge {
  const [data, setData] = useState<{ waiting: number; decided: string[] }>({ waiting: 0, decided: [] });
  const [notice, setNotice] = useState('');
  const [tick, setTick] = useState(0);
  const last = useRef<{ waiting: number; news: number } | null>(null);

  const load = useCallback(() => {
    if (!enabled) return;
    api
      .get<{ waiting: number; decided: string[] }>('/approvals/summary')
      .then((r) => {
        setData(r);
        const seen = readSeen();
        const news = r.decided.filter((d) => d > seen).length;
        const prev = last.current;
        if (prev && r.waiting > prev.waiting) setNotice(r.waiting - prev.waiting === 1 ? 'A new request is waiting for your decision.' : `${r.waiting - prev.waiting} new requests are waiting for your decision.`);
        else if (prev && news > prev.news) setNotice(news - prev.news === 1 ? 'One of your requests has been decided.' : `${news - prev.news} of your requests have been decided.`);
        last.current = { waiting: r.waiting, news };
      })
      .catch(() => undefined);
  }, [enabled]);

  useEffect(() => {
    load();
    if (!enabled) return;
    const timer = window.setInterval(load, 60_000);
    const again = () => load();
    window.addEventListener('focus', again);
    window.addEventListener(EVENT, again);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', again);
      window.removeEventListener(EVENT, again);
    };
  }, [enabled, load, tick]);
  useEffect(() => setTick(0), []);

  const seen = readSeen();
  const news = data.decided.filter((d) => d > seen).length;
  return { waiting: data.waiting, news, count: data.waiting + news, notice, clearNotice: () => setNotice('') };
}
