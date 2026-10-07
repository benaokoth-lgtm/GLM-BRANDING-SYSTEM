import { X509Certificate, constants as cryptoConstants, publicEncrypt, randomBytes } from 'crypto';
import { prisma } from './db';
import { open } from './crypto';

// Where M-Pesa's settings come from. The Admin sets them under Master Data → M-Pesa (stored in MpesaSettings). An install that
// pre-dates that screen keeps working from the MPESA_* environment variables until the first save there.

export interface MpesaConfig {
  /** Where these values came from. */
  source: 'settings' | 'env';
  enabled: boolean;
  environment: 'sandbox' | 'production';
  shortCode: string;
  isTill: boolean;
  consumerKey: string;
  consumerSecret: string;
  passkey: string;
  publicBaseUrl: string;
  callbackSecret: string;
  c2bRegisteredAt: Date | null;
  // Pay-outs to phones (B2C)
  b2cShortCode: string;
  initiatorName: string;
  initiatorPassword: string;
  securityCert: string;
  b2cCommand: string;
}

export const newCallbackSecret = () => randomBytes(24).toString('hex');

export async function getSettingsRow() {
  return (await prisma.mpesaSettings.findUnique({ where: { id: 1 } })) ?? prisma.mpesaSettings.create({ data: { id: 1 } });
}

export async function loadMpesaConfig(): Promise<MpesaConfig> {
  const row = await prisma.mpesaSettings.findUnique({ where: { id: 1 } });
  // Saved settings win as soon as there are credentials in them.
  if (row && (row.consumerKey || row.shortCode)) {
    return {
      source: 'settings',
      enabled: row.enabled,
      environment: row.environment === 'production' ? 'production' : 'sandbox',
      shortCode: row.shortCode,
      isTill: row.isTill,
      consumerKey: open(row.consumerKey),
      consumerSecret: open(row.consumerSecret),
      passkey: open(row.passkey),
      publicBaseUrl: row.publicBaseUrl.replace(/\/+$/, ''),
      callbackSecret: open(row.callbackSecret),
      c2bRegisteredAt: row.c2bRegisteredAt,
      b2cShortCode: row.b2cShortCode,
      initiatorName: row.initiatorName,
      initiatorPassword: open(row.initiatorPassword),
      securityCert: row.securityCert,
      b2cCommand: row.b2cCommand || 'BusinessPayment',
    };
  }
  const e = process.env;
  const origin = (() => {
    try {
      return e.MPESA_PUBLIC_URL ? e.MPESA_PUBLIC_URL.replace(/\/+$/, '') : e.MPESA_CALLBACK_URL ? new URL(e.MPESA_CALLBACK_URL).origin : '';
    } catch {
      return '';
    }
  })();
  return {
    source: 'env',
    enabled: !!(e.MPESA_CONSUMER_KEY && e.MPESA_CONSUMER_SECRET && e.MPESA_SHORTCODE && e.MPESA_PASSKEY && e.MPESA_CALLBACK_URL),
    environment: e.MPESA_ENV === 'production' ? 'production' : 'sandbox',
    shortCode: e.MPESA_SHORTCODE || '',
    isTill: false,
    consumerKey: e.MPESA_CONSUMER_KEY || '',
    consumerSecret: e.MPESA_CONSUMER_SECRET || '',
    passkey: e.MPESA_PASSKEY || '',
    publicBaseUrl: origin,
    callbackSecret: e.MPESA_C2B_SECRET || '',
    c2bRegisteredAt: null,
    b2cShortCode: '',
    initiatorName: '',
    initiatorPassword: '',
    securityCert: '',
    b2cCommand: 'BusinessPayment',
  };
}

/** Everything needed to prompt a customer is present and M-Pesa is switched on. */
export function isReady(c: MpesaConfig): boolean {
  return c.enabled && !!(c.consumerKey && c.consumerSecret && c.shortCode && c.passkey);
}

export const darajaBaseUrl = (c: Pick<MpesaConfig, 'environment'>) =>
  // (the tests point this at a local stand-in for Safaricom; it is ignored everywhere else)
  process.env.NODE_ENV === 'test' && process.env.DARAJA_TEST_URL ? process.env.DARAJA_TEST_URL : c.environment === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

/** Can money be sent OUT to a phone? Needs the initiator, its password, Safaricom's certificate and a Paybill. */
export function isB2cReady(c: MpesaConfig): boolean {
  return c.enabled && !!(c.consumerKey && c.consumerSecret && (c.b2cShortCode || c.shortCode) && c.initiatorName && c.initiatorPassword && c.securityCert);
}

/** Reads Safaricom's certificate however it was pasted: the PEM text, or just the base64 body. Throws if it is not a certificate. */
export function parseCertificate(text: string): X509Certificate {
  const t = text.trim();
  if (!t) throw new Error('No certificate');
  return new X509Certificate(/BEGIN CERTIFICATE/.test(t) ? t : Buffer.from(t.replace(/\s+/g, ''), 'base64'));
}

/** The initiator's password encrypted with Safaricom's public certificate (RSA, PKCS#1 v1.5), base64 — what Daraja calls the SecurityCredential. */
export function securityCredential(c: Pick<MpesaConfig, 'initiatorPassword' | 'securityCert'>): string {
  const cert = parseCertificate(c.securityCert);
  return publicEncrypt({ key: cert.publicKey, padding: cryptoConstants.RSA_PKCS1_PADDING }, Buffer.from(c.initiatorPassword, 'utf8')).toString('base64');
}

/** The addresses Safaricom is told to call. In env mode the STK callback is MPESA_CALLBACK_URL exactly as set. */
export function callbackUrls(c: MpesaConfig): { stk: string; validation: string; confirmation: string; b2cResult: string; b2cTimeout: string } | null {
  if (!c.publicBaseUrl || !c.callbackSecret) return null;
  const base = `${c.publicBaseUrl}/api/mpesa`;
  return {
    stk: c.source === 'env' && process.env.MPESA_CALLBACK_URL ? process.env.MPESA_CALLBACK_URL : `${base}/callback/${c.callbackSecret}`,
    validation: `${base}/c2b/${c.callbackSecret}/validation`,
    confirmation: `${base}/c2b/${c.callbackSecret}/confirmation`,
    b2cResult: `${base}/b2c/${c.callbackSecret}/result`,
    b2cTimeout: `${base}/b2c/${c.callbackSecret}/timeout`,
  };
}

export class DarajaError extends Error {}

export async function getAccessToken(c: MpesaConfig): Promise<string> {
  if (!c.consumerKey || !c.consumerSecret) throw new DarajaError('Enter the consumer key and secret first');
  const auth = Buffer.from(`${c.consumerKey}:${c.consumerSecret}`).toString('base64');
  let res: Response;
  try {
    res = await fetch(`${darajaBaseUrl(c)}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
  } catch {
    throw new DarajaError('Could not reach Safaricom — check the server has internet access');
  }
  if (!res.ok) throw new DarajaError(res.status === 400 || res.status === 401 ? 'Safaricom rejected the consumer key / secret (check the environment matches: sandbox keys only work on Sandbox)' : `Safaricom answered ${res.status} when asked for a token`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new DarajaError('Safaricom did not return an access token');
  return data.access_token;
}

export function darajaTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
