// A fake M-Pesa provider for tests. Implements the same PaymentProvider
// interface as the real one, so the service layer exercises the same code
// paths. Tests can drive initiate() and parseWebhook() deterministically.
import type {
  InitiatePaymentInput,
  InitiatePaymentResult,
  ParsedWebhook,
  PaymentProvider,
  QueryStatusResult,
  WebhookParseInput,
} from '../../src/payments/types.js';

export class FakeMpesaProvider implements PaymentProvider {
  readonly name = 'mpesa' as const;
  initiateCalls: InitiatePaymentInput[] = [];
  /** If set, initiate() rejects with this error. */
  initiateError: Error | null = null;
  /** If set, the next callback parsed by parseWebhook uses this payload. */
  nextCallback: ParsedWebhook | null = null;

  async initiate(input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    this.initiateCalls.push(input);
    if (this.initiateError) throw this.initiateError;
    return {
      providerRef: `ws_CO_TEST_${input.paymentId.slice(0, 8)}`,
      merchantRequestId: `MR_TEST_${input.paymentId.slice(0, 8)}`,
      status: 'initiated',
      rawRequest: input,
      rawResponse: { ResponseCode: '0' },
    };
  }

  parseWebhook(_input: WebhookParseInput): ParsedWebhook {
    if (!this.nextCallback) throw new Error('FakeMpesaProvider.nextCallback is not set');
    const cb = this.nextCallback;
    // Consume once so a test that fires two callbacks with different content
    // gets two different parses.
    return cb;
  }

  async queryStatus(input: { providerRef: string }): Promise<QueryStatusResult> {
    return { status: 'pending', providerRef: input.providerRef, raw: {} };
  }
}