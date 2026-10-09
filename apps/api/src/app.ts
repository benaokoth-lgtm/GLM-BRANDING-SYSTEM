import express from 'express';
import cors from 'cors';
// Patches Express to forward a rejected promise from an async route handler
// to the error middleware below — without it, Express 4 lets that rejection
// become an unhandled rejection, which crashes the whole process (killing
// the API for every user) on any unexpected error, e.g. a bad foreign key.
import 'express-async-errors';
import { authRouter } from './routes/auth';
import { masterDataRouter } from './routes/masterdata';
import { ordersRouter } from './routes/orders';
import { financeRouter } from './routes/finance';
import { stockRouter } from './routes/stock';
import { reportsRouter } from './routes/reports';
import { emailRouter } from './routes/email';
import { mpesaRouter } from './routes/mpesa';
import { ncbaRouter } from './routes/ncba';
import { embroideryRouter } from './routes/embroidery';
import { assetsRouter } from './routes/assets';
import { dtfRouter } from './routes/dtf';
import { accountingRouter } from './routes/accounting';
import { productionRouter } from './routes/production';
import { qualityRouter } from './routes/quality';
import { commissionRouter } from './routes/commission';
import { pricelistsRouter } from './routes/pricelists';
import { backupRouter } from './routes/backup';
import { securityRouter } from './routes/security';
import { freelanceRouter } from './routes/freelance';
import { whatsappRouter } from './routes/whatsapp';
import { auditMiddleware } from './audit';

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5174').split(',').map((o) => o.trim());

export const app = express();
app.disable('x-powered-by'); // do not announce which framework this is
// Behind a reverse proxy (Nginx on a VPS) every request would otherwise appear to come from the proxy itself, so the login rate limit would be
// shared by everybody. Set TRUST_PROXY=1 (the number of proxies in front) there; unset on hosts that already hand the real address through.
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
app.use(cors({ origin: allowedOrigins }));
// Raised from Express's 100kb default so a small company logo (sent as a base64
// data URL from Master Data) fits in the request body.
app.use(express.json({ limit: '5mb' }));

// Headers on every API response: no sniffing, no framing, nothing remembered by caches or sent on as a referrer, and the API may never be
// treated as a page. (The branding endpoint sets its own short cache time.)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-store');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

// Slow requests (over a second) are logged with how long they took, so "it takes long to load" can be traced to the exact screen's request:
// on the VPS, journalctl -u glm-pos-api | grep "\[slow\]". Only the path is logged, never the query string or body.
const SLOW_MS = Number(process.env.SLOW_REQUEST_MS) || 1000;
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    if (ms >= SLOW_MS && process.env.NODE_ENV !== 'test') console.warn(`[slow] ${req.method} ${req.originalUrl.split('?')[0]} ${ms}ms (${res.statusCode})`);
  });
  next();
});

// Who did what: every change, refused request and sensitive read is written to the audit log.
app.use(auditMiddleware);

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);
app.use('/api/master-data', masterDataRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/finance', financeRouter);
app.use('/api/stock', stockRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/email', emailRouter);
app.use('/api/mpesa', mpesaRouter);
app.use('/api/ncba', ncbaRouter);
app.use('/api/embroidery', embroideryRouter);
app.use('/api/assets', assetsRouter);
app.use('/api/dtf', dtfRouter);
app.use('/api/accounting', accountingRouter);
app.use('/api/production', productionRouter);
app.use('/api/quality', qualityRouter);
app.use('/api/commission', commissionRouter);
app.use('/api/pricelists', pricelistsRouter);
app.use('/api/backup', backupRouter);
app.use('/api/security', securityRouter);
app.use('/api/freelance', freelanceRouter);
app.use('/api/whatsapp', whatsappRouter);

// Catch-all — any error forwarded here (including async rejections, thanks
// to express-async-errors above) gets a clean JSON 500 instead of Express's
// default HTML error page or an unhandled crash. Logged server-side so the
// real cause is still visible in the dev console / production logs.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});
