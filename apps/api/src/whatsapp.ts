// Sending an invoice, quotation or receipt straight to a customer's WhatsApp, as a PDF attachment, through Meta's WhatsApp Business Cloud API.
//
// How a message goes: the PDF is uploaded to WhatsApp (POST /{phone-number-id}/media), which returns a media id, and a message that carries that id is
// sent to the customer (POST /{phone-number-id}/messages). A business can only start a conversation with an APPROVED TEMPLATE message; free-form messages
// are accepted only while the customer has written to the business in the last 24 hours. So the normal route is a template whose header is a document
// (the PDF) and whose body has five variables (see TEMPLATE_BODY below); if no template is set, a plain document message is tried, which works only inside
// that 24-hour window. The Admin sets it all up under Master Data → WhatsApp; the access token is sealed with the DATA_KEY like the other secrets.
import { prisma } from './db';
import { open } from './crypto';

export interface WhatsappConfig {
  phoneNumberId: string;
  token: string;
  businessAccountId: string;
  templateName: string;
  templateLanguage: string;
  apiVersion: string;
}

/** Where Meta's API lives. Tests point it at a stand-in server; nothing else can move it. */
const base = () => (process.env.NODE_ENV === 'test' && process.env.WHATSAPP_TEST_URL ? process.env.WHATSAPP_TEST_URL : 'https://graph.facebook.com');

/** The saved setup, or null when WhatsApp is not switched on and complete. `ignoreSwitch` is for the Admin's connection test, which runs before it is switched on. */
export async function loadWhatsappConfig(opts: { ignoreSwitch?: boolean } = {}): Promise<WhatsappConfig | null> {
  const row = await prisma.whatsappSettings.findUnique({ where: { id: 1 } });
  if (!row || (!row.enabled && !opts.ignoreSwitch) || !row.phoneNumberId || !row.accessToken) return null;
  return {
    phoneNumberId: row.phoneNumberId.trim(),
    token: open(row.accessToken),
    businessAccountId: row.businessAccountId,
    templateName: row.templateName.trim(),
    templateLanguage: row.templateLanguage.trim() || 'en',
    apiVersion: row.apiVersion.trim() || 'v21.0',
  };
}

/** The wording the template must have (Utility category, header type Document). Shown on the setup screen so it can be copied into Meta's template form. */
export const TEMPLATE_BODY = 'Hello {{1}}, please find attached your {{2}} {{3}} from GLM Branding. Total: {{4}}. {{5}}';

export class WhatsappError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

/** Turns one of Meta's error answers into something a person can act on. */
export function explainWhatsappError(code: number | undefined, message: string, detail?: string): string {
  const raw = detail ? `${message} (${detail})` : message;
  switch (code) {
    case 190:
    case 102:
      return 'WhatsApp refused the access token: it is wrong, has expired or was revoked. Create a new permanent token (a System User token) and save it under Master Data → WhatsApp.';
    case 131030:
      return 'That number is not on the list of numbers allowed to receive messages yet. While the WhatsApp number is in test mode, add the recipient under WhatsApp → API Setup in Meta, or finish going live.';
    case 131047:
      return 'The customer has not written to us in the last 24 hours, so only an approved template message can be sent to them. Set the template name under Master Data → WhatsApp.';
    case 131026:
      return 'The message could not be delivered: that number may not be on WhatsApp.';
    case 132000:
    case 132005:
    case 132012:
      return 'The template does not match what was sent. Check that it has a Document header and five body variables, as shown under Master Data → WhatsApp.';
    case 132001:
      return 'WhatsApp cannot find that template in that language. Check the template name and language code under Master Data → WhatsApp, and that Meta has approved it.';
    case 132015:
    case 132016:
      return 'That template is paused or disabled by WhatsApp. Check it in Meta’s template manager.';
    case 130429:
    case 131048:
    case 131056:
      return 'WhatsApp is limiting how fast messages can be sent. Try again in a minute.';
    case 131042:
    case 131045:
      return 'The WhatsApp Business account has a payment or registration problem. Check the account in Meta Business Settings.';
    case 100:
      return `WhatsApp rejected the request: ${raw}`;
    default:
      return `WhatsApp could not send it: ${raw}`;
  }
}

async function graph(cfg: WhatsappConfig, path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${base()}/${cfg.apiVersion}/${path}`, { ...init, headers: { Authorization: `Bearer ${cfg.token}`, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new WhatsappError('Could not reach WhatsApp (graph.facebook.com). Check the server’s internet connection and try again.');
  }
  const body: any = await res.json().catch(() => null);
  if (!res.ok || body?.error) {
    const e = body?.error ?? {};
    throw new WhatsappError(explainWhatsappError(e.code, e.message ?? `HTTP ${res.status}`, e.error_data?.details), e.code);
  }
  return body;
}

/** Checks the token and the phone number id, and returns the number's display name so the Admin can see it is the right one. */
export async function checkConnection(cfg: WhatsappConfig): Promise<{ displayPhoneNumber: string; verifiedName: string; quality: string }> {
  const r = await graph(cfg, `${cfg.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`);
  return { displayPhoneNumber: r.display_phone_number ?? '', verifiedName: r.verified_name ?? '', quality: r.quality_rating ?? '' };
}

/** Uploads the PDF to WhatsApp and returns the media id to attach to a message. */
async function uploadPdf(cfg: WhatsappConfig, pdf: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'application/pdf');
  form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);
  const r = await graph(cfg, `${cfg.phoneNumberId}/media`, { method: 'POST', body: form });
  if (!r?.id) throw new WhatsappError('WhatsApp did not accept the PDF upload.');
  return String(r.id);
}

export interface InvoiceMessage {
  /** The customer's number, digits with country code and no plus: 254712345678. */
  to: string;
  pdf: Buffer;
  filename: string;
  /** The five values of the template body: customer, document kind, number, total, and the balance / thank-you line. */
  params: [string, string, string, string, string];
  /** A line shown under the document when no template is used (free-form, inside the 24-hour window). */
  caption: string;
}

/** Sends the PDF to the customer. Returns the message id WhatsApp gives it. */
export async function sendInvoiceDocument(cfg: WhatsappConfig, m: InvoiceMessage): Promise<{ messageId: string; mode: 'template' | 'document' }> {
  const mediaId = await uploadPdf(cfg, m.pdf, m.filename);
  const clean = (s: string) => s.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 900) || '-'; // template variables cannot hold line breaks
  const payload = cfg.templateName
    ? {
        messaging_product: 'whatsapp',
        to: m.to,
        type: 'template',
        template: {
          name: cfg.templateName,
          language: { code: cfg.templateLanguage },
          components: [
            { type: 'header', parameters: [{ type: 'document', document: { id: mediaId, filename: m.filename } }] },
            { type: 'body', parameters: m.params.map((t) => ({ type: 'text', text: clean(t) })) },
          ],
        },
      }
    : { messaging_product: 'whatsapp', to: m.to, type: 'document', document: { id: mediaId, filename: m.filename, caption: m.caption.slice(0, 1000) } };
  const r = await graph(cfg, `${cfg.phoneNumberId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const id = r?.messages?.[0]?.id;
  if (!id) throw new WhatsappError('WhatsApp did not confirm the message.');
  return { messageId: String(id), mode: cfg.templateName ? 'template' : 'document' };
}
