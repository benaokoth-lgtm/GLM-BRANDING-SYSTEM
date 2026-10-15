// A card job is "1000cards-laminated" on its quote and on the order made from it — no "49 A3 sheets", which is our production detail. Quotes saved before that are put right at start-up.
// (Named z… because it adds data other files' totals must not see.)
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cardsSummary, tidyCostingSummary } from '@glm/shared';
import { prisma } from '../src/db';
import { tidyCostingSummaries } from '../src/costingTidy';

describe('costing quote descriptions', () => {
  after(async () => {
    await prisma.$disconnect();
  });

  it('a card job is described as its quantity and finish, and nothing about the sheets', () => {
    assert.equal(cardsSummary(1000, 'lam'), '1000cards-laminated');
    assert.equal(cardsSummary(500, 'plain'), '500cards-plain');
    assert.equal(cardsSummary(250, 'frost'), '250cards-frosted');
    // the old wording is turned into the new; anything else is left alone
    assert.equal(tidyCostingSummary('1000 cards · Laminated · 49 A3 sheets'), '1000cards-laminated');
    assert.equal(tidyCostingSummary('500 cards · Plain · 25 A3 sheets'), '500cards-plain');
    assert.equal(tidyCostingSummary('1000cards-laminated'), '1000cards-laminated');
    assert.equal(tidyCostingSummary('2 × 1 m · 3 unit(s) · 6.00 sqm'), '2 × 1 m · 3 unit(s) · 6.00 sqm');
    assert.equal(tidyCostingSummary('Eulogy, 8 pages / 130gsm gloss — 100 copies'), 'Eulogy, 8 pages / 130gsm gloss — 100 copies');
  });

  it('quotes saved with the old wording, and the order lines made from them, are put right — once, and only those', async () => {
    const base = { createdDate: '2026-10-01', validUntil: '2026-10-31', clientName: 'Hope Chapel', staffId: 1, staffName: 'x', jobType: 'cards', inputJson: '{}', linesJson: '[]', cost: 100, marginPct: 20, floorMarginPct: 10, price: 120 };
    await prisma.costingQuote.create({ data: { ...base, quoteNo: 'CQ-9001', summary: '1000 cards · Laminated · 49 A3 sheets' } });
    await prisma.costingQuote.create({ data: { ...base, quoteNo: 'CQ-9002', jobType: 'signage', summary: '2 × 1 m · 3 unit(s) · 6.00 sqm' } });
    const changed = await tidyCostingSummaries();
    assert.ok(changed >= 1);
    assert.equal((await prisma.costingQuote.findUniqueOrThrow({ where: { quoteNo: 'CQ-9001' } })).summary, '1000cards-laminated');
    assert.equal((await prisma.costingQuote.findUniqueOrThrow({ where: { quoteNo: 'CQ-9002' } })).summary, '2 × 1 m · 3 unit(s) · 6.00 sqm');
    assert.equal(await tidyCostingSummaries(), 0); // nothing left to change
  });
});
