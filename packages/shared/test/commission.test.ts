import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FILM_BANDS,
  DEFAULT_GENERAL_BANDS,
  artworkPremiumCommission,
  bandPosition,
  bandedAmount,
  bandsProblem,
  WALK_IN_CLIENT,
  clientKeyFor,
  isNamedClient,
  filmPremiumCommission,
  filmPremiumPerM,
  ownershipActive,
  ownershipEnd,
  paidShare,
} from '../src/commission.ts';
import { jobTotals, systemJobCalc, type DtfArtworkJob } from '../src/dtf.ts';

const VAT = 0.16;

test('banded commission is marginal — each rate applies only to its own slice', () => {
  assert.equal(bandedAmount(DEFAULT_GENERAL_BANDS, 100000), 0); // under the first threshold
  assert.equal(bandedAmount(DEFAULT_GENERAL_BANDS, 200000), 1000); // 50,000 × 2%
  assert.equal(bandedAmount(DEFAULT_GENERAL_BANDS, 400000), 3000 + 3500); // 150k×2% + 100k×3.5%
  assert.equal(bandedAmount(DEFAULT_GENERAL_BANDS, 600000), 3000 + 7000 + 5000); // + 100k×5%
  assert.equal(bandedAmount(DEFAULT_GENERAL_BANDS, 0), 0);
  assert.equal(bandedAmount(DEFAULT_GENERAL_BANDS, -5), 0);
  // order of the list does not matter
  assert.equal(bandedAmount([...DEFAULT_GENERAL_BANDS].reverse(), 400000), 6500);
});

test('band position shows the current rate and the distance to the next band', () => {
  const p = bandPosition(DEFAULT_GENERAL_BANDS, 200000);
  assert.deepEqual(p, { rate: 2, nextFrom: 300000, nextRate: 3.5, toNext: 100000 });
  const top = bandPosition(DEFAULT_GENERAL_BANDS, 900000);
  assert.deepEqual(top, { rate: 5, nextFrom: null, nextRate: null, toNext: null });
});

test('bands are validated', () => {
  assert.equal(bandsProblem(DEFAULT_GENERAL_BANDS, 'x'), null);
  assert.match(bandsProblem([], 'x')!, /at least one/);
  assert.match(bandsProblem([{ from: 10, rate: 1 }], 'x')!, /start at 0/);
  assert.match(bandsProblem([{ from: 0, rate: 101 }], 'x')!, /between 0 and 100/);
  assert.match(bandsProblem([{ from: 0, rate: 1 }, { from: 0, rate: 2 }], 'x')!, /same amount/);
});

test('film: nothing at or below the base, a ladder above it, and no ceiling', () => {
  assert.equal(filmPremiumCommission(10, 400, 400, DEFAULT_FILM_BANDS, VAT), 0);
  assert.equal(filmPremiumCommission(10, 380, 400, DEFAULT_FILM_BANDS, VAT), 0);
  // 425/m: premium 25 → 25×10% = 2.50 per metre; 10 m = 25, less VAT
  assert.equal(filmPremiumCommission(10, 425, 400, DEFAULT_FILM_BANDS, VAT), Math.round((25 / 1.16) * 100) / 100);
  // 500/m is no longer special: premium 100 → 25×10% + 25×25% + 25×40% + 25×50% = 2.5+6.25+10+12.5 = 31.25/m
  assert.equal(filmPremiumCommission(1, 500, 400, DEFAULT_FILM_BANDS, VAT), Math.round((31.25 / 1.16) * 100) / 100);
  // and 550/m keeps climbing at the open-ended top rate
  assert.equal(filmPremiumCommission(1, 550, 400, DEFAULT_FILM_BANDS, VAT), Math.round(((31.25 + 25) / 1.16) * 100) / 100);
  assert.equal(filmPremiumPerM(350, 400), 0);
  assert.equal(filmPremiumPerM(430, 400), 30);
});

