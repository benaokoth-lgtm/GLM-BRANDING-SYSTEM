# GLM Branding — Order Processing & POS System

An order capture, quotation/invoicing, and payment-tracking system for GLM Branding
(embroidery, DTF printing, UV printing, large-format printing, digital printing).
Handles walk-in retail customers and corporate accounts through three roles: **Staff**
(captures orders/quotes), **Supervisor** (traces orders and payments by staff), and
**Admin** (all of Supervisor plus master-data management).

Built from a design handoff (`design_handoff_pos_system/`), recreated in this codebase
using the conventions of the Olerai Hotel System / Word Power Church System projects.
Extended with a **P&L account** tab (`design_handoff_pnl_account/`) — Supervisor/Admin
only — that aggregates orders/payments into a filterable profit-and-loss statement
alongside a manually-maintained operating-expense ledger. A **Finance** tab (next to
P&L, Supervisor/Admin only) adds VAT / NSSF / SHIF / Payroll sub-tabs — a pay-run log
with Kenyan statutory deductions computed via `packages/shared/src/tax.ts` (ported from
Olerai Hotel System for consistent, vetted formulas), and a VAT statement derived from
real sales. Printing/company-branding and Finance were added directly (no design
handoff for either).

## Stack

- **Monorepo**: npm workspaces (`apps/api`, `apps/web`, `packages/shared`)
- **API**: Express + TypeScript, Prisma ORM (SQLite for dev, swap to Postgres for prod)
- **Auth**: PIN-pad login (bcrypt-hashed 4-digit PINs) + JWT sessions, role-gated routes
- **Web**: React + Vite + React Router, plain CSS ported from the design handoff's
  token system (Barlow / Barlow Condensed, blueprint-frame cards with "+" registration
  marks — see `apps/web/src/styles/tokens.css`)

## Getting started

```bash
npm install
npm run db:push
npm run db:seed
```

Then in two terminals:

```bash
npm run dev:api   # http://localhost:4100
npm run dev:web   # http://localhost:5174
```

## Demo logins (seeded)

| Name | Role | PIN |
|---|---|---|
| Amina Otieno | Staff | 1111 |
| Brian Kimani | Staff | 2222 |
| Grace Wanjiru | Supervisor | 3333 |
| Ken Mwangi | Admin | 9999 |

Change these before using with real data — either via Master Data → Staff & Users
(add a new admin, then remove the demo accounts) or by re-running the seed with your
own roster.

## Notes

- Order/line-item totals are always computed from source values (qty, price,
  discounts, payments) via `packages/shared/src/calc.ts` — never stored, so there's
  nothing to fall out of sync.
- Walk-in and quotation capture are Staff-only actions, matching the design handoff:
  Supervisor/Admin trace and manage but don't originate new orders.
- The P&L account's cost-of-sales % is a single adjustable assumption (default 40% of
  accrual revenue) — GLM's price list stores customer-facing prices, not internal unit
  cost, so this is a placeholder until real job-costing data exists.
- Printed documents: A4 for corporate invoices/quotations and thermal (80mm) for
  walk-in receipts, plus company name/address/logo captured in Master Data → Company
  Info and reused across every printed document. Walk-in orders auto-open the receipt
  print dialog right after capture.
- Finance → Payroll has no link to the Staff & Users roster — pay-run entries are
  free-text (name/type/gross pay per period), matching Olerai's Labour & Wages model,
  since GLM has casual day-rate labour alongside any salaried staff. The VAT tab shows
  Output VAT on sales only (assumes VAT-inclusive pricing at 16%) — Input VAT on
  purchases isn't tracked yet, so this isn't net VAT payable to KRA.
- No production deployment config yet (cPanel/Vercel) — add when ready to ship.
