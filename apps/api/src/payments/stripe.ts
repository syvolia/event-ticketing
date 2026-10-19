// Stripe PaymentIntents provider.
//
// The webhook signature is verified with stripe.webhooks.constructEvent on
// the RAW request body. Fastify's preParsing hook (see server.ts) captures
// the raw bytes for this route before the JSON parser runs, because any
// reformatting of the body — whitespace, key reordering — changes the HMAC
// and the verification fails.
//
// We do not confirm on the server. The client confirms the PaymentIntent with
// the client_secret we return, and the resulting state change reaches us via
// the payment_intent.succeeded webhook. This keeps card data out of our
// process.

import Stripe from 'stripe';
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

export interface StripeProviderOptions {
  secretKey?: string;
  webhookSecret?: string;
  apiVersion?: Stripe.LatestApiVersion;
}

export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(opts: StripeProviderOptions = {}) {
    const key = opts.secretKey ?? config.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
    this.stripe = new Stripe(key, {
      // Pinning the API version is not optional: a Stripe-side upgrade would
      // otherwise silently change response shapes under us.
      apiVersion: opts.apiVersion ?? '2024-06-20',
      typescript: true,
    });
    this.webhookSecret = opts.webhookSecret ?? config.STRIPE_WEBHOOK_SECRET;
  }

  async initiate(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    // Pass our paymentId as Stripe's idempotency key. Retrying initiate with
    // the same paymentId returns the same PaymentIntent rather than creating
    // a second one. This mirrors the DB's UNIQUE on
    // payments(order_id, provider, idempotency_key): even if the app retried
    // before writing the first response, Stripe itself deduplicates.
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: input.amountMinor,
        currency: input.currency.toLowerCase(),
        // Metadata comes back on every webhook event for this intent, so the
        // service layer can map event -> order without a second lookup.
        metadata: { orderId: input.orderId, paymentId: input.paymentId },
        automatic_payment_methods: { enabled: true },
        description: input.description.slice(0, 500),
      },
      { idempotencyKey: `pay_${input.paymentId}` },
    );
    if (!intent.client_secret) {
      throw new Error('Stripe PaymentIntent is missing client_secret');
    }
    return {
      providerRef: intent.id,
      clientSecret: intent.client_secret,
      status: intent.status === 'succeeded' ? 'succeeded' : 'initiated',
      rawRequest: { amount: input.amountMinor, currency: input.currency },
      rawResponse: intent,
    };
  }

  parseWebhook(input: WebhookParseInput): ParsedWebhook {
    const sig = input.headers['stripe-signature'];
    if (typeof sig !== 'string') {
      throw badRequest('Missing Stripe-Signature header');
    }
    if (!this.webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    }
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(input.rawBody, sig, this.webhookSecret);
    } catch (err) {
      // Signature verification failures are client-visible as 400s, not 500s.
      throw badRequest(
        `Stripe signature verification failed: ${(err as Error).message}`,
      );
    }

    // We only care about two event types. Everything else is recorded for
    // audit but does not change state.
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object as Stripe.PaymentIntent;
      return {
        providerEventId: event.id,
        eventType: event.type,
        providerRef: pi.id,
        status: 'succeeded',
        amountMinor: pi.amount_received || pi.amount,
        currency: pi.currency.toUpperCase(),
        receiptNumber: pi.latest_charge ? String(pi.latest_charge) : undefined,
        raw: event,
      };
    }
    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object as Stripe.PaymentIntent;
      const lastError = pi.last_payment_error;
      return {
        providerEventId: event.id,
        eventType: event.type,
        providerRef: pi.id,
        status: 'failed',
        amountMinor: pi.amount,
        currency: pi.currency.toUpperCase(),
        failureCode: lastError?.code ?? 'payment_failed',
        failureReason: lastError?.message ?? 'Payment failed',
        raw: event,
      };
    }
    // Unknown event types: record with status pending so the handler stores
    // them but does not transition anything.
    const obj = event.data.object as { id?: string };
    return {
      providerEventId: event.id,
      eventType: event.type,
      providerRef: obj.id ?? 'unknown',
      status: 'pending',
      raw: event,
    };
  }

  async queryStatus(input: { providerRef: string }): Promise<QueryStatusResult> {
    const pi = await this.stripe.paymentIntents.retrieve(input.providerRef);
    let status: QueryStatusResult['status'] = 'pending';
    if (pi.status === 'succeeded') status = 'succeeded';
    else if (pi.status === 'canceled' || pi.status === 'requires_payment_method') {
      status = 'failed';
    }
    return {
      status,
      providerRef: pi.id,
      amountMinor: pi.amount_received || pi.amount,
      failureCode: pi.last_payment_error?.code ?? undefined,
      failureReason: pi.last_payment_error?.message ?? undefined,
      raw: pi,
    };
  }
}