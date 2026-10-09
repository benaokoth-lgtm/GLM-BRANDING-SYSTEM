import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { prisma } from './db';
import { open } from './crypto';

// NCBA Bank's Lipa na M-Pesa services on Paybill 880100, built from NCBA's two integration guides:
//   • "NCBA Till STK Push & Dynamic QR Code API" (2024) — we ask NCBA to prompt a customer's phone, and can ask it what became of a prompt;
//   • "NCBA Paybill-Level Push Notification Service Guide" (2023) — NCBA tells us, by POSTing to our address, about every payment made to the
//     Paybill / Till, signed with the username, password and secret key we gave NCBA in the signed instruction letter.
// Everything secret is kept sealed with DATA_KEY (see crypto.ts) and never sent back to the browser.

export const NCBA_BASE_URL = 'https://c2bapis.ncbagroup.com';

export interface NcbaConfig {
  enabled: boolean;
  baseUrl: string;
  apiUsername: string;
  apiSecret: string;
  payBillNo: string;
  accountNo: string;
  network: string;
  publicBaseUrl: string;
  callbackSecret: string;
  pushUser: string;
  pushPassword: string;
  pushSecret: string;
  checkHash: boolean;
}

export const newNcbaSecret = (bytes = 24) => randomBytes(bytes).toString('hex');

export async function getNcbaRow() {
  return (await prisma.ncbaSettings.findUnique({ where: { id: 1 } })) ?? prisma.ncbaSettings.create({ data: { id: 1 } });
}

export async function loadNcbaConfig(): Promise<NcbaConfig> {
  const r = await prisma.ncbaSettings.findUnique({ where: { id: 1 } });
  return {
    enabled: r?.enabled ?? false,
    baseUrl: (r?.baseUrl || NCBA_BASE_URL).replace(/\/+$/, ''),
    apiUsername: r?.apiUsername ?? '',
    apiSecret: open(r?.apiSecret ?? ''),
    payBillNo: r?.payBillNo || '880100',
    accountNo: r?.accountNo ?? '',
    network: r?.network || 'Safaricom',
    publicBaseUrl: (r?.publicBaseUrl ?? '').replace(/\/+$/, ''),
    callbackSecret: open(r?.callbackSecret ?? ''),
    pushUser: open(r?.pushUser ?? ''),
    pushPassword: open(r?.pushPassword ?? ''),
    pushSecret: open(r?.pushSecret ?? ''),
    checkHash: r?.checkHash ?? true,
  };
}

/** Enough to send prompts. */
export const ncbaReady = (c: NcbaConfig) => c.enabled && !!(c.apiUsername && c.apiSecret && c.payBillNo && c.accountNo);

/** The address NCBA is told to send payment notifications to (null until this installation's public https address is saved). */
export function ncbaNotifyUrl(c: NcbaConfig): string | null {
  return c.publicBaseUrl && c.callbackSecret ? `${c.publicBaseUrl}/api/ncba/notify/${c.callbackSecret}` : null;
}

// Only NCBA's own host is ever called (an Admin typing another address here would make this server call it), except under test.
export function ncbaBaseUrlOk(url: string): boolean {
  if (process.env.NODE_ENV === 'test') return /^http:\/\/127\.0\.0\.1:\d+$/.test(url) || /^https:\/\/([a-z0-9-]+\.)*ncbagroup\.com$/i.test(url);
  return /^https:\/\/([a-z0-9-]+\.)*ncbagroup\.com$/i.test(url);
}

export class NcbaError extends Error {}

// ── The STK push API ────────────────────────────────────────────────────────
let tokenCache: { key: string; token: string; until: number } | null = null;

export function resetNcbaToken() {
  tokenCache = null;
}

async function fetchJson(url: string, init: RequestInit): Promise<{ status: number; data: any }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new NcbaError(`Could not reach NCBA (${e instanceof Error ? e.message : 'network error'}). Check the server's internet connection and try again.`);
  }
  return { status: res.status, data: await res.json().catch(() => null) };
}

