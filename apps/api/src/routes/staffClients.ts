import { Router } from 'express';
import { z } from 'zod';
import { clientKeyFor, isNamedClient, ownershipEnd, todayStr } from '@glm/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { activeOwner, canManageCommission, commissionEnabled, getCommissionConfig } from '../commission';
import { canCaptureForOthers, salesPeople } from '../frontOffice';

// The staff client register: the clients each sales person has brought in — name and phone — kept so an order can be started by picking the sales person and then one of their clients, which fills
// in the client's name and phone. It is the same register commission uses for "clients credited to a staff member": a client belongs to one sales person at a time (for the ownership months set in
// Commission → Rates), and orders from them are credited to that person. A sales person keeps their own list; the front office and commission managers keep anyone's.
export const staffClientsRouter = Router();
staffClientsRouter.use(requireAuth);

/** The phone to show for a register row: the one typed, else rebuilt from the key (the last nine digits of a Kenyan number). */
export function registerPhone(r: { phone: string; clientKey: string }): string {
  if (r.phone.trim()) return r.phone.trim();
  return r.clientKey.startsWith('p:') ? `0${r.clientKey.slice(2)}` : '';
}

/** May this person see and keep the register of this staff member? Their own always; anyone's for the front office and commission managers. */
async function mayKeep(user: { id: number; role: string }, staffId: number): Promise<boolean> {
  return staffId === user.id || (await canCaptureForOthers(user.role)) || (await canManageCommission(user.role));
}

staffClientsRouter.use(async (_req, res, next) => {
  if (!(await commissionEnabled())) return res.status(403).json({ error: 'The client register works with commission, which is switched off. An Admin can switch it on in Master Data → Company Info.' });
  next();
});

const shape = async (rows: { id: number; clientKey: string; clientName: string; phone: string; staffId: number; startDate: string; endDate: string; note: string }[]) => {
  const corp = rows.filter((r) => r.clientKey.startsWith('c:')).map((r) => Number(r.clientKey.slice(2)));
  const corporates = corp.length ? await prisma.corporateClient.findMany({ where: { id: { in: corp } }, select: { id: true, phone: true } }) : [];
  const corpPhone = new Map(corporates.map((c) => [c.id, c.phone]));
  return rows.map((r) => ({
    id: r.id,
    name: r.clientName,
    phone: registerPhone(r) || (r.clientKey.startsWith('c:') ? (corpPhone.get(Number(r.clientKey.slice(2))) ?? '') : ''),
    corporate: r.clientKey.startsWith('c:'),
    staffId: r.staffId,
    startDate: r.startDate,
    endDate: r.endDate,
    note: r.note,
  }));
};

// The people whose registers the caller may keep, and whether they may keep anyone's.
staffClientsRouter.get('/people', async (req, res) => {
  const all = (await canCaptureForOthers(req.user!.role)) || (await canManageCommission(req.user!.role));
  const people = all ? await salesPeople() : [];
  const me = { id: req.user!.id, name: req.user!.name };
  res.json({
    all,
    me,
    people: [me, ...people.filter((p) => p.id !== me.id).map((p) => ({ id: p.id, name: p.name }))],
  });
});

// A sales person's clients: the list the order screens offer once the sales person is chosen.
staffClientsRouter.get('/', async (req, res) => {
  const staffId = req.query.staffId ? Number(req.query.staffId) : req.user!.id;
  if (!Number.isInteger(staffId)) return res.status(400).json({ error: 'Choose a sales person' });
  if (!(await mayKeep(req.user!, staffId))) return res.status(403).json({ error: 'Not permitted for your role' });
  const rows = await prisma.clientOwner.findMany({ where: { staffId, status: 'Active', endDate: { gte: todayStr() } }, orderBy: { clientName: 'asc' }, take: 1000 });
  res.json(await shape(rows));
});

const clientSchema = z.object({
  staffId: z.number().int().optional(),
  corporateClientId: z.number().int().optional(),
  name: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  note: z.string().trim().max(200).optional(),
});

// Add a client to a sales person's register.
staffClientsRouter.post('/', async (req, res) => {
  const parsed = clientSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const d = parsed.data;
  const staffId = d.staffId ?? req.user!.id;
  if (!(await mayKeep(req.user!, staffId))) return res.status(403).json({ error: 'You can only keep your own clients' });
  if (staffId !== req.user!.id && !(await salesPeople()).some((p) => p.id === staffId)) return res.status(400).json({ error: 'That person is not set up to be given orders' });
  let name = (d.name ?? '').trim();
  let phone = (d.phone ?? '').trim();
  if (d.corporateClientId) {
    const c = await prisma.corporateClient.findUnique({ where: { id: d.corporateClientId } });
    if (!c) return res.status(400).json({ error: 'Corporate client not found' });
    name = c.name;
    phone = phone || c.phone;
  } else {
    if (!isNamedClient(name)) return res.status(400).json({ error: 'Enter the client’s name' });
    if (phone.replace(/\D/g, '').length < 9) return res.status(400).json({ error: 'Enter the client’s phone number — it is how they are recognised on their next order' });
  }
  const clientKey = clientKeyFor({ corporateClientId: d.corporateClientId, phone, name });
  if (!clientKey) return res.status(400).json({ error: 'Enter the client’s name and phone number' });
  const owner = await activeOwner(prisma, clientKey);
  if (owner) return res.status(409).json({ error: owner.staffId === staffId ? 'This client is already in the register' : `This client is already credited to ${owner.staffName} until ${owner.endDate}. Clients are not shared — they have to be released first.` });
  const cfg = await getCommissionConfig();
  const startDate = todayStr();
  const row = await prisma.clientOwner.create({
    data: { clientKey, clientName: name, phone, staffId, startDate, endDate: ownershipEnd(startDate, cfg.ownershipMonths), note: d.note ?? '', createdByName: req.user!.name },
  });
  res.status(201).json((await shape([row]))[0]);
});

// Correct a client's name or phone (a new phone number can change who they are recognised as, so the same rule applies: nobody else may hold them).
staffClientsRouter.put('/:id', async (req, res) => {
  const parsed = z.object({ name: z.string().trim().max(200), phone: z.string().trim().max(40), note: z.string().trim().max(200).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
  const row = await prisma.clientOwner.findUnique({ where: { id: Number(req.params.id) } });
  if (!row || row.status !== 'Active') return res.status(404).json({ error: 'Client not found in the register' });
  if (!(await mayKeep(req.user!, row.staffId))) return res.status(403).json({ error: 'You can only keep your own clients' });
  const d = parsed.data;
  if (row.clientKey.startsWith('c:')) {
    // a corporate account keeps its name; only the phone shown and the note can be changed here
    const updated = await prisma.clientOwner.update({ where: { id: row.id }, data: { phone: d.phone, note: d.note ?? row.note } });
    return res.json((await shape([updated]))[0]);
  }
  if (!isNamedClient(d.name)) return res.status(400).json({ error: 'Enter the client’s name' });
  if (d.phone.replace(/\D/g, '').length < 9) return res.status(400).json({ error: 'Enter the client’s phone number' });
  const clientKey = clientKeyFor({ phone: d.phone, name: d.name })!;
  if (clientKey !== row.clientKey) {
    const owner = await activeOwner(prisma, clientKey);
    if (owner && owner.id !== row.id) return res.status(409).json({ error: `That phone number belongs to a client credited to ${owner.staffName} until ${owner.endDate}.` });
  }
  const updated = await prisma.clientOwner.update({ where: { id: row.id }, data: { clientKey, clientName: d.name, phone: d.phone, note: d.note ?? row.note } });
  res.json((await shape([updated]))[0]);
});
