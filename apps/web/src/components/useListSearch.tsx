import { useEffect, useState } from 'react';
import { fmtDate } from '@glm/shared';

// A search by order number and/or date, and 10 rows to a page, for a list of orders or jobs held in the browser. The search works like the one on All
// Orders: an order number (any part of it, with or without the dash: "1020", "w-1020"), and a date, which is that day alone, or with a second date the
// range from one to the other. Use it with a list, and put \`searchBar\` above the table and \`pager\` below it.

const squash = (v: string) => v.toLowerCase().replace(/[\s-]+/g, '');

export function useListSearch<T>(
  rows: T[],
  orderNoOf: (r: T) => string,
  /** The row's date as YYYY-MM-DD ('' when it has none). */
  dateOf: (r: T) => string,
  opts: { id: string; dateLabel?: string; pageSize?: number },
) {
  const pageSize = opts.pageSize ?? 10;
  const [orderQ, setOrderQ] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);

  const q = squash(orderQ);
  const from = dateFrom && dateTo && dateFrom > dateTo ? dateTo : dateFrom;
  const to = dateFrom && dateTo && dateFrom > dateTo ? dateFrom : dateTo;
  const searching = !!q || !!dateFrom || !!dateTo;
  const found = rows.filter((r) => {
    if (q && !squash(orderNoOf(r)).includes(q)) return false;
    const d = dateOf(r);
    if (from && !to) return d === from; // one date: that day
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
  const pageCount = Math.max(1, Math.ceil(found.length / pageSize));
  const thisPage = Math.min(page, pageCount);
  const pageRows = found.slice((thisPage - 1) * pageSize, thisPage * pageSize);
  const when = from && to ? (from === to ? ` on ${fmtDate(from)}` : ` between ${fmtDate(from)} and ${fmtDate(to)}`) : from ? ` on ${fmtDate(from)}` : to ? ` up to ${fmtDate(to)}` : '';

  // back to the first page whenever what is being looked for changes
  useEffect(() => setPage(1), [orderQ, dateFrom, dateTo]);

  const searchBar = (
    <div className="no-print" style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 'var(--space-3)' }}>
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor={`${opts.id}-q`}>Order number</label>
        <input id={`${opts.id}-q`} className="input" style={{ width: 170 }} value={orderQ} onChange={(e) => setOrderQ(e.target.value)} placeholder="e.g. W-1020 or 1020" autoComplete="off" />
      </div>
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor={`${opts.id}-from`}>{opts.dateLabel ?? 'Date'}</label>
        <input id={`${opts.id}-from`} className="input" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
      </div>
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor={`${opts.id}-to`}>to (optional)</label>
        <input id={`${opts.id}-to`} className="input" type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} />
      </div>
      {searching && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setOrderQ(''); setDateFrom(''); setDateTo(''); }}>
          Clear search
        </button>
      )}
      <span className="note" style={{ margin: 0 }}>
        {searching ? `${found.length} found${when}` : 'Search by order number, by date, or both. One date is that day; add a second for a range.'}
      </span>
    </div>
  );

  const pager =
    found.length > 0 ? (
      <div className="no-print" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', marginTop: 'var(--space-3)' }}>
        <span className="note" style={{ margin: 0 }}>
          Showing {(thisPage - 1) * pageSize + 1}–{Math.min(thisPage * pageSize, found.length)} of {found.length}
        </span>
        {pageCount > 1 && (
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPage(1)} disabled={thisPage === 1} aria-label="First page">
              «
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPage(thisPage - 1)} disabled={thisPage === 1}>
              ‹ Previous
            </button>
            <span style={{ minWidth: 96, textAlign: 'center' }}>
              Page {thisPage} of {pageCount}
            </span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPage(thisPage + 1)} disabled={thisPage === pageCount}>
              Next ›
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPage(pageCount)} disabled={thisPage === pageCount} aria-label="Last page">
              »
            </button>
          </div>
        )}
      </div>
    ) : null;

  return { found, pageRows, searchBar, pager, searching };
}

/** A date-and-time as the YYYY-MM-DD day it falls on in the viewer's own time. */
export const localDay = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleDateString('en-CA') : '');
