// Nodemailer wired to Mailpit in dev (no auth, plain SMTP on 1025).
// In production this would point at SES / Postmark / etc., and would require
// credentials. The interface here stays the same.
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { logger } from '../logger.js';

let cached: Transporter | null = null;

function getTransporter(): Transporter {
  if (cached) return cached;
  cached = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    // Mailpit speaks plain SMTP; a real provider would set `secure: true` on
    // 465 or STARTTLS on 587 with credentials.
    secure: false,
    // Fail fast: without a timeout, a hung SMTP server blocks the outbox
    // worker indefinitely.
    connectionTimeout: 5_000,
    socketTimeout: 10_000,
  });
  return cached;
}

export interface TicketEmailItem {
  id: string;
  shortCode: string;
  tierName: string;
  qrPngDataUrl: string;
}

export interface TicketEmailInput {
  to: string;
  buyerName: string;
  eventName: string;
  venue: string;
  startsAt: Date;
  orderId: string;
  items: TicketEmailItem[];
}

export async function sendTicketEmail(input: TicketEmailInput): Promise<void> {
  const t = getTransporter();
  const html = renderHtml(input);
  const text = renderText(input);
  const info = await t.sendMail({
    from: config.SMTP_FROM,
    to: input.to,
    subject: `Your tickets for ${input.eventName}`,
    text,
    html,
  });
  logger.info(
    { messageId: info.messageId, to: input.to, orderId: input.orderId },
    'ticket email sent',
  );
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderHtml(input: TicketEmailInput): string {
  const cards = input.items
    .map(
      (it) => `
      <div style="border:1px solid #ddd;border-radius:8px;padding:16px;margin:12px 0;font-family:sans-serif">
        <div style="font-weight:600">${esc(it.tierName)}</div>
        <div style="font-family:monospace;font-size:20px;letter-spacing:2px;margin:8px 0">${esc(it.shortCode)}</div>
        <img src="${it.qrPngDataUrl}" alt="QR code" width="256" height="256" />
        <div style="font-size:12px;color:#666;margin-top:8px">Show this at the door.</div>
      </div>`,
    )
    .join('');
  return `<!doctype html>
<html><body style="font-family:sans-serif;max-width:640px;margin:auto;padding:24px">
  <h1 style="margin:0 0 8px">Your tickets are ready</h1>
  <p>Hi ${esc(input.buyerName)},</p>
  <p>Thanks for your purchase for <strong>${esc(input.eventName)}</strong> at ${esc(input.venue)}.</p>
  <p>Starts ${input.startsAt.toISOString()}</p>
  ${cards}
  <p style="font-size:12px;color:#666">Order ${esc(input.orderId)}</p>
</body></html>`;
}

function renderText(input: TicketEmailInput): string {
  const lines = input.items
    .map((it) => `  - ${it.tierName}: ${it.shortCode} (open the HTML email for the QR)`)
    .join('\n');
  return `Your tickets for ${input.eventName}\n\n${lines}\n\nOrder ${input.orderId}\n`;
}