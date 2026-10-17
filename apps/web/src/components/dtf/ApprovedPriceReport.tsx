import { useEffect, useState } from 'react';
import type { DtfProduct } from '@glm/shared';
import { fmtDate, fmtKsh, fmtNum } from '@glm/shared';
import { api } from '../../api/client';
import { Card, Field } from './shared';

// DTF → Price Approvals → the report of every approved price change: when it was asked for, the price the system suggested (the recommended price per piece), the price that was approved,
// and who asked and who approved. Filter by the day it was requested; newest first. Print it, or download it as a spreadsheet (CSV).

interface Row {
  id: number;
  orderNo: string;
  kind?: 'artwork' | 'embroidery';
  rollId: string;
  client: string;
  pieces: number;
  systemPerPiece: number;
  chargedPerPiece: number;
  shortfall: number;
  pctBelow: number;
  requestedByName: string;
  requestedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
}
interface Report {
  rows: Row[];
  count: number;
  totalDiscount: number;
}

const csvCell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;

export default function ApprovedPriceReport({ product, refreshKey }: { product: DtfProduct; refreshKey: string }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const q = new URLSearchParams({ product });
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    setError('');
    api
      .get<Report>(`/dtf/approvals/report?${q.toString()}`)
      .then(setReport)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the report'));
  }, [product, from, to, refreshKey]);

  function download() {
    if (!report) return;
    const head = ['Date requested', 'Order', 'Roll / job', 'Client', 'Pieces', 'Suggested price / piece', 'Approved price / piece', 'Below suggested %', 'Discount', 'Requested by', 'Approved by', 'Date approved'];
    const lines = report.rows.map((r) => [r.requestedAt.slice(0, 10), r.orderNo, r.kind === 'embroidery' ? 'Embroidery' : r.rollId, r.client, r.pieces, r.systemPerPiece, r.chargedPerPiece, r.pctBelow, r.shortfall, r.requestedByName, r.decidedByName ?? '', r.decidedAt?.slice(0, 10) ?? '']);
    const csv = [head, ...lines].map((l) => l.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `approved-price-changes-${product}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card title={`Approved price changes${report ? ` (${report.count})` : ''}`}>
      <div className="no-print" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
        <Field label="Requested from">
          <input className="input" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="Requested from" />
        </Field>
        <Field label="to">
          <input className="input" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="Requested to" />
        </Field>
        {(from || to) && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setFrom(''); setTo(''); }}>
            All dates
          </button>
        )}
        <button type="button" className="btn btn-secondary btn-sm" disabled={!report || report.count === 0} onClick={download}>
          Download (CSV)
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!report || report.count === 0} onClick={() => window.print()}>
          Print
        </button>
      </div>
      {error && <p className="note" style={{ color: 'var(--color-error)' }}>{error}</p>}
      {!report ? (
        <p className="note">Loading…</p>
      ) : report.count === 0 ? (
        <p className="note" style={{ margin: 0 }}>No price change has been approved{from || to ? ' in these dates' : ' yet'}.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ whiteSpace: 'nowrap' }}>
            <thead>
              <tr>
                <th>Date requested</th>
                <th>Order</th>
                <th>Roll / job</th>
                <th>Client</th>
                <th style={{ textAlign: 'right' }}>Pieces</th>
                <th style={{ textAlign: 'right' }}>Suggested price / piece</th>
                <th style={{ textAlign: 'right' }}>Approved price / piece</th>
                <th style={{ textAlign: 'right' }}>Below suggested</th>
                <th style={{ textAlign: 'right' }}>Discount</th>
                <th>Requested by</th>
                <th>Approved by</th>
                <th>Date approved</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDate(r.requestedAt.slice(0, 10))}</td>
                  <td>{r.orderNo}</td>
                  <td>{r.kind === 'embroidery' ? 'Embroidery' : r.rollId}</td>
                  <td>{r.client}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNum(r.pieces)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNum(r.systemPerPiece, 2)}</td>
                  <td style={{ textAlign: 'right' }}><b>{fmtNum(r.chargedPerPiece, 2)}</b></td>
                  <td style={{ textAlign: 'right' }}>{fmtNum(r.pctBelow, 1)}%</td>
                  <td style={{ textAlign: 'right' }}>{fmtKsh(r.shortfall)}</td>
                  <td>{r.requestedByName}</td>
                  <td>{r.decidedByName}</td>
                  <td>{r.decidedAt ? fmtDate(r.decidedAt.slice(0, 10)) : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={8}><b>Total given away in {report.count} approved {report.count === 1 ? 'price' : 'prices'}</b></td>
                <td style={{ textAlign: 'right' }}><b>{fmtKsh(report.totalDiscount)}</b></td>
                <td colSpan={3}></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}
