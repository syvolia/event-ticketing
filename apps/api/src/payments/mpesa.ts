// M-Pesa Daraja STK Push provider.
//
// Two things that catch most integrations:
//   1. The STK password is base64(ShortCode + PassKey + Timestamp) where the
//      timestamp is in East Africa Time (UTC+3), format YYYYMMDDHHmmss. Any
//      other clock or format and Daraja answers with a generic auth error.
//   2. The STK Push request returns synchronously with MerchantRequestID and
//      CheckoutRequestID. The *result* arrives later on the CallbackURL. The
//      provider must therefore return both ids so the service can store them
//      before the callback lands.
//
// Callback delivery is unauthenticated (Safaricom does not sign callbacks).
// We rely on (a) the CheckoutRequestID being unguessable, (b) matching the
// callback amount against the payment amount, and (c) the DB unique indexes
// on payment_events(provider, provider_event_id) to make replays a no-op. If
// we needed stronger guarantees we would IP-allowlist Safaricom's egress.

import type { MpesaStkCallback } from '@ticketing/shared';
import { mpesaStkCallbackSchema } from '@ticketing/shared';
import { config } from '../config.js';
import { badRequest } from '../errors.js';
import type {
  InitiatePaymentInput,
  InitiatePaymentResult,
  ParsedWebhook,
  PaymentProvider,
  QueryStatusResult,
  WebhookParseInput,
} from './types.js';

const BASE_URL =
  config.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

/** East Africa Time (UTC+3) as YYYYMMDDHHmmss. */
export function eatTimestamp(d: Date = new Date()): string {
  const eat = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  const p = (n: number): string => n.toString().padStart(2, '0');
  return (
    `${eat.getUTCFullYear()}${p(eat.getUTCMonth() + 1)}${p(eat.getUTCDate())}` +
    `${p(eat.getUTCHours())}${p(eat.getUTCMinutes())}${p(eat.getUTCSeconds())}`
  );
}

