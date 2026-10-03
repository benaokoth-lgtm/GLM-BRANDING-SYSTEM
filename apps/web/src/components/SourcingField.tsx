import { useEffect, useState } from 'react';
import { fmtDate } from '@glm/shared';
import { api } from '../api/client';

interface Lookup {
  clientKey: string | null;
  months: number;
  owner: { staffId: number; staffName: string; endDate: string; mine: boolean } | null;
}

// "Who sourced this client?" — on every order. A client a staff member brings in through their own network is credited to them for
// a fixed period (12 months by default); while that runs, every order from the client counts towards that person's commission,
// whoever captures it. Nobody shares a client, so when the client is already credited to someone the box is replaced by a note
// saying who. Everyone else's orders are "house" orders and earn no sourcing commission.
export default function SourcingField({
  corporateClientId,
  phone,
  name,
  staffName,
  checked,
  onChange,
}: {
  corporateClientId?: number | null;
  phone?: string;
  name?: string;
  /** Who would be credited if the box is ticked. */
  staffName: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const [lookup, setLookup] = useState<Lookup | null>(null);

  useEffect(() => {
    const qs = new URLSearchParams();
    if (corporateClientId) qs.set('corporateClientId', String(corporateClientId));
    if (phone?.trim()) qs.set('phone', phone.trim());
    if (name?.trim()) qs.set('name', name.trim());
    if ([...qs.keys()].length === 0) {
      setLookup(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api
        .get<Lookup>(`/commission/owner-lookup?${qs.toString()}`)
        .then((l) => live && setLookup(l))
        .catch(() => live && setLookup(null));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [corporateClientId, phone, name]);

  const owner = lookup?.owner ?? null;
  // A client who already belongs to someone cannot be claimed — drop any claim that was ticked before the lookup came back.
  useEffect(() => {
    if (owner && checked) onChange(false);
  }, [owner, checked, onChange]);

  const needsPhone = checked && !corporateClientId && !(phone ?? '').trim();

  return (
    <div className="field" style={{ margin: 0 }}>
      <label>Who sourced this client?</label>
      {owner ? (
        <p className="note" style={{ margin: 0 }}>
          This client is credited to <b>{owner.staffName}{owner.mine ? ' (you)' : ''}</b> until {fmtDate(owner.endDate)}. Orders from them count towards that person’s commission, whoever
          captures them — clients are not shared.
        </p>
      ) : (
        <>
          <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start', fontWeight: 400 }}>
            <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3 }} />
            <span>
              <b>{staffName || 'This staff member'}</b> brought this client in through their own network — credit them for {lookup?.months ?? 12} months
            </span>
          </label>
          {needsPhone && <p className="note" style={{ color: '#a33', margin: 'var(--space-1) 0 0' }}>Add the client’s phone number so they can be recognised on their next order.</p>}
          {!checked && <p className="note" style={{ margin: 'var(--space-1) 0 0' }}>Leave unticked for walk-ins and clients the shop already had — a house order earns no sourcing commission.</p>}
        </>
      )}
    </div>
  );
}
