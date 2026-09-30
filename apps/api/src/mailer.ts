import nodemailer from 'nodemailer';

// Returns null when SMTP_* isn't configured, so callers can report a clear
// "email isn't set up" rather than failing obscurely.
export function buildTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

export function mailFrom(): string | undefined {
  return process.env.SMTP_FROM || process.env.SMTP_USER;
}
