// Protecting secrets and backups with a key that lives on the server, not in the database.
//
//   DATA_KEY  — any long random text in the server's environment (/etc/glm-pos/api.env), e.g. from `openssl rand -hex 32`.
//
// With it set:
//   • secrets stored in the database (M-Pesa consumer secret / passkey, the email password, the Google Drive secret and token) are kept
//     sealed — AES-256-GCM, written as "enc:v1:…" — so a copy of the database or of a backup file does not reveal them;
//   • every backup file is encrypted too (AES-256-GCM), so a backup that reaches Google Drive, a laptop or a USB stick is unreadable
//     without the key.
// Without it everything still works, in plain text, and the Security tab says so. Keep a copy of the key somewhere other than this server
// (a password manager): without it, sealed settings and encrypted backups cannot be opened.
import crypto from 'node:crypto';

const SEALED = 'enc:v1:';
const BACKUP_MAGIC = Buffer.from('GLMENC1\0');

function rootKey(): Buffer | null {
  const k = process.env.DATA_KEY;
  return k && k.length >= 16 ? Buffer.from(k, 'utf8') : null;
}

/** A separate key for each purpose, derived from DATA_KEY. */
function subKey(purpose: 'secrets' | 'backup'): Buffer | null {
  const root = rootKey();
  return root ? Buffer.from(crypto.hkdfSync('sha256', root, Buffer.from('glm-pos'), Buffer.from(purpose), 32)) : null;
}

export const dataKeyConfigured = () => rootKey() !== null;
export const isSealed = (v: string | null | undefined): boolean => !!v && v.startsWith(SEALED);

/** Seals a secret for storage. Empty text, text that is already sealed, or no DATA_KEY: returned as it is. */
export function seal(plain: string): string {
  const key = subKey('secrets');
  if (!key || !plain || isSealed(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return SEALED + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

/** Reads a stored secret back: sealed values are opened, anything else (older plain values) is returned as it is. */
export function open(stored: string): string {
  if (!isSealed(stored)) return stored;
  const key = subKey('secrets');
  if (!key) throw new Error('A saved setting is protected with DATA_KEY, but DATA_KEY is not set on this server');
  const raw = Buffer.from(stored.slice(SEALED.length), 'base64');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    throw new Error('A saved setting could not be opened — DATA_KEY is not the one it was sealed with');
  }
}

// ── Backup files ─────────────────────────────────────────────────────────────
export const isEncryptedBackup = (b: Buffer): boolean => b.length > BACKUP_MAGIC.length && b.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC);

/** Encrypts a backup file (already gzipped). With no DATA_KEY it is returned unchanged. */
export function encryptBackup(data: Buffer): Buffer {
  const key = subKey('backup');
  if (!key) return data;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([BACKUP_MAGIC, iv, c.getAuthTag(), body]);
}

export function decryptBackup(data: Buffer): Buffer {
  if (!isEncryptedBackup(data)) return data;
  const key = subKey('backup');
  if (!key) throw new Error('This backup is encrypted. Set the same DATA_KEY on this server (in its environment file) that the backup was made with, then restore it.');
  const at = BACKUP_MAGIC.length;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(at, at + 12));
    d.setAuthTag(data.subarray(at + 12, at + 28));
    return Buffer.concat([d.update(data.subarray(at + 28)), d.final()]);
  } catch {
    throw new Error('This backup could not be decrypted — DATA_KEY on this server is not the key it was made with, or the file is damaged');
  }
}
