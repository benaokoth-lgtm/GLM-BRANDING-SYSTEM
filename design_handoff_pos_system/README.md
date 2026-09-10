# Handoff: GLM Branding — Order Processing & POS System

## Overview
An order capture, quotation/invoicing, and payment-tracking system for GLM Branding, a garment/branding services business (embroidery, DTF printing, UV printing, large-format printing, digital printing). It handles two customer types — walk-in retail customers and corporate accounts — through three roles: **Staff** (captures orders/quotes), **Supervisor** (traces orders and payments by staff), and **Admin** (all of Supervisor plus master-data management).

## About the Design Files
The bundled file is a **design reference built in HTML** (a single interactive prototype using inline React-style state) — it demonstrates the intended screens, data model, and interaction logic, not production code to copy directly. The task is to **recreate this design in the target codebase's environment** — recommended stack below — using its own component library, state management, and data layer, not by embedding this HTML.

## Fidelity
**High-fidelity.** Colors, type, spacing, and component framing (blueprint cards, corner registration marks, tags, buttons) follow the bound "Industry" design system exactly — see `design-tokens/`. Recreate pixel-accurately using those tokens rather than inventing new values.

## Recommended stack
- **Frontend:** Next.js (React + TypeScript), Tailwind CSS configured with the tokens in `design-tokens/theme.json` / `styles.css`
- **Backend:** Next.js API routes (no separate server needed at this scale)
- **Database:** PostgreSQL via Prisma ORM — the data is fully relational (orders → line items → payments; staff → orders; corporate clients → invoices)
- **Auth:** NextAuth or Clerk, with a `role` field (Staff / Supervisor / Admin) gating routes and UI
- **Data fetching:** React Query (TanStack Query) for caching/mutations
- **Validation:** Zod schemas shared between client forms and API route handlers
- **Hosting:** Vercel (app) + Supabase or Neon (Postgres)

## Screens / Views

### 1. Header / Role switcher
Top `nav` bar: brand mark left, a "logged in as" staff picker (Staff role only) and a 3-way role toggle (Staff / Supervisor / Admin) right. In production this becomes real auth — the role toggle here is a prototype convenience; replace with actual session role.

### 2. New Walk-in Order (Staff)
Form: customer name, phone, staff allocation (dropdown, defaults to logged-in staff — **every walk-in order must be assigned to a staff member at capture time**, this is the traceability anchor). Payment timing is a 2-way choice: **Pay now** or **Pay on completion**.

Line-item builder (repeatable rows), each row has:
- **Type**: `Material + Service` (we supply the garment) / `Service only` (client brings their own merchandise — applies to DTF & embroidery) / `Per-metre service` (e.g. DTF sheet sold by the metre)
- Service dropdown (Embroidery, DTF Printing, UV Printing, Large Format Printing, Digital Printing, DTF Sheet per metre)
- Material dropdown (shown only for Material + Service rows: Polo Shirt, T-Shirt, Cap, Hoodie)
- Qty / Metres, Unit price (auto-fills from catalog price, editable), Discount % and Discount Ksh (both apply **per line**)
- Remove-row button; "Add line item" button appends a row

Order-level: Discount % and Discount Ksh (apply to the whole order **in addition to** line discounts). If either exceeds the configured ceiling (Master Data → Discount Rules, default 15%), show a warning tag "Exceeds standard discount — needs supervisor approval" (non-blocking in this prototype; in production this should route to an approval step).

If "Pay now" is selected: amount + payment method fields — this becomes the order's first payment record (can be partial or full).

Submitting creates an Order (status `Order`, stage `Order Received`) and routes to My Orders.

### 3. New Quotation (Staff, corporate clients)
Same line-item builder as walk-in, but: corporate client dropdown (from Master Data), "prepared by" staff dropdown, no payment step. Submitting creates a record with status `Quote`. A quote has **no due date** until converted.

**Quote → Invoice**: from the order detail dialog, a "Convert quotation to invoice" button (visible only while status is `Quote`) flips status to `Invoice` and sets a due date = created date + the client's credit-term days (from Master Data → Corporate Clients). Either staff or supervisor may trigger this — no forced client-acceptance step.

### 4. My Orders (Staff) / All Orders (Supervisor, Admin)
A table of orders. My Orders is scoped to the logged-in staff member — this is how a staff member sees only their own work. All Orders is unscoped and carries staff + status filter dropdowns and 4 KPI cards above the table (Total orders, In production, Pending balance, Overdue invoices) — this is the supervisor/admin traceability view.

Columns: Order #, Type (Walk-in/Corporate), Client, Staff, Status (Quote/Invoice/Order — tag), Stage, Total, Balance, Payment status tag (Settled / Pending / Overdue). Clicking a row opens the order detail dialog.

