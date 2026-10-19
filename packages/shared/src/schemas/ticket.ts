import { z } from 'zod';
import { ticketStatusSchema } from '../enums.js';

export const ticketViewSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  orderId: z.string().uuid(),
  tierId: z.string().uuid(),
  tierName: z.string(),
  eventName: z.string(),
  eventStartsAt: z.string(),
  shortCode: z.string(),
  status: ticketStatusSchema,
  // The buyer owns this ticket; exposing the payload is fine and lets them
  // render their own QR if they prefer a third-party app.
  qrPayload: z.string(),
  checkedInAt: z.string().nullable(),
  voidedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type TicketView = z.infer<typeof ticketViewSchema>;

export const voidTicketInputSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type VoidTicketInput = z.infer<typeof voidTicketInputSchema>;