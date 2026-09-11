import { Router } from 'express';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';

export const emailRouter = Router();
emailRouter.use(requireAuth);

function buildTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

const sendSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(200),
  // Pre-rendered HTML from the frontend (same template used for print — see
  // buildCorporateDocumentHtml in apps/web/src/utils/printInvoice.ts) so the
  // invoice/quotation layout is defined in exactly one place.
  html: z.string().min(1),
});

// Sends the exact invoice/quotation HTML the frontend already renders for
// print — see "Send email" in OrderDetailDialog.tsx. Returns a clear 501 if
// SMTP_* isn't set in apps/api/.env, rather than silently failing or
// crashing, since a fresh install has no mail credentials yet.
emailRouter.post('/send', async (req, res) => {
  const transport = buildTransport();
  if (!transport) {
    return res.status(501).json({ error: 'Email isn\'t configured yet — set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS in apps/api/.env' });
  }

  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });

  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: parsed.data.to,
      subject: parsed.data.subject,
      html: parsed.data.html,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to send email' });
  }
});
