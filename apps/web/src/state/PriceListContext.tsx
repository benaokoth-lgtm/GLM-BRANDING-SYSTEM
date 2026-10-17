import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { PRICE_LIST_LABEL } from '@glm/shared';
import type { PriceList } from '@glm/shared';

// The price list a sales screen is captured under: GLM Sales (the menu's original screens) or Freelancer Sales (the same screens under /freelancer/…). The screens read it to offer the right prices,
// say which list is in use, and tell the server which list the order belongs to (the server checks it again).
const Ctx = createContext<PriceList>('glm');

export function PriceListProvider({ list, children }: { list: PriceList; children: ReactNode }) {
  return <Ctx.Provider value={list}>{children}</Ctx.Provider>;
}

export const usePriceList = (): PriceList => useContext(Ctx);

/** The price of a service or material on a list: the Freelancer price (typed by hand, or the GLM price less the default percentage), else the GLM price. */
export function priceOnList(item: { price: number; freelancerPrice?: number }, list: PriceList): number {
  return list === 'freelancer' ? item.freelancerPrice ?? item.price : item.price;
}

/** A catalogue (services or materials) with each price replaced by the one on this list, so every screen that reads `price` offers the right one. */
export function withListPrices<T extends { price: number; freelancerPrice?: number }>(items: T[], list: PriceList): T[] {
  return list === 'freelancer' ? items.map((i) => ({ ...i, price: priceOnList(i, list) })) : items;
}

/** A line at the top of a sales screen saying which price list it works from, so nobody captures under the wrong menu. */
export function PriceListBanner({ note }: { note?: string }) {
  const list = usePriceList();
  const fl = list === 'freelancer';
  return (
    <p
      className="note no-print"
      role="status"
      style={{ margin: '0 0 var(--space-3)', borderLeft: `3px solid ${fl ? 'var(--color-accent)' : 'var(--color-divider)'}`, paddingLeft: 'var(--space-2)' }}
    >
      <b>{PRICE_LIST_LABEL[list]}</b> — {fl ? 'Freelancer prices apply, and the order is credited to the sales person it is for.' : 'GLM prices apply. A client in a sales person’s Client Register is captured under Freelancer Sales.'}
      {note ? ` ${note}` : ''}
    </p>
  );
}
