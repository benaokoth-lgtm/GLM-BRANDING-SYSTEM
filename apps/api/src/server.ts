import 'dotenv/config';
import { app } from './app';
import { startDepreciationSchedule } from './accounting/depreciation';
import { ensureChartOnce } from './accounting/chart';
import { ensureRequisitionsOnce } from './requisitions';
import { ensureProductionOnce } from './production';
import { ensureCostAccessOnce } from './costs';

const port = Number(process.env.PORT) || 4100;
app.listen(port, () => {
  console.log(`GLM Branding POS API listening on :${port}`);
  // Make sure the chart of accounts exists, then catch asset depreciation up and keep it current.
  ensureChartOnce()
    .then(() => startDepreciationSchedule())
    .catch((e) => console.error('Accounting start-up failed', e));
  // Give older requisitions a reference and a line; grant the production/quality permissions on databases that pre-date them.
  Promise.all([ensureRequisitionsOnce(), ensureProductionOnce(), ensureCostAccessOnce()]).catch((e) => console.error('Start-up checks failed', e));
});
