// Lists in Production and Quality control are kept apart by line of business: a heading per business head, with DTF Printing split into
// its film sales and artwork sales. (The API says which heading an order is under — `businessHead`.)

const DTF = 'DTF Printing';
const GENERAL = 'General Order';

function rank(head: string): number {
  if (head === `${DTF} — Film sales`) return 0;
  if (head === `${DTF} — Artwork sales`) return 1;
  if (head === DTF) return 2;
  if (head === GENERAL) return 4;
  return 3;
}

/** Rows grouped by their business head: DTF film, DTF artwork, then the other heads A–Z, General Order last. Order within a head is kept. */
export function groupByHead<T extends { businessHead: string }>(rows: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const r of rows) groups.set(r.businessHead, [...(groups.get(r.businessHead) ?? []), r]);
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
}

/** A heading row for a table. */
export function HeadRow({ head, count, cols }: { head: string; count: number; cols: number }) {
  return (
    <tr>
      <td colSpan={cols} style={{ background: 'var(--color-surface)', fontWeight: 700, paddingTop: 'var(--space-3)' }}>
        {head} <span className="text-muted">({count})</span>
      </td>
    </tr>
  );
}

/** A heading for a list that is not a table. */
export function HeadTitle({ head, count }: { head: string; count: number }) {
  return (
    <div style={{ background: 'var(--color-surface)', fontWeight: 700, padding: 'var(--space-2) var(--space-2)', marginTop: 'var(--space-3)' }}>
      {head} <span className="text-muted">({count})</span>
    </div>
  );
}
