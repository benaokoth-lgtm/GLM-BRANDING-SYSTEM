import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { canAccessOrder, orderInclude, serializeDetail } from './orders';
import { buildOrderPdf, documentKind } from '../orderPdf';
import { explainMailError, getMailer, refusal } from '../mailer';

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
  // An optional note to the customer, shown above the details in the email.
  message: z.string().max(2000).optional(),
  // Older browser tabs still send the rendered HTML: it is ignored now — the document is built here, as a PDF, from the order itself.
  html: z.string().max(1_500_000).optional(),
});

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Emails the invoice, quotation or receipt as a PDF ATTACHMENT, with a short message in the body. The PDF is built on the server from the order's own
// record (see orderPdf.ts), so it is always what the system holds, whoever's browser asks. Returns a clear 501 if mail isn't set up, rather than
// failing silently, since a fresh install has no mail credentials yet.
emailRouter.post('/send', sendLimiter, async (req, res) => {
  const mailer = await getMailer();
  if (!mailer) {
    return res.status(501).json({ error: "Email isn't set up yet — an Admin can set it up under Master Data → Email" });
  }

  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const order = await prisma.order.findUnique({ where: { id: parsed.data.orderId }, include: orderInclude });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!(await canAccessOrder(req.user!, order))) return res.status(403).json({ error: 'Not permitted' });

  const detail = serializeDetail(order);
  const company = await prisma.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  const kind = documentKind(detail);
  let pdf: Buffer;
  try {
    pdf = await buildOrderPdf(detail, company);
  } catch (err) {
    console.error('PDF build failed', err);
    return res.status(500).json({ error: 'Could not prepare the PDF to attach' });
  }

  const owes = detail.totals.balanceDue > 0.009 && kind.isInvoice;
  const money = (n: number) => 'Ksh ' + n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const who = detail.corporateClient?.name || (detail.customerName && detail.customerName.trim().toLowerCase() !== 'walk-in' ? detail.customerName : '');
  const reach = [company.companyPhone, company.companyPhone2].filter((p) => p && p.trim()).join(' / ');
  const summary = `Total ${money(detail.totals.grandTotal)}${kind.isInvoice ? (owes ? `. Balance due ${money(detail.totals.balanceDue)}${detail.dueDate ? ` by ${detail.dueDate}` : ''}.` : '. Paid in full, thank you.') : '.'}`;
  const lines = [
    `Dear ${who || 'customer'},`,
    ...(parsed.data.message?.trim() ? ['', parsed.data.message.trim()] : []),
    '',
    `Please find attached our ${kind.label.toLowerCase()} ${detail.orderNo} from ${company.companyName}. ${summary}`,
    '',
    reach ? `Questions? Call ${reach}.` : '',
    '',
    company.companyName,
  ];
  const fileBase = `${kind.label}-${detail.orderNo}`.replace(/[^A-Za-z0-9._-]+/g, '-');

  try {
    const info = await mailer.sendMail({
      to: parsed.data.to,
      subject: parsed.data.subject,
      text: lines.join('\n'),
      html: lines.map((l) => (l ? `<p style="margin:0 0 10px">${esc(l)}</p>` : '')).join(''),
      attachments: [{ filename: `${fileBase}.pdf`, content: pdf, contentType: 'application/pdf' }],
    });
    const refused = refusal(info, parsed.data.to);
    if (refused) return res.status(502).json({ error: refused });
    res.json({ ok: true, attachment: `${fileBase}.pdf` });
  } catch (err) {
    res.status(502).json({ error: explainMailError(err, mailer.config) });
  }
});
