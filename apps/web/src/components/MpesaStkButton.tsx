import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

interface MpesaStatus {
  status: 'Pending' | 'Success' | 'Failed' | 'Cancelled';
  amount: number;
  mpesaReceipt: string | null;
  resultDesc: string | null;
}

interface Props {
  phone: string;
  amount: number;
  accountReference: string;
  description?: string;
  orderId?: number;
  disabled?: boolean;
  onSuccess: (mpesaReceipt: string | null) => void;
}

const POLL_MS = 3000;
// Safaricom's own STK prompt times out around 60-90s on the customer's
// phone — "Confirm received manually" appears well before that so staff
// aren't stuck waiting on a callback that may never arrive (e.g. no public
// MPESA_CALLBACK_URL configured yet — see apps/api/.env).
const MANUAL_CONFIRM_AFTER_MS = 12000;

// A self-contained "Send STK Push" control: prompts the customer's phone,
// polls for the result, and surfaces a manual-confirm fallback. Used both
// from an existing order's payment flow (orderId set — the resulting
// Payment is created server-side once Success, see routes/mpesa.ts) and
// from walk-in capture before the order exists yet (orderId omitted —
// onSuccess is the caller's cue to fill in the payment amount/method and
// proceed with creating the order).
export default function MpesaStkButton({ phone, amount, accountReference, description, orderId, disabled, onSuccess }: Props) {
  const [checkoutRequestId, setCheckoutRequestId] = useState<string | null>(null);
  const [status, setStatus] = useState<MpesaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [canConfirmManually, setCanConfirmManually] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const manualTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (manualTimerRef.current) clearTimeout(manualTimerRef.current);
    },
    [],
  );

  function stopPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    if (manualTimerRef.current) clearTimeout(manualTimerRef.current);
    pollRef.current = null;
    manualTimerRef.current = null;
  }

  async function send() {
    setError(null);
    setStatus(null);
    setCanConfirmManually(false);
    setBusy(true);
    try {
      const res = await api.post<{ checkoutRequestId: string }>('/mpesa/stkpush', {
        phone,
        amount,
        accountReference,
        description,
        orderId,
      });
      setCheckoutRequestId(res.checkoutRequestId);
      setStatus({ status: 'Pending', amount, mpesaReceipt: null, resultDesc: null });
      manualTimerRef.current = setTimeout(() => setCanConfirmManually(true), MANUAL_CONFIRM_AFTER_MS);
      pollRef.current = setInterval(() => poll(res.checkoutRequestId), POLL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send STK push');
    } finally {
      setBusy(false);
    }
  }

  async function poll(id: string) {
    try {
      const res = await api.get<MpesaStatus>(`/mpesa/status/${id}`);
      setStatus(res);
      if (res.status === 'Success') {
        stopPolling();
        onSuccess(res.mpesaReceipt);
      } else if (res.status === 'Failed' || res.status === 'Cancelled') {
        stopPolling();
      }
    } catch {
      // transient network error while polling — next tick retries
    }
  }

  async function confirmManually() {
    if (!checkoutRequestId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/mpesa/${checkoutRequestId}/confirm-manually`, {});
      stopPolling();
      setStatus((s) => (s ? { ...s, status: 'Success' } : s));
      onSuccess(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to confirm manually');
    } finally {
      setBusy(false);
    }
  }

  if (status?.status === 'Success') {
    return <span className="tag tag-accent">M-Pesa payment received{status.mpesaReceipt ? ` — ${status.mpesaReceipt}` : ''}</span>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', alignItems: 'start' }}>
      {!checkoutRequestId || status?.status === 'Failed' || status?.status === 'Cancelled' ? (
        <button type="button" className="btn btn-secondary blueprint" onClick={send} disabled={disabled || busy || !phone || amount <= 0}>
          <i className="corner tl"></i>
          <i className="corner tr"></i>
          <i className="corner bl"></i>
          <i className="corner br"></i>
          📲 Send M-Pesa STK push
        </button>
      ) : (
        <>
          <span className="tag tag-outline">Waiting for customer to complete payment on their phone…</span>
          {canConfirmManually && (
            <button type="button" className="btn btn-ghost" style={{ fontSize: 11 }} onClick={confirmManually} disabled={busy}>
              I've confirmed payment was received (e.g. via SMS) — mark as paid
            </button>
          )}
        </>
      )}
      {status?.status === 'Failed' && <p className="note" style={{ color: '#a33', margin: 0 }}>{status.resultDesc || 'Payment failed or was declined.'}</p>}
      {status?.status === 'Cancelled' && <p className="note" style={{ margin: 0 }}>Customer cancelled the prompt.</p>}
      {error && (
        <p className="note" style={{ color: '#a33', margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}
