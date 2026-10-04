import DtfDaily from './DtfDaily';
import type { DtfTabProps } from './shared';

// History view — recording a new job happens on its own page (New Artwork Order); this tab (canManageDtf only, see Dtf.tsx) lists the
// jobs a day at a time, with each day's orders behind it, and is where an admin removes a bad entry.
export default function DtfJobs(props: DtfTabProps) {
  return <DtfDaily kind="jobs" {...props} />;
}
