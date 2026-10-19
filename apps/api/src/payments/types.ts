// Provider-agnostic contract. The service layer never branches on provider
// name; adding a third PSP means implementing this interface and registering
// it, nothing else.
//
// Optional fields explicitly allow `| undefined`. This is required because
// callers build these objects from Zod-parsed input (where `.optional()` gives
// `string | undefined`) and from conditional expressions that yield
// `undefined` on the "not present" branch. Under exactOptionalPropertyTypes,
// `?: string` means "key may be absent" — it does NOT mean "value may be
// undefined", so we spell both out.
import type { PaymentProvider as PaymentProviderName } from '@ticketing/shared';

export interface InitiatePaymentInput {
  /** Our payments.id — used as the idempotency key with the provider. */
  paymentId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  /** M-Pesa only. E.164. */
  phone?: string | undefined;
  /** Short, human-readable reference shown on the buyer's phone or receipt. */
  accountReference: string;
  description: string;
}

export interface InitiatePaymentResult {
  /** Provider's primary handle: CheckoutRequestID (M-Pesa) or PaymentIntent id (Stripe). */
  providerRef: string;
  /** M-Pesa only: MerchantRequestID, returned synchronously by STK Push. */
  merchantRequestId?: string | undefined;
  /** Stripe only: client_secret the browser confirms with. */
  clientSecret?: string | undefined;
  /** Initial status as reported by the provider. */
  status: 'initiated' | 'pending' | 'succeeded';
  rawRequest: unknown;
  rawResponse: unknown;
}

export type NormalizedPaymentStatus = 'succeeded' | 'failed' | 'pending';

export interface ParsedWebhook {
  /** Stable across redeliveries. M-Pesa: CheckoutRequestID. Stripe: event.id. */
  providerEventId: string;
  /** e.g. 'stk_callback', 'payment_intent.succeeded'. */
  eventType: string;
  /** Matches payments.provider_ref. */
  providerRef: string;
  /** Optional. M-Pesa only. */
  merchantRequestId?: string | undefined;
  status: NormalizedPaymentStatus;
  amountMinor?: number | undefined;
  currency?: string | undefined;
  /** M-Pesa receipt number, Stripe charge id. */
  receiptNumber?: string | undefined;
  phone?: string | undefined;
  failureCode?: string | undefined;
  failureReason?: string | undefined;
  raw: unknown;
}

export interface QueryStatusResult {
  status: NormalizedPaymentStatus;
  providerRef: string;
  amountMinor?: number | undefined;
  receiptNumber?: string | undefined;
  failureCode?: string | undefined;
  failureReason?: string | undefined;
  raw: unknown;
}

export interface WebhookParseInput {
  headers: Record<string, string | string[] | undefined>;
  /** Raw bytes. Required for Stripe signature verification. */
  rawBody: Buffer;
  /** Parsed JSON body, for M-Pesa whose callbacks are unsigned. */
  body: unknown;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  initiate(input: InitiatePaymentInput): Promise<InitiatePaymentResult>;
  parseWebhook(input: WebhookParseInput): Promise<ParsedWebhook> | ParsedWebhook;
  /** Optional. The reconciler calls this for payments stuck in initiated. */
  queryStatus?(input: { providerRef: string; amountMinor: number }): Promise<QueryStatusResult>;
}