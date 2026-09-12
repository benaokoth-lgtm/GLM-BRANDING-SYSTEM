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
import { pnlRouter } from './routes/pnl';
import { financeRouter } from './routes/finance';
import { stockRouter } from './routes/stock';
import { filmRouter } from './routes/film';
import { reportsRouter } from './routes/reports';
import { emailRouter } from './routes/email';
import { mpesaRouter } from './routes/mpesa';
import { assetsRouter } from './routes/assets';

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5174').split(',').map((o) => o.trim());

export const app = express();
app.use(cors({ origin: allowedOrigins }));
// Raised from Express's 100kb default so a small company logo (sent as a base64
// data URL from Master Data) fits in the request body.
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);
app.use('/api/master-data', masterDataRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/pnl', pnlRouter);
app.use('/api/finance', financeRouter);
app.use('/api/stock', stockRouter);
app.use('/api/film', filmRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/email', emailRouter);
app.use('/api/mpesa', mpesaRouter);
app.use('/api/assets', assetsRouter);

// Catch-all — any error forwarded here (including async rejections, thanks
// to express-async-errors above) gets a clean JSON 500 instead of Express's
// default HTML error page or an unhandled crash. Logged server-side so the
// real cause is still visible in the dev console / production logs.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});
