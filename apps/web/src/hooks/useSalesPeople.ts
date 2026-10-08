import { useEffect, useState } from 'react';
import { api } from '../api/client';

export interface SalesPerson {
  id: number;
  name: string;
  role: string;
  /** Their own order taking is switched off, so the front office is the one who captures for them. */
  orderTakingOff: boolean;
}

/** The sales persons the front office can give an order to (only asked for by someone who may capture for others). */
export function useSalesPeople(enabled: boolean): SalesPerson[] {
  const [people, setPeople] = useState<SalesPerson[]>([]);
  useEffect(() => {
    if (!enabled) return;
    api.get<SalesPerson[]>('/master-data/sales-people').then(setPeople).catch(() => setPeople([]));
  }, [enabled]);
  return people;
}
