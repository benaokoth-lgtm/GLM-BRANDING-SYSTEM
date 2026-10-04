import DtfDaily from './DtfDaily';
import type { DtfTabProps } from './shared';

// History view — recording a new sale happens on its own page (New Film Order) so Staff with just canAccessDtf can reach it without seeing
// roll costs or Setup. This tab (canManageDtf only, see Dtf.tsx) lists the sales a day at a time, with each day's orders behind it, and is
// where a manager reconciles payment and an admin removes bad entries.
export default function DtfSales(props: DtfTabProps) {
  return <DtfDaily kind="sales" {...props} />;
}
