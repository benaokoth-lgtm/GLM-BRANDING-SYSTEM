// Seals, at start-up, any secret that was saved before DATA_KEY was set (see crypto.ts). Safe to run every time: sealed values are left alone.
import { prisma } from './db';
import { dataKeyConfigured, isSealed, seal } from './crypto';

const plain = (v: string | null | undefined) => !!v && !isSealed(v);

export interface SecretStatus {
  /** Secrets that are saved but still readable in the database (0 when DATA_KEY is set and everything has been sealed). */
  unsealed: string[];
}

export async function secretStatus(): Promise<SecretStatus> {
  const unsealed: string[] = [];
  const m = await prisma.mpesaSettings.findUnique({ where: { id: 1 } });
  if (m) for (const k of ['consumerKey', 'consumerSecret', 'passkey', 'callbackSecret'] as const) if (plain(m[k])) unsealed.push(`M-Pesa ${k}`);
  const mail = await prisma.mailSettings.findUnique({ where: { id: 1 } });
  if (plain(mail?.password)) unsealed.push('Email password');
  const b = await prisma.backupSettings.findUnique({ where: { id: 1 } });
  if (b) for (const k of ['driveClientSecret', 'driveRefreshToken'] as const) if (plain(b[k])) unsealed.push(`Google Drive ${k}`);
  const wa = await prisma.whatsappSettings.findUnique({ where: { id: 1 } });
  if (plain(wa?.accessToken)) unsealed.push('WhatsApp access token');
  return { unsealed };
}

export async function sealStoredSecrets(): Promise<void> {
  if (!dataKeyConfigured()) return;
  const m = await prisma.mpesaSettings.findUnique({ where: { id: 1 } });
  if (m && (['consumerKey', 'consumerSecret', 'passkey', 'callbackSecret'] as const).some((k) => plain(m[k]))) {
    await prisma.mpesaSettings.update({ where: { id: 1 }, data: { consumerKey: seal(m.consumerKey), consumerSecret: seal(m.consumerSecret), passkey: seal(m.passkey), callbackSecret: seal(m.callbackSecret) } });
  }
  const mail = await prisma.mailSettings.findUnique({ where: { id: 1 } });
  if (mail && plain(mail.password)) await prisma.mailSettings.update({ where: { id: 1 }, data: { password: seal(mail.password) } });
  const wa = await prisma.whatsappSettings.findUnique({ where: { id: 1 } });
  if (wa && plain(wa.accessToken)) await prisma.whatsappSettings.update({ where: { id: 1 }, data: { accessToken: seal(wa.accessToken) } });
  const b = await prisma.backupSettings.findUnique({ where: { id: 1 } });
  if (b && (plain(b.driveClientSecret) || plain(b.driveRefreshToken))) {
    await prisma.backupSettings.update({ where: { id: 1 }, data: { driveClientSecret: seal(b.driveClientSecret), driveRefreshToken: seal(b.driveRefreshToken) } });
  }
}
