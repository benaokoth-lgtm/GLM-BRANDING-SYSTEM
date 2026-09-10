# Handoff: P&L Account tab for GLM Order Processing & POS

## Overview
Adds a Profit & Loss reporting screen to the existing GLM Branding Order Processing & POS system. It aggregates every walk-in order and corporate invoice already captured by the POS into a filterable P&L account — by month, quarter, year, last-12-months, or a custom date range — with cost-of-sales, an operating-expense ledger (categories matched to GLM's real Petty Cash Tracker), prior-period comparison, and a 6-month trend chart. Visible to Supervisor and Admin roles only (Staff cannot originate orders from here and doesn't get the tab).

## About the Design Files
The bundled `GLM Order Processing & POS.dc.html` is a **design reference built in HTML** (a single interactive prototype with inline React-style state) — it demonstrates the intended screen, data model, and calculation logic, not production code to copy directly. Recreate it in the target codebase (per the existing repo's stack: Next.js/React + TypeScript, Prisma/Postgres, per `README.md` at the repo root) using its own component library, data layer, and API routes — do not embed this HTML.

## Fidelity
**High-fidelity.** This file extends the team's own prior design handoff (`design_handoff_pos_system/`) and reuses its exact token set — colors, type, spacing, the blueprint corner-mark component framing — so the new P&L tab reads as one continuous product with the rest of the POS. See `design-tokens/` (copied alongside) for the token source.

## Where it lives in the app
A new tab, **"P&L"**, added to the existing tab row:
- **Staff** role: unchanged (New Walk-in Order / New Quotation / My Orders) — no access to P&L.
- **Supervisor** role: All Orders, Pending Payments, **P&L**.
- **Admin** role: All Orders, Pending Payments, Master Data, **P&L**.

## Screens / Views

### P&L tab
**Purpose:** give Supervisor/Admin a filterable profit-and-loss account built from live order/payment data plus a manually-maintained expense ledger.

**Layout (top to bottom, single column, `max-width:1280px` centered — matches the rest of the app's `<main>`):**
1. **Filter bar** (card, `.card.blueprint`): left side — 4 preset buttons (This month / This quarter / Year to date / Last 12 months); right side — From/To native `<input type="date">` fields (for a fully custom range) and a "Print / PDF" button (`window.print()`, see Print behavior below).
2. **KPI row**: 4 equal-width cards (`display:grid;grid-template-columns:repeat(4,1fr)`): Revenue (accrual), Revenue (cash received), Gross profit, Net profit. The accrual-revenue and net-profit cards show a small muted line underneath with the % change vs. the immediately-preceding period of equal length (e.g. "+12.4% vs prior period", or "No prior data" if the prior period has no revenue).
3. **P&L statement card**: a classic vertical P&L layout, each line a flex row (`justify-content:space-between`) with the amount right-aligned and `white-space:nowrap` (important — long formatted Ksh amounts must not wrap):
   - Walk-in sales
   - Corporate sales (invoiced) — divider below
   - Total revenue (heading weight)
   - Cost of sales (— % of revenue, the % is a live editable input inline in the label) shown in parentheses (deduction)
   - **Gross profit** (border-top + border-bottom-2px, larger type — subtotal styling)
   - One line per expense category (in parentheses, deductions) — see category list below
   - Total operating expenses (parenthesized)
   - **Net profit** (border-top-2px, largest type) with the net margin % alongside
4. **Trend card**: simple CSS bar chart, 6 month buckets ending at the filter's "To" date, two bars per month (revenue, net profit — net profit bar turns a different color when negative), value shown via `title` tooltip and printed as text under axis.
5. **Expense ledger card** (excluded from print via `.no-print`): an inline add-row form (Date / Category dropdown / Note / Amount / Add button) above a table of the 40 most recent expense entries within the selected range, each with a remove (✕) button. A caption states the comparison period used for the prior-period deltas.

## Data model additions
```
Order.payments[]  — already existed; now also drives "cash received" revenue (sum of payment.amount whose date falls in the selected range), independent of order.createdDate.
Expense { id, date, category, note, amount }   // new — the operating-expense ledger
```
Revenue counted in the P&L = every walk-in Order + every corporate Order with `status === 'Invoice'` (NOT `'Quote'`), using `computeOrderTotals(order).grandTotal`, bucketed by `order.createdDate` for the accrual figure and by each `payment.date` for the cash figure.

**Cost of sales** is NOT itemized per job — it's modeled as a single adjustable percentage of accrual revenue (default 40%, editable inline in the statement). This is a placeholder assumption because GLM's Master Data price list stores customer-facing prices, not GLM's own unit cost — a real implementation should replace this with either (a) a cost field added to the Service/Material master data, or (b) actual job-costing data, whichever the business adopts.

**Expense categories** (13, matches GLM's actual Petty Cash Tracker spreadsheet plus a Salaries & wages line that sits outside petty cash):
Salaries & wages, Printing Materials & Consumables, Casual Labour, Transport, Utilities, Equipment Maintenance, Office Supplies, Courier/Delivery, Refreshments, Miscellaneous, Airtime/Data, Cleaning, Bank Charges.

The prototype ships with ~21 months (Jan 2025–Sep 2026) of **deterministically-generated sample orders and expenses** (seeded PRNG, so output is stable) purely so the filters/chart have something to show. None of this is real — production should read live `orders`/`payments` rows and a real `expenses` table (e.g. seeded from GLM's Petty Cash Tracker once staff start logging entries there, or entered directly in this UI).

## Interactions & Behavior
- Preset buttons set `plFromDate`/`plToDate` in state (This month = 1st of current month → today; This quarter = start of current calendar quarter → today; Year to date = Jan 1 → today; Last 12 months = today minus 11 months, 1st of that month → today).
- Editing either date input switches to a fully custom range.
- Editing the cost-of-sales % input recomputes gross profit and net profit live.
- Adding an expense: validates amount > 0, prepends to the ledger, resets the draft row (category defaults to "Other/Misc" equivalent — currently defaults to the last-used category structure; feel free to default to blank/"Miscellaneous").
- Removing an expense removes it from the ledger and all aggregates recompute.
- "Print / PDF" calls `window.print()`. A `@media print { .no-print { display:none !important; } }` rule hides the nav bar, tab bar, the filter card, the cost-of-sales % input widget, and the "add expense" ledger card, leaving only the KPI cards, the P&L statement, and the trend chart on the printed page.
- Prior-period comparison: same length of time immediately preceding the selected `From` date (e.g. filtering Aug 1–31 compares to Jul 1–31; filtering a custom 10-day range compares to the preceding 10 days).

## State Management (new state, additive to the existing Order model)
```
plFromDate: string        // 'YYYY-MM-DD'
plToDate: string          // 'YYYY-MM-DD'
plCogsPct: number         // default 40
plExpenses: Expense[]     // see model above
plNewExpense: { date, category, note, amount }  // add-row draft
```
Computation is pure/derived (never stored): `computePlAgg(fromDate, toDate)` walks `orders` + `plExpenses` and returns revenue (accrual & cash, split walk-in/corporate), COGS, gross profit, expense-by-category totals, and net profit. `priorRange()` derives the comparison window. `buildTrend()` calls `computePlAgg` once per of the trailing 6 calendar months.

## Design Tokens
Unchanged from the existing POS handoff — see `design-tokens/theme.json` / `styles.css`:
- Background `#f2f2f3`, text `#1d1f20`, accent `#5980a6` (mono ramp, steps 100–900)
- Headings: Barlow Condensed (400/600); Body: Barlow (400/500/700)
- Radius 4px; spacing scale at 0.85× density; square-corner "blueprint" card framing with `+` registration marks reused on every new card/button here, exactly as elsewhere in the app.
- No new colors or components were introduced — the P&L reuses `.card`, `.btn`, `.input`, `.table`, `.field`, `.blueprint`/`.corner`, `.text-muted`, `.note` from the existing token sheet.

## Assets
None — data-driven, no imagery.

## Files
- `GLM Order Processing & POS.dc.html` — the full interactive prototype including the new P&L tab (open directly in a browser; switch role to Supervisor or Admin to see the P&L tab).
- `design-tokens/styles.css`, `design-tokens/theme.json` — the design system's token source (unchanged from the original POS handoff).
- Source of truth for the original POS screens/data model: `design_handoff_pos_system/README.md` in the connected repo (`benaokoth-lgtm/GLM-BRANDING-SYSTEM`) — this handoff only documents what's new.
