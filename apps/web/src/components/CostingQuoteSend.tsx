import { useEffect, useState } from 'react';
import { whatsappNumber } from '@glm/shared';
import { api, fetchFile } from '../api/client';
import type { CompanySettings, OrderDetail } from '../api/models';
import { printCorporateDocument } from '../utils/printInvoice';
import { whatsappMessage } from '../utils/shareOrder';

// Sales → Job Costing → Saved quotes: print, email or WhatsApp a quote as the house quotation — the same document, and the same Email, WhatsApp and Print buttons, as an invoice or
// quotation in Finance. The document is built by the server from the saved quote (costingDocument.ts): the price the client is quoted (the agreed price once there is one), never the cost.

export default function CostingQuoteSend({ quoteId, defaultPhone, onError }: { quoteId: number; defaultPhone: string; onError: (message: string | null) => void }) {
  const [panel, setPanel] = useState<'email' | 'whatsapp' | null>(null);
  const [company, setCompany] = useState<CompanySettings | null>(null);
  const [doc, setDoc] = useState<OrderDetail | null>(null);
  const [emailTo, setEmailTo] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [waTo, setWaTo] = useState(defaultPhone);
  const [waFile, setWaFile] = useState<File | null>(null);
  const [waReady, setWaReady] = useState(false);
  const [waBusy, setWaBusy] = useState(false);
  const [waNote, setWaNote] = useState<string | null>(null);
  const [waLog, setWaLog] = useState<{ id: number; to: string; status: string; sentByName: string; at: string }[]>([]);

  useEffect(() => {
    api.get<CompanySettings>('/master-data/settings').then(setCompany).catch(() => undefined);
  }, []);

  // the document as it is now (the agreed price may have been recorded since the quote was opened): fetched when a panel opens
  useEffect(() => {
    if (!panel) return;
    api.get<OrderDetail>(`/costing/quotes/${quoteId}/document`).then(setDoc).catch(() => setDoc(null));
  }, [panel, quoteId]);

  // The PDF is fetched as soon as the WhatsApp panel opens, so pressing the button can hand it over at once (a browser only lets a file be shared in direct response to a tap).
  useEffect(() => {
    if (panel !== 'whatsapp') return;
    let live = true;
    setWaFile(null);
    fetchFile(`/costing/quotes/${quoteId}/pdf`, 'Quotation.pdf')
      .then((f) => live && setWaFile(f))
      .catch(() => live && setWaFile(null));
    api.get<{ ready: boolean }>('/whatsapp/status').then((r) => live && setWaReady(r.ready)).catch(() => setWaReady(false));
    api.get<typeof waLog>(`/whatsapp/log?costingQuoteId=${quoteId}`).then((l) => live && setWaLog(l)).catch(() => setWaLog([]));
    return () => {
      live = false;
    };
  }, [panel, quoteId]);

  async function print() {
    // the popup opens synchronously, before any await, so a popup blocker does not take it for an unsolicited window
    const w = window.open('', '_blank');
    onError(null);
    try {
      const [d, co] = await Promise.all([api.get<OrderDetail>(`/costing/quotes/${quoteId}/document`), company ? Promise.resolve(company) : api.get<CompanySettings>('/master-data/settings')]);
      printCorporateDocument(w, d, co);
    } catch (e) {
      w?.close();
      onError(e instanceof Error ? e.message : 'Could not prepare the quotation');
    }
  }

  async function sendEmail() {
    if (!emailTo.trim()) return onError('Enter a recipient email address');
    onError(null);
    setEmailBusy(true);
    setEmailSent(false);
    try {
      await api.post('/email/send', { costingQuoteId: quoteId, to: emailTo.trim(), subject: `Quotation ${doc?.orderNo ?? ''} — ${company?.companyName ?? ''}`.replace(/\s+—\s*$/, '').replace(/\s{2,}/g, ' ') });
      setEmailSent(true);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Failed to send email');
    } finally {
      setEmailBusy(false);
    }
  }

  async function sendWhatsappDirect() {
    onError(null);
    setWaNote(null);
    setWaBusy(true);
    try {
      const r = await api.post<{ to: string }>('/whatsapp/send', { costingQuoteId: quoteId, to: waTo.trim() || undefined });
      setWaNote(`Sent to +${r.to} as a PDF.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not send it on WhatsApp');
    } finally {
      setWaBusy(false);
      api.get<typeof waLog>(`/whatsapp/log?costingQuoteId=${quoteId}`).then(setWaLog).catch(() => undefined);
    }
  }

  const message = () => (doc ? whatsappMessage(doc, company) : '');

  async function sendWhatsappShare() {
    if (!waFile) return;
    onError(null);
    if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [waFile] })) {
      try {
        await navigator.share({ files: [waFile], text: message(), title: waFile.name });
      } catch (e) {
        if (!(e instanceof DOMException && e.name === 'AbortError')) onError('Could not open the share sheet. Use "Save the PDF and open the chat" instead.');
      }
      return;
    }
    saveAndOpenChat();
  }

  function saveAndOpenChat() {
    if (!waFile) return;
    const number = whatsappNumber(waTo);
    if (!number) return onError("Enter the customer's WhatsApp number, like 0797 785 033");
    onError(null);
    const url = URL.createObjectURL(waFile);
    const a = document.createElement('a');
    a.href = url;
    a.download = waFile.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    window.open(`https://wa.me/${number}?text=${encodeURIComponent(message())}`, '_blank');
  }

  function sendWhatsappText() {
    const number = whatsappNumber(waTo);
    if (!number) return onError("Enter the customer's WhatsApp number, like 0797 785 033");
    onError(null);
    window.open(`https://wa.me/${number}?text=${encodeURIComponent(message())}`, '_blank');
  }

  const corners = (
    <>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
    </>
  );

  return (
    <div>
      {panel && (
        <div style={{ borderTop: '1px solid var(--color-divider)', padding: 'var(--space-3) 0' }}>
          <div style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', opacity: 0.65, marginBottom: 'var(--space-2)' }}>
            {panel === 'email' ? 'Email this quotation' : 'Send this quotation on WhatsApp'}
          </div>
          {panel === 'email' ? (
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
              <input className="input" type="email" style={{ flex: '1 1 240px', maxWidth: 320 }} value={emailTo} onChange={(e) => { setEmailTo(e.target.value); setEmailSent(false); }} placeholder="customer@example.com" autoFocus />
              <button type="button" className="btn btn-primary" onClick={sendEmail} disabled={emailBusy || !emailTo.trim()}>
                {emailBusy ? 'Sending…' : 'Send email'}
              </button>
              {emailSent && <span className="tag tag-accent">Sent</span>}
              <span className="note" style={{ margin: 0 }}>Sent as a PDF attachment: the A4 quotation.</span>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
              <input className="input" type="tel" style={{ flex: '1 1 200px', maxWidth: 240 }} value={waTo} onChange={(e) => setWaTo(e.target.value)} placeholder="0797 785 033" autoFocus />
              {waReady && (
                <button type="button" className="btn btn-primary" onClick={sendWhatsappDirect} disabled={waBusy || !waTo.trim()}>
                  {waBusy ? 'Sending…' : 'Send to the customer now'}
                </button>
              )}
              <button type="button" className={'btn ' + (waReady ? 'btn-secondary' : 'btn-primary')} onClick={sendWhatsappShare} disabled={!waFile}>
                {waFile ? 'Share the PDF from this device' : 'Preparing the PDF…'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={saveAndOpenChat} disabled={!waFile || !waTo.trim()}>
                Save the PDF and open the chat
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={sendWhatsappText} disabled={!waTo.trim() || !doc}>
                Message only
              </button>
              {waNote && <span className="tag tag-accent">{waNote}</span>}
              {waLog.length > 0 && (
                <span className="note" style={{ margin: 0, flexBasis: '100%' }}>
                  WhatsApp history: {waLog.slice(0, 3).map((l) => `${l.status === 'Sent' ? 'sent' : 'failed'} to +${l.to} by ${l.sentByName} (${new Date(l.at).toLocaleString('en-KE', { dateStyle: 'short', timeStyle: 'short' })})`).join(' · ')}
                </span>
              )}
              <span className="note" style={{ margin: 0 }}>
                {waReady && <><b>Send to the customer now</b> sends the PDF from the system straight to the number above. </>}
                <b>Share the PDF from this device</b> opens your device's share list with the PDF and the message: choose WhatsApp, then the customer. Where the device has no share list, <b>Save the PDF and open the chat</b> saves it and opens the customer's chat for you to attach it with the paperclip.
              </span>
            </div>
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <button type="button" className={'btn blueprint ' + (panel === 'email' ? 'btn-primary' : 'btn-secondary')} onClick={() => { setPanel(panel === 'email' ? null : 'email'); setEmailSent(false); }}>
          {corners}✉️ Email quotation
        </button>
        <button type="button" className={'btn blueprint ' + (panel === 'whatsapp' ? 'btn-primary' : 'btn-secondary')} onClick={() => setPanel(panel === 'whatsapp' ? null : 'whatsapp')}>
          {corners}💬 WhatsApp quotation
        </button>
        <button type="button" className="btn btn-secondary blueprint" onClick={print}>
          {corners}🖶 Print quotation (A4)
        </button>
      </div>
    </div>
  );
}
