// WhatsApp: the Admin's setup (Master Data → WhatsApp) and sending an invoice, quotation or receipt straight to a customer's WhatsApp as a PDF.
// See whatsapp.ts for how the messages go and why a template is needed.
import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { fmtDate, whatsappNumber } from '@glm/shared';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { seal } from '../crypto';
import { canAccessOrder, orderInclude, serializeDetail } from './orders';
import { buildOrderPdf, documentKind } from '../orderPdf';
import { TEMPLATE_BODY, WhatsappError, checkConnection, loadWhatsappConfig, sendInvoiceDocument } from '../whatsapp';

export const whatsappRouter = Router();
whatsappRouter.use(requireAuth);

// A person can send at most 30 WhatsApp messages an hour from here, as with email.
const sendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `wa-${(req as { user?: { id: number } }).user?.id ?? 'anon'}`,
  validate: false,
  message: { error: 'You have sent a lot of WhatsApp messages this hour. Try again later, or ask a manager.' },
});

// ── Setup (Admin only) ──────────────────────────────────────────────────────
type Row = Awaited<ReturnType<typeof prisma.whatsappSettings.findUnique>>;
const publicView = (row: Row) => ({
  enabled: !!row?.enabled,
  configured: !!(row?.phoneNumberId && row?.accessToken),
  phoneNumberId: row?.phoneNumberId ?? '',
  businessAccountId: row?.businessAccountId ?? '',
  hasToken: !!row?.accessToken,
  templateName: row?.templateName ?? '',
  templateLanguage: row?.templateLanguage ?? 'en',
  apiVersion: row?.apiVersion ?? 'v21.0',
  templateBody: TEMPLATE_BODY,
});

whatsappRouter.get('/settings', requireRole('Admin'), async (_req, res) => {
  res.json(publicView(await prisma.whatsappSettings.findUnique({ where: { id: 1 } })));
});

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  phoneNumberId: z.string().trim().regex(/^\d{5,25}$/, 'The Phone number ID is a long number, from WhatsApp → API Setup in Meta').or(z.literal('')).optional(),
  businessAccountId: z.string().trim().regex(/^\d{5,25}$/, 'The WhatsApp Business Account ID is a long number, from WhatsApp → API Setup in Meta').or(z.literal('')).optional(),
  accessToken: z.string().trim().max(1000).optional(), // blank = keep what is saved
  templateName: z.string().trim().regex(/^[a-z0-9_]{0,512}$/, 'A template name has only lowercase letters, numbers and underscores').optional(),
  templateLanguage: z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, 'The language code looks like en or en_US').optional(),
  apiVersion: z.string().trim().regex(/^v\d{1,2}\.\d$/, 'The API version looks like v21.0').optional(),
});

whatsappRouter.put('/settings', requireRole('Admin'), async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const b = parsed.data;
  const row = await prisma.whatsappSettings.findUnique({ where: { id: 1 } });
  const data = {
    enabled: b.enabled ?? row?.enabled ?? false,
    phoneNumberId: b.phoneNumberId ?? row?.phoneNumberId ?? '',
    businessAccountId: b.businessAccountId ?? row?.businessAccountId ?? '',
    accessToken: b.accessToken ? seal(b.accessToken) : row?.accessToken ?? '',
    templateName: b.templateName ?? row?.templateName ?? '',
    templateLanguage: b.templateLanguage || row?.templateLanguage || 'en',
    apiVersion: b.apiVersion || row?.apiVersion || 'v21.0',
  };
  if (data.enabled && !(data.phoneNumberId && data.accessToken)) return res.status(400).json({ error: 'Enter the Phone number ID and the access token before switching it on' });
  const saved = await prisma.whatsappSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
  res.json(publicView(saved));
});

// Asks WhatsApp who owns the Phone number ID with this token, so a wrong ID or token shows up here and not on a customer's invoice.
whatsappRouter.post('/settings/test', requireRole('Admin'), async (_req, res) => {
  const cfg = await loadWhatsappConfig({ ignoreSwitch: true });
  if (!cfg) return res.status(400).json({ error: 'Save the Phone number ID and the access token first' });
  try {
    res.json({ ok: true, ...(await checkConnection(cfg)) });
  } catch (e) {
    res.status(400).json({ error: e instanceof WhatsappError ? e.message : 'Could not check the connection' });
  }
});

// ── Using it ────────────────────────────────────────────────────────────────
/** Can this install send? (Anyone signed in may ask: the order window uses it to decide which buttons to offer.) */
whatsappRouter.get('/status', async (_req, res) => {
  const cfg = await loadWhatsappConfig();
  res.json({ ready: !!cfg, template: !!cfg?.templateName });
});

const money = (n: number) => 'Ksh ' + n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const sendSchema = z.object({
  orderId: z.number().int().positive(),
  // Where to send it; left out, the number on the order is used.
  to: z.string().trim().max(40).optional(),
});

whatsappRouter.post('/send', sendLimiter, async (req, res) => {
  const cfg = await loadWhatsappConfig();
  if (!cfg) return res.status(501).json({ error: "WhatsApp isn't set up yet — an Admin can set it up under Master Data → WhatsApp" });
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const order = await prisma.order.findUnique({ where: { id: parsed.data.orderId }, include: orderInclude });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!(await canAccessOrder(req.user!, order))) return res.status(403).json({ error: 'Not permitted' });

  const detail = serializeDetail(order);
  const to = whatsappNumber(parsed.data.to || detail.corporateClient?.phone || detail.phone);
  if (!to) return res.status(400).json({ error: "Enter the customer's WhatsApp number, like 0797 785 033" });

  const company = await prisma.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  const kind = documentKind(detail);
  const owes = kind.isInvoice && detail.totals.balanceDue > 0.009;
  const who = detail.corporateClient?.name || (detail.customerName && detail.customerName.trim().toLowerCase() !== 'walk-in' ? detail.customerName : '') || 'customer';
  const closing = kind.isInvoice
    ? owes
      ? `Balance due ${money(detail.totals.balanceDue)}${detail.dueDate ? ` by ${fmtDate(detail.dueDate)}` : ''}.`
      : 'Paid in full, thank you.'
    : 'Please contact us to confirm.';
  const filename = `${kind.label}-${detail.orderNo}`.replace(/[^A-Za-z0-9._-]+/g, '-') + '.pdf';

  const log = (status: 'Sent' | 'Failed', extra: { waMessageId?: string; error?: string; mode?: string }) =>
    prisma.whatsappMessage.create({ data: { orderId: order.id, toNumber: to, status, mode: extra.mode ?? '', waMessageId: extra.waMessageId ?? null, error: extra.error ?? '', sentByName: req.user!.name } });

  try {
    const pdf = await buildOrderPdf(detail, company);
    const sent = await sendInvoiceDocument(cfg, {
      to,
      pdf,
      filename,
      params: [who, kind.label.toLowerCase(), detail.orderNo, money(detail.totals.grandTotal), closing],
      caption: `${kind.label} ${detail.orderNo} from ${company.companyName}. Total ${money(detail.totals.grandTotal)}. ${closing}`,
    });
    await log('Sent', { waMessageId: sent.messageId, mode: sent.mode });
    res.json({ ok: true, to, messageId: sent.messageId, mode: sent.mode, attachment: filename });
  } catch (e) {
    const message = e instanceof WhatsappError ? e.message : 'Could not prepare or send the message';
    if (!(e instanceof WhatsappError)) console.error('WhatsApp send failed', e);
    await log('Failed', { error: message });
    res.status(502).json({ error: message });
  }
});

/** The last few WhatsApp messages sent for an order: who sent them, to which number, and whether WhatsApp took them. */
whatsappRouter.get('/log', async (req, res) => {
  const orderId = Number(req.query.orderId);
  if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: 'Choose the order' });
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { staffId: true } });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!(await canAccessOrder(req.user!, order))) return res.status(403).json({ error: 'Not permitted' });
  const rows = await prisma.whatsappMessage.findMany({ where: { orderId }, orderBy: { id: 'desc' }, take: 10 });
  res.json(rows.map((r) => ({ id: r.id, to: r.toNumber, status: r.status, mode: r.mode, error: r.error, sentByName: r.sentByName, at: r.createdAt.toISOString() })));
});
