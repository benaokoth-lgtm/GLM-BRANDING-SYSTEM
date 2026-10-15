import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../state/AuthContext';
import { useFeatures } from '../hooks/useFeatures';
import type { SalesPerson } from '../hooks/useSalesPeople';

// Starting an order from the staff client register: pick the sales person (the front office does; a sales person is already themselves), then pick one of THEIR clients, and the client's name and
// phone are filled in. The register is kept under Client Register in the menu; it is the one commission uses for clients credited to a staff member.

interface RegisterClient {
  id: number;
  name: string;
  phone: string;
}

interface Props {
  /** The front office (and Admin) may pick any sales person; everyone else picks from their own clients. */
  forOthers?: boolean;
  salesPeople?: SalesPerson[];
  salesPersonId?: number | null;
  onSalesPersonChange?: (id: number | null) => void;
  /** Called with the chosen client's name and phone. */
  onPick: (c: { name: string; phone: string }) => void;
}

export default function StaffClientPicker({ forOthers = false, salesPeople = [], salesPersonId = null, onSalesPersonChange, onPick }: Props) {
  const { user } = useAuth();
  const features = useFeatures();
  const [clients, setClients] = useState<RegisterClient[]>([]);
  const [failed, setFailed] = useState(false);
  const [chosen, setChosen] = useState('');
  // whose clients: the chosen sales person, else the person themselves
  const staffId = forOthers ? salesPersonId : (user?.id ?? null);

  useEffect(() => {
    setChosen('');
    if (!features?.commission || !staffId) {
      setClients([]);
      return;
    }
    let live = true;
    api
      .get<RegisterClient[]>(`/staff-clients?staffId=${staffId}`)
      .then((r) => {
        if (live) {
          setClients(r);
          setFailed(false);
        }
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [staffId, features?.commission]);

  // the register belongs to commission: with it switched off there is nothing to pick from
  if (!features?.commission || failed) return null;
  // a sales person with no clients in their own register is not bothered with an empty list
  if (!forOthers && clients.length === 0) return null;
  const who = forOthers ? salesPeople.find((p) => p.id === salesPersonId)?.name : undefined;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: forOthers ? '1fr 1fr' : '1fr', gap: 'var(--space-3)', border: '1px dashed var(--color-divider)', padding: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
      {forOthers && (
        <div className="field" style={{ margin: 0 }}>
          <label>Sales person</label>
          <select className="input" value={salesPersonId ?? ''} onChange={(e) => onSalesPersonChange?.(e.target.value ? Number(e.target.value) : null)} aria-label="Sales person whose client this is">
            <option value="">Pick the sales person…</option>
            {salesPeople.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field" style={{ margin: 0 }}>
        <label>{forOthers ? (who ? `${who}’s clients` : 'Their clients') : 'Pick one of your clients'}</label>
        <select
          className="input"
          value={chosen}
          disabled={!staffId || clients.length === 0}
          aria-label="Pick a client from the register"
          onChange={(e) => {
            const c = clients.find((x) => String(x.id) === e.target.value);
            setChosen(e.target.value);
            if (c) onPick({ name: c.name, phone: c.phone });
          }}
        >
          <option value="">{!staffId ? 'Pick the sales person first' : clients.length === 0 ? 'No clients in their register yet' : 'Pick a client…'}</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.phone ? ` · ${c.phone}` : ''}
            </option>
          ))}
        </select>
        <p className="note" style={{ margin: 'var(--space-1) 0 0', fontSize: 12 }}>
          Fills in the name and phone below. <Link to="/commission?tab=register">Client Register</Link>
        </p>
      </div>
    </div>
  );
}
