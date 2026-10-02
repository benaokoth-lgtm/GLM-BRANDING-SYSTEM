import type { ReactNode } from 'react';
import type { DtfArtworkJob, DtfFilmSale, DtfRoll, DtfSettings } from '@glm/shared';

export interface DtfData {
  canManage: boolean;
  settings: DtfSettings;
  rolls: DtfRoll[];
  sales: DtfFilmSale[];
  jobs: DtfArtworkJob[];
}

export interface DtfTabProps {
  data: DtfData;
  reload: () => Promise<void>;
  setError: (msg: string | null) => void;
}

/** The blueprint "+" registration marks used on every card/primary button. */
export function Corners() {
  return (
    <>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
    </>
  );
}

export function Card({ title, children, noPrint }: { title?: string; children: ReactNode; noPrint?: boolean }) {
  return (
    <div className={`card blueprint${noPrint ? ' no-print' : ''}`} style={{ padding: 'var(--space-4)' }}>
      <Corners />
      {title && (
        <div className="card-title" style={{ marginBottom: 'var(--space-3)' }}>
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

export const num = (s: string) => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : 0);
export const right = { textAlign: 'right' } as const;

/** A 1px-bordered cell used for the roll/preview spec grids. */
export function Spec({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-2) var(--space-3)', margin: '0 -1px -1px 0' }}>
      <div style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-text-muted)', fontWeight: 700 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 19, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}
