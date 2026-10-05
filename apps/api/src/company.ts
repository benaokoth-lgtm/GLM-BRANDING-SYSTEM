import { prisma } from './db';

/** The name the system calls itself on screen and in the emails it sends about signing in: the "system name" if one is set, else the company name. */
export async function systemName(): Promise<string> {
  const s = await prisma.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  return s.systemName.trim() || s.companyName.trim() || 'the system';
}

/** The company name as set in Master Data → Company Info — used wherever the system speaks for the company (emails, …), never a fixed name. */
export async function companyName(): Promise<string> {
  const s = await prisma.setting.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  return s.companyName.trim() || 'the company';
}
