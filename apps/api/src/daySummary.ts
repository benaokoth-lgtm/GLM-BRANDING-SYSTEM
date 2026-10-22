// The evening summary: at a set time each evening the day's figures (received, cash-up, what is owed, the NCBA tie-out and any day not closed) go to chosen WhatsApp numbers.
// Business-started messages need an approved TEMPLATE (Utility, text body, five variables — wording in TEMPLATE below); with none saved a plain message is sent, which WhatsApp delivers only to a person
// who wrote to us in the last 24 hours (messaging the business number once a day keeps that open).
import { whatsappNumber } from '@glm/shared';
import { prisma } from './db';
import { summaryFor } from './dayClose';
import { WhatsappError, loadWhatsappConfig, sendTemplateText, sendTextMessage } from './whatsapp';

export const SUMMARY_TEMPLATE_BODY = 'GLM daily summary for {{1}}. Received: {{2}}. Cash: {{3}}. Owed by customers: {{4}}. {{5}}';

export async function getSummarySettings() {
  return prisma.dayCloseSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
}

/** The numbers typed in, cleaned: separated by commas, semicolons or lines; ones that are not WhatsApp numbers are dropped. */
export function parseNumbers(raw: string): string[] {
  return [...new Set(raw.split(/[,;\n]+/).map((s) => whatsappNumber(s.trim())).filter((n): n is string => !!n))];
}

/** Nairobi's clock, whatever the server's: today's date and the time as HH:MM. */
export function nairobiNow(now = new Date()): { date: string; time: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export interface SummaryResult {
  ok: boolean;
  sent: string[];
  failed: { to: string; error: string }[];
  text: string;
}

/** Builds and sends the summary of `date` to every number. Each message is recorded in the WhatsApp log. */
export async function sendSummary(date: string, by: string): Promise<SummaryResult> {
  const s = await getSummarySettings();
  const numbers = parseNumbers(s.summaryNumbers);
  const summary = await summaryFor(date);
  if (numbers.length === 0) return { ok: false, sent: [], failed: [{ to: '', error: 'No WhatsApp number to send the summary to' }], text: summary.text };
  const cfg = await loadWhatsappConfig();
  if (!cfg) return { ok: false, sent: [], failed: [{ to: '', error: "WhatsApp isn't set up yet — an Admin sets it up under Master Data → WhatsApp" }], text: summary.text };
  const result: SummaryResult = { ok: true, sent: [], failed: [], text: summary.text };
  for (const to of numbers) {
    const log = (status: 'Sent' | 'Failed', extra: { id?: string; error?: string }) =>
      prisma.whatsappMessage.create({ data: { toNumber: to, status, mode: s.summaryTemplate ? 'template' : 'text', fileName: 'Daily summary', waMessageId: extra.id ?? null, error: extra.error ?? '', sentByName: by } });
    try {
      const id = s.summaryTemplate ? await sendTemplateText(cfg, to, s.summaryTemplate, summary.params) : await sendTextMessage(cfg, to, summary.text);
      await log('Sent', { id });
      result.sent.push(to);
    } catch (e) {
      const error = e instanceof WhatsappError ? e.message : 'Could not send the summary';
      if (!(e instanceof WhatsappError)) console.error('Day summary send failed', e);
      await log('Failed', { error });
      result.failed.push({ to, error });
    }
  }
  result.ok = result.failed.length === 0;
  return result;
}

const RETRY_AFTER_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;

/** Is it time to send today's summary? After the set time, once a day; a failed one is tried again every half hour, up to three times. */
export function summaryDue(s: { summaryEnabled: boolean; summaryTime: string; summaryNumbers: string; summaryLastDate: string; summaryAttempts: number; summaryLastTryAt: Date | null; summaryLastStatus: string }, now = new Date()): boolean {
  if (!s.summaryEnabled || parseNumbers(s.summaryNumbers).length === 0) return false;
  const n = nairobiNow(now);
  if (n.time < s.summaryTime) return false;
  if (s.summaryLastDate !== n.date) return true;
  if (s.summaryLastStatus === 'Sent') return false;
  return s.summaryAttempts < MAX_ATTEMPTS && (!s.summaryLastTryAt || now.getTime() - s.summaryLastTryAt.getTime() >= RETRY_AFTER_MS);
}

export async function runScheduledSummary(now = new Date()): Promise<SummaryResult | null> {
  const s = await getSummarySettings();
  if (!summaryDue(s, now)) return null;
  const date = nairobiNow(now).date;
  const attempts = s.summaryLastDate === date ? s.summaryAttempts + 1 : 1;
  const r = await sendSummary(date, 'Day close summary');
  await prisma.dayCloseSettings.update({
    where: { id: 1 },
    data: { summaryLastDate: date, summaryAttempts: attempts, summaryLastTryAt: now, summaryLastStatus: r.ok ? 'Sent' : `Failed: ${r.failed[0]?.error ?? 'unknown'}`.slice(0, 300) },
  });
  return r;
}

export function startSummaryScheduler(): void {
  const tick = async () => {
    try {
      await runScheduledSummary();
    } catch (err) {
      console.error('Evening summary failed', err);
    }
  };
  setTimeout(tick, 90_000).unref();
  setInterval(tick, 60_000).unref();
}
