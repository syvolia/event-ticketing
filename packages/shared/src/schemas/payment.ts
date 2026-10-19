import { z } from 'zod';
import { paymentProviderSchema } from '../enums.js';

// E.164: a leading `+`, a country code that cannot start with 0, then 6–14
// more digits. Same pattern the DB CHECK constraint enforces on
// `payments.phone` and `users.phone`, so an input that passes here cannot be
// rejected later at the DB layer.
export const E164_REGEX = /^\+[1-9][0-9]{6,14}$/;

// API contract for POST /orders/:id/pay.
export const startPaymentInputSchema = z.object({
  provider: paymentProviderSchema,
  // M-Pesa requires a phone number; Stripe ignores it. The API layer validates
  // presence for mpesa, and the DB's CHECK on payments.phone rejects malformed
  // E.164 even if a future code path skips the schema.
  phone: z.string().regex(E164_REGEX, 'Enter a phone like +254712345678').optional(),
});
export type StartPaymentInput = z.infer<typeof startPaymentInputSchema>;

// Client-side form schema for the checkout page. Only the phone is
// client-provided; price, quantities, and totals are server-owned.
export const checkoutFormSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(E164_REGEX, 'Enter a phone number like +254712345678'),
});
export type CheckoutForm = z.infer<typeof checkoutFormSchema>;

export const paymentViewSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  provider: paymentProviderSchema,
  status: z.string(),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  providerRef: z.string().nullable(),
  clientSecret: z.string().nullable(),
  failureCode: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
});
export type PaymentView = z.infer<typeof paymentViewSchema>;

// ---------------------------------------------------------------------------
// Raw webhook payload shapes — kept here so tests and future clients can
// reuse them.
// ---------------------------------------------------------------------------

export const mpesaStkCallbackItemSchema = z.object({
  Name: z.string(),
  Value: z.union([z.string(), z.number()]),
});

export const mpesaStkCallbackSchema = z.object({
  Body: z.object({
    stkCallback: z.object({
      MerchantRequestID: z.string(),
      CheckoutRequestID: z.string(),
      ResultCode: z.number().int(),
      ResultDesc: z.string(),
      CallbackMetadata: z
        .object({
          Item: z.array(mpesaStkCallbackItemSchema),
        })
        .optional(),
    }),
  }),
});
export type MpesaStkCallback = z.infer<typeof mpesaStkCallbackSchema>;