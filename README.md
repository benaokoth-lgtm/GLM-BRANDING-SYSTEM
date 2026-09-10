# GLM Branding — Order Processing & POS System

An order capture, quotation/invoicing, and payment-tracking system for GLM Branding
(embroidery, DTF printing, UV printing, large-format printing, digital printing).
Handles walk-in retail customers and corporate accounts through three roles: **Staff**
(captures orders/quotes), **Supervisor** (traces orders and payments by staff), and
**Admin** (all of Supervisor plus master-data management).

Built from a design handoff (`design_handoff_pos_system/`), recreated in this codebase
using the conventions of the Olerai Hotel System / Word Power Church System projects.

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
- No production deployment config yet (cPanel/Vercel) — add when ready to ship.
