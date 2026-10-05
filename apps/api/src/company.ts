import { prisma } from './db';

/** The company name as set in Master Data → Company Info — used wherever the system speaks for the company (emails, …), never a fixed name. */
export async function companyName(): Promise<string> {
  const s = await prisma.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  return s.companyName.trim() || 'the company';
}