test('artwork: commission only on what was charged above the recommended price', () => {
  assert.equal(artworkPremiumCommission(100, 40, 40, 50, VAT), 0); // charged the recommended price
  assert.equal(artworkPremiumCommission(100, 35, 40, 50, VAT), 0); // never negative
  // 100 pieces × 10 extra = 1000, VAT out = 862.07, 50% = 431.03
  assert.equal(artworkPremiumCommission(100, 50, 40, 50, VAT), 431.03);
});

test('commission follows the money: a payment of a third earns a third', () => {
  assert.equal(paidShare(100, 300), 100 / 300);
  assert.equal(paidShare(500, 300), 1);
  assert.equal(paidShare(0, 0), 0);
  assert.equal(paidShare(-10, 300), 0);
});

test('a sourced client is credited for 12 months, then the window closes', () => {
  assert.equal(ownershipEnd('2026-03-15', 12), '2027-03-15');
  assert.equal(ownershipEnd('2026-12-31', 12), '2027-12-31');
  assert.equal(ownershipEnd('2024-02-29', 12), '2025-02-28'); // leap day
  assert.equal(ownershipEnd('2026-01-31', 1), '2026-02-28');
  const o = { endDate: '2027-03-15', status: 'Active' };
  assert.equal(ownershipActive(o, '2027-03-15'), true);
  assert.equal(ownershipActive(o, '2027-03-16'), false);
  assert.equal(ownershipActive({ ...o, status: 'Released' }, '2026-04-01'), false);
});

test('the same client is recognised however the phone number is written', () => {
  assert.equal(clientKeyFor({ phone: '0712 345 678' }), clientKeyFor({ phone: '+254712345678' }));
  assert.equal(clientKeyFor({ corporateClientId: 7, phone: '0712345678' }), 'c:7');
  assert.equal(clientKeyFor({ name: '  Mary   Wanjiku ' }), 'n:mary wanjiku');
  assert.equal(clientKeyFor({ phone: '123', name: 'Al' }), null); // nothing to recognise them by
  assert.equal(clientKeyFor({}), null);
});

test('an anonymous walk-in is not a client anyone can be credited with', () => {
  assert.equal(WALK_IN_CLIENT, 'Walk-in');
  assert.equal(isNamedClient('Walk-in'), false);
  assert.equal(isNamedClient(' walk in '), false);
  assert.equal(isNamedClient('WALKIN'), false);
  assert.equal(isNamedClient(''), false);
  assert.equal(isNamedClient(undefined), false);
  assert.equal(isNamedClient('Walter Inn'), true);
  assert.equal(clientKeyFor({ name: 'Walk-in' }), null);
  assert.equal(clientKeyFor({ name: 'Walk-in', phone: '0712 345 678' }), 'p:712345678'); // a phone number still identifies them
});

test('an artwork job keeps the recommended price unless a higher one was charged', () => {
  const job: DtfArtworkJob = { id: '1', rollId: 'ROLL-001', jobOn: '2026-01-02', client: 'x', runningMetres: 2, pieces: 108, fixedChargePerMetreAtJob: 2160, minPricePerPieceAtJob: 30 };
  assert.equal(systemJobCalc(job).finalPerPiece, 70); // 30 + 2160×2/108
  assert.equal(jobTotals(job).jobTotal, 7560);
  const higher = { ...job, chargedPerPiece: 80 };
  assert.equal(jobTotals(higher).finalPerPiece, 80);
  assert.equal(jobTotals(higher).jobTotal, 8640);
  assert.equal(systemJobCalc(higher).finalPerPiece, 70); // the recommendation itself is unchanged
  // a lower price is honoured too (it needs approval before production, enforced by the API)
  assert.equal(jobTotals({ ...job, chargedPerPiece: 50 }).finalPerPiece, 50);
  assert.equal(jobTotals({ ...job, chargedPerPiece: 50 }).jobTotal, 5400);
});