### 5. Pending Payments (Supervisor, Admin)
Table of every order/invoice with balance > 0: Order #, Client, Staff, Total, Paid, Balance, Due date, a paid-percentage progress bar, and a status tag (Overdue if a corporate invoice's due date has passed with a balance still owing; otherwise Pending).

### 6. Order Detail (dialog, all roles)
Opened by clicking any order row. Shows: client, staff, created date; the full line-item table with per-line discount and total; subtotal / order discount / grand total; a **production stage stepper** (Order Received → In Production → Quality Check → Ready for Pickup/Delivery → Completed — click any stage to set it, this is the staff-traceable status the supervisor/admin watch); the **payment history log** (date, amount, method); balance due with an overdue tag when applicable; a mini "record payment" form (amount + method) to log a new partial or final payment at any point, including on production completion; and, only for quotes, the convert-to-invoice action.

### 7. Master Data (Admin only)
Five sub-tabs, each a table + inline add-form:
- **Staff & Users**: name + role (Staff/Supervisor/Admin)
- **Service Price List**: service name, unit (piece/metre/sqm), price — covers Embroidery, DTF Printing, UV Printing, Large Format Printing, Digital Printing, DTF Sheet per metre
- **Material Price List**: garment/blank name + price (Polo Shirt, T-Shirt, Cap, Hoodie, etc.)
- **Corporate Clients**: name + credit terms (days) — drives invoice due dates
- **Discount Rules**: a single "standard discount ceiling %" that triggers the approval-warning tag on order forms

## Interactions & Behavior
- All forms are fully controlled; totals recompute live as line items, quantities, prices, or discounts change.
- Line total = `qty × unitPrice × (1 − discountPct/100) − discountAmt`, floored at 0.
- Order grand total = `subtotal × (1 − orderDiscountPct/100) − orderDiscountAmt`, floored at 0.
- Balance due = `grandTotal − sum(payments.amount)`, floored at 0.
- Overdue = corporate **Invoice** (not Quote) whose `dueDate` has passed and balance > 0.
- Switching role resets the active tab to that role's first tab (Staff → New Walk-in Order; Supervisor/Admin → All Orders).
- No client-side routing/URLs are used in the prototype (single-page tab state) — in the real app these should be real routes (e.g. `/orders/:id`, `/quotes/new`) for deep-linking and back-button support.

## State Management (data model)
```
StaffUser        { id, name, role: 'Staff'|'Supervisor'|'Admin' }
Service          { id, name, unit: 'piece'|'metre'|'sqm', price }
Material         { id, name, price }
CorporateClient  { id, name, creditDays }
Order            {
  id, kind: 'walkin'|'corporate',
  customerName?, phone?,              // walkin
  corporateClientId?,                 // corporate
  staffId, createdDate,
  status: 'Quote'|'Invoice'|'Order',  // Quote/Invoice = corporate; Order = walkin
  stage: 'Order Received'|'In Production'|'Quality Check'|'Ready for Pickup/Delivery'|'Completed',
  dueDate?,                           // corporate invoices only
  paymentTiming?: 'onAcceptance'|'onCompletion',  // walkin only
  lineItems: [{ itemType: 'material-service'|'service-only'|'per-metre', serviceId, materialId?, qty, unitPrice, discountPct, discountAmt }],
  orderDiscountPct, orderDiscountAmt,
  payments: [{ date, amount, method }]
}
```
Persist this in Postgres as `staff_users`, `services`, `materials`, `corporate_clients`, `orders`, `order_line_items`, `payments` tables (line items and payments as child tables with a foreign key to `orders`).

## Design Tokens
See `design-tokens/theme.json` and `design-tokens/styles.css` for the full variable set. Key values:
- Background `#f2f2f3`, text `#1d1f20`, single accent `#5980a6` (mono ramp, steps 100–900)
- Headings: Barlow Condensed (400/600); Body: Barlow (400/500/700)
- Radius: 4px; spacing scale at 0.85× density (use the `--space-*` variables, not raw px)
- Component frame: square corners, hairline borders, "+" corner registration marks (`.blueprint` + 4 `<i class="corner tl/tr/bl/br">`) on every card, figure, and the primary button — never rounded, never filled except the primary button
- Icons: Lucide, stroke-width 1.5

## Assets
No custom imagery — this is a data-driven internal tool. If a logo/wordmark exists for GLM Branding, place it in the nav bar in place of the text brand mark.

## Files
- `GLM Order Processing & POS.dc.html` — the full interactive prototype (open directly in a browser to click through all screens and roles)
- `design-tokens/styles.css`, `design-tokens/theme.json` — the design system's token source
