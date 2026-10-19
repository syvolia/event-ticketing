import { z } from 'zod';

export const checkoutLineSchema = z.object({
  tierId: z.string().uuid(),
  quantity: z.number().int().positive().max(50),
});
export type CheckoutLine = z.infer<typeof checkoutLineSchema>;

export const createOrderInputSchema = z
  .object({
    eventId: z.string().uuid(),
    items: z.array(checkoutLineSchema).min(1).max(20),
  })
  .refine((v) => new Set(v.items.map((i) => i.tierId)).size === v.items.length, {
    message: 'duplicate tierId in items',
    path: ['items'],
  });
export type CreateOrderInput = z.infer<typeof createOrderInputSchema>;

// Same validation the API applies to the `Idempotency-Key` header.
export const idempotencyKeySchema = z.string().min(8).max(200);
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

// The latest payment attached to an order, as returned by the API. The buyer
// flow uses this to distinguish "waiting on the user" from "payment failed".
// Null when the buyer has not started a payment yet.
export const latestPaymentViewSchema = z.object({
  id: z.string().uuid(),
  provider: z.enum(['mpesa', 'stripe']),
  status: z.enum(['initiated', 'pending', 'succeeded', 'failed', 'refunded']),
  failureCode: z.string().nullable(),
  failureReason: z.string().nullable(),
});
export type LatestPaymentView = z.infer<typeof latestPaymentViewSchema>;

export const orderItemViewSchema = z.object({
  tierId: z.string().uuid(),
  tierName: z.string(),
  quantity: z.number().int().positive(),
  unitPriceMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  lineTotalMinor: z.number().int().nonnegative(),
});
export type OrderItemView = z.infer<typeof orderItemViewSchema>;

export const orderViewSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  status: z.string(),
  currency: z.string().length(3),
  subtotalMinor: z.number().int().nonnegative(),
  totalMinor: z.number().int().nonnegative(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  latestPayment: latestPaymentViewSchema.nullable(),
  items: z.array(orderItemViewSchema),
});
export type OrderView = z.infer<typeof orderViewSchema>;

export const scanTicketInputSchema = z.object({
  qrToken: z.string().min(20).max(500),
});
export type ScanTicketInput = z.infer<typeof scanTicketInputSchema>;