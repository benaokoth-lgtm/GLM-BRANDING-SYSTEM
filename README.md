# GLM Branding — Order Processing & POS System

An order capture, quotation/invoicing, and payment-tracking system for GLM Branding
(embroidery, DTF printing, UV printing, large-format printing, digital printing).

Five roles: **Staff** (captures orders/quotes), **Supervisor** (traces orders/payments,
raises stock requisitions), **Finance Manager** and **General Manager** (P&L, Finance,
and Stock approval — everything financial), and **Admin** (all of the above plus
master-data management).

Built from a design handoff (`design_handoff_pos_system/`), recreated in this codebase
using the conventions of the Olerai Hotel System / Word Power Church System projects.
Extended with a **P&L account** tab (`design_handoff_pnl_account/`) that aggregates
orders/payments into a filterable profit-and-loss statement, a **Finance** tab (VAT /
NSSF / SHIF / Payroll / Expenses / Petty Cash — Kenyan statutory deductions computed via
`packages/shared/src/tax.ts`, ported from Olerai Hotel System for consistent, vetted
formulas), and a **Stock** tab (requisition/approval workflow with reorder alerts).
Printing/company-branding, Finance, and Stock were added directly (no design handoff
for any of them).

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
| David Kamau | Finance Manager | 4444 |
| Lucy Njeri | General Manager | 5555 |
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
- Finance → Payroll's staff picker pulls from Master Data → Staff & Users (a real
  `staffId`, not free text) — pick the employee, GLM's Casual day-rate labour is still
  supported via the Employee/Casual type on each pay-run entry. The VAT tab shows
  Output VAT on sales only (assumes VAT-inclusive pricing at 16%) — Input VAT on
  purchases isn't tracked yet, so this isn't net VAT payable to KRA.
- P&L, Finance (VAT/NSSF/SHIF/Payroll/Expenses/Petty Cash), and Stock approval are
  gated to **Finance Manager, General Manager, and Admin** only — Supervisor lost this
  access and keeps All Orders/Payments/Stock (requisition only, not approval).
  `packages/shared/src/constants.ts` exports `FINANCE_ROLES` and `MANAGEMENT_ROLES` as
  the single source of truth for this gating on both the API and the frontend.
- Every Expense, PayrollEntry, and PettyCashTopUp row records `capturedByName` (or
  `authorizedByName` for top-ups) — a plain-text snapshot of who created it, not a
  foreign key, so the trail survives even if that user is later removed.
- Wrong expense entries are corrected via **Amend**, not direct edit: propose new
  values with a required reason, and a *different* Finance Manager/General
  Manager/Admin must approve before the Expense row (and P&L numbers built from it)
  actually change — self-approval is blocked server-side. Deleting an expense outright
  is still instant/ungated, unchanged from before.
- Finance → Petty Cash has its own "Log a petty cash expense" form for convenience, but
  it posts to the same Expense table as Finance → Expenses — one ledger, viewable both
  places. Current balance = all-time top-ups minus all-time operating expenses, so it
  assumes every recorded expense is petty-cash-funded (not true for e.g. bank-paid
  salaries) — exclude those from the Expenses ledger if that assumption doesn't hold.
- Stock (next to Finance): Material now has `stockQty`/`reorderLevel`. A requisition
  only increases `stockQty` once approved ("available for sale") — Supervisor and the
  Finance roles can all raise a requisition, but only the Finance roles can approve or
  reject one, and a requester can't approve their own request. Reorder alerts are
  computed live (stockQty ≤ reorderLevel), shown on the Stock tab and as a tag in
  Master Data → Material Price List, where reorderLevel is inline-editable.
- Payments (top nav) has Pending Payments / Paid sub-tabs with a shared date-range
  filter (presets + custom From/To), filtered by each order's created date. All Orders
  now shows an order date column too.
- **Dates display as dd/mm/yyyy everywhere** (tables, dialogs, printed documents) via
  `packages/shared/src/calc.ts`'s `fmtDate()` — this is a display-only conversion.
  Storage, filtering, and `<input type="date">` values are unchanged (still ISO
  `YYYY-MM-DD`, as the HTML date input requires).
- No production deployment config yet (cPanel/Vercel) — add when ready to ship.
