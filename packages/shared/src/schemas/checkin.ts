import { z } from 'zod';
import { checkinOutcomeSchema } from '../enums.js';

// A single scan. clientScanId is generated client-side and is what makes
// batch retries idempotent. scannedAt is the wall-clock time the scanner
// observed the QR — this is the value that decides "earliest wins", NOT the
// server receive time.
export const scanInputSchema = z.object({
  clientScanId: z.string().min(8).max(100),
  token: z.string().min(20).max(2000),
  deviceId: z.string().min(1).max(200),
  scannedAt: z.coerce.date(),
  gate: z.string().min(1).max(50).optional(),
  eventId: z.string().uuid().optional(),
});
export type ScanInput = z.infer<typeof scanInputSchema>;

export const checkinInputSchema = scanInputSchema.extend({
  clientScanId: z.string().min(8).max(100).default(() => crypto.randomUUID()),
});
export type CheckinInput = z.infer<typeof checkinInputSchema>;

export const syncInputSchema = z.object({
  scans: z.array(scanInputSchema).min(1).max(500),
});
export type SyncInput = z.infer<typeof syncInputSchema>;

export const scanResultSchema = z.object({
  clientScanId: z.string(),
  outcome: checkinOutcomeSchema,
  ticketId: z.string().uuid().nullable().optional(),
  shortCode: z.string().nullable().optional(),
  tierName: z.string().nullable().optional(),
  // Populated on 'duplicate': the winning scan's details.
  existingAt: z.string().nullable().optional(),
  existingGate: z.string().nullable().optional(),
  existingDeviceId: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
});
export type ScanResult = z.infer<typeof scanResultSchema>;

export const manifestTicketSchema = z.object({
  id: z.string().uuid(),
  shortCode: z.string(),
  tierName: z.string(),
  status: z.enum(['valid', 'checked_in', 'void']),
});
export type ManifestTicket = z.infer<typeof manifestTicketSchema>;

export const checkinManifestSchema = z.object({
  eventId: z.string().uuid(),
  eventName: z.string(),
  generatedAt: z.string(),
  signing: z.object({
    algorithm: z.literal('hmac-sha256'),
    kids: z.array(z.string()),
  }),
  tickets: z.array(manifestTicketSchema),
});
export type CheckinManifest = z.infer<typeof checkinManifestSchema>;

export const checkinStatsSchema = z.object({
  eventId: z.string().uuid(),
  total: z.number().int().nonnegative(),
  valid: z.number().int().nonnegative(),
  checkedIn: z.number().int().nonnegative(),
  voided: z.number().int().nonnegative(),
});
export type CheckinStats = z.infer<typeof checkinStatsSchema>;