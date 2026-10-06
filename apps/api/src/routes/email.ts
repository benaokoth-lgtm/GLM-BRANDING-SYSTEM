import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { canAccessOrder } from './orders';
import { explainMailError, getMailer } from '../mailer';

export const emailRouter = Router();
emailRouter.use(requireAuth);

// A person can send at most 30 emails an hour from here, so the company mailbox cannot be used to send in bulk.
const sendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `mail-${(req as { user?: { id: number } }).user?.id ?? 'anon'}`,
  validate: false,
  message: { error: 'You have sent a lot of emails this hour. Try again later, or ask a manager.' },
});

const sendSchema = z.object({
  // The document is always an order's invoice, quotation or receipt: say which, and the sender must be able to see that order.
  orderId: z.number().int().positive(),
  to: z.string().email(),
  subject: z.string().min(1).max(200),
  // Pre-rendered HTML from the frontend (same template used for print — see
  // buildCorporateDocumentHtml in apps/web/src/utils/printInvoice.ts) so the
  // invoice/quotation layout is defined in exactly one place.
  html: z.string().min(1).max(1_500_000),
});

// Sends the exact invoice/quotation HTML the frontend already renders for
// print — see "Send email" in OrderDetailDialog.tsx. Returns a clear 501 if
// SMTP_* isn't set in apps/api/.env, rather than silently failing or
// crashing, since a fresh install has no mail credentials yet.
emailRouter.post('/send', sendLimiter, async (req, res) => {
  const mailer = await getMailer();
  if (!mailer) {
    return res.status(501).json({ error: "Email isn't set up yet — an Admin can set it up under Master Data → Email" });
  }

  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const order = await prisma.order.findUnique({ where: { id: parsed.data.orderId }, select: { staffId: true } });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!(await canAccessOrder(req.user!, order))) return res.status(403).json({ error: 'Not permitted' });

  try {
    await mailer.sendMail({
      to: parsed.data.to,
      subject: parsed.data.subject,
      html: parsed.data.html,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: explainMailError(err, mailer.config) });
  }
});