/** NCBA's token (valid for five hours). The two guides disagree on GET and POST for this call, so GET is tried first and POST if NCBA says that method is not allowed. */
export async function ncbaToken(c: NcbaConfig): Promise<string> {
  const key = `${c.baseUrl}|${c.apiUsername}|${c.apiSecret}`;
  if (tokenCache && tokenCache.key === key && tokenCache.until > Date.now()) return tokenCache.token;
  const headers = { Authorization: 'Basic ' + Buffer.from(`${c.apiUsername}:${c.apiSecret}`).toString('base64') };
  const url = `${c.baseUrl}/payments/api/v1/auth/token`;
  let r = await fetchJson(url, { method: 'GET', headers });
  if (r.status === 404 || r.status === 405) r = await fetchJson(url, { method: 'POST', headers });
  if (r.status === 401) throw new NcbaError('NCBA did not accept the API username and secret key. Check them against the signed instruction letter you gave NCBA.');
  const token = r.data?.access_token;
  if (r.status !== 200 || typeof token !== 'string') throw new NcbaError(`NCBA could not give a token (${r.data?.message || `HTTP ${r.status}`}).`);
  const seconds = Number(r.data?.expires_in) || 18_000;
  tokenCache = { key, token, until: Date.now() + Math.max(60, seconds - 300) * 1000 };
  return token;
}

