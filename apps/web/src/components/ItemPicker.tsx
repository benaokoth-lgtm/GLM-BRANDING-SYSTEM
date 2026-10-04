import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtKsh } from '@glm/shared';
import type { CatalogMaterial, CatalogService } from '../api/models';

// One searchable list for everything that can go on an order line: a SERVICE from the Service Price List or an ITEM from the Stock Price
// List (Master Data). Type to narrow it down — every word you type must appear in the name — then click it, or use ↑ ↓ and Enter.
// What kind of line it becomes (a service, a per-metre service, or an item sold from stock) follows from what is picked.

export type PickChoice = { kind: 'service' | 'material'; id: number };

// The last few things each person picked, kept in this browser, so the box opens with the items they sell most often.
const RECENT_MAX = 8;
const recentKey = (userId?: number) => `glm_recent_picks_${userId ?? 0}`;
export function loadRecent(userId?: number): PickChoice[] {
  try {
    const v = JSON.parse(localStorage.getItem(recentKey(userId)) ?? '[]');
    return Array.isArray(v) ? v.filter((c) => c && (c.kind === 'service' || c.kind === 'material') && Number.isInteger(c.id)).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}
export function rememberPick(userId: number | undefined, choice: PickChoice) {
  try {
    const next = [choice, ...loadRecent(userId).filter((c) => !(c.kind === choice.kind && c.id === choice.id))].slice(0, RECENT_MAX);
    localStorage.setItem(recentKey(userId), JSON.stringify(next));
  } catch {
    /* remembering recent picks is a convenience only */
  }
}

interface Option {
  kind: 'service' | 'material';
  id: number;
  name: string;
  hint: string;
  warn?: boolean;
  recent?: boolean;
}

export default function ItemPicker({
  services,
  materials,
  selected,
  onPick,
  recent = [],
  autoOpen = false,
  onOpened,
}: {
  services: CatalogService[];
  materials: CatalogMaterial[];
  selected: PickChoice | null;
  onPick: (choice: PickChoice) => void;
  /** Shown first while nothing has been typed. */
  recent?: PickChoice[];
  /** Open the list as soon as this turns true (used to carry on to the next line from the keyboard). */
  autoOpen?: boolean;
  onOpened?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const all = useMemo<Option[]>(
    () => [
      ...services.map((s) => ({ kind: 'service' as const, id: s.id, name: s.name, hint: `${fmtKsh(s.price)} / ${s.unit}` })),
      ...materials.map((m) => ({ kind: 'material' as const, id: m.id, name: m.name, hint: `${fmtKsh(m.price)} · ${m.stockQty} in stock`, warn: m.stockQty <= 0 })),
    ],
    [services, materials],
  );

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = words.length ? all.filter((o) => words.every((w) => o.name.toLowerCase().includes(w))) : all;
    // names that start with what was typed come first
    const first = words[0];
    return first ? [...hits].sort((a, b) => Number(b.name.toLowerCase().startsWith(first)) - Number(a.name.toLowerCase().startsWith(first))) : hits;
  }, [all, query]);
  // while nothing is typed, the person's recent picks come first
  const recents: Option[] = query.trim() ? [] : recent.map((c) => all.find((o) => o.kind === c.kind && o.id === c.id)).filter((o): o is Option => !!o).map((o) => ({ ...o, recent: true }));
  const svc = shown.filter((o) => o.kind === 'service');
  const itm = shown.filter((o) => o.kind === 'material');
  const LIMIT = 40; // only what is on screen can be arrowed to
  const flat = [...recents, ...svc.slice(0, LIMIT), ...itm.slice(0, LIMIT)];

  useEffect(() => setActive(0), [query, open]);
  useEffect(() => {
    if (autoOpen) {
      setOpen(true);
      onOpened?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen]);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const current = selected ? all.find((o) => o.kind === selected.kind && o.id === selected.id) : undefined;

  function choose(o: Option) {
    onPick({ kind: o.kind, id: o.id });
    setOpen(false);
    setQuery('');
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(flat.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (flat[active]) choose(flat[active]!);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const row = (o: Option) => {
    const i = flat.indexOf(o);
    return (
      <button
        key={(o.recent ? 'r' : '') + o.kind + o.id}
        type="button"
        onMouseEnter={() => setActive(i)}
        onClick={() => choose(o)}
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
          width: '100%',
          textAlign: 'left',
          padding: '7px 10px',
          border: 'none',
          borderBottom: '1px solid var(--color-divider)',
          background: i === active ? 'var(--color-accent)' : 'transparent',
          color: i === active ? 'var(--color-bg)' : 'var(--color-text)',
          font: 'inherit',
          cursor: 'pointer',
        }}
      >
        <span>{o.name}</span>
        <span style={{ fontSize: 11, opacity: 0.8, whiteSpace: 'nowrap', color: o.warn && i !== active ? '#a33' : undefined }}>{o.hint}</span>
      </button>
    );
  };

  const heading = (text: string) => (
    <div className="card-kicker" style={{ padding: '6px 10px', background: 'var(--color-surface)', position: 'sticky', top: 0 }}>
      {text}
    </div>
  );

  return (
    <div ref={box} style={{ position: 'relative' }}>
      {open ? (
        <input
          ref={input}
          className="input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder="Search services and items…"
          aria-label="Search the service and stock price lists"
        />
      ) : (
        <button type="button" className="input" onClick={() => setOpen(true)} style={{ textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          {current ? (
            <>
              <span>{current.name}</span>
              <span className={current.kind === 'service' ? 'tag tag-accent' : 'tag tag-outline'} style={{ fontSize: 10 }}>
                {current.kind === 'service' ? 'Service' : 'Item'}
              </span>
            </>
          ) : (
            <span className="text-muted">Pick a service or an item…</span>
          )}
        </button>
      )}
      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: '100%',
            zIndex: 30,
            maxHeight: 320,
            minWidth: 320,
            overflowY: 'auto',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-text)',
            boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
          }}
        >
          {shown.length === 0 && <div className="note" style={{ padding: '10px' }}>Nothing matches “{query}” in the service or stock price lists.</div>}
          {recents.length > 0 && heading('Recent — what you sold last')}
          {recents.map(row)}
          {svc.length > 0 && heading(`Services — Service Price List (${svc.length})`)}
          {svc.slice(0, LIMIT).map(row)}
          {svc.length > LIMIT && <div className="note" style={{ padding: '4px 10px' }}>…{svc.length - LIMIT} more — keep typing to narrow it down</div>}
          {itm.length > 0 && heading(`Items — Stock Price List (${itm.length})`)}
          {itm.slice(0, LIMIT).map(row)}
          {itm.length > LIMIT && <div className="note" style={{ padding: '4px 10px' }}>…{itm.length - LIMIT} more — keep typing to narrow it down</div>}
        </div>
      )}
    </div>
  );
}
