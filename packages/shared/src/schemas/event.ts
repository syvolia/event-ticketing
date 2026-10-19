import { z } from 'zod';
import { eventStatusSchema } from '../enums.js';

export const currencySchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'currency must be ISO 4217 (uppercase)');

// ---------------------------------------------------------------------------
// Wire types — the JSON shapes the API returns and the frontend consumes.
// Dates are ISO strings on the wire (Fastify serializes Date to ISO); the
// API's internal representations may still use Date, but anything crossing
// the HTTP boundary is a string.
// ---------------------------------------------------------------------------

// A tier as seen by a buyer: includes live availability, which is computed
// in SQL (`capacity - sold - reserved`) so the client never has to guess.
export const tierWithAvailabilitySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  priceMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  capacity: z.number().int().positive(),
  perOrderMax: z.number().int().positive(),
  sold: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  salesStart: z.string(),
  salesEnd: z.string(),
});
export type TierWithAvailability = z.infer<typeof tierWithAvailabilitySchema>;

export const eventListItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  venue: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: eventStatusSchema,
  organizerUserId: z.string().uuid(),
});
export type EventListItem = z.infer<typeof eventListItemSchema>;

export const eventDetailSchema = eventListItemSchema.extend({
  tiers: z.array(tierWithAvailabilitySchema),
});
export type EventDetail = z.infer<typeof eventDetailSchema>;

// ---------------------------------------------------------------------------
// Inputs — what a client sends.
// ---------------------------------------------------------------------------

export const createEventInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(10_000).default(''),
    venue: z.string().trim().min(1).max(300),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
  })
  .refine((e) => e.endsAt > e.startsAt, {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });
export type CreateEventInput = z.infer<typeof createEventInputSchema>;

export const updateEventInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(10_000).optional(),
    venue: z.string().trim().min(1).max(300).optional(),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field must be provided',
  });
export type UpdateEventInput = z.infer<typeof updateEventInputSchema>;

export const createTierInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    // Server-side authoritative price. The client NEVER sends a total — only
    // the tier id + quantity — so price integrity is preserved end-to-end.
    priceMinor: z.number().int().nonnegative(),
    currency: currencySchema,
    capacity: z.number().int().positive(),
    perOrderMax: z.number().int().positive(),
    salesStart: z.coerce.date(),
    salesEnd: z.coerce.date(),
  })
  .refine((t) => t.salesEnd > t.salesStart, {
    message: 'salesEnd must be after salesStart',
    path: ['salesEnd'],
  })
  .refine((t) => t.perOrderMax <= t.capacity, {
    message: 'perOrderMax cannot exceed capacity',
    path: ['perOrderMax'],
  });
export type CreateTierInput = z.infer<typeof createTierInputSchema>;

export const updateTierInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    priceMinor: z.number().int().nonnegative().optional(),
    currency: currencySchema.optional(),
    capacity: z.number().int().positive().optional(),
    perOrderMax: z.number().int().positive().optional(),
    salesStart: z.coerce.date().optional(),
    salesEnd: z.coerce.date().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field must be provided',
  });
export type UpdateTierInput = z.infer<typeof updateTierInputSchema>;

export const eventStatusUpdateSchema = z.object({ status: eventStatusSchema });
export type EventStatusUpdate = z.infer<typeof eventStatusUpdateSchema>;