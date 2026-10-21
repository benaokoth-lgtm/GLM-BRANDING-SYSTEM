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
import { quoteDocument } from '../costingDocument';
import { quoteForUser } from './costing';
import { TEMPLATE_BODY, WhatsappError, checkConnection, loadWhatsappConfig, sendFileMessage, sendInvoiceDocument } from '../whatsapp';

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
  orderId: z.number().int().positive().optional(),
  // …or a Job Costing quote's quotation
  costingQuoteId: z.number().int().positive().optional(),
  // Where to send it; left out, the number on the order is used.
  to: z.string().trim().max(40).optional(),
});

whatsappRouter.post('/send', sendLimiter, async (req, res) => {
  const cfg = await loadWhatsappConfig();
  if (!cfg) return res.status(501).json({ error: "WhatsApp isn't set up yet — an Admin can set it up under Master Data → WhatsApp" });
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  if (!parsed.data.orderId && !parsed.data.costingQuoteId) return res.status(400).json({ error: 'Choose the order or quote to send' });
  let detail: ReturnType<typeof serializeDetail> | ReturnType<typeof quoteDocument>;
  if (parsed.data.costingQuoteId) {
    const r = await quoteForUser(req.user!, parsed.data.costingQuoteId);
    if ('error' in r) return res.status(r.status).json({ error: r.error });
    detail = quoteDocument(r.quote);
  } else {
    const order = await prisma.order.findUnique({ where: { id: parsed.data.orderId! }, include: orderInclude });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!(await canAccessOrder(req.user!, order))) return res.status(403).json({ error: 'Not permitted' });
    detail = serializeDetail(order);
  }
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
    prisma.whatsappMessage.create({ data: { orderId: parsed.data.costingQuoteId ? null : parsed.data.orderId!, costingQuoteId: parsed.data.costingQuoteId ?? null, toNumber: to, status, mode: extra.mode ?? '', waMessageId: extra.waMessageId ?? null, error: extra.error ?? '', sentByName: req.user!.name } });

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
  const quoteId = Number(req.query.costingQuoteId);
  const orderId = Number(req.query.orderId);
  let where: { orderId: number } | { costingQuoteId: number };
  if (Number.isInteger(quoteId) && quoteId > 0) {
    const r = await quoteForUser(req.user!, quoteId);
    if ('error' in r) return res.status(r.status).json({ error: r.error });
    where = { costingQuoteId: quoteId };
  } else {
    if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: 'Choose the order' });
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { staffId: true } });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!(await canAccessOrder(req.user!, order))) return res.status(403).json({ error: 'Not permitted' });
    where = { orderId };
  }
  const rows = await prisma.whatsappMessage.findMany({ where, orderBy: { id: 'desc' }, take: 10 });
  res.json(rows.map((r) => ({ id: r.id, to: r.toNumber, status: r.status, mode: r.mode, fileName: r.fileName, error: r.error, sentByName: r.sentByName, at: r.createdAt.toISOString() })));
});

// ── A file picked with the paperclip ────────────────────────────────────────
// Any file (a PDF, a picture of the artwork, a Word or Excel file) to any number, with or without an order: the browser sends it as base64 and the server uploads it to WhatsApp and sends it.
const FILE_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
};
const MAX_FILE = 10 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024; // WhatsApp refuses a picture over 5 MB

const sendFileSchema = z.object({
  to: z.string().trim().min(1, "Enter the customer's WhatsApp number, like 0797 785 033").max(40),
  filename: z.string().trim().min(1).max(120),
  mime: z.string().trim().max(120),
  data: z.string().min(1, 'Attach a file first'),
  customer: z.string().trim().max(80).optional(),
  message: z.string().trim().max(600).optional(),
  orderId: z.number().int().positive().optional(),
});

whatsappRouter.post('/send-file', sendLimiter, async (req, res) => {
  const cfg = await loadWhatsappConfig();
  if (!cfg) return res.status(501).json({ error: "WhatsApp isn't set up yet — an Admin can set it up under Master Data → WhatsApp" });
  const parsed = sendFileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = parsed.data;
  const ext = FILE_TYPES[d.mime];
  if (!ext) return res.status(400).json({ error: 'That kind of file cannot be sent on WhatsApp from here. Use a PDF, a picture (JPG, PNG, WebP), a Word or Excel file, or a text file.' });
  const to = whatsappNumber(d.to);
  if (!to) return res.status(400).json({ error: "Enter the customer's WhatsApp number, like 0797 785 033" });
  const data = Buffer.from(d.data, 'base64');
  if (data.length === 0) return res.status(400).json({ error: 'The file is empty' });
  if (data.length > MAX_FILE) return res.status(400).json({ error: 'That file is over 10 MB. Send a smaller one (compress the PDF or the picture).' });
  if (d.mime.startsWith('image/') && data.length > MAX_IMAGE) return res.status(400).json({ error: 'WhatsApp accepts pictures up to 5 MB. Send a smaller picture, or send it as a PDF.' });
  if (d.orderId) {
    const order = await prisma.order.findUnique({ where: { id: d.orderId }, select: { staffId: true } });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!(await canAccessOrder(req.user!, order))) return res.status(403).json({ error: 'Not permitted' });
  }

  const company = await prisma.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  const base = d.filename.replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'document';
  const filename = `${base}.${ext}`;
  const note = d.message || `From ${company.companyName}.`;
  const log = (status: 'Sent' | 'Failed', extra: { waMessageId?: string; error?: string; mode?: string }) =>
    prisma.whatsappMessage.create({ data: { orderId: d.orderId ?? null, toNumber: to, status, mode: extra.mode ?? '', fileName: filename, waMessageId: extra.waMessageId ?? null, error: extra.error ?? '', sentByName: req.user!.name } });
  try {
    const sent = await sendFileMessage(cfg, { to, data, filename, mime: d.mime, params: [d.customer || 'customer', 'document', filename, 'not applicable', note], caption: note });
    await log('Sent', { waMessageId: sent.messageId, mode: sent.mode });
    res.json({ ok: true, to, messageId: sent.messageId, mode: sent.mode, attachment: filename });
  } catch (e) {
    const message = e instanceof WhatsappError ? e.message : 'Could not send the file';
    if (!(e instanceof WhatsappError)) console.error('WhatsApp file send failed', e);
    await log('Failed', { error: message });
    res.status(502).json({ error: message });
  }
});

/** The latest WhatsApp messages: your own, or everyone's for an Admin (the standalone Send a document screen). */
whatsappRouter.get('/recent', async (req, res) => {
  const rows = await prisma.whatsappMessage.findMany({ where: req.user!.role === 'Admin' ? {} : { sentByName: req.user!.name }, orderBy: { id: 'desc' }, take: 15 });
  res.json(rows.map((r) => ({ id: r.id, to: r.toNumber, status: r.status, mode: r.mode, fileName: r.fileName, error: r.error, sentByName: r.sentByName, at: r.createdAt.toISOString() })));
});