export function stkPassword(shortcode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

// ResultCode map. The user-facing values are what we surface in the payment
// row's failure_reason; the numeric code is preserved in payment_events.payload
// for audit.
function mapResultCode(code: number): { status: 'succeeded' | 'failed'; reason: string } {
  switch (code) {
    case 0:
      return { status: 'succeeded', reason: 'Success' };
    case 1:
      return { status: 'failed', reason: 'Insufficient funds' };
    case 1001:
      return { status: 'failed', reason: 'Unable to lock subscriber' };
    case 1019:
      return { status: 'failed', reason: 'Transaction expired' };
    case 1025:
      return { status: 'failed', reason: 'Error sending push request' };
    case 1032:
      return { status: 'failed', reason: 'Request cancelled by user' };
    case 1037:
      return { status: 'failed', reason: 'Timeout: user unreachable' };
    case 2001:
      return { status: 'failed', reason: 'Wrong PIN' };
    default:
      return { status: 'failed', reason: `Unknown result code ${code}` };
  }
}

interface MetadataItem {
  Name: string;
  Value: string | number;
}

function readMetadata(items: MetadataItem[] | undefined, name: string): string | number | undefined {
  return items?.find((i) => i.Name === name)?.Value;
}

export interface MpesaProviderOptions {
  /** Override for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Override for tests so we do not depend on the module-level config. */
  shortcode?: string;
  passkey?: string;
  callbackUrl?: string;
  consumerKey?: string;
  consumerSecret?: string;
  baseUrl?: string;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

export class MpesaProvider implements PaymentProvider {
  readonly name = 'mpesa' as const;
  private tokenCache: TokenCache | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly shortcode: string;
  private readonly passkey: string;
  private readonly callbackUrl: string;
  private readonly consumerKey: string;
  private readonly consumerSecret: string;
  private readonly baseUrl: string;

  constructor(opts: MpesaProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.shortcode = opts.shortcode ?? config.MPESA_SHORTCODE;
    this.passkey = opts.passkey ?? config.MPESA_PASSKEY;
    this.callbackUrl = opts.callbackUrl ?? config.MPESA_CALLBACK_URL;
    this.consumerKey = opts.consumerKey ?? config.MPESA_CONSUMER_KEY;
    this.consumerSecret = opts.consumerSecret ?? config.MPESA_CONSUMER_SECRET;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
  }

  // -------------------------------------------------------------------------
  // OAuth token with in-memory caching. Daraja tokens are valid for 3599s;
  // we refresh 60s early so a token that is about to expire is never used.
  // Caching matters: without it every STK Push pays for an extra round trip.
  // -------------------------------------------------------------------------
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) {
      return this.tokenCache.token;
    }
    if (!this.consumerKey || !this.consumerSecret) {
      throw badRequest('M-Pesa credentials are not configured');
    }
    const basic = Buffer.from(`${this.consumerKey}:${this.consumerSecret}`).toString('base64');
    const res = await this.fetchImpl(
      `${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      { method: 'GET', headers: { Authorization: `Basic ${basic}` } },
    );
    if (!res.ok) {
      throw new Error(`M-Pesa OAuth failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { access_token: string; expires_in: string | number };
    const ttl = Number(body.expires_in) * 1000 || 3_599_000;
    this.tokenCache = { token: body.access_token, expiresAt: now + ttl };
    return body.access_token;
  }

  async initiate(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    if (!this.callbackUrl) {
      throw badRequest('MPESA_CALLBACK_URL is not configured');
    }
    if (!input.phone) {
      throw badRequest('phone is required for M-Pesa');
    }
    // M-Pesa Amount is an integer number of shillings, not cents. If our
    // stored minor-unit amount is not a whole shilling, the push would be
    // silently rounded — refuse instead.
    if (input.amountMinor % 100 !== 0) {
      throw badRequest('M-Pesa amount must be a whole number of shillings');
    }
    const amountShillings = input.amountMinor / 100;
    if (amountShillings < 1) {
      throw badRequest('M-Pesa amount must be at least KES 1');
    }

    const token = await this.getAccessToken();
    const timestamp = eatTimestamp();
    const password = stkPassword(this.shortcode, this.passkey, timestamp);
    // Strip the leading '+' so PartyA matches the MSISDN format Daraja expects.
    const msisdn = input.phone.replace(/^\+/, '');

    const payload = {
      BusinessShortCode: this.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline' as const,
      Amount: amountShillings,
      PartyA: msisdn,
      PartyB: this.shortcode,
      PhoneNumber: msisdn,
      CallBackURL: this.callbackUrl,
      // AccountReference is max 12 chars on some shortcodes; our reference is
      // built from the order id prefix, so keep it short at the call site.
      AccountReference: input.accountReference.slice(0, 12),
      TransactionDesc: input.description.slice(0, 100),
    };

    const res = await this.fetchImpl(`${this.baseUrl}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const responseBody = (await res.json()) as {
      MerchantRequestID?: string;
      CheckoutRequestID?: string;
      ResponseCode?: string;
      ResponseDescription?: string;
      CustomerMessage?: string;
    };
    if (!res.ok || responseBody.ResponseCode !== '0') {
      throw new Error(
        `M-Pesa STK Push rejected: ${res.status} ${JSON.stringify(responseBody)}`,
      );
    }
    if (!responseBody.CheckoutRequestID || !responseBody.MerchantRequestID) {
      throw new Error('M-Pesa STK Push response missing identifiers');
    }

    return {
      providerRef: responseBody.CheckoutRequestID,
      merchantRequestId: responseBody.MerchantRequestID,
      status: 'initiated',
      // Redact the password from the stored request — it is base64 and would
      // let a reader recover the passkey.
      rawRequest: { ...payload, Password: '***' },
      rawResponse: responseBody,
    };
  }

  parseWebhook(input: WebhookParseInput): ParsedWebhook {
    const parsed = mpesaStkCallbackSchema.parse(input.body);
    const cb: MpesaStkCallback['Body']['stkCallback'] = parsed.Body.stkCallback;
    const mapped = mapResultCode(cb.ResultCode);

    const items = cb.CallbackMetadata?.Item as MetadataItem[] | undefined;
    const receiptRaw = readMetadata(items, 'MpesaReceiptNumber');
    const amountRaw = readMetadata(items, 'Amount');
    const phoneRaw = readMetadata(items, 'PhoneNumber');

    return {
      providerEventId: cb.CheckoutRequestID,
      eventType: 'stk_callback',
      providerRef: cb.CheckoutRequestID,
      merchantRequestId: cb.MerchantRequestID,
      status: mapped.status,
      ...(amountRaw !== undefined ? { amountMinor: Number(amountRaw) * 100 } : {}),
      currency: 'KES',
      ...(receiptRaw !== undefined ? { receiptNumber: String(receiptRaw) } : {}),
      ...(phoneRaw !== undefined ? { phone: `+${String(phoneRaw)}` } : {}),
      failureCode: mapped.status === 'failed' ? String(cb.ResultCode) : undefined,
      failureReason: mapped.status === 'failed' ? mapped.reason : undefined,
      raw: parsed,
    };
  }

  async queryStatus(input: { providerRef: string; amountMinor: number }): Promise<QueryStatusResult> {
    const token = await this.getAccessToken();
    const timestamp = eatTimestamp();
    const password = stkPassword(this.shortcode, this.passkey, timestamp);
    const res = await this.fetchImpl(`${this.baseUrl}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        BusinessShortCode: this.shortcode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: input.providerRef,
      }),
    });
    const body = (await res.json()) as {
      ResultCode?: string | number;
      ResultDesc?: string;
      ResponseCode?: string;
    };
    if (!res.ok) {
      // A transport failure is not a payment failure. Return pending so the
      // reconciler tries again.
      return { status: 'pending', providerRef: input.providerRef, raw: body };
    }
    const code = Number(body.ResultCode ?? -1);
    // 4999 means "still processing" — this is not a failure.
    if (code === 4999) {
      return { status: 'pending', providerRef: input.providerRef, raw: body };
    }
    const mapped = mapResultCode(code);
    return {
      status: mapped.status,
      providerRef: input.providerRef,
      ...(mapped.status === 'succeeded' ? { amountMinor: input.amountMinor } : {}),
      failureCode: mapped.status === 'failed' ? String(code) : undefined,
      failureReason: mapped.status === 'failed' ? mapped.reason : undefined,
      raw: body,
    };
  }
}