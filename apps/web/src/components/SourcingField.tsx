import { useEffect, useState } from 'react';
import { fmtDate, isNamedClient } from '@glm/shared';
import { api } from '../api/client';
import { useFeatures } from '../hooks/useFeatures';
import FreelancePicker from './FreelancePicker';

interface Lookup {
  clientKey: string | null;
  months: number;
  owner: { staffId: number; staffName: string; endDate: string; mine: boolean } | null;
}

interface SourcingFieldProps {
  corporateClientId?: number | null;
  phone?: string;
  name?: string;
  /** Who would be credited if the box is ticked. */
  staffName: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  /** The freelance sales person this order is credited to (instead of a staff member), if any. */
  freelanceId?: number | null;
  onFreelanceChange?: (id: number | null) => void;
}

// "Who brought this order?" — on every order. Either a staff member brought the client in through their own network — then the client is credited
// to them for a fixed period (12 months by default) and every order from the client counts towards their commission, whoever captures it — or a
// FREELANCE sales person brought the order, who is credited on that order alone and paid weekly. An order is credited to one or the other, never both:
// choosing a freelancer clears any staff claim, and a client already credited to a staff member cannot be given to a freelancer. Everything else is a
// "house" order and earns no sourcing commission.
export default function SourcingField(props: SourcingFieldProps) {
  const features = useFeatures();
  // Nothing to claim while the commission scheme is switched off.
  if (!features?.commission) return null;
  return <SourcingFieldInner {...props} />;
}

function SourcingFieldInner({ corporateClientId, phone, name, staffName, checked, onChange, freelanceId, onFreelanceChange }: SourcingFieldProps) {
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [viaFreelance, setViaFreelance] = useState((freelanceId ?? null) !== null);

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
  // A client who already belongs to someone cannot be claimed — drop any claim that was ticked before the lookup came back — and cannot be given
  // to a freelance sales person either.
  useEffect(() => {
    if (owner && checked) onChange(false);
  }, [owner, checked, onChange]);
  useEffect(() => {
    if (owner && viaFreelance) {
      setViaFreelance(false);
      onFreelanceChange?.(null);
    }
  }, [owner, viaFreelance, onFreelanceChange]);

  // Name and phone are optional on a walk-in sale; they are required here, to credit the client to someone.
  const needsDetails = checked && !corporateClientId && (!(phone ?? '').trim() || !isNamedClient(name));

  return (
    <div className="field" style={{ margin: 0 }}>
      <label>Who brought this order?</label>
      {owner ? (
        <p className="note" style={{ margin: 0 }}>
          This client is credited to <b>{owner.staffName}{owner.mine ? ' (you)' : ''}</b> until {fmtDate(owner.endDate)}. Orders from them count towards that person’s commission, whoever
          captures them — clients are not shared, and the order cannot be credited to a freelance sales person.
        </p>
      ) : (
        <>
          {onFreelanceChange && (
            <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap', marginBottom: 'var(--space-2)' }}>
              <label style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center', fontWeight: 400 }}>
                <input
                  type="radio"
                  checked={!viaFreelance}
                  onChange={() => {
                    setViaFreelance(false);
                    onFreelanceChange(null);
                  }}
                />
                The shop or our own staff
              </label>
              <label style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center', fontWeight: 400 }}>
                <input
                  type="radio"
                  checked={viaFreelance}
                  onChange={() => {
                    setViaFreelance(true);
                    onChange(false); // one or the other, never both
                  }}
                />
                A freelance sales person brought this order
              </label>
            </div>
          )}
          {viaFreelance && onFreelanceChange ? (
            <>
              <FreelancePicker value={freelanceId ?? null} onChange={onFreelanceChange} />
              <p className="note" style={{ margin: 'var(--space-1) 0 0' }}>
                The order is credited to them alone and they are paid weekly on it — no staff member earns commission on it, and the client is not credited to staff. Commission is paid only on lines sold at or above our base prices.
              </p>
            </>
          ) : (
            <>
              <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start', fontWeight: 400 }}>
                <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3 }} />
                <span>
                  <b>{staffName || 'This staff member'}</b> brought this client in through their own network — credit them for {lookup?.months ?? 12} months
                </span>
              </label>
              {needsDetails && <p className="note" style={{ color: '#a33', margin: 'var(--space-1) 0 0' }}>Enter the client’s name and phone number — they are needed to credit the client to you and to recognise them on their next order.</p>}
              {!checked && <p className="note" style={{ margin: 'var(--space-1) 0 0' }}>Leave unticked for walk-ins and clients the shop already had — no name or phone is needed, and a house order earns no sourcing commission.</p>}
            </>
          )}
        </>
      )}
    </div>
  );
}
