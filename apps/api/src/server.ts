import 'dotenv/config';
import { app } from './app';
import { startDepreciationSchedule } from './accounting/depreciation';
import { ensureChartOnce } from './accounting/chart';
import { ensureRequisitionsOnce } from './requisitions';
import { ensureProductionOnce } from './production';
import { ensureCostAccessOnce } from './costs';
import { ensureCommissionAccessOnce } from './commission';
import { ensureFrontOfficeOnce } from './frontOffice';
import { ensureBusinessHeadsOnce, ensurePurchasesOnce, ensureStoresAccess } from './purchases';
import { ensureStaffNamesOnce } from './staffNames';
import { ensureMaterialItemsOnce } from './materials';
import { startBackupScheduler } from './backup';
import { pruneAudit } from './audit';
import { sealStoredSecrets } from './secrets';
import { dataKeyConfigured } from './crypto';

const port = Number(process.env.PORT) || 4100;
app.listen(port, () => {
  console.log(`POS API listening on :${port}`);
  // Make sure the chart of accounts exists, then catch asset depreciation up and keep it current.
  ensureChartOnce()
    .then(() => startDepreciationSchedule())
    .catch((e) => console.error('Accounting start-up failed', e));
  startBackupScheduler();
  void pruneAudit();
  sealStoredSecrets().catch((e) => console.error('Sealing saved secrets failed', e));
  if (!dataKeyConfigured()) console.warn('DATA_KEY is not set: saved secrets and backup files are stored unprotected. See Master Data → Security.');
  // Give older requisitions a reference and a line; grant the production/quality permissions on databases that pre-date them.
  Promise.all([ensureRequisitionsOnce(), ensureProductionOnce(), ensureCostAccessOnce(), ensureCommissionAccessOnce(), ensureFrontOfficeOnce(), ensurePurchasesOnce(), ensureStoresAccess(), ensureBusinessHeadsOnce(), ensureStaffNamesOnce(), ensureMaterialItemsOnce()]).catch((e) => console.error('Start-up checks failed', e));
});
