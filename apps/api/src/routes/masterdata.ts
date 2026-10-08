import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth';
import crypto from 'crypto';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSION_KEYS, cleanKraPin, composeName, materialName } from '@glm/shared';
import { ensureMaterialItemsOnce } from '../materials';
import { seal } from '../crypto';
import { PIN_ROUNDS, pinProblemFor, randomPin, requiredLengthFor } from '../pins';
import { canCaptureForOthers, salesPeople } from '../frontOffice';
import { permissionsForRole } from '../permissions';
import { ensureStaffNamesOnce } from '../staffNames';
import { canSeeCosts } from '../costs';
import { defaultBusinessHeadName } from '@glm/shared';
import { ensureBusinessHeadsOnce } from '../purchases';
import { MARKUP_TYPES } from '@glm/shared';
import { commissionEnabled } from '../commission';
import { systemName } from '../company';
import { createTransport, explainMailError, getMailer, getMailSettingsRow, loadMailConfig, refusal } from '../mailer';

export const masterDataRouter = Router();
masterDataRouter.use(requireAuth);

// ── Staff & Users ───────────────────────────────────────────────────────
masterDataRouter.get('/staff', async (_req, res) => {
  const users = await prisma.user.findMany({ orderBy: { name: 'asc' } });
  res.json(users.map((u) => ({ id: u.id, name: u.name, role: u.role, active: u.active })));
});

// A name is captured as first name, optional middle name and surname — first name and surname are compulsory.
const nameParts = {
  firstName: z.string({ required_error: 'First name is required' }).trim().min(1, 'First name is required'),
  middleName: z.string().trim().optional().default(''),
  lastName: z.string({ required_error: 'Surname is required' }).trim().min(1, 'Surname is required'),
};

/** Is another staff member already called this (ignoring capitals and extra spaces)? */
async function nameTaken(full: string, exceptId?: number): Promise<boolean> {
  const key = full.toLowerCase();
  return (await prisma.user.findMany({ select: { id: true, name: true } })).some((u) => u.id !== exceptId && u.name.trim().replace(/\s+/g, ' ').toLowerCase() === key);
}

const staffSchema = z.object({
  ...nameParts,
  role: z.string().min(1),
  // Optional when an email address is given: a PIN is made for them and emailed (they choose their own at first sign-in).
  pin: z.string().regex(/^\d{4,6}$/, 'A PIN is 4 to 6 digits').optional().or(z.literal('')),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
  // Email them their login details now (needs an email and a mail account set up under Master Data → Email).
  emailPin: z.boolean().optional(),
});

masterDataRouter.post('/staff', requireRole('Admin'), async (req, res) => {
  const parsed = staffSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const { role } = parsed.data;
  const typedPin = parsed.data.pin || '';
  const name = composeName(parsed.data);
  if (await nameTaken(name)) return res.status(400).json({ error: `There is already a staff member called ${name}` });
  const email = parsed.data.email || null;
  if (!typedPin && !email) return res.status(400).json({ error: 'Enter a PIN, or an email address so a PIN can be made and emailed to them' });
  if (parsed.data.emailPin && !email) return res.status(400).json({ error: 'Enter their email address to email them the PIN' });
  // No PIN typed: one is made and emailed. A typed PIN is emailed only when asked.
  const emailThem = !!email && (!!parsed.data.emailPin || !typedPin);
  if (!typedPin && !(await loadMailConfig())) return res.status(400).json({ error: "Email isn't set up yet — set it up under Master Data → Email first, or type a PIN for them" });
  if (email && (await prisma.user.findUnique({ where: { email } }))) return res.status(400).json({ error: 'That email address is already used by someone else' });
  if (role !== 'Admin') {
    const roleExists = await prisma.role.findUnique({ where: { name: role } });
    if (!roleExists) return res.status(400).json({ error: 'Unknown role — add it under Roles & Access first' });
  }
  const pin = typedPin || randomPin(await requiredLengthFor(role));
  const weak = typedPin ? await pinProblemFor(pin, role) : null;
  if (weak) return res.status(400).json({ error: weak });
  const pinHash = await bcrypt.hash(pin, PIN_ROUNDS);
  const user = await prisma.user.create({ data: { pinLength: pin.length, name, firstName: parsed.data.firstName, middleName: parsed.data.middleName, lastName: parsed.data.lastName, role, pinHash, email, mustChangePin: emailThem } });
  let emailed: { ok: boolean; error?: string } | undefined;
  if (emailThem && email) emailed = await emailPin(user.name, email, pin);
  res.status(201).json({ id: user.id, name: user.name, role: user.role, emailed });
});

// ── Emailing login details ──────────────────────────────────────────────
// Sends someone their login PIN from the mail account set up under Master Data → Email. A PIN sent this way is a one-off: the person
// is made to choose their own the first time they sign in (mustChangePin).
async function emailPin(name: string, to: string, pin: string, opts: { reset?: boolean; mustChange?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
  const mustChange = opts.mustChange ?? true;
  const mailer = await getMailer();
  if (!mailer) return { ok: false, error: "Email isn't set up yet — set it up under Master Data → Email first" };
  const url = mailer.config.loginUrl ? `\nSign in at: ${mailer.config.loginUrl}\n` : '';
  const company = await systemName();
  try {
    const info = await mailer.sendMail({
      to,
      subject: opts.reset ? `Your ${company} PIN was reset` : `Your ${company} login`,
      text: `Hello ${name},\n\n${opts.reset ? `Your PIN for the ${company} system has been reset.` : `You can now sign in to the ${company} system.`}\n${url}\nChoose your name on the sign-in screen and enter this PIN:\n\n    ${pin}\n\n${mustChange ? 'You will be asked to choose your own PIN the first time you sign in. Please do that straight away, and delete this email afterwards.' : 'Please delete this email once you have signed in.'}\n\nIf you were not expecting this message, tell your manager.`,
    });
    const refused = refusal(info, to);
    if (refused) return { ok: false, error: refused };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: explainMailError(e, mailer.config) };
  }
}

