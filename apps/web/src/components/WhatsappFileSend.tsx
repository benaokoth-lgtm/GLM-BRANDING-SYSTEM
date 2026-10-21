import { useRef, useState } from 'react';
import { api } from '../api/client';

// The paperclip: pick any file (a PDF, a picture of the artwork, a Word or Excel file) and send it straight to a customer's WhatsApp number from the system. Used under an order's WhatsApp
// panel (the file is logged against the order) and on the Send a document screen. A PDF goes through the approved template; a picture or other file is a plain message, which WhatsApp
// accepts only within 24 hours of the customer writing to us.

export const WHATSAPP_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx,.txt,application/pdf,image/jpeg,image/png,image/webp';
const MAX_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
};
const mimeOf = (f: File) => MIME_BY_EXT[f.name.split('.').pop()?.toLowerCase() ?? ''] ?? f.type;

const toBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('Could not read that file'));
    r.readAsDataURL(f);
  });

const size = (n: number) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

export default function WhatsappFileSend({
  to,
  customer,
  orderId,
  onError,
  onSent,
  compact,
}: {
  to: string;
  customer?: string;
  orderId?: number;
  onError: (message: string | null) => void;
  onSent?: (message: string) => void;
  compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  function pick(f: File | undefined) {
    setDone(null);
    if (!f) return;
    if (!mimeOf(f) || !Object.values(MIME_BY_EXT).includes(mimeOf(f))) return onError('That kind of file cannot be sent on WhatsApp. Use a PDF, a picture (JPG, PNG, WebP), a Word or Excel file, or a text file.');
    if (f.size > MAX_BYTES) return onError('That file is over 10 MB. Send a smaller one (compress the PDF or the picture).');
    if (f.type.startsWith('image/') && f.size > 5 * 1024 * 1024) return onError('WhatsApp accepts pictures up to 5 MB. Send a smaller picture, or send it as a PDF.');
    onError(null);
    setFile(f);
  }

  async function send() {
    if (!file) return;
    onError(null);
    setBusy(true);
    try {
      const r = await api.post<{ to: string; mode: string }>('/whatsapp/send-file', {
        to: to.trim(),
        filename: file.name,
        mime: mimeOf(file),
        data: await toBase64(file),
        customer: customer?.trim() || undefined,
        message: message.trim() || undefined,
        orderId,
      });
      const text = `Sent ${file.name} to +${r.to}.`;
      setDone(text);
      onSent?.(text);
      setFile(null);
      setMessage('');
      if (input.current) input.current.value = '';
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not send the file on WhatsApp');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center', flexBasis: '100%' }}>
      <input ref={input} type="file" accept={WHATSAPP_ACCEPT} style={{ display: 'none' }} onChange={(e) => pick(e.target.files?.[0])} />
      <button type="button" className="btn btn-secondary" onClick={() => input.current?.click()} disabled={busy}>
        📎 {file ? 'Change file' : 'Attach a file'}
      </button>
      {file && (
        <span className="tag tag-accent" title={file.name}>
          {file.name.length > 34 ? file.name.slice(0, 31) + '…' : file.name} · {size(file.size)}
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Remove the file" onClick={() => { setFile(null); if (input.current) input.current.value = ''; }} style={{ marginLeft: 6 }}>
            ✕
          </button>
        </span>
      )}
      {file && !compact && (
        <input className="input" style={{ flex: '1 1 220px', maxWidth: 360 }} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={600} placeholder="Message to go with it (optional)" />
      )}
      {file && (
        <button type="button" className="btn btn-primary" onClick={send} disabled={busy || !to.trim()}>
          {busy ? 'Sending…' : 'Send the file now'}
        </button>
      )}
      {done && <span className="tag tag-accent">{done}</span>}
      <span className="note" style={{ margin: 0, flexBasis: '100%' }}>
        A <b>PDF</b> reaches any customer. A <b>picture</b> or Word/Excel file is delivered only if the customer has written to us in the last 24 hours. Up to 10 MB (pictures 5 MB).
      </span>
    </div>
  );
}
