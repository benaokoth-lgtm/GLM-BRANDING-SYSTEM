import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { notifyFeaturesChanged } from '../hooks/useFeatures';

// Master Data → Company Info: the Admin decides when the sales-commission scheme is on. Switching it off hides the Commission module and stops
// crediting orders to anyone; nothing is deleted, and switching it on again brings everything back.
export default function CommissionSwitch() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get<{ enabled: boolean }>('/master-data/commission-switch')
      .then((r) => setEnabled(r.enabled))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not read the commission switch'));
  }, []);

  async function flip() {
    if (enabled === null) return;
    const next = !enabled;
    if (!next && !window.confirm('Switch commission off? The Commission module is hidden and new orders are not credited to anyone. Nothing is deleted — switch it on again to bring it all back.')) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.put<{ enabled: boolean }>('/master-data/commission-switch', { enabled: next });
      setEnabled(r.enabled);
      notifyFeaturesChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the commission switch');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card blueprint elev-sm" style={{ maxWidth: 760, marginBottom: 'var(--space-5)' }}>
      <i className="corner tl"></i>
      <i className="corner tr"></i>
      <i className="corner bl"></i>
      <i className="corner br"></i>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
        <div>
          <div className="card-kicker">Sales commission</div>
          <div className="card-title">{enabled === null ? '…' : enabled ? 'On' : 'Off'}</div>
        </div>
        <button type="button" className={'btn ' + (enabled ? 'btn-secondary' : 'btn-primary')} disabled={busy || enabled === null} onClick={flip}>
          {enabled ? 'Switch off' : 'Switch on'}
        </button>
      </div>
      <p className="note" style={{ marginBottom: 0 }}>
        {enabled
          ? 'Staff can credit clients to themselves, orders are credited, and the Commission module is open to staff and managers.'
          : 'Nothing is credited to anyone, nobody can claim a client, and the Commission module is hidden. Switch it on when you want commission to start — clients are only credited, and orders only counted, from then on. Film and artwork commission is worked out from the payments received in each month, so the cleanest time to start is the 1st.'}
      </p>
      {error && (
        <p className="note" style={{ color: '#a33' }}>
          {error}
        </p>
      )}
    </div>
  );
}