// Staff with their email and whether they must still choose their own PIN. Admin-only (the plain /staff list is open to everyone).
masterDataRouter.get('/staff-details', requireRole('Admin'), async (_req, res) => {
  await ensureStaffNamesOnce();
  const users = await prisma.user.findMany({ orderBy: { name: 'asc' } });
  res.json(users.map((u) => ({ id: u.id, name: u.name, firstName: u.firstName, middleName: u.middleName, lastName: u.lastName, role: u.role, email: u.email, mustChangePin: u.mustChangePin, active: u.active, orderTakingOff: u.orderTakingOff })));
});

// Switch someone's sign-in off (they have left, or must no longer use the system) or back on. Everything they did stays on record. Switching off
// ends their open sessions at once. You cannot switch off yourself, or the last active Admin.
masterDataRouter.put('/staff/:id/active', requireRole('Admin'), async (req, res) => {
  const parsed = z.object({ active: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const id = Number(req.params.id);
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return res.status(404).json({ error: 'Staff member not found' });
  if (!parsed.data.active) {
    if (id === req.user!.id) return res.status(400).json({ error: 'You cannot switch off your own sign-in' });
    if (user.role === 'Admin' && (await prisma.user.count({ where: { role: 'Admin', active: true, id: { not: id } } })) === 0) {
      return res.status(400).json({ error: 'There must always be at least one active Admin' });
    }
  }
  await prisma.user.update({ where: { id }, data: { active: parsed.data.active, failedLoginCount: 0, lockedUntil: null, ...(parsed.data.active ? {} : { tokenVersion: { increment: 1 } }) } });
  res.json({ id, active: parsed.data.active });
});

// Delete a staff member for good. Only possible for someone with no history (a user added by mistake, or who never did anything): once they have taken
// orders or payments, or have payroll, production, quality, client or commission records, deleting them would orphan or change the books, so the API
// refuses and says to switch them off instead (their history stays, they just cannot sign in). You cannot delete yourself or the last Admin.
masterDataRouter.delete('/staff/:id', requireRole('Admin'), async (req, res) => {
  const id = Number(req.params.id);
  const user = await prisma.user.findUnique({
    where: { id },
    include: { _count: { select: { orders: true, payments: true, payrollEntries: true, productionTasks: true, qualityChecks: true, clientOwnerships: true, commissionPayouts: true } } },
  });
  if (!user) return res.status(404).json({ error: 'Staff member not found' });
  if (id === req.user!.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  if (user.role === 'Admin' && (await prisma.user.count({ where: { role: 'Admin', id: { not: id } } })) === 0) {
    return res.status(400).json({ error: 'There must always be at least one Admin' });
  }
  const labels: Record<string, string> = { orders: 'orders', payments: 'payments', payrollEntries: 'payroll entries', productionTasks: 'production tasks', qualityChecks: 'quality checks', clientOwnerships: 'client assignments', commissionPayouts: 'commission pay-outs' };
  const held = Object.entries(user._count).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${labels[k] ?? k}`);
  if (held.length) {
    return res.status(409).json({ error: `${user.name} cannot be deleted because they have ${held.join(', ')} on record. Deleting would damage those records — use Switch off instead: they can no longer sign in and their history stays.` });
  }
  try {
    await prisma.user.delete({ where: { id } });
  } catch {
    return res.status(409).json({ error: `${user.name} has records in the system and cannot be deleted. Use Switch off instead.` });
  }
  res.json({ ok: true, id, name: user.name });
});

// ── Front office ────────────────────────────────────────────────────────
// The sales persons the front office can give orders to (active people whose role is marked "can be assigned orders").
masterDataRouter.get('/sales-people', async (req, res) => {
  if (!(await canCaptureForOthers(req.user!.role))) return res.status(403).json({ error: 'Not permitted for your role' });
  res.json(await salesPeople());
});

// Order taking on or off for one person. Off: they cannot capture General / Film / Artwork orders and the front office captures for them; their other
// duties (production, quality control …) are untouched. Their open sessions end so the screens follow at once. Front-office roles always take orders.
masterDataRouter.put('/staff/:id/order-taking', requireRole('Admin'), async (req, res) => {
  const parsed = z.object({ on: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const id = Number(req.params.id);
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return res.status(404).json({ error: 'Staff member not found' });
  if (await canCaptureForOthers(user.role)) return res.status(400).json({ error: `${user.name} is front office and always takes orders` });
  if (!(await permissionsForRole(user.role)).canBeAssignedOrders) return res.status(400).json({ error: `${user.name} is not a sales person (their role is not marked "can be assigned orders" under Roles & Access)` });
  await prisma.user.update({ where: { id }, data: { orderTakingOff: !parsed.data.on, ...(id === req.user!.id ? {} : { tokenVersion: { increment: 1 } }) } });
  res.json({ id, orderTaking: parsed.data.on });
});

// The same for every sales person at once (people whose role is marked "can be assigned orders").
masterDataRouter.put('/staff-order-taking', requireRole('Admin'), async (req, res) => {
  const parsed = z.object({ on: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const people = (await salesPeople()).filter((p) => p.id !== req.user!.id);
  const others = (await Promise.all(people.map(async (p) => ((await canCaptureForOthers(p.role)) ? null : p)))).filter((p): p is NonNullable<typeof p> => !!p);
  await prisma.user.updateMany({ where: { id: { in: others.map((p) => p.id) } }, data: { orderTakingOff: !parsed.data.on, tokenVersion: { increment: 1 } } });
  res.json({ changed: others.length, orderTaking: parsed.data.on });
});

// Change someone's role (what they may do in the system). Applies at once: the role is read from the database on every request, so their open sessions are
// ended and they sign in again to see their new screens; if the new role needs a longer PIN than they have, they are asked to choose one then. You cannot
// change your own role (another Admin does it), which also means an active Admin always remains.
masterDataRouter.put('/staff/:id/role', requireRole('Admin'), async (req, res) => {
  const parsed = z.object({ role: z.string().trim().min(1, 'Choose a role') }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const id = Number(req.params.id);
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return res.status(404).json({ error: 'Staff member not found' });
  const role = parsed.data.role;
  if (id === req.user!.id) return res.status(400).json({ error: 'You cannot change your own role. Ask another Admin to do it.' });
  if (role === user.role) return res.json({ id, name: user.name, role, changed: false });
  if (role !== 'Admin' && !(await prisma.role.findUnique({ where: { name: role } }))) return res.status(400).json({ error: 'Unknown role — add it under Roles & Access first' });
  const needsLongerPin = user.pinLength < (await requiredLengthFor(role));
  await prisma.user.update({ where: { id }, data: { role, tokenVersion: { increment: 1 }, ...(needsLongerPin ? { mustChangePin: true } : {}) } });
  res.json({ id, name: user.name, role, previousRole: user.role, changed: true, mustChangePin: needsLongerPin || user.mustChangePin });
});

// Change how someone's name is recorded (first name and surname compulsory, middle name optional). The full name follows everywhere it is shown;
// documents already issued keep the name they were issued with.
masterDataRouter.put('/staff/:id/name', requireRole('Admin'), async (req, res) => {
  const parsed = z.object(nameParts).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const id = Number(req.params.id);
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Staff member not found' });
  const name = composeName(parsed.data);
  if (await nameTaken(name, id)) return res.status(400).json({ error: `There is already a staff member called ${name}` });
  const user = await prisma.user.update({ where: { id }, data: { name, firstName: parsed.data.firstName, middleName: parsed.data.middleName, lastName: parsed.data.lastName } });
  res.json({ id: user.id, name: user.name, firstName: user.firstName, middleName: user.middleName, lastName: user.lastName });
});

masterDataRouter.put('/staff/:id/email', requireRole('Admin'), async (req, res) => {
  const parsed = z.object({ email: z.string().trim().toLowerCase().email().or(z.literal('')) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid email address (or leave it blank to remove it)' });
  const email = parsed.data.email || null;
  if (email) {
    const other = await prisma.user.findUnique({ where: { email } });
    if (other && other.id !== Number(req.params.id)) return res.status(400).json({ error: 'That email address is already used by someone else' });
  }
  const user = await prisma.user.update({ where: { id: Number(req.params.id) }, data: { email } }).catch(() => null);
  if (!user) return res.status(404).json({ error: 'Staff member not found' });
  res.json({ id: user.id, email: user.email });
});

// Gives someone a fresh random PIN and emails it to them. They must change it at first login. Clears any lockout.
masterDataRouter.post('/staff/:id/send-pin', requireRole('Admin'), async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: Number(req.params.id) } });
  if (!user) return res.status(404).json({ error: 'Staff member not found' });
  if (!user.email) return res.status(400).json({ error: `${user.name} has no email address yet — add one first` });
  if (!(await loadMailConfig())) return res.status(400).json({ error: "Email isn't set up yet — set it up under Master Data → Email first" });

  const pin = randomPin(await requiredLengthFor(user.role));
  const previous = { pinHash: user.pinHash, pinLength: user.pinLength, mustChangePin: user.mustChangePin };
  await prisma.user.update({ where: { id: user.id }, data: { pinHash: await bcrypt.hash(pin, PIN_ROUNDS), pinLength: pin.length, mustChangePin: true, failedLoginCount: 0, lockCount: 0, lockedUntil: null, tokenVersion: { increment: 1 } } });
  const sent = await emailPin(user.name, user.email, pin);
  if (!sent.ok) {
    // Don't leave them locked out of a PIN nobody received.
    await prisma.user.update({ where: { id: user.id }, data: previous });
    return res.status(502).json({ error: `The email could not be sent, so their PIN was left unchanged. ${sent.error}` });
  }
  res.json({ ok: true, sentTo: user.email });
});

// Reset someone's PIN. The Admin may type the new PIN (checked against the rules for the person's role) or leave it blank to have one made. It can be emailed
// to them, and they can be made to choose their own at next sign-in. Their open sessions end and any lockout is cleared. A PIN that was made and not emailed is
// returned once so the Admin can hand it over; one the Admin typed is never echoed. You cannot reset your own here (use Change PIN in the header).
masterDataRouter.post('/staff/:id/reset-pin', requireRole('Admin'), async (req, res) => {
  const parsed = z
    .object({ pin: z.string().regex(/^\d{4,6}$/, 'A PIN is 4 to 6 digits').optional().or(z.literal('')), email: z.boolean().optional(), mustChange: z.boolean().optional() })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const id = Number(req.params.id);
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return res.status(404).json({ error: 'Staff member not found' });
  if (id === req.user!.id) return res.status(400).json({ error: 'To change your own PIN use Change PIN at the top of the screen.' });
  const typed = parsed.data.pin || '';
  const sendIt = !!parsed.data.email;
  const mustChange = parsed.data.mustChange ?? true;
  if (sendIt) {
    if (!user.email) return res.status(400).json({ error: `${user.name} has no email address yet — add one first, or untick the email box` });
    if (!(await loadMailConfig())) return res.status(400).json({ error: "Email isn't set up yet — set it up under Master Data → Email first, or untick the email box" });
  }
  if (typed) {
    const weak = await pinProblemFor(typed, user.role);
    if (weak) return res.status(400).json({ error: weak });
  }
  const pin = typed || randomPin(await requiredLengthFor(user.role));
  const previous = { pinHash: user.pinHash, pinLength: user.pinLength, mustChangePin: user.mustChangePin, failedLoginCount: user.failedLoginCount, lockCount: user.lockCount, lockedUntil: user.lockedUntil };
  await prisma.user.update({ where: { id }, data: { pinHash: await bcrypt.hash(pin, PIN_ROUNDS), pinLength: pin.length, mustChangePin: mustChange, failedLoginCount: 0, lockCount: 0, lockedUntil: null, tokenVersion: { increment: 1 } } });
  if (sendIt) {
    const sent = await emailPin(user.name, user.email!, pin, { reset: true, mustChange });
    if (!sent.ok) {
      await prisma.user.update({ where: { id }, data: previous }); // do not leave them on a PIN nobody received
      return res.status(502).json({ error: `The email could not be sent, so their PIN was left unchanged. ${sent.error}` });
    }
  }
  res.json({ ok: true, emailed: sendIt, sentTo: sendIt ? user.email : undefined, mustChange, ...(!typed && !sendIt ? { pin } : {}) });
});

// ── Email settings (Master Data → Email) ───────────────────────────────
// The mail account the system sends from, in the layout of a mailbox's "mail client settings". The password is never sent back.
function publicMail(row: Awaited<ReturnType<typeof getMailSettingsRow>>, source: 'settings' | 'env' | 'none') {
  return {
    source,
    configured: source !== 'none',
    username: row?.username ?? '',
    outgoingHost: row?.outgoingHost ?? '',
    smtpPort: row?.smtpPort ?? 465,
    incomingHost: row?.incomingHost ?? '',
    imapPort: row?.imapPort ?? 993,
    pop3Port: row?.pop3Port ?? 995,
    fromName: row?.fromName ?? '',
    loginUrl: row?.loginUrl ?? '',
    hasPassword: !!row?.password,
  };
}

masterDataRouter.get('/mail', requireRole('Admin'), async (_req, res) => {
  const cfg = await loadMailConfig();
  const row = await getMailSettingsRow();
  if (cfg?.source === 'env' && !row) {
    // Still sending from server variables: show them so the first save carries them over.
    return res.json({ ...publicMail(null, 'env'), username: cfg.username, outgoingHost: cfg.outgoingHost, smtpPort: cfg.smtpPort, hasPassword: true, fromName: cfg.fromName });
  }
  res.json(publicMail(row, cfg ? 'settings' : 'none'));
});

const mailSchema = z.object({
  username: z.string().trim().max(200).optional(),
  password: z.string().max(200).optional(), // blank = keep what is saved
  outgoingHost: z.string().trim().max(200).optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  incomingHost: z.string().trim().max(200).optional(),
  imapPort: z.number().int().min(1).max(65535).optional(),
  pop3Port: z.number().int().min(1).max(65535).optional(),
  fromName: z.string().trim().max(80).optional(),
  loginUrl: z.string().trim().max(200).optional(),
});

masterDataRouter.put('/mail', requireRole('Admin'), async (req, res) => {
  const parsed = mailSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const b = parsed.data;
  const cfg = await loadMailConfig();
  const row = await getMailSettingsRow();
  // First save from an install still on server variables: carry the password over so it need not be retyped.
  const carried = !row && cfg?.source === 'env' ? cfg : null;
  const username = b.username ?? row?.username ?? carried?.username ?? '';
  if (username && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(username)) return res.status(400).json({ error: 'The username is the full email address, e.g. admin@glmgroup.co.ke' });
  if (b.loginUrl && !/^https?:\/\//.test(b.loginUrl)) return res.status(400).json({ error: 'The sign-in address must start with https://' });
  const data = {
    username,
    password: seal(b.password ? b.password : row?.password ?? carried?.password ?? ''),
    outgoingHost: b.outgoingHost ?? row?.outgoingHost ?? carried?.outgoingHost ?? '',
    smtpPort: b.smtpPort ?? row?.smtpPort ?? carried?.smtpPort ?? 465,
    incomingHost: b.incomingHost ?? row?.incomingHost ?? '',
    imapPort: b.imapPort ?? row?.imapPort ?? 993,
    pop3Port: b.pop3Port ?? row?.pop3Port ?? 995,
    fromName: b.fromName ?? row?.fromName ?? carried?.fromName ?? '',
    loginUrl: (b.loginUrl ?? row?.loginUrl ?? '').replace(/\/+$/, ''),
  };
  const saved = await prisma.mailSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
  const complete = !!(saved.outgoingHost && saved.username && saved.password);
  res.json(publicMail(saved, complete ? 'settings' : 'none'));
});

// Checks the connection and the login, then sends a real message so you can see it arrive.
masterDataRouter.post('/mail/test', requireRole('Admin'), async (req, res) => {
  const parsed = z.object({ to: z.string().trim().email() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter the email address to send the test to' });
  const cfg = await loadMailConfig();
  if (!cfg) return res.status(400).json({ error: 'Save the username, password and outgoing server first' });
  const transport = createTransport(cfg);
  try {
    await transport.verify();
  } catch (e) {
    return res.status(400).json({ error: explainMailError(e, cfg) });
  }
  try {
    await transport.sendMail({
      from: cfg.fromName ? { name: cfg.fromName, address: cfg.username } : cfg.username,
      to: parsed.data.to,
      subject: `${await systemName()} — test email`,
      text: `This is a test message from the ${await systemName()} system. If you can read it, your mail settings work.`,
    });
  } catch (e) {
    return res.status(400).json({ error: explainMailError(e, cfg) });
  }
  res.json({ ok: true, sentTo: parsed.data.to, from: cfg.username });
});

// ── Roles & Access — Admin-only, same level as every other Master Data ──
// mutation. 'Admin' itself isn't a row here: it's always all-permissions by
// server rule (see permissions.ts), so there's nothing to configure for it —
// listing it as a phantom row would only invite someone to "edit" it and be
// confused when nothing changes.
masterDataRouter.get('/roles', requireRole('Admin'), async (_req, res) => {
  const roles = await prisma.role.findMany({ orderBy: { name: 'asc' } });
  res.json(
    roles.map((r) => ({
      id: r.id,
      name: r.name,
      permissions: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, r[k]])),
    })),
  );
});

const roleSchema = z.object({
  name: z.string().min(1).max(60),
  permissions: z.record(z.string(), z.boolean()).optional(),
});

function permissionFields(permissions: Record<string, boolean> | undefined) {
  const out: Record<string, boolean> = {};
  for (const k of PERMISSION_KEYS) out[k] = permissions?.[k] ?? false;
  return out;
}

masterDataRouter.post('/roles', requireRole('Admin'), async (req, res) => {
  const parsed = roleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  if (parsed.data.name === 'Admin') return res.status(400).json({ error: '"Admin" is reserved and always has full access' });
  const role = await prisma.role
    .create({ data: { name: parsed.data.name, ...permissionFields(parsed.data.permissions ?? DEFAULT_ROLE_PERMISSIONS.Staff) } })
    .catch(() => null);
  if (!role) return res.status(400).json({ error: 'A role with that name already exists' });
  res.status(201).json({ id: role.id, name: role.name, permissions: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, role[k]])) });
});

const roleUpdateSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  permissions: z.record(z.string(), z.boolean()).optional(),
});

masterDataRouter.put('/roles/:id', requireRole('Admin'), async (req, res) => {
  const parsed = roleUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const existing = await prisma.role.findUnique({ where: { id: Number(req.params.id) } });
  if (!existing) return res.status(404).json({ error: 'Role not found' });
  if (parsed.data.name === 'Admin') return res.status(400).json({ error: '"Admin" is reserved and always has full access' });

  const data: Record<string, unknown> = {};
  if (parsed.data.name) data.name = parsed.data.name;
  if (parsed.data.permissions) Object.assign(data, permissionFields({ ...Object.fromEntries(PERMISSION_KEYS.map((k) => [k, existing[k]])), ...parsed.data.permissions }));

  const role = await prisma.role.update({ where: { id: existing.id }, data }).catch(() => null);
  if (!role) return res.status(400).json({ error: 'A role with that name already exists' });
  res.json({ id: role.id, name: role.name, permissions: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, role[k]])) });
});

masterDataRouter.delete('/roles/:id', requireRole('Admin'), async (req, res) => {
  const existing = await prisma.role.findUnique({ where: { id: Number(req.params.id) } });
  if (!existing) return res.status(404).json({ error: 'Role not found' });
  const inUse = await prisma.user.findFirst({ where: { role: existing.name } });
  if (inUse) return res.status(400).json({ error: 'Reassign every staff member off this role before deleting it' });
  await prisma.role.delete({ where: { id: existing.id } });
  res.status(204).end();
});

// ── Service Price List ──────────────────────────────────────────────────
// Everyone sees the price list (selling prices). The supplier's usual price and the mark-up on a contracted-out service are costs,
// so they are only sent to people who can see costs.
masterDataRouter.get('/services', async (req, res) => {
  await ensureMaterialItemsOnce();
  const costs = await canSeeCosts(req.user!.role);
  const services = await prisma.service.findMany({ orderBy: { name: 'asc' } });
  res.json(services.map(({ markupType, markupValue, defaultSupplierCost, ...s }) => (costs ? { ...s, markupType, markupValue, defaultSupplierCost } : s)));
});

const serviceSchema = z.object({
  name: z.string().trim().min(1).max(120), // the service (item) — the size, if any, is added to it
  description: z.string().trim().max(300).optional().default(''),
  size: z.string().trim().max(40).optional().default(''),
  businessHeadId: z.number().int().nullable().optional(),
  unit: z.enum(['piece', 'metre', 'sqm']),
  price: z.number().positive(),
  usesArtworkPricing: z.boolean().optional(),
  // Contracted-out service: the supplier quotes one VAT-inclusive price (paper and service together); we add a mark-up.
  outsourced: z.boolean().optional(),
  supplierName: z.string().trim().max(120).optional(),
  markupType: z.enum(MARKUP_TYPES).optional(),
  markupValue: z.number().min(0).optional(),
  defaultSupplierCost: z.number().positive().nullable().optional(),
});

masterDataRouter.post('/services', requireRole('Admin'), async (req, res) => {
  const parsed = serviceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  await ensureMaterialItemsOnce();
  const item = parsed.data.name.replace(/\s+/g, ' ');
  const size = parsed.data.size.replace(/\s+/g, ' ');
  const fullName = materialName(item, size);
  if ((await prisma.service.findMany({ select: { name: true } })).some((s) => same(s.name, fullName))) return res.status(400).json({ error: `${fullName} is already in the service price list` });
  // A new service goes under the head its name suggests until someone chooses one.
  let { businessHeadId } = parsed.data;
  if (businessHeadId == null) {
    await ensureBusinessHeadsOnce();
    businessHeadId = (await prisma.businessHead.findUnique({ where: { name: defaultBusinessHeadName(parsed.data.name) } }))?.id ?? null;
  }
  res.status(201).json(await prisma.service.create({ data: { ...parsed.data, name: fullName, item, size, businessHeadId } }));
});

// Price/unit and the artwork-pricing/pressing-fee flags are all catalog
// definition properties — Admin-only, same access level as adding a
// service. Lets Admin reconfigure a service in place (e.g. switching DTF
// Printing from a flat per-piece price to a per-sqm rate) instead of
// needing a new service.
const serviceUpdateSchema = z
  .object({
    item: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(300).optional(),
    size: z.string().trim().max(40).optional(),
    price: z.number().positive().optional(),
    businessHeadId: z.number().int().nullable().optional(),
    unit: z.enum(['piece', 'metre', 'sqm']).optional(),
    usesArtworkPricing: z.boolean().optional(),
    chargesPressingFee: z.boolean().optional(),
    outsourced: z.boolean().optional(),
    supplierName: z.string().trim().max(120).optional(),
    markupType: z.enum(MARKUP_TYPES).optional(),
    markupValue: z.number().min(0).optional(),
    defaultSupplierCost: z.number().positive().nullable().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'No fields to update' });

masterDataRouter.put('/services/:id', requireRole('Admin'), async (req, res) => {
  const parsed = serviceUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  await ensureMaterialItemsOnce();
  const id = Number(req.params.id);
  const current = await prisma.service.findUnique({ where: { id } });
  if (!current) return res.status(404).json({ error: 'Service not found' });
  const { size: sizeRaw, item: itemRaw, ...rest } = parsed.data;
  const oldItem = current.item || current.name;
  const newItem = itemRaw !== undefined ? itemRaw.replace(/\s+/g, ' ') : oldItem;
  const newSize = sizeRaw !== undefined ? sizeRaw.replace(/\s+/g, ' ') : current.size;
  const renamed = newItem !== oldItem;
  const sizeChanged = newSize !== current.size;
  const all = await prisma.service.findMany();
  // Renaming the service renames every size of it.
  const group = all.filter((s) => s.id === id || same(s.item || s.name, oldItem));
  if (renamed || sizeChanged) {
    // The DTF services are looked up by name by the DTF module, so their names stay as they are.
    const locked = (renamed ? group : [current]).find((g) => g.soldViaDtfModule);
    if (locked) return res.status(400).json({ error: `${locked.name} is sold through the DTF module, so its name and size cannot be changed` });
    const after = group.map((g) => ({ id: g.id, name: materialName(newItem, g.id === id ? newSize : g.size) }));
    const others = all.filter((s) => !group.some((g) => g.id === s.id));
    for (let i = 0; i < after.length; i++) {
      if (others.some((o) => same(o.name, after[i]!.name)) || after.findIndex((x) => same(x.name, after[i]!.name)) !== i) return res.status(400).json({ error: `${after[i]!.name} is already in the service price list` });
    }
  }
  await prisma.$transaction(async (tx) => {
    if (renamed) for (const g of group) if (g.id !== id) await tx.service.update({ where: { id: g.id }, data: { item: newItem, name: materialName(newItem, g.size) } });
    await tx.service.update({ where: { id }, data: { ...rest, ...(renamed || sizeChanged ? { item: newItem, size: newSize, name: materialName(newItem, newSize) } : {}) } });
  });
  res.json(await prisma.service.findUnique({ where: { id } }));
});

// ── Business heads ──────────────────────────────────────────────────────
// The lines of business income is reported under (DTF Printing, UV Printing, Laser Engraving, Large Format Printing, Embroidery,
// General Order). Everyone can read them; only Admin changes them.
masterDataRouter.get('/business-heads', async (_req, res) => {
  await ensureBusinessHeadsOnce();
  const heads = await prisma.businessHead.findMany({ include: { _count: { select: { services: true } } }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
  res.json(heads.map((h) => ({ id: h.id, name: h.name, sortOrder: h.sortOrder, active: h.active, services: h._count.services })));
});

masterDataRouter.post('/business-heads', requireRole('Admin'), async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1, 'Give the business head a name').max(60) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  if (await prisma.businessHead.findUnique({ where: { name: parsed.data.name } })) return res.status(400).json({ error: 'There is already a business head with that name' });
  const last = await prisma.businessHead.findFirst({ orderBy: { sortOrder: 'desc' } });
  res.status(201).json(await prisma.businessHead.create({ data: { name: parsed.data.name, sortOrder: (last?.sortOrder ?? 0) + 1 } }));
});

masterDataRouter.put('/business-heads/:id', requireRole('Admin'), async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(60).optional(), active: z.boolean().optional(), sortOrder: z.number().int().optional() }).refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const id = Number(req.params.id);
  if (parsed.data.name) {
    const clash = await prisma.businessHead.findUnique({ where: { name: parsed.data.name } });
    if (clash && clash.id !== id) return res.status(400).json({ error: 'There is already a business head with that name' });
  }
  const head = await prisma.businessHead.update({ where: { id }, data: parsed.data }).catch(() => null);
  if (!head) return res.status(404).json({ error: 'Business head not found' });
  res.json(head);
});

masterDataRouter.delete('/business-heads/:id', requireRole('Admin'), async (req, res) => {
  const id = Number(req.params.id);
  const head = await prisma.businessHead.findUnique({ where: { id }, include: { _count: { select: { services: true } } } });
  if (!head) return res.status(404).json({ error: 'Business head not found' });
  if (head._count.services > 0) return res.status(400).json({ error: 'Move its services to another business head first (or mark it inactive instead)' });
  await prisma.businessHead.delete({ where: { id } });
  res.status(204).end();
});

// ── Material Price List ─────────────────────────────────────────────────
// Columns: Item, Description, Size, Unit, Price. An item that comes in sizes (a polo shirt in L and XL) is one line per size, each with its own
// price and stock; the line's name — what orders, purchases and stock show — is the item and its size together ("Polo Shirt — L").
masterDataRouter.get('/materials', async (_req, res) => {
  await ensureMaterialItemsOnce();
  res.json(await prisma.material.findMany({ orderBy: { name: 'asc' } }));
});

const same = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

const variantSchema = z.object({ size: z.string().trim().max(40).optional().default(''), price: z.number().positive('Every size needs a price greater than 0') });
const materialSchema = z
  .object({
    item: z.string().trim().min(1).max(120).optional(),
    name: z.string().trim().min(1).max(120).optional(), // older callers: the item's name
    description: z.string().trim().max(300).optional().default(''),
    unit: z.string().trim().min(1).max(30).optional().default('piece'),
    businessHeadId: z.number().int().nullable().optional(),
    price: z.number().positive().optional(), // an item with one price and no sizes
    variants: z.array(variantSchema).min(1).max(40).optional(), // the sizes, each with its price
  })
  .refine((o) => !!(o.item || o.name), { message: 'Item name is required' })
  .refine((o) => !!o.variants || o.price != null, { message: 'A price is required' });

masterDataRouter.post('/materials', requireRole('Admin'), async (req, res) => {
  const parsed = materialSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  await ensureMaterialItemsOnce();
  const d = parsed.data;
  const item = (d.item || d.name)!.replace(/\s+/g, ' ');
  const variants = d.variants ?? [{ size: '', price: d.price! }];

  // A size is named, or it is the item's only line.
  if (variants.length > 1 && variants.some((v) => !v.size)) return res.status(400).json({ error: 'Give every size a name (L, XL …), or add a single line with no size' });
  for (let i = 0; i < variants.length; i++) if (variants.findIndex((v) => same(v.size, variants[i]!.size)) !== i) return res.status(400).json({ error: `The size ${variants[i]!.size || '(none)'} is entered twice` });

  const existing = (await prisma.material.findMany({ select: { item: true, size: true } })).filter((m) => same(m.item, item));
  for (const v of variants) {
    if (existing.some((m) => same(m.size, v.size))) return res.status(400).json({ error: `${materialName(item, v.size)} is already in the price list` });
  }
  if (existing.length > 0 && existing.some((m) => !m.size) && variants.some((v) => v.size)) {
    return res.status(400).json({ error: `${item} already exists without a size — edit it to give it a size (say L), then add the other sizes` });
  }
  if (existing.length > 0 && existing.some((m) => m.size) && variants.some((v) => !v.size)) {
    return res.status(400).json({ error: `${item} comes in sizes — give the new line a size` });
  }
  if (d.businessHeadId != null && !(await prisma.businessHead.findUnique({ where: { id: d.businessHeadId } }))) return res.status(400).json({ error: 'That business head does not exist' });

  const created = await prisma.$transaction(
    variants.map((v) =>
      prisma.material.create({
        data: { name: materialName(item, v.size), item, description: d.description, size: v.size.replace(/\s+/g, ' '), unit: d.unit, price: v.price, businessHeadId: d.businessHeadId ?? null },
      }),
    ),
  );
  res.status(201).json(created);
});

// Reorder level, price, and the line's details are editable in place by Admin or the Finance roles that also manage Stock — unlike the
// roster/price-list "add" actions above, which stay Admin-only. Renaming the ITEM renames every size of it.
const materialUpdateSchema = z
  .object({
    price: z.number().positive().optional(),
    reorderLevel: z.number().min(0).optional(),
    // The line of business this material is normally bought for (purchases of it are tagged to it by default).
    businessHeadId: z.number().int().nullable().optional(),
    item: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(300).optional(),
    size: z.string().trim().max(40).optional(),
    unit: z.string().trim().min(1).max(30).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'No fields to update' });

masterDataRouter.put('/materials/:id', requirePermission('canApproveStock'), async (req, res) => {
  const parsed = materialUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  await ensureMaterialItemsOnce();
  const id = Number(req.params.id);
  const current = await prisma.material.findUnique({ where: { id } });
  if (!current) return res.status(404).json({ error: 'Material not found' });
  const { item: newItemRaw, size: newSizeRaw, ...rest } = parsed.data;

  const oldItem = current.item || current.name;
  const newItem = (newItemRaw ?? oldItem).replace(/\s+/g, ' ');
  const newSize = (newSizeRaw ?? current.size).replace(/\s+/g, ' ');
  const group = (await prisma.material.findMany({ where: { item: oldItem } })).filter((m) => same(m.item, oldItem));
  const renamed = newItem !== oldItem;
  const sizeChanged = newSize !== current.size;

  if (renamed || sizeChanged) {
    // The lines of the item it would end up with, other than the ones being renamed or changed here, must not clash with the new names.
    const others = (await prisma.material.findMany({ select: { id: true, item: true, size: true } })).filter((m) => same(m.item, newItem) && !group.some((g) => g.id === m.id));
    const after = group.map((g) => ({ id: g.id, size: g.id === id ? newSize : g.size }));
    const lines = [...after, ...others];
    for (let i = 0; i < lines.length; i++) {
      if (lines.findIndex((l) => same(l.size, lines[i]!.size)) !== i) return res.status(400).json({ error: `${materialName(newItem, lines[i]!.size)} is already in the price list` });
    }
    if (lines.length > 1 && lines.some((l) => !l.size)) return res.status(400).json({ error: `${newItem} comes in sizes — every line needs a size` });
  }
  if (rest.businessHeadId != null && !(await prisma.businessHead.findUnique({ where: { id: rest.businessHeadId } }))) return res.status(400).json({ error: 'That business head does not exist' });

  await prisma.$transaction(async (tx) => {
    if (renamed) for (const g of group) await tx.material.update({ where: { id: g.id }, data: { item: newItem, name: materialName(newItem, g.id === id ? newSize : g.size) } });
    await tx.material.update({ where: { id }, data: { ...rest, size: newSize, item: newItem, name: materialName(newItem, newSize) } });
  });
  res.json(await prisma.material.findUnique({ where: { id } }));
});

// ── Corporate Clients ───────────────────────────────────────────────────
masterDataRouter.get('/corporate-clients', async (_req, res) => {
  res.json(await prisma.corporateClient.findMany({ orderBy: { name: 'asc' } }));
});

const clientSchema = z.object({
  name: z.string().min(1),
  creditDays: z.number().int().positive(),
  email: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
});

masterDataRouter.post('/corporate-clients', requireRole('Admin'), async (req, res) => {
  const parsed = clientSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  res.status(201).json(await prisma.corporateClient.create({ data: { ...parsed.data, email: parsed.data.email ?? '', phone: parsed.data.phone ?? '' } }));
});

const clientUpdateSchema = z
  .object({
    creditDays: z.number().int().positive().optional(),
    email: z.string().max(200).optional(),
    phone: z.string().max(50).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'No fields to update' });

masterDataRouter.put('/corporate-clients/:id', requireRole('Admin'), async (req, res) => {
  const parsed = clientUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const client = await prisma.corporateClient.update({ where: { id: Number(req.params.id) }, data: parsed.data }).catch(() => null);
  if (!client) return res.status(404).json({ error: 'Corporate client not found' });
  res.json(client);
});

// ── Commission on/off ────────────────────────────────────────────────────
// Admin decides when the sales-commission scheme starts and stops. Nothing is deleted when it is switched off: rates, client ownership and
// past statements are kept, and come back when it is switched on again.
masterDataRouter.get('/commission-switch', requireRole('Admin'), async (_req, res) => {
  res.json({ enabled: await commissionEnabled() });
});

masterDataRouter.put('/commission-switch', requireRole('Admin'), async (req, res) => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'enabled (true or false) is required' });
  await prisma.commissionSettings.upsert({ where: { id: 1 }, update: { enabled: parsed.data.enabled, updatedByName: req.user!.name }, create: { id: 1, enabled: parsed.data.enabled, updatedByName: req.user!.name } });
  res.json({ enabled: parsed.data.enabled });
});

// ── Discount Rules ───────────────────────────────────────────────────────
function serializeSettings(settings: {
  kraPin: string;
  maxDiscountPct: number;
  companyName: string;
  legalName: string;
  companyAddress: string;
  systemName: string;
  companyPhone: string;
  companyPhone2: string;
  website: string;
  facebook: string;
  tiktok: string;
  companyEmail: string;
  logoDataUrl: string | null;
}) {
  return {
    kraPin: settings.kraPin,
    maxDiscountPct: settings.maxDiscountPct,
    companyName: settings.companyName,
    legalName: settings.legalName,
    companyAddress: settings.companyAddress,
    systemName: settings.systemName,
    companyPhone: settings.companyPhone,
    companyPhone2: settings.companyPhone2,
    website: settings.website,
    facebook: settings.facebook,
    tiktok: settings.tiktok,
    companyEmail: settings.companyEmail,
    logoDataUrl: settings.logoDataUrl,
  };
}

masterDataRouter.get('/settings', async (_req, res) => {
  const settings = await prisma.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  res.json(serializeSettings(settings));
});

// Partial update — Master Data's Discount Rules and Company Info tabs each save
// their own subset of fields without needing to resend the other's values.
const settingsSchema = z
  .object({
    maxDiscountPct: z.number().min(0).optional(),
    companyName: z.string().min(1).max(200).optional(),
    // The name on the system screens (header, browser tab, sign-in), exactly as typed; blank = use the company name.
    systemName: z.string().trim().max(200).optional(),
    // The registered company the "companyName" trading name operates under —
    // shown as a small "trading name of ..." line under the brand name on
    // printed invoices/quotations (see printInvoice.ts). Blank hides it.
    legalName: z.string().max(200).optional(),
    companyAddress: z.string().max(500).optional(),
    companyPhone: z.string().trim().max(50).optional(),
    companyPhone2: z.string().trim().max(50).optional(),
    // Shown as typed on printed documents (a web address, a page name or a handle). Blank hides the line.
    website: z.string().trim().max(200).optional(),
    facebook: z.string().trim().max(200).optional(),
    tiktok: z.string().trim().max(200).optional(),
    companyEmail: z.string().max(200).optional(),
    // The company's KRA PIN (employer's PIN on the payroll and P9). Blank clears it.
    kraPin: z.string().max(40).optional(),
    // A data: URL logo image, capped well under the 5mb JSON body limit; null clears it.
    logoDataUrl: z.string().max(2_000_000).nullable().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, { message: 'No fields to update' });

masterDataRouter.put('/settings', requireRole('Admin'), async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const data = { ...parsed.data };
  if (data.kraPin !== undefined) {
    const pin = cleanKraPin(data.kraPin);
    if (pin.error) return res.status(400).json({ error: pin.error });
    data.kraPin = pin.value ?? '';
  }
  const settings = await prisma.setting.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
  res.json(serializeSettings(settings));
});
