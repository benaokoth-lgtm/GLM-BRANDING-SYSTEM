# GLM Branding — Order Processing & POS System

An order capture, quotation/invoicing, and payment-tracking system for GLM Branding
(embroidery, DTF printing, UV printing, large-format printing, digital printing).

Five roles ship seeded — **Staff** (captures orders/quotes), **Supervisor** (traces
orders/payments, raises stock requisitions), **Finance Manager** and **General Manager**
(P&L, Finance, and Stock approval — everything financial), and **Admin** (all of the
above plus master-data management) — but roles are no longer fixed: Master Data → Roles
& Access lets Admin add/rename/delete roles and toggle exactly which areas of the app
each one can reach. See "Roles & access levels" below.

Built from a design handoff (`design_handoff_pos_system/`), recreated in this codebase
using the conventions of the Olerai Hotel System / Word Power Church System projects.
Extended with a **P&L account** tab (`design_handoff_pnl_account/`) that aggregates
orders/payments into a filterable profit-and-loss statement, a **Finance** tab (Expenses,
Petty Cash) and a **Compliance** tab (VAT / NSSF / SHIF / Payroll — Kenyan statutory
deductions computed via `packages/shared/src/tax.ts`, ported from Olerai Hotel System for
consistent, vetted formulas), a **Stock** tab (stock levels, requisition/approval
workflow, and stock take reconciliation, with reorder alerts), a **Film** tab (DTF
transfer-film roll inventory — usage log, roll install/replace tied to Finance Expenses
via invoice number, and a waste report; goes beyond the `design_handoff_pnl_account/`
handoff's read-only Film Usage report screen into full roll-level inventory tracking, per
direct request), and a **Reports** tab (filterable sales, film usage, and sales-by-service
reports). Printing/company-branding, Finance, Compliance, Stock, Film, and Reports were
added directly (no design handoff for the operational parts of any of them).

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
  `staffId`, not free text). The VAT tab shows Output VAT on sales only (assumes
  VAT-inclusive pricing at 16%) — Input VAT on purchases isn't tracked yet, so this isn't
  net VAT payable to KRA.
- P&L, Finance/Compliance, and Stock approval default to **Finance Manager, General
  Manager, and Admin** only (seeded permissions) — Supervisor defaults to All
  Orders/Payments/Stock (requisition only, not approval). This is now configurable per
  role rather than hardcoded — see "Roles & access levels" below.
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
  Master Data → Stock Price List, where reorderLevel is inline-editable.
- Payments (top nav) has Pending Payments / Paid sub-tabs with a shared date-range
  filter (presets + custom From/To), filtered by each order's created date. All Orders
  now shows an order date column too.
