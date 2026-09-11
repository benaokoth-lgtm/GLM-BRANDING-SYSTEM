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
formulas), a **Stock** tab (requisition/approval workflow with reorder alerts), and a
**Film** tab (DTF transfer-film roll inventory — usage log, roll install/replace, and a
waste report; goes beyond the `design_handoff_pnl_account/` handoff's read-only Film
Usage report screen into full roll-level inventory tracking, per direct request).
Printing/company-branding, Finance, Stock, and Film were added directly (no design
handoff for the operational parts of any of them).

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
- **Materials and services are always separate line items** — there's no combined
  "material + service" row. Selling a material GLM stocks (Cap, Polo Shirt, canvas, ...)
  is a `material` line; a service fee (DTF Printing, Embroidery, Large Format Printing,
  ...) is its own `service` line. Printing/servicing an item GLM also sold is two lines
  (a material line, then a service line); a service line with no matching material line
  means the client brought their own item — no separate flag needed, the presence or
  absence of the material line says it.
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
  actually change — self-approval is blocked server-side.
- **Deleting an Expense, Payroll entry, or Petty Cash top-up always requires approval**
  — there's no direct delete anywhere for these three. Clicking ✕ opens a required-reason
  prompt that raises a deletion request; the record stays fully intact (and in the P&L/
  payroll/petty-cash numbers) until a *different* Finance Manager/General Manager/Admin
  approves it below the table — the requester can't approve or reject their own request,
  same rule as amendments. Rejecting leaves the record untouched. This intentionally
  doesn't cover Orders/Payments, which had no delete capability before this change either.
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
- **Film** (next to Stock, same MANAGEMENT_ROLES access — Supervisor + Finance roles +
  Admin) tracks DTF transfer-film roll inventory:
  - A Service can be flagged **"Tracks film"** in Master Data → Service Price List
    (Admin-only toggle; seeded true for DTF Printing and DTF Sheet (per metre)). Order
    line items using a film-tracked service show a "Film used (m)" field — captured
    independently of qty/pricing since actual film consumed can differ from what's
    billed (waste, spacing, piece-rate jobs). A tag warns if it's left blank.
  - Film usage is only logged (and the active roll decremented) once production
    actually starts — on walk-in capture, or on quote→invoice conversion — never at
    quote-drafting time, since a quote may never be accepted.
  - Film → Film Usage also has a manual "Log film fed into the machine" form for usage
    outside a captured order (test prints, off-system jobs, corrections) — same roll
    decrement as order-triggered usage, one shared running balance either way.
  - Film → Film Rolls installs a new roll (length, cost, date) and shows the active
    roll's remaining balance, cost/metre, and average rate charged so far. Installing a
    new roll while the current one still shows a positive remaining balance means the
    physical roll ran out before the system's tally did — that shortfall is
    auto-logged as waste on the retiring roll, no manual step needed.
  - Each retired roll snapshots its average rate charged (revenue ÷ metres used,
    weighted) against its cost/metre (cost ÷ roll length) to flag whether it was
    **undercharged** — the Roll history & waste report lists every replacement cycle
    with its waste quantity, avg rate charged, and margin/metre.
  - Roll length/cost defaults on the install form (100m / Ksh 7,000 — GLM's real 60cm×100m
    invoice price as of Sep 2026, i.e. Ksh 70/linear metre or Ksh 116.67/sqm) are a
    starting point, not a stored assumption — enter the actual figure off each purchase
    invoice, since cost varies by supplier order.
  - A Service can also be flagged **"Charges pressing fee"** in Master Data → Service
    Price List (seeded true for DTF Printing only — not DTF Sheet (per metre), which is
    a pure film sale with no press step). Its line items show a **staff-picked** "Heat
    press fee (Ksh/pc)" dropdown (Ksh 20/25/30/35/40/45/50 — deliberately a fixed pick
    list, not free text, so pricing stays within GLM's approved band) added on top of
    the base price for every piece (`lineTotal = qty × (unitPrice + heatPressFee) × (1
    - discountPct/100) - discountAmt`), shown on printed invoices/receipts and the order
    detail dialog, and folded into the effective rate used for film-roll revenue/margin
    tracking above. A tag warns if it's left blank on a line item that needs one.
  - **DTF Printing is priced per sqm, not per piece** (unit "sqm", seeded at Ksh 750/sqm —
    the midpoint of the Ksh 667–833/sqm band implied by the existing 400–500/linear-metre
    film sale). A service that's both unit "sqm" and "Tracks film" shows an "Artwork size
    (sqm)" field on its line items instead of a flat price: staff enter one artwork's area
    and the quantity of pieces, and the system computes both the per-piece price (area ×
    Ksh/sqm rate) and the total film consumed (area × qty, converted to linear metres via
    `FILM_ROLL_WIDTH_M` = 0.6m) — shown read-only on the line, editable by hand if it's
    ever wrong. The per-metre film sale (DTF Sheet) is unchanged; both mechanisms deduct
    from the same active roll. Unit and price for any service are now editable in place in
    Master Data → Service Price List (not just Admin-only creation), so this is
    reconfigurable without a code change. A 📐 button next to Artwork size opens a small
    calculator (`ArtworkSizeDialog.tsx`) — length × width in cm → sqm — for staff who know
    a print's dimensions but not its area; it only appears on sqm-priced, film-tracked
    services (today, only DTF Printing), never on other printing services.
  - **Film → Print Queue** lists every sqm-priced, film-tracked artwork line (`printedAt`
    still null) not yet run through the press, across every order and client — small DTF
    jobs are typically gang-sheeted together into one efficient run rather than printed
    one at a time. Each row stays billed to its own order regardless of how many other
    clients' artworks share the physical sheet; marking a batch "printed" only clears it
    off the queue (`OrderLineItem.printedAt`) and touches neither billing nor film usage,
    both of which already happened at order capture. The suggested 0.3 sqm batch
    threshold (`DTF_PRINT_QUEUE_BATCH_SQM`) is a machine-time efficiency starting point,
    not a pricing rule — GLM's real press cycle time should set the actual number.
  - **Master Data → Artwork Size Bands** are flat "quick pick" prices for common small
    artwork sizes (e.g. "6cm x 6cm" → Ksh 50, seeded from GLM's confirmed real price) — an
    alternative to the area × Ksh/sqm formula, which underprices tiny prints dominated by
    fixed setup/press time rather than material. Bands store `lengthCm`/`widthCm` (not
    just a derived `areaSqm`, recomputed server-side whenever either changes), since two
    shapes can share an area while one is too long/narrow to actually fit a slot.
  - Two ways to apply a band on an order line: the **"Quick size" dropdown** (a manual
    pick, above Artwork size (sqm)), or **auto-match via the 📐 calculator**
    (`ArtworkSizeDialog.tsx`'s `findMatchingBand`) — staff enter the artwork's real
    length × width and the smallest band it strictly fits within (both dimensions,
    either orientation, no rounding) is applied automatically, with a live preview
    before confirming; if it's bigger than every band in both orientations, the normal
    area formula applies instead. Either path sets price *and* area together, so film
    usage always deducts exactly as accurately as a custom-sized artwork — only the
    price diverges from the formula, and a "Matched: <label>" tag on the line item
    confirms which band applied. Not tied to a specific service, so any future
    sqm-priced film-tracked service could reuse the same bands. Only one band ships
    seeded (the confirmed 6x6cm price) — add more (e.g. 8x8cm) once GLM confirms real
    prices, rather than guessing.
- **Dates display as dd/mm/yyyy everywhere** (tables, dialogs, printed documents) via
  `packages/shared/src/calc.ts`'s `fmtDate()` — this is a display-only conversion.
  Storage, filtering, and `<input type="date">` values are unchanged (still ISO
  `YYYY-MM-DD`, as the HTML date input requires).
- **API crash safety**: `express-async-errors` is imported at the top of `apps/api/src/app.ts`
  so a rejected promise inside any async route handler (a bad foreign key, an unexpected
  DB error) is forwarded to a catch-all error middleware and returned as a clean JSON 500
  — without it, Express 4 lets that rejection crash the whole process, taking the API
  down for every user over a single bad request.
- No production deployment config yet (cPanel/Vercel) — add when ready to ship.
