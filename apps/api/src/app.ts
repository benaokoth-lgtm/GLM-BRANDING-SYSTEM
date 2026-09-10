import express from 'express';
import cors from 'cors';
import { authRouter } from './routes/auth';
import { masterDataRouter } from './routes/masterdata';
import { ordersRouter } from './routes/orders';

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5174').split(',').map((o) => o.trim());

export const app = express();
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);
app.use('/api/master-data', masterDataRouter);
app.use('/api/orders', ordersRouter);
