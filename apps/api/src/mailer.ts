import nodemailer from 'nodemailer';
import { prisma } from './db';
import { open } from './crypto';

// The mail account the system sends from. The Admin sets it under Master Data → Email (stored in MailSettings, laid out like
// the "mail client settings" cPanel shows for a mailbox). An install that has not saved anything there yet keeps sending from
// the older SMTP_* environment variables.

export interface MailConfig {
  source: 'settings' | 'env';
  username: string;
  password: string;
  outgoingHost: string;
  smtpPort: number;
  incomingHost: string;
  imapPort: number;
  pop3Port: number;
  fromName: string;
  loginUrl: string;
}

export async function getMailSettingsRow() {
  return prisma.mailSettings.findUnique({ where: { id: 1 } });
}

/** The account to send from, or null when no mail account has been set up. */
export async function loadMailConfig(): Promise<MailConfig | null> {
  const row = await getMailSettingsRow();
  if (row && row.outgoingHost && row.username && row.password) {
    return { source: 'settings', username: row.username, password: open(row.password), outgoingHost: row.outgoingHost, smtpPort: row.smtpPort, incomingHost: row.incomingHost, imapPort: row.imapPort, pop3Port: row.pop3Port, fromName: row.fromName, loginUrl: row.loginUrl };
  }
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) return null;
  return {
    source: 'env',
    username: SMTP_USER,
    password: SMTP_PASS,
    outgoingHost: SMTP_HOST,
    smtpPort: Number(SMTP_PORT),
    incomingHost: '',
    imapPort: 993,
    pop3Port: 995,
    fromName: SMTP_FROM && !SMTP_FROM.includes('@') ? SMTP_FROM : '',
    loginUrl: '',
  };
}

export function createTransport(c: MailConfig) {
  return nodemailer.createTransport({
    host: c.outgoingHost,
    port: c.smtpPort,
    secure: c.smtpPort === 465, // SSL/TLS on 465; any other port (587) upgrades with STARTTLS
    auth: { user: c.username, pass: c.password },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
}

/** What the mail server said about a message: who it took, who it refused, and its own words. */
export interface MailReceipt {
  accepted?: (string | { address: string })[];
  rejected?: (string | { address: string })[];
  response?: string;
}

/**
 * The mail server taking the message is not the same as the call not failing: a server can answer "250 OK" for some addresses and refuse others.
 * Returns a message when the recipient was refused or no one was accepted, or null when the server took it.
 */
export function refusal(info: MailReceipt | undefined, to: string): string | null {
  if (!info) return null;
  const addr = (a: string | { address: string }) => (typeof a === 'string' ? a : a.address).toLowerCase();
  const refused = (info.rejected ?? []).map(addr);
  const taken = (info.accepted ?? []).map(addr);
  if (refused.includes(to.toLowerCase()) || (taken.length === 0 && (info.accepted !== undefined || refused.length > 0))) {
    return `The mail server refused ${to}${info.response ? ` (${info.response})` : ''}. Check the address is spelled correctly.`;
  }
  return null;
}

export interface Mailer {
  config: MailConfig;
  sendMail(msg: { to: string; subject: string; text?: string; html?: string; attachments?: { filename: string; content: Buffer; contentType?: string }[] }): Promise<MailReceipt>;
}

/** A ready-to-use mailer (From set from the mail settings), or null when mail isn't set up. */
export async function getMailer(): Promise<Mailer | null> {
  const config = await loadMailConfig();
  if (!config) return null;
  const transport = createTransport(config);
  const from = config.fromName ? { name: config.fromName, address: config.username } : config.username;
  return { config, sendMail: (msg) => transport.sendMail({ from, ...msg }) as Promise<MailReceipt> };
}

/** Turns a mail-server failure into something a person can act on. */
export function explainMailError(e: unknown, c: Pick<MailConfig, 'outgoingHost' | 'smtpPort'>): string {
  const err = e as { code?: string; responseCode?: number; message?: string };
  if (err.code === 'EAUTH' || err.responseCode === 535) return 'The mail server rejected the username or password.';
  if (err.code === 'ECONNECTION' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ESOCKET' || err.code === 'ENOTFOUND' || err.code === 'EDNS') {
    return `Could not connect to ${c.outgoingHost} on port ${c.smtpPort}. Check the outgoing server name and port (465 for SSL/TLS).`;
  }
  if (err.code === 'ECERTIFICATE' || /certificate/i.test(err.message ?? '')) return 'The mail server’s security certificate was not accepted. Use the exact mail server name shown in your mail account’s settings.';
  return err.message || 'The email could not be sent.';
}
