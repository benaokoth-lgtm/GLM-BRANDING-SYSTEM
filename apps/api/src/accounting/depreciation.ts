import { prisma } from '../db';
import { depreciationMonthsDue, monthEnd, monthOf, monthlyDepreciation, todayStr } from '@glm/shared';

// Automatic asset depreciation. Each asset with a method set is charged one month at a time, starting the month AFTER
// it was bought, up to the last COMPLETED month (so a charge is never booked for a month still in progress). A
// retired asset stops depreciating from its retirement month. (assetId, period) is unique in the database, so this can
// run as often as it likes — on server start, daily, and before every accounting report — without double-charging.

function previousMonth(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, '0')}`;
}

/** Charges every month that is due. Returns how many charges were created. */
export async function runDepreciation(today: string = todayStr()): Promise<number> {
  const through = previousMonth(monthOf(today));
  let created = 0;
  const assets = await prisma.asset.findMany({
    where: { depreciationMethod: { not: 'None' }, purchaseDate: { not: null }, value: { gt: 0 } },
    include: { depreciations: true },
  });
  for (const a of assets) {
    const charged = new Set(a.depreciations.map((d) => d.period));
    let accumulated = a.depreciations.reduce((x, d) => x + d.amount, 0);
    for (const period of depreciationMonthsDue(a.purchaseDate!, through, charged, a.condition === 'Retired' ? a.retiredOn : null)) {
      const amount = monthlyDepreciation(
        { cost: a.value ?? 0, salvage: a.salvageValue, method: a.depreciationMethod, lifeYears: a.usefulLifeYears, ratePct: a.depreciationRatePct },
        accumulated,
      );
      if (amount <= 0) break; // fully depreciated down to salvage
      try {
        await prisma.assetDepreciation.create({ data: { assetId: a.id, period, date: monthEnd(period), amount } });
        accumulated += amount;
        created++;
      } catch {
        // A concurrent run created this month first (the unique index) — nothing to do.
      }
    }
  }
  return created;
}

let running: Promise<number> | null = null;
/** Runs the job once at a time; callers share the in-flight run. */
export function runDepreciationOnce(): Promise<number> {
  if (!running) running = runDepreciation().finally(() => (running = null));
  return running;
}

/** Called once from server.ts: catch up now, then re-check every six hours (cheap, and idempotent). */
export function startDepreciationSchedule(): void {
  const tick = () => runDepreciationOnce().catch((e) => console.error('Depreciation run failed', e));
  tick();
  setInterval(tick, 6 * 60 * 60 * 1000).unref();
}

export interface DepreciationRow {
  assetId: number;
  tag: string;
  name: string;
  category: string;
  condition: string;
  purchaseDate: string | null;
  method: string;
  cost: number;
  salvage: number;
  lifeYears: number | null;
  ratePct: number | null;
  chargedToDate: number;
  bookValue: number;
  monthlyCharge: number;
  thisPeriod: number;
}

/** The register with its depreciation position as of `asOf`, and what was charged in [from, to]. */
export async function depreciationSchedule(from: string, to: string, asOf: string): Promise<DepreciationRow[]> {
  const assets = await prisma.asset.findMany({ include: { depreciations: true }, orderBy: { tag: 'asc' } });
  return assets.map((a) => {
    const cost = a.value ?? 0;
    const chargedToDate = a.depreciations.filter((d) => d.date <= asOf).reduce((x, d) => x + d.amount, 0);
    const thisPeriod = a.depreciations.filter((d) => d.date >= from && d.date <= to).reduce((x, d) => x + d.amount, 0);
    const monthly = monthlyDepreciation(
      { cost, salvage: a.salvageValue, method: a.depreciationMethod, lifeYears: a.usefulLifeYears, ratePct: a.depreciationRatePct },
      chargedToDate,
    );
    return {
      assetId: a.id,
      tag: a.tag,
      name: a.name,
      category: a.category,
      condition: a.condition,
      purchaseDate: a.purchaseDate,
      method: a.depreciationMethod,
      cost,
      salvage: a.salvageValue,
      lifeYears: a.usefulLifeYears,
      ratePct: a.depreciationRatePct,
      chargedToDate: Math.round(chargedToDate * 100) / 100,
      bookValue: Math.round((cost - chargedToDate) * 100) / 100,
      monthlyCharge: a.condition === 'Retired' ? 0 : monthly,
      thisPeriod: Math.round(thisPeriod * 100) / 100,
    };
  });
}