async function authed(c: NcbaConfig, path: string, body: unknown) {
  const call = async (token: string) => fetchJson(`${c.baseUrl}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let r = await call(await ncbaToken(c));
  if (r.status === 401) {
    resetNcbaToken(); // the token may have expired early: one fresh try
    r = await call(await ncbaToken(c));
  }
  return r;
}

/** Asks NCBA to prompt the phone. Returns NCBA's transaction id (and its reference id). */
export async function ncbaInitiate(c: NcbaConfig, p: { phone: string; amount: number }): Promise<{ transactionId: string; referenceId: string }> {
  const r = await authed(c, '/payments/api/v1/stk-push/initiate', {
    TelephoneNo: p.phone,
    Amount: String(Math.round(p.amount)),
    PayBillNo: c.payBillNo,
    AccountNo: c.accountNo,
    Network: c.network,
    TransactionType: 'CustomerPayBillOnline',
  });
  const d = r.data ?? {};
  if (r.status !== 200 || !d.TransactionID) throw new NcbaError(d.StatusDescription || d.message || `NCBA rejected the payment request (HTTP ${r.status})`);
  return { transactionId: String(d.TransactionID), referenceId: d.ReferenceID ? String(d.ReferenceID) : '' };
}

/** What became of a prompt. NCBA answers SUCCESS or FAILED (with a description); it does not give the M-Pesa receipt here. */
export async function ncbaQuery(c: NcbaConfig, transactionId: string): Promise<{ status: string; description: string }> {
  const r = await authed(c, '/payments/api/v1/stk-push/query', { TransactionID: transactionId });
  if (r.status !== 200) throw new NcbaError(r.data?.message || `NCBA could not say (HTTP ${r.status})`);
  return { status: String(r.data?.status ?? '').toUpperCase(), description: String(r.data?.description ?? '') };
}

// ── Payment notifications from NCBA ─────────────────────────────────────────
export interface NcbaNotice {
  transType: string;
  transId: string;
  ftRef: string;
  transTime: string;
  amount: string; // exactly as NCBA wrote it ("10.00"): the hash is made from the text
  account: string; // the Paybill / Till number
  billRef: string;
  narrative: string;
  mobile: string;
  name: string;
  username: string;
  password: string;
  hash: string;
}

const pick = (o: Record<string, unknown>, ...names: string[]) => {
  for (const n of names) {
    const hit = Object.keys(o).find((k) => k.toLowerCase() === n.toLowerCase());
    if (hit != null && o[hit] != null) return String(o[hit]);
  }
  return '';
};

function xmlTag(xml: string, tag: string): string {
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i').exec(xml);
  if (!m) return '';
  return m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
}

/** Reads a notification in either of NCBA's formats (JSON, or the SOAP/XML one), covering the Buygoods, Paybill and NCBA Till layouts. */
export function parseNotice(body: unknown): { notice: NcbaNotice; format: 'json' | 'xml' } | null {
  if (typeof body === 'string') {
    if (!/<\w/.test(body)) return null;
    const x = (...tags: string[]) => tags.map((t) => xmlTag(body, t)).find((v) => v) ?? '';
    const notice: NcbaNotice = {
      transType: x('TransType'),
      transId: x('TransID'),
      ftRef: x('FTRef'),
      transTime: x('TransTime'),
      amount: x('TransAmount'),
      account: x('AccountNr', 'BusinessShortCode'),
      billRef: x('BillRefNumber'),
      narrative: x('Narrative'),
      mobile: x('PhoneNr', 'Mobile'),
      name: x('CustomerName', 'Name'),
      username: x('User', 'Username'),
      password: x('Password'),
      hash: x('HashVal', 'SecretKey', 'Hash'),
    };
    // For the Buygoods / Paybill layouts the narrative is the customer's account reference
    if (!notice.billRef && notice.narrative) notice.billRef = notice.narrative;
    return notice.transId ? { notice, format: 'xml' } : null;
  }
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    const notice: NcbaNotice = {
      transType: pick(o, 'TransType'),
      transId: pick(o, 'TransID'),
      ftRef: pick(o, 'FTRef'),
      transTime: pick(o, 'TransTime'),
      amount: pick(o, 'TransAmount'),
      account: pick(o, 'BusinessShortCode', 'AccountNr'),
      billRef: pick(o, 'BillRefNumber'),
      narrative: pick(o, 'Narrative'),
      mobile: pick(o, 'Mobile', 'PhoneNr'),
      name: pick(o, 'name', 'CustomerName'),
      username: pick(o, 'Username', 'User'),
      password: pick(o, 'Password'),
      hash: pick(o, 'Hash', 'HashVal', 'SecretKey'),
    };
    return notice.transId ? { notice, format: 'json' } : null;
  }
  return null;
}

/**
 * The signature NCBA puts on each notification: the secret key, then the notification's details in a fixed order, then "1" — hashed with SHA-256 and
 * Base64-encoded (NCBA's Java sample encodes the hex text of the hash). The guide's sample lists TransType, TransID, time, amount, credit account, bill
 * reference, mobile and name; the NCBA Till layout also carries an FT reference and a narrative whose place in the string the guide does not show. So the
 * layouts that are plausible are all tried, each with the hash text and the raw hash, and the notification is trusted when any of them matches.
 */
export function hashCandidates(secret: string, n: NcbaNotice): string[] {
  const core = (withFt: boolean, withNarr: boolean) =>
    secret + n.transType + n.transId + (withFt ? n.ftRef : '') + n.transTime + n.amount + n.account + n.billRef + (withNarr ? n.narrative : '') + n.mobile + n.name + '1';
  const out: string[] = [];
  for (const [ft, narr] of [[false, false], [true, false], [false, true], [true, true]] as const) {
    const digest = createHash('sha256').update(core(ft, narr), 'utf8');
    const raw = digest.copy().digest();
    out.push(Buffer.from(raw.toString('hex')).toString('base64'), raw.toString('base64'));
  }
  return out;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function hashOk(secret: string, n: NcbaNotice): boolean {
  if (!secret || !n.hash) return false;
  return hashCandidates(secret, n).some((h) => same(h, n.hash));
}

/** Are the username and password on the notification the ones this installation gave NCBA? */
export function credentialsOk(c: NcbaConfig, n: NcbaNotice): boolean {
  return !!c.pushUser && !!c.pushPassword && same(n.username, c.pushUser) && same(n.password, c.pushPassword);
}

/** Does a phone NCBA reported (a number, or a 64-character SHA-256 of one) belong to the number a prompt was sent to? */
export function phoneMatches(sent: string, reported: string): boolean {
  const r = reported.trim();
  if (!r) return false;
  const digits = (s: string) => s.replace(/\D/g, '');
  if (/^[0-9a-f]{64}$/i.test(r)) {
    const d = digits(sent);
    const forms = [d, '+' + d, '0' + d.slice(3), d.slice(3)];
    return forms.some((f) => createHash('sha256').update(f).digest('hex') === r.toLowerCase());
  }
  const a = digits(sent);
  const b = digits(r);
  return !!a && !!b && a.slice(-9) === b.slice(-9);
}

/** What goes in NCBA's reply: the JSON form or the XML form, "received" or "not accepted". */
export function replyFor(format: 'json' | 'xml', ok: boolean): { type: string; body: string } {
  if (format === 'json') return { type: 'application/json', body: JSON.stringify({ ResultCode: ok ? '0' : '1', ResultDesc: ok ? 'Received' : 'Not accepted' }) };
  return {
    type: 'text/xml',
    body: `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body><NCBAPaymentNotificationResult><Result>${ok ? 'OK' : 'FAIL'}</Result></NCBAPaymentNotificationResult></soapenv:Body></soapenv:Envelope>`,
  };
}