- **Film** (next to Stock, same default access as Stock — Supervisor + Finance roles +
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
- **Finance was split into Finance (Expenses, Petty Cash) and Compliance (VAT, NSSF,
  SHIF, Payroll)** — both gated by the same `canAccessFinance` permission (see "Roles &
  access levels" below), seeded true for Finance Manager, General Manager, Admin.
  `DeleteReasonRow` and `DeletionRequestsCard` were pulled out to
  `apps/web/src/components/` so both pages share one implementation instead of
  duplicating the deletion-request UI.
- **Stock now has a Stock Levels tab** (plain table of every material's price/on-hand/
  reorder level — the previous Stock page only surfaced items already *below* reorder,
  with no way to see the full picture) and a **Stock Take tab** for physical count
  reconciliation: staff record what's actually on the shelf, and `Material.stockQty` is
  corrected to match immediately. Each count snapshots `systemQty`/`countedQty`/
  `varianceQty` to a `StockTake` row for audit, so a shortfall or overage is logged, not
  silently discarded — the same "physical reality overrides the system tally" pattern
  already used for film-roll waste-on-replacement.
- **Every film roll now carries an invoice/receipt number, tied to Finance → Expenses**:
  Film → Film Rolls' install form has two modes. **"New purchase"** requires an
  invoice/receipt number and automatically creates the matching Expense (category "DTF
  Film Rolls") at install time — no separate manual entry needed. **"Already logged as
  an expense"** shows a dropdown of unlinked "DTF Film Rolls" expenses that have an
  invoice number on file; picking one reuses its cost/invoice number instead of creating
  a duplicate Expense. Once an expense is linked to a roll (`FilmRoll.expenseId`, a
  `@unique` foreign key), it permanently drops off that dropdown — enforced both by the
  `GET /film/available-expenses` query (excludes already-linked ids) and server-side on
  `POST /film/rolls` (rejects reusing a linked expense even if called directly), so "no
  film picked again from Expenses" holds regardless of UI state.
- **New Reports menu** (gated by its own `canAccessReports` permission, seeded alongside
  P&L/Finance/Compliance) with three
  sub-tabs, all sharing one Today/This Month/This Year/Custom date-range filter bar
  (custom range is whatever From/To are set to once either is edited by hand):
  - **Sales** — every walk-in order and invoiced corporate order dated in range
    (accrual basis, matching the P&L/VAT convention exactly — same `kind === 'walkin' ||
    status === 'Invoice'` rule), listed with totals and a running grand total.
  - **Film Usage** — reuses `GET /film/usage`, same log Film → Film Usage already shows.
  - **Sales by Category** — new `GET /reports/sales-by-category` endpoint groups revenue
    by *service* (Embroidery, DTF Printing, Laser Engraving, etc. — the thing that maps
    to "which machine/production line is performing"), with a separate combined
    "Materials" bucket for plain product sales (Cap, T-Shirt, ...), since a material sale
    isn't a machine/service and mixing it in would distort the per-service ranking.
- **Petty Cash → P&L flow confirmed intact after the above changes**: Petty Cash expenses
  and film-roll-linked expenses both write to the same `Expense` table `pnl.ts` already
  reads unfiltered by category, so both show up correctly in the P&L's operating-expense
  breakdown with no extra plumbing — verified live by installing a film roll against an
  existing expense and confirming its "DTF Film Rolls" line appeared in the P&L total
  with no double-count.

## Roles & access levels

Roles are no longer a fixed union — Master Data → Roles & Access (Admin-only) manages a
`Role` table with one Boolean per gated area: `canCaptureOrders`, `canViewAllOrders`,
`canManagePayments`, `canAccessPnl`, `canAccessFinance` (covers both Finance and
Compliance, since they share one backend router), `canAccessStock`, `canApproveStock`,
`canAccessFilm`, `canAccessReports`. Add a role (e.g. "Accountant"), tick the boxes it
needs, assign it to a staff member in Staff & Users — no code change required.

- **"Admin" is never a row in that table.** The server treats the literal role name
  `Admin` as having every permission unconditionally (`apps/api/src/permissions.ts`), and
  rejects creating or renaming any role to `Admin`. This is the deliberate fixed recovery
  path: however roles get misconfigured, logging in as Admin always has full access to
  fix it. Master Data itself (adding services/materials/staff/settings, and managing
  roles) stays hardcoded Admin-only — not a configurable permission — since it's the most
  sensitive area and includes the roles screen itself.
- Permissions are checked **live** on every gated backend request
  (`requirePermission()` in `apps/api/src/middleware/auth.ts` looks up the caller's Role
  row fresh each time, not from the JWT) — a permission change takes effect immediately
  for that user, no re-login needed for the *backend* to enforce it. The *frontend* nav
  (which tabs render) is built from a snapshot of permissions taken at login time
  (`apps/web/src/state/AuthContext.tsx`), so a user whose access changed mid-session sees
  the old nav until they next log in — a stale nav link still hits a live, correctly
  enforced backend check underneath, it just won't render until refreshed.
- Deleting a role is blocked while any staff member is still assigned to it (reassign
  them first); this and the Admin protections above are the only guardrails — nothing
  stops an Admin from otherwise emptying out any other role's access entirely.

## Payroll, Petty Cash, and no double-booking salaries

- **Employees are paid a fixed monthly salary**, entered directly as one amount (Finance
  → Compliance → Payroll) — no more days × rate for them. **Casuals stay day-rate**
  (days worked × Ksh/day), unchanged, since that's genuinely variable pay.
- **"Salaries & wages" is not a pickable category under Finance → Expenses or Petty
  Cash** (removed from `EXPENSE_CATEGORIES`) — every payroll entry, by construction, is
  the only place that cost gets captured. The P&L's "Salaries & wages" line is derived
  directly from `PayrollEntry.grossPay` summed over the period (`apps/api/src/routes/pnl.ts`),
  not from any Expense row, so there is exactly one place to enter a salary cost and no
  way to double-book it via Expenses or Petty Cash.
- **Payroll's payment source** is `Petty Cash` or `Bank/Cheque` (`PAYROLL_PAYMENT_SOURCES`
  in `packages/shared/src/constants.ts`) — distinct from the customer-facing
  `PAYMENT_METHODS` used elsewhere. Choosing `Petty Cash` registers that entry's **net**
  pay (not gross — the statutory deductions are a separate downstream remittance, not
  cash that left the tin) as an outflow against the Petty Cash float.
- **Insufficient petty cash blocks the entry outright**, both for a payroll entry marked
  "Petty Cash" and for a plain Expense (every Expense row is implicitly petty-cash-funded
  — see the ledger's own balance calc): `computePettyCashBalance()` in
  `apps/api/src/routes/finance.ts` is the single source of truth for the float's current
  balance (all-time top-ups minus all-time Expenses minus all-time petty-cash-sourced
  payroll net pay), checked before either kind of entry is allowed to save. A film-roll
  "new purchase" (which auto-creates a DTF Film Rolls Expense — see above) is checked the
  same way. Nothing partially saves; the request is rejected with the shortfall shown.

## M-Pesa STK Push, email, and WhatsApp

- **M-Pesa STK Push** prompts the customer's own phone to complete a payment — available
  both during walk-in order capture (`NewWalkinOrder.tsx`, before the order exists yet)
  and from any existing order's payment flow (`OrderDetailDialog.tsx`, used by Payments
  and Orders). `apps/api/src/routes/mpesa.ts` wraps Safaricom's Daraja API: `POST
  /mpesa/stkpush` initiates the push, `POST /mpesa/callback` is Safaricom's webhook
  target, `GET /mpesa/status/:id` is polled by the frontend (`MpesaStkButton.tsx`) every
  3s, and once a push resolves Success against an *existing* order, its Payment record is
  created automatically — no separate manual "Record payment" step. **Requires real
  Safaricom Daraja credentials and, in production, a publicly reachable HTTPS
  `MPESA_CALLBACK_URL`** (Safaricom cannot reach `localhost`) — set `MPESA_*` in
  `apps/api/.env` (commented template included); until then, initiating a push returns a
  clear "not configured" error rather than failing silently. A **"confirm payment
  received manually"** fallback appears ~12s after sending a push, for an environment
  with no reachable callback yet (e.g. local development) — staff confirm once they've
  verified payment through other means (the till's own SMS alert), which records the
  payment the same way a successful callback would.
- **"Send email"** on a corporate invoice/quotation (`OrderDetailDialog.tsx`) sends the
  *exact* HTML the Print button renders — `buildCorporateDocumentHtml()` in
  `apps/web/src/utils/printInvoice.ts` was extracted as a pure string builder shared by
  both, so the layout is defined in exactly one place. The frontend renders the HTML and
  posts it to `POST /api/email/send`, which relays it via nodemailer using standard SMTP
  credentials (`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM` in
  `apps/api/.env`, commented template included) — any provider works (Gmail app
  password, Zoho, SendGrid's SMTP relay, ...). Returns a clear "not configured" error
  until those are set. The recipient field prefills from the corporate client's email on
  file (Master Data → Corporate Clients) when present.
- **"Send WhatsApp"** opens a `wa.me` click-to-chat link pre-filled with a short summary
  (order number, total, balance due) to the client's phone on file — no API credentials
  needed, since it's a plain deep link, not the WhatsApp Business API. The trade-off:
  click-to-chat links can't attach a file, so the actual invoice/quotation document still
  has to be shared separately (printed or emailed) — the button's own note says so.
  `CorporateClient` gained `email`/`phone` fields (Master Data → Corporate Clients,
  inline-editable) to back both buttons.

## Trading name vs. registered company name

GLM trades as "GLM Branding" but the uploaded logo carries the registered company's
name, "GLM Group Limited" — showing both with no stated relationship on a printed
invoice/quotation reads like two unrelated businesses sharing a header. `Setting` gained
a `legalName` field (Master Data → Company Info → "Registered/legal entity name",
defaults to "GLM Group Limited") that prints as a small "Trading name of ..." line
directly under the bold trading name in the invoice/quotation header
(`apps/web/src/utils/printInvoice.ts`) — the same "trading as" disclosure convention as
a real letterhead, establishing the hierarchy (prominent trading name, quiet legal fine
print) instead of two same-weight names competing for attention. The line only renders
when `legalName` is set and differs from `companyName`; leaving it blank hides it
entirely. Walk-in receipts (`printTicket.ts`) don't carry a logo image (plain text on
thermal paper) but show the same "Trading name of ..." line as text under the brand
name, in the slot a reference receipt template would put its marketing tagline.

## Quotation → invoice: auto-converts on deposit, VAT-inclusive pricing, thermal receipt redesign

- **A quotation now converts to an invoice automatically the moment any payment is
  recorded against it** — receiving money is itself proof the client accepted, so there's
  no need for a separate manual step. `POST /orders/:id/payments`
  (`apps/api/src/routes/orders.ts`) creates the Payment and, if the order's status is
  still `Quote`, converts it in the same transaction (sets `status: 'Invoice'`, the due
  date from the client's credit terms, and logs film usage for any film-tracked lines —
  exactly what the explicit "Convert quotation to invoice" button already did, now
  extracted into a shared `convertQuoteToInvoice()` helper both paths call). The manual
  button still exists for a quote accepted with nothing paid upfront, and
  `OrderDetailDialog.tsx` notes the auto-convert behavior next to it so it doesn't look
  redundant.
- **Prices were already computed as VAT-inclusive** (see Compliance → VAT's own
  disclosure), but nothing on a printed invoice, quotation, or receipt actually said so —
  a customer had no way to tell whether 16% VAT was baked into the total. Both
  `printInvoice.ts` (A4 invoices/quotations) and `printTicket.ts` (thermal receipts) now
  split the final total via the existing `splitVatInclusive()` helper
  (`packages/shared/src/tax.ts`) and print a small "Includes VAT (16%)" / "Net amount
  (excl. VAT)" pair directly under the grand total — the underlying numbers were already
  correct, this only makes the VAT treatment explicit on the document itself.
- **The walk-in thermal receipt (`printTicket.ts`) was redesigned against a reference
  UK-supermarket-style thermal receipt** the same structural template: bold centred brand
  block, dashed section rules, an order/customer/staff block, itemised purchases, a
  totals block (now with the VAT breakdown above), a payment/balance-due block, a
  "please keep this receipt" note with an item count, a scannable barcode, and a closing
  thank-you line. Every field on it is real GLM data — order number, customer, staff,
  line items, payments, balance due — deliberately never inventing the reference's
  till/terminal/card-authorisation numbers, which don't correspond to anything this
  system tracks (no card-network integration here). The barcode (Code128 of the order
  number, via JsBarcode loaded from a CDN — the same "external resource during print"
  pattern `printInvoice.ts` already uses for its Google Font) is a genuine scannable
  reference, not decoration.

## Stock: requisition → purchase (held) → reconciled acceptance (released)

Modeled directly on the Olerai Hotel System's purchase-order capture/approve-receipt
flow (same machine, sibling project — read to match its shape rather than invent a new
one). Stock → **Purchases** is the new middle stage between an approved requisition and
`Material.stockQty` actually increasing:

- **Approving a requisition no longer touches stock.** It only authorizes buying it —
  `stockRouter`'s requisition-approve route dropped the `stockQty` increment it used to
  do (`apps/api/src/routes/stock.ts`). An approved requisition instead becomes pickable
  under Purchases (`GET /stock/requisitions/awaiting-purchase`), pre-filling the
  material/quantity when selected — or a purchase can be captured standalone, with no
  requisition at all.
- **A captured purchase is "Held"** — the new `Purchase` model records what was actually
  bought (supplier, quantity, unit cost, invoice number) but does not touch
  `Material.stockQty` yet. It uses the exact same "new purchase creates the Expense" /
  "already logged, pick it from a dropdown" linkage as Film Roll installs
  (`FilmRoll.expenseId`) — a "new" purchase auto-creates a "Printing Materials &
  Consumables" Expense (checked against the Petty Cash float, same insufficient-balance
  guard as everywhere else money leaves it) and an "existing" one links an already-logged
  expense; either way `Purchase.expenseId` is `@unique`, so one expense can only ever
  back one purchase.
- **Reconciliation happens at acceptance**, not before: a *different* finance
  manager/general manager/admin than whoever captured the purchase (self-accept is
  blocked, same segregation-of-duties rule as every other approve/reject in this app)
  reviews `requisitionedQty` (what was asked for) against `qty` (what was actually
  bought) — the variance is computed and snapshotted right then
  (`POST /stock/purchases/:id/accept`) — and only accepting is what runs
  `Material.stockQty += qty`, i.e. releases it into the store. Rejecting
  (`POST /stock/purchases/:id/reject`, a reason required) leaves stock untouched so the
  purchase can be corrected and re-captured. Verified live end-to-end: raised a
  requisition for 20 Caps, approved it as one manager, captured a purchase of only 18 as
  a second manager (confirmed self-accept is blocked), accepted it as a third — stock
  went from 0 to exactly 18 only at that final step, with the -2 variance recorded
  against the purchase.

## Finance consolidation: Quotation, Invoice, All Orders, Payments and P&L moved in

Anyone who can reach Finance (`canAccessFinance` — Finance Manager, General Manager,
Admin) now does **everything** sales/order/finance-related from inside it, as tabs, in
one place — Quotation, Invoice, All Orders, Payments, P&L, Expenses, Petty Cash
(`apps/web/src/pages/Finance.tsx`) — instead of six separate top-level nav entries. All
Orders/Payments/P&L are the *exact same* `Orders`/`Payments`/`PnL` components mounted as
tab content (no duplicated logic); Quotation and Invoice share one new
`CorporateOrderForm` component (`apps/web/src/components/CorporateOrderForm.tsx`)
parameterized by `kind`.

- **This consolidation is conditional on having Finance access, not universal.**
  Supervisor has order/payment oversight (`canViewAllOrders`/`canManagePayments`) but not
  `canAccessFinance`, and still gets All Orders/Payments as their own top-level nav
  entries exactly as before (`AppLayout.tsx`'s `buildTabs` only folds these into Finance
  once `canAccessFinance` is already true, so Supervisor loses nothing). Staff's "New
  Walk-in Order"/"My Orders" are untouched — only "New Quotation" moved, and it moved
  *into* Finance rather than staying a Staff self-service action, since creating a
  quotation is now bundled with the same finance-role-only Invoice/pricing-negotiation
  work.
- **Quotation creation now requires Finance access, not just order capture** —
  `POST /orders/quote`'s permission changed from `canCaptureOrders` to `canAccessFinance`
  (`apps/api/src/routes/orders.ts`), enforced server-side (verified a Staff account gets
  a clean 403 calling it directly, not just a missing nav link). The "Prepared by" picker
  on the quotation/invoice form also changed from Staff-only to all staff, since a
  Finance Manager negotiating and capturing the deal themselves needs to appear in their
  own picker.
- **New: "Invoice" creates a corporate order that skips the quotation stage entirely** —
  for a client who's already negotiated and agreed, `POST /orders/invoice` (same
  `canAccessFinance` gate, same line-item shape as `/orders/quote`) posts straight to
  `status: 'Invoice'` with the due date set from the client's credit terms and film usage
  logged immediately — the exact end state `convertQuoteToInvoice` leaves a quote in,
  just without ever having been a quote. Verified live: created a direct invoice, confirmed
  it never touched Quote status, and its due date matched the client's credit-days terms.

## Asset Register: fixed-asset tracking under Finance

Finance → **Asset Register** (`apps/web/src/components/AssetRegister.tsx`,
`apps/api/src/routes/assets.ts`) tracks GLM's own fixed assets — printers, embroidery
machines, heat presses, computers, furniture, vehicles — as distinct from `Material`
(consumable stock sold to customers). Modeled directly on the Olerai Hotel System's own
Asset Register (same machine, sibling project — read to match its shape).

- **Deliberately no approval workflow.** Unlike Stock Purchases or Requisitions, a
  condition change (Active → Under Repair → Retired, or reactivating) is routine
  record-keeping, not a spend decision, so `POST /assets/:id/condition` applies directly
  — no requester/approver split, no self-block. The spend decision already happened at
  purchase time.
- **Deliberately no Expense linkage.** FilmRoll and Stock Purchase both auto-create (or
  link to) an `Expense` via a `@unique expenseId`, because those are recurring
  consumable buys that need to hit the P&L/Petty Cash ledger. A capital asset purchase is
  typically a one-off already captured under Finance → Expenses however the business
  normally records it, so `Asset.value` is just a book-value/insurance record, not wired
  into Petty Cash sufficiency checks the way Purchases/FilmRolls are.
- **Categories are GLM-specific**, not reused from `EXPENSE_CATEGORIES` or
  `ASSET_CATEGORIES`'s consumable-stock cousin: Printing Equipment, Embroidery Machines,
  Heat Press & Curing, Computers & IT Equipment, Furniture & Fixtures, Vehicles, Office
  Equipment, Other (`packages/shared/src/constants.ts`).
  - **Hard-delete is Admin-only** (`DELETE /assets/:id`), one level up from
    `canAccessFinance`'s general read/write/condition-change access — deleting the record
    entirely (as opposed to retiring it, which keeps history) is the same tier as Master
    Data's other destructive catalog actions.
  - Access to the tab itself, and to add/edit/change-condition, only requires
    `canAccessFinance` (Finance Manager, General Manager, Admin). Verified live: added an
    asset, ran it through the full condition lifecycle (Active → Under Repair → Retired →
    reactivated), edited it, filtered by category and condition, and deleted it as Admin.

## Embroidery: artwork-size pricing (no film) + gross profitability vs. thread/needle cost

Embroidery is now priced the same way DTF Printing is — by artwork size — but tracks no
film, since embroidery consumes thread/needles, not transfer film. This required
decoupling two things that used to be one conflated flag.

- **`Service.usesArtworkPricing` is new, separate from `Service.tracksFilm`.** Before this,
  the "Artwork size (sqm)" UI and the area × Ksh/sqm price formula
  (`LineItemsEditor.tsx`) only appeared for a service that was *both* unit `sqm` *and*
  `tracksFilm` — correct for DTF Printing, but wrong for Embroidery, which needs the same
  artwork-size pricing with zero film tracking. Now pricing is gated on
  `usesArtworkPricing && unit === 'sqm'`, and film-length capture/computation stays gated
  on `tracksFilm` alone — independent flags, so a service can have either, both (DTF
  Printing), or neither. The real "DTF Printing" service was flipped to
  `usesArtworkPricing: true` (preserving its exact existing behavior) as part of this
  change; "Embroidery" was flipped to `unit: 'sqm', usesArtworkPricing: true` (from its
  old flat `piece` pricing) with a starter Ksh 8,000/sqm formula rate for custom sizes —
  a placeholder pending GLM's real figures.
- **Artwork Size Bands are now scoped per service** (`ArtworkSizeBand.serviceId`, a
  required FK) instead of one global list — a DTF print and an embroidered patch of the
  same physical size price very differently, so a 6cm × 6cm band can no longer leak its
  DTF price onto an Embroidery line. Master Data → Artwork Size Bands gained a service
  picker; `LineItemsEditor.tsx`'s quick-size dropdown and the 📐 calculator both filter to
  the current line's own service. Seeded four starter bands for Embroidery (small logo
  5×5cm/Ksh 300, medium logo 8×8cm/Ksh 450, large design 12×12cm/Ksh 700, jacket back
  25×25cm/Ksh 1,800) — small embroidery jobs are dominated by machine setup/stitch-out
  time even more than DTF prints are, so these flat tiers are the primary pricing path in
  practice, with the per-sqm formula as a fallback for anything larger/custom. All are
  placeholders — adjust to GLM's real pricing in Master Data.
- **No FilmRoll/FilmUsage changes were needed at all.** `tracksFilm: false` on Embroidery
  alone keeps it out of `logFilmUsageForOrder` (film.ts) and the DTF print queue — verified
  live by capturing an Embroidery order line (Medium logo band, Ksh 450) and confirming
  its `OrderLineItem.filmLengthM` is `null` and zero `FilmUsage` rows were created for it.

**Reports → Embroidery Profitability** (`GET /reports/embroidery-profitability`,
`apps/api/src/routes/reports.ts`) gives a gross-profit view: Embroidery service revenue in
range (same accrual basis as Sales by Category) against the cost of thread/needles bought
in range, via the existing Stock → Purchases pipeline rather than a new cost-tracking
model.

- **Thread and needles are ordinary `Material` rows** ("Embroidery Thread", "Embroidery
  Needles" — added via Master Data → Stock Price List, same as any consumable), bought
  through the existing requisition → purchase (held) → reconciled acceptance (released)
  pipeline from the Stock feature, not a new mechanism.
- **Only `status: 'Accepted'` purchases count as real cost** — a Held or Rejected purchase
  hasn't actually entered the store, matching the same "held vs. released" reasoning as
  everywhere else in Stock.
- **Consumables are identified by exact Material name**
  (`EMBROIDERY_CONSUMABLE_MATERIAL_NAMES` in `packages/shared/src/constants.ts`), not a
  new Expense category or a schema link between Material and Service — there's no
  per-service consumable-material relationship in this schema (a Material line is a
  standalone sale/stock item, never "consumed by" a service line), and matching by name
  mirrors how Sales by Category already groups revenue by `service.name` with no ID-based
  flagging either. Adding another embroidery consumable later (e.g. stabilizer backing)
  means adding its Material name to that constant.
- **Per-piece margin is a gauge, not an exact job cost** — consumable cost is spread
  evenly across pieces sold in range (mirroring FilmRoll's weighted-average
  margin-per-metre pattern, translated to per-piece), since thread/needle usage isn't
  captured per individual order the way film length is. An "Underpriced" flag surfaces
  when average revenue per piece falls below average consumable cost per piece.
- Verified live: inserted a test Accepted thread purchase (10 units, Ksh 2,500) and a test
  Embroidery order (Ksh 450), confirmed the report correctly summed revenue and cost, computed
  gross profit/margin, and broke the cost down by material — then deleted both test rows
  (plus a temporary test Finance Manager user created to exercise the accept step) to keep
  the real data clean.
