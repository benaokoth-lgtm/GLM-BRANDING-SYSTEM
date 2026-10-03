import { PrismaClient } from '@prisma/client';
import { todayStr } from '@glm/shared';
import { ensureChartOfAccounts } from '../src/accounting/chart';
import { runDepreciation } from '../src/accounting/depreciation';
import { reconcile } from '../src/accounting/reconcile';
import { buildBalanceSheet, buildTrialBalance } from '../src/accounting/reports';

const prisma = new PrismaClient();

// Prints the books check from the command line — handy after a deploy or an import to confirm the ledger hangs together
// (the same checks as Accounting → Books Check):
//   node books-check.js                      -> year to date
//   node books-check.js 2026-01-01 2026-06-30
async function main() {
  const today = todayStr();
  const from = process.argv[2] || `${today.slice(0, 4)}-01-01`;
  const to = process.argv[3] || today;
  await ensureChartOfAccounts();
  const charged = await runDepreciation();
  if (charged) console.log(`Depreciation: ${charged} monthly charge(s) posted.\n`);

  const r = await reconcile(from, to, to);
  console.log(`Books check ${from} → ${to}\n`);
  for (const c of r.integrity) console.log(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.name} — ${c.detail}`);
  console.log('');
  for (const s of r.sources) console.log(`${s.label.padEnd(36)} ${String(s.records).padStart(4)} records   expected ${s.expected.toFixed(2).padStart(14)}   posted ${s.posted.toFixed(2).padStart(14)}   diff ${s.difference.toFixed(2)}`);
  if (r.issues.length) {
    console.log('\nIssues:');
    for (const i of r.issues) console.log(`  ${i.source} ${i.ref}: expected ${i.expected}, posted ${i.posted} — ${i.problem}`);
  }
  if (r.catchAll.length) {
    console.log('\nBooked to a catch-all account:');
    for (const c of r.catchAll) console.log(`  ${c.ref} (${c.head}) ${c.amount} -> ${c.account}`);
  }
  console.log('\nNot (fully) in the books:');
  for (const n of r.notInBooks) if (n.count) console.log(`  ${n.label}: ${n.count} (${n.amount.toFixed(2)})`);
  const tb = await buildTrialBalance(to);
  const bs = await buildBalanceSheet(to);
  console.log(`\nTrial balance: debits ${tb.debit.toFixed(2)} / credits ${tb.credit.toFixed(2)}${tb.balanced ? '' : '  *** OUT OF BALANCE ***'}`);
  console.log(`Balance sheet: assets ${bs.assets.total.toFixed(2)} = liabilities ${bs.liabilities.total.toFixed(2)} + equity ${bs.equity.total.toFixed(2)}${bs.balanced ? '' : '  *** DOES NOT BALANCE ***'}`);
  console.log(r.allPosted ? '\nAll good: everything reaches the books.' : '\nSomething needs attention — see above.');
  if (!r.allPosted) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
