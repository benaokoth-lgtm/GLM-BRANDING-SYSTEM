import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../state/AuthContext';
import { useRange } from './accounting/shared';
import { BalanceSheetTab, CashFlowTab, LedgerTab, ProfitLossTab, TrialBalanceTab } from './accounting/StatementsTabs';
import { PayablesTab, ReceivablesTab } from './accounting/AgingTabs';
import { NotesTab } from './accounting/NotesTab';
import { MpesaTab } from './accounting/MpesaTab';
import { DepreciationTab } from './accounting/DepreciationTab';
import { ChartTab } from './accounting/ChartTab';
import { JournalsTab } from './accounting/JournalsTab';
import { BooksCheckTab } from './accounting/BooksCheckTab';

// Accounting: the books, derived from everything the business does. Orders, payments, expenses, wages, petty cash, credit
// and debit notes, M-Pesa receipts and asset depreciation post themselves; journals cover only what has no screen of its own.
// Expenses, petty cash and the asset register are still captured under Finance (and wages under Compliance).
const TABS = [
  { id: 'pl', label: 'Profit & Loss' },
  { id: 'bs', label: 'Balance Sheet' },
  { id: 'cash-flow', label: 'Cash Flow' },
  { id: 'receivables', label: 'Receivables' },
  { id: 'payables', label: 'Payables' },
  { id: 'notes', label: 'Credit / Debit Notes' },
  { id: 'mpesa', label: 'M-Pesa Matching', alsoPayments: true },
  { id: 'depreciation', label: 'Depreciation' },
  { id: 'coa', label: 'Chart of Accounts' },
  { id: 'journals', label: 'Journals' },
  { id: 'ledger', label: 'General Ledger' },
  { id: 'tb', label: 'Trial Balance' },
  { id: 'check', label: 'Books Check' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const TAB_KEY = 'glm_accounting_tab';

export default function Accounting() {
  const { user } = useAuth();
  const fullAccess = user?.role === 'Admin' || !!user?.permissions.canAccessAccounting;
  // A cashier who can manage payments (but isn't in Accounting) only gets M-Pesa matching.
  const tabs = TABS.filter((t) => fullAccess || ('alsoPayments' in t && t.alsoPayments));
  const [params] = useSearchParams();
  const [picked, setPicked] = useState<TabId | null>(() => {
    const fromLink = params.get('tab') as TabId | null;
    if (fromLink) return fromLink;
    try {
      return localStorage.getItem(TAB_KEY) as TabId | null;
    } catch {
      return null;
    }
  });
  const tab: TabId = tabs.some((t) => t.id === picked) ? (picked as TabId) : (tabs[0]?.id ?? 'mpesa');
  // One date range shared by the period reports, so switching tabs keeps the days you picked.
  const range = useRange();

  function choose(id: TabId) {
    setPicked(id);
    try {
      localStorage.setItem(TAB_KEY, id);
    } catch {
      /* remembering the tab is a convenience only */
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div className="no-print" style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {tabs.map((t) => (
          <button key={t.id} type="button" className={'btn blueprint ' + (tab === t.id ? 'btn-primary' : 'btn-secondary')} onClick={() => choose(t.id)}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'pl' && <ProfitLossTab range={range} />}
      {tab === 'bs' && <BalanceSheetTab />}
      {tab === 'cash-flow' && <CashFlowTab range={range} />}
      {tab === 'receivables' && <ReceivablesTab />}
      {tab === 'payables' && <PayablesTab />}
      {tab === 'notes' && <NotesTab range={range} />}
      {tab === 'mpesa' && <MpesaTab />}
      {tab === 'depreciation' && <DepreciationTab range={range} />}
      {tab === 'coa' && <ChartTab />}
      {tab === 'journals' && <JournalsTab />}
      {tab === 'ledger' && <LedgerTab range={range} />}
      {tab === 'tb' && <TrialBalanceTab />}
      {tab === 'check' && <BooksCheckTab range={range} />}
    </div>
  );
}
