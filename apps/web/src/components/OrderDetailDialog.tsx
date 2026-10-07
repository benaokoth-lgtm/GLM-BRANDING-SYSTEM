import { useEffect, useState } from 'react';
import { STAGES, fmtDate, fmtKsh, whatsappNumber } from '@glm/shared';
import type { OrderStage } from '@glm/shared';
import { api } from '../api/client';
import type { CompanySettings, OrderDetail } from '../api/models';
import { buildCorporateDocumentHtml, printCorporateDocument, printOrderDocument } from '../utils/printInvoice';
import { documentLabel, documentTitleCase, orderContact, whatsappMessage } from '../utils/shareOrder';
import SplitPayments, { newPaymentRow, paymentProblem, toApiPayments } from './SplitPayments';
import OutsourcedCostingPanel from './OutsourcedCostingPanel';
import { useAuth } from '../state/AuthContext';
import type { PaymentRow } from './SplitPayments';

interface Props {
  orderId: number;
  onClose: () => void;
  onChanged: () => void;
}

export default function OrderDetailDialog({ orderId, onClose, onChanged }: Props) {
  const { user } = useAuth();
  // Supplier costs and mark-ups are only for people who can see costs; the server withholds them from everyone else.
  const seeCosts = user?.role === 'Admin' || !!user?.permissions.canSeeCosts;
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [company, setCompany] = useState<CompanySettings | null>(null);
  // Payments can be split across methods (part cash, part M-Pesa…) — see components/SplitPayments.tsx.
  const [paymentRows, setPaymentRows] = useState<PaymentRow[]>(() => [newPaymentRow()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmCredit, setConfirmCredit] = useState(false);

  // Sending the document to the customer: by email (the A4 document) or WhatsApp (a message to their number). One panel, opened from the buttons
  // beside Print; the recipient is filled in from the order when we have it and can always be typed.
  const [sharePanel, setSharePanel] = useState<'email' | 'whatsapp' | null>(null);
  const [emailTo, setEmailTo] = useState('');
  const [waTo, setWaTo] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  function load() {
    api.get<OrderDetail>(`/orders/${orderId}`).then(setDetail).catch((err) => setError(err.message));
  }

  useEffect(load, [orderId]);
  useEffect(() => {
    api.get<CompanySettings>('/master-data/settings').then(setCompany);
  }, []);

  useEffect(() => {
    if (!detail) return;
    const c = orderContact(detail);
    setEmailTo(c.email);
    setWaTo(c.phone);
  }, [detail]);

  async function recordPayment() {
    const payments = toApiPayments(paymentRows);
    if (payments.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/orders/${orderId}/payments`, { payments });
      setPaymentRows([newPaymentRow()]);
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record payment');
    } finally {
      setBusy(false);
    }
  }

  // The only way an order is completed: handing it to the customer after it has passed quality control. Normally that needs it
  // paid in full; "on credit" releases it with a balance and turns it into an invoice.
  async function handOver(onCredit = false) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/orders/${orderId}/handover`, { onCredit });
      setConfirmCredit(false);
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not hand the order over');
    } finally {
      setBusy(false);
    }
  }

  async function convert() {
    setBusy(true);
    try {
      await api.post(`/orders/${orderId}/convert`);
      load();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function print() {
    if (!detail) return;
    // Open the popup synchronously (no await before this) so browser popup
    // blockers don't treat it as an unsolicited window; fill it in once the
    // company profile (name/address/logo) has loaded.
    const w = window.open('', '_blank');
    const co = company ?? (await api.get<CompanySettings>('/master-data/settings'));
    // A walk-in order (paid or not) prints on the thermal receipt printer, two copies; corporate invoices and quotations print on A4.
    printOrderDocument(w, detail, co);
  }

  // A walk-in order that still owes a balance is an invoice: it can also be printed on A4, in the house layout.
  async function printA4() {
    if (!detail) return;
    const w = window.open('', '_blank');
    const co = company ?? (await api.get<CompanySettings>('/master-data/settings'));
    printCorporateDocument(w, detail, co);
  }

  async function sendEmail() {
    if (!detail || !company) return;
    if (!emailTo.trim()) return setError('Enter a recipient email address');
    setError(null);
    setEmailBusy(true);
    setEmailSent(false);
    try {
      const html = buildCorporateDocumentHtml(detail, company);
      await api.post('/email/send', { orderId: detail.id, to: emailTo.trim(), subject: `${documentTitleCase(detail)} ${detail.orderNo} — ${company.companyName}`, html });
      setEmailSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send email');
    } finally {
      setEmailBusy(false);
    }
  }

  function sendWhatsapp() {
    if (!detail) return;
    const number = whatsappNumber(waTo);
    if (!number) return setError('Enter the customer\'s WhatsApp number, like 0797 785 033');
    setError(null);
    window.open(`https://wa.me/${number}?text=${encodeURIComponent(whatsappMessage(detail, company))}`, '_blank');
  }

  if (!detail) {
    return (
      <div className="dialog-backdrop">
        <div className="dialog blueprint">
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          <p className="note">Loading…</p>
        </div>
      </div>
    );
  }

  const clientLabel = detail.kind === 'corporate' ? detail.corporateClient?.name ?? '—' : detail.customerName ?? '—';

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog blueprint"
        style={{ maxWidth: 760, width: '92vw', maxHeight: '88vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div className="dialog-title">
          Order {detail.orderNo} <span className={detail.status === 'Quote' ? 'tag tag-outline' : 'tag tag-accent'}>{detail.status}</span>
        </div>
        <div className="dialog-body">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
            <div>
              <div className="card-kicker">Client</div>
              <div>{clientLabel}</div>
            </div>
            <div>
              <div className="card-kicker">Staff</div>
              <div>{detail.staff.name}</div>
            </div>
            <div>
              <div className="card-kicker">Created</div>
              <div>{fmtDate(detail.createdDate)}</div>
            </div>
          </div>
          {detail.priceApproval === 'Pending' && (
            <p className="note" style={{ borderLeft: '2px solid #a33', paddingLeft: 'var(--space-2)' }}>
              <span className="tag tag-outline">Awaiting price approval</span> This artwork job is priced below the recommended price. A manager has to approve it before it can be paid for or produced.
            </p>
          )}
          {detail.salesSource === 'freelance' && detail.freelanceAgentName && (
            <p className="note" style={{ marginTop: 'calc(-1 * var(--space-2))' }}>
              Credited to freelance sales person <b>{detail.freelanceAgentName}</b> — they are paid weekly on this order (at or above base prices). No staff member earns commission on it.
            </p>
          )}
          {detail.salesSource === 'sourced' && detail.sourcedByName && (
            <p className="note" style={{ marginTop: 'calc(-1 * var(--space-2))' }}>
              Credited to <b>{detail.sourcedByName}</b> — their sourced client, so this order counts towards their commission.
            </p>
          )}

          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Qty</th>
                <th>Unit price</th>
                <th>Discount</th>
                <th>Line total</th>
              </tr>
            </thead>
            <tbody>
              {detail.lineItems.map((li) => (
                <tr key={li.id}>
                  <td>
                    {[li.serviceName, li.materialName].filter(Boolean).join(' + ')}
                    {li.outsourced && (
                      <div style={{ fontSize: 11 }}>
                        <span className="tag tag-outline">Contracted out</span> {seeCosts && li.needsCosting && <span className="tag tag-outline" style={{ borderColor: '#a33', color: '#a33' }}>needs supplier quote</span>}
                      </div>
                    )}
                    {li.artworkAreaSqm != null && (
                      <div className="text-muted" style={{ fontSize: 11 }}>
                        Artwork: {li.artworkAreaSqm} sqm × {li.qty} pcs
                      </div>
                    )}
                    {li.heatPressFee != null && (
                      <div className="text-muted" style={{ fontSize: 11 }}>
                        Heat press fee: {fmtKsh(li.heatPressFee)}/pc
                      </div>
                    )}
                  </td>
                  <td>{li.qty}</td>
                  <td>{fmtKsh(li.unitPrice)}</td>
                  <td>
                    {li.discountPct}% / {fmtKsh(li.discountAmt)}
                  </td>
                  <td>{fmtKsh(li.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-6)', margin: 'var(--space-3) 0', fontFamily: 'var(--font-heading)' }}>
            <div>Subtotal: {fmtKsh(detail.totals.subtotal)}</div>
            <div>Order discount: {fmtKsh(detail.totals.orderDiscount)}</div>
            <div>Grand total: {fmtKsh(detail.totals.grandTotal)}</div>
          </div>

          {seeCosts && detail.lineItems.some((l) => l.outsourced) && <OutsourcedCostingPanel orderId={orderId} onChanged={onChanged} />}

          <div
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: 11,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              opacity: 0.65,
              margin: 'var(--space-4) 0 var(--space-2)',
            }}
          >
            Production stage
          </div>
          {detail.status === 'Quote' ? (
            <p className="note">A quotation is not in production yet — it starts once the client accepts it.</p>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                {STAGES.map((st) => (
                  <span key={st} className={'tag ' + (detail.stage === st ? 'tag-accent' : 'tag-outline')} style={detail.stage === st ? { fontWeight: 700 } : { opacity: 0.55 }}>
                    {st}
                  </span>
                ))}
              </div>
              <p className="note" style={{ marginTop: 'var(--space-2)' }}>
                {detail.stage === 'Order Received' && 'Waiting for Production to assign it to a staff member.'}
                {detail.stage === 'In Production' && 'Being made. When it is finished it goes to Quality Control.'}
                {detail.stage === 'Quality Check' && 'Made — waiting for a quality inspection.'}
                {detail.stage === 'Ready for Pickup/Delivery' && 'Passed quality control — ready for the customer.'}
                {detail.stage === 'Completed' && 'Handed over to the customer.'}
              </p>
              {detail.stage === 'Ready for Pickup/Delivery' &&
                (detail.totals.balanceDue <= 0.009 ? (
                  <button type="button" className="btn btn-primary blueprint" onClick={() => handOver(false)} disabled={busy}>
                    <i className="corner tl"></i>
                    <i className="corner tr"></i>
                    <i className="corner bl"></i>
                    <i className="corner br"></i>
                    Hand over to customer (complete the order)
                  </button>
                ) : (
                  <div style={{ border: '1px solid var(--color-divider)', padding: 'var(--space-3)' }}>
                    <p style={{ margin: 0 }}>
                      <strong>{fmtKsh(detail.totals.balanceDue)} is still owing.</strong> Take the payment below and the order can be handed over — or release it on credit.
                    </p>
                    {!confirmCredit ? (
                      <button type="button" className="btn btn-secondary" style={{ marginTop: 'var(--space-2)' }} onClick={() => setConfirmCredit(true)} disabled={busy}>
                        Hand over on credit…
                      </button>
                    ) : (
                      <div style={{ marginTop: 'var(--space-2)' }}>
                        <p className="note">
                          The customer takes the order now and it is <strong>converted to an invoice</strong> for the {fmtKsh(detail.totals.balanceDue)} still owing — due{' '}
                          {detail.status === 'Invoice' && detail.dueDate && detail.dueDate >= new Date().toISOString().slice(0, 10) ? fmtDate(detail.dueDate) : 'after the credit terms'}, and
                          collected through Accounts Receivable.
                        </p>
                        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                          <button type="button" className="btn btn-primary" onClick={() => handOver(true)} disabled={busy}>
                            Hand over &amp; convert to invoice
                          </button>
                          <button type="button" className="btn btn-ghost" onClick={() => setConfirmCredit(false)} disabled={busy}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
            </>
          )}

          <div
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: 11,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              opacity: 0.65,
              margin: 'var(--space-4) 0 var(--space-2)',
            }}
          >
            Payments
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Amount</th>
                <th>Method</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              {detail.payments.map((p) => (
                <tr key={p.id}>
                  <td className="text-muted">{fmtDate(p.date)}</td>
                  <td>{fmtKsh(p.amount)}</td>
                  <td>{p.method}</td>
                  <td className="text-muted">{p.reference || (p.method === 'M-Pesa' ? 'no code' : '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {detail.payments.length === 0 && <p className="note">No payments recorded yet.</p>}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--space-3)' }}>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 18 }}>Balance due: {fmtKsh(detail.totals.balanceDue)}</div>
            {detail.overdue && <span className="tag tag-accent">Overdue — due {fmtDate(detail.dueDate)}</span>}
          </div>

          {error && (
            <p className="note" style={{ color: '#a33' }}>
              {error}
            </p>
          )}

          {detail.totals.balanceDue > 0 && detail.canTakePayment !== false && (
            <div style={{ marginTop: 'var(--space-3)' }}>
              <div className="card-kicker" style={{ marginBottom: 'var(--space-2)' }}>
                Record payment — split across methods if needed
              </div>
              <SplitPayments
                rows={paymentRows}
                onChange={setPaymentRows}
                total={detail.totals.balanceDue}
                phone={detail.phone || detail.corporateClient?.phone || ''}
                accountReference={detail.orderNo}
              />
              {paymentProblem(paymentRows, detail.totals.balanceDue) && (
                <p className="note" style={{ color: '#a33' }}>
                  {paymentProblem(paymentRows, detail.totals.balanceDue)}
                </p>
              )}
              <button
                type="button"
                className="btn btn-secondary blueprint"
                style={{ marginTop: 'var(--space-3)' }}
                onClick={recordPayment}
                disabled={busy || toApiPayments(paymentRows).length === 0 || !!paymentProblem(paymentRows, detail.totals.balanceDue)}
              >
                <i className="corner tl"></i>
                <i className="corner tr"></i>
                <i className="corner bl"></i>
                <i className="corner br"></i>
                Record payment
              </button>
            </div>
          )}

          {detail.status === 'Quote' && (
            <div style={{ marginTop: 'var(--space-4)', borderTop: '1px solid var(--color-divider)', paddingTop: 'var(--space-3)' }}>
              <button type="button" className="btn btn-primary btn-block blueprint" onClick={convert} disabled={busy}>
                <i className="corner tl"></i>
                <i className="corner tr"></i>
                <i className="corner bl"></i>
                <i className="corner br"></i>
                Convert quotation to invoice
              </button>
              <p className="note" style={{ marginTop: 'var(--space-2)' }}>
                Only needed if the client accepts with nothing paid upfront — recording any payment above (a deposit)
                converts this quotation to an invoice automatically.
              </p>
            </div>
          )}

        </div>
        {sharePanel && (
          <div className="no-print" style={{ borderTop: '1px solid var(--color-divider)', padding: 'var(--space-3) var(--space-4)' }}>
            <div style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', opacity: 0.65, marginBottom: 'var(--space-2)' }}>
              {sharePanel === 'email' ? `Email this ${documentLabel(detail)}` : `Send this ${documentLabel(detail)} on WhatsApp`}
            </div>
            {sharePanel === 'email' ? (
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                <input className="input" type="email" style={{ flex: '1 1 240px', maxWidth: 320 }} value={emailTo} onChange={(e) => { setEmailTo(e.target.value); setEmailSent(false); }} placeholder="customer@example.com" autoFocus />
                <button type="button" className="btn btn-primary" onClick={sendEmail} disabled={emailBusy || !emailTo.trim()}>
                  {emailBusy ? 'Sending…' : 'Send email'}
                </button>
                {emailSent && <span className="tag tag-accent">Sent</span>}
                <span className="note" style={{ margin: 0 }}>Sends the A4 {documentLabel(detail)} itself.</span>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                <input className="input" type="tel" style={{ flex: '1 1 200px', maxWidth: 240 }} value={waTo} onChange={(e) => setWaTo(e.target.value)} placeholder="0797 785 033" autoFocus />
                <button type="button" className="btn btn-primary" onClick={sendWhatsapp} disabled={!waTo.trim()}>
                  Open WhatsApp
                </button>
                <span className="note" style={{ margin: 0 }}>Opens WhatsApp with the message ready to send — the figures, the balance and how to reach us. WhatsApp cannot attach the document; email or print it for that.</span>
              </div>
            )}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className={'btn blueprint ' + (sharePanel === 'email' ? 'btn-primary' : 'btn-secondary')} onClick={() => { setSharePanel(sharePanel === 'email' ? null : 'email'); setEmailSent(false); }}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            ✉️ Email {documentLabel(detail)}
          </button>
          <button type="button" className={'btn blueprint ' + (sharePanel === 'whatsapp' ? 'btn-primary' : 'btn-secondary')} onClick={() => setSharePanel(sharePanel === 'whatsapp' ? null : 'whatsapp')}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            💬 WhatsApp {documentLabel(detail)}
          </button>
          <button type="button" className="btn btn-secondary blueprint" onClick={print}>

            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            {detail.kind === 'walkin' ? '🖶 Print receipt (2 copies)' : detail.status === 'Quote' ? '🖶 Print quotation (A4)' : '🖶 Print invoice (A4)'}
          </button>
          {detail.kind === 'walkin' && detail.status === 'Invoice' && (
            <button type="button" className="btn btn-secondary blueprint" onClick={printA4}>
              <i className="corner tl"></i>
              <i className="corner tr"></i>
              <i className="corner bl"></i>
              <i className="corner br"></i>
              🖶 Print invoice (A4)
            </button>
          )}
          <button type="button" className="btn btn-secondary blueprint" onClick={onClose}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
