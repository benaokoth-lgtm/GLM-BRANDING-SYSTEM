import express from 'express';
import cors from 'cors';
import { authRouter } from './routes/auth';
import { masterDataRouter } from './routes/masterdata';
import { ordersRouter } from './routes/orders';
import { pnlRouter } from './routes/pnl';
import { financeRouter } from './routes/finance';
import { stockRouter } from './routes/stock';

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
