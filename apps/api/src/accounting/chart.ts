import { prisma } from '../db';
import { ACCT, DEFAULT_CHART, EXPENSE_CATEGORIES, EXPENSE_HEAD_ACCOUNT_CODES, SYSTEM_ACCOUNT_CODES, defaultServiceIncomeCode } from '@glm/shared';
import type { AccountType } from '@glm/shared';

// Where custom expense heads (ones added after setup) get their accounts: above the standard ones,
// leaving 6900+ free for the built-in catch-alls.
const CUSTOM_EXPENSE_START = 5300;
const CUSTOM_EXPENSE_CEILING = 5999;

async function nextCustomExpenseCode(): Promise<string> {
  const rows = await prisma.account.findMany({ where: { type: 'Expense' }, select: { code: true } });
  let max = CUSTOM_EXPENSE_START - 10;
  for (const r of rows) {
    const n = Number(r.code);
    if (Number.isFinite(n) && n >= CUSTOM_EXPENSE_START && n <= CUSTOM_EXPENSE_CEILING && n > max) max = n;
  }
  return String(max + 10);
}

/** The account an expense head should post to: a standard one by name, otherwise a fresh account of its own. */
export async function accountIdForNewExpenseHead(name: string): Promise<number> {
  const standardCode = EXPENSE_HEAD_ACCOUNT_CODES[name];
  if (standardCode) {
    const acc = await prisma.account.findUnique({ where: { code: standardCode } });
    if (acc && acc.type === 'Expense') return acc.id;
  }
  const created = await prisma.account.create({
    data: { code: await nextCustomExpenseCode(), name, type: 'Expense', description: `Auto-created for the “${name}” expense head.` },
  });
  return created.id;
}

/**
 * Idempotent: makes sure the standard chart exists, that every expense head posts to an Expense account and every
 * service to an Income account (creating or linking as needed), and that the Accounting permission is granted once to
 * the finance roles on databases that pre-date it. Safe to run on every start and before every accounting request.
 */
export async function ensureChartOfAccounts(): Promise<void> {
  const existing = await prisma.account.findMany({ select: { code: true } });
  const have = new Set(existing.map((a) => a.code));
  for (const def of DEFAULT_CHART) {
    if (have.has(def.code)) continue;
    await prisma.account.create({
      data: { code: def.code, name: def.name, type: def.type, subtype: def.subtype, description: def.description || '', system: SYSTEM_ACCOUNT_CODES.includes(def.code) },
    });
  }

  // Heads: the standard list always exists; any head without an account is linked now.
  for (const name of EXPENSE_CATEGORIES) {
    const head = await prisma.expenseHead.findUnique({ where: { name } });
    if (!head) await prisma.expenseHead.create({ data: { name, accountId: await accountIdForNewExpenseHead(name) } });
  }
  // Heads already used by old expense rows (a custom category someone typed) must exist too.
  const used = await prisma.expense.findMany({ distinct: ['category'], select: { category: true } });
  for (const { category } of used) {
    if (!(await prisma.expenseHead.findUnique({ where: { name: category } }))) {
      await prisma.expenseHead.create({ data: { name: category, accountId: await accountIdForNewExpenseHead(category) } });
    }
  }
  for (const head of await prisma.expenseHead.findMany({ where: { accountId: null } })) {
    await prisma.expenseHead.update({ where: { id: head.id }, data: { accountId: await accountIdForNewExpenseHead(head.name) } });
  }

  // Services: default Income account by name; materials fall back to Merchandise Sales in the ledger.
  const byCode = new Map((await prisma.account.findMany()).map((x) => [x.code, x.id]));
  for (const s of await prisma.service.findMany({ where: { accountId: null } })) {
    const id = byCode.get(defaultServiceIncomeCode(s.name)) ?? byCode.get(ACCT.printingIncome);
    if (id) await prisma.service.update({ where: { id: s.id }, data: { accountId: id } });
  }

  // Grant the module once, to the roles that would normally have it, on databases that pre-date it.
  // (After that, Master Data → Roles & Access is the source of truth.)
  if ((await prisma.role.count({ where: { canAccessAccounting: true } })) === 0) {
    await prisma.role.updateMany({ where: { name: { in: ['Finance Manager', 'General Manager'] } }, data: { canAccessAccounting: true } });
  }
}

let ensured: Promise<void> | null = null;
/** Runs ensureChartOfAccounts at most once at a time; re-runs on the next call after a failure. */
export function ensureChartOnce(): Promise<void> {
  if (!ensured) {
    ensured = ensureChartOfAccounts().finally(() => {
      ensured = null;
    });
  }
  return ensured;
}

/** Validates an account chosen for a head/service, or returns null when none was requested. */
export async function validateAccountChoice(requested: unknown, type: AccountType): Promise<number | null> {
  if (requested === undefined || requested === null || requested === '') return null;
  const acc = await prisma.account.findUnique({ where: { id: Number(requested) } });
  if (!acc || !acc.active) throw new Error('Choose an existing, active account');
  if (acc.type !== type) throw new Error(`That head must be linked to an ${type} account`);
  return acc.id;
}
