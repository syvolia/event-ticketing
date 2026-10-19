// Provider registry. Constructed once at module load; providers are stateless
// enough that a single instance per process is correct. Providers that need
// credentials validate them at construction, so a misconfigured provider fails
// at boot, not on the first request.
import type { PaymentProvider as PaymentProviderName } from '@ticketing/shared';
import type { PaymentProvider } from './types.js';
import { MpesaProvider } from './mpesa.js';
import { StripeProvider } from './stripe.js';
import { config } from '../config.js';

const providers = new Map<PaymentProviderName, PaymentProvider>();

// Lazy construction so a test that only exercises M-Pesa does not need Stripe
// credentials present, and vice versa.
export function getProvider(name: PaymentProviderName): PaymentProvider {
  const existing = providers.get(name);
  if (existing) return existing;
  let provider: PaymentProvider;
  if (name === 'mpesa') provider = new MpesaProvider();
  else if (name === 'stripe') provider = new StripeProvider();
  else throw new Error(`Unknown payment provider: ${String(name)}`);
  providers.set(name, provider);
  return provider;
}

/** Test helper — replaces the registry entry for the duration of a suite. */
export function _setProviderForTests(name: PaymentProviderName, provider: PaymentProvider): void {
  providers.set(name, provider);
}

export function _resetProvidersForTests(): void {
  providers.clear();
}

export function enabledProviders(): PaymentProviderName[] {
  const out: PaymentProviderName[] = ['mpesa'];
  if (config.STRIPE_SECRET_KEY) out.push('stripe');
  return out;
}