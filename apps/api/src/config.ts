// Config is parsed once at boot. Bad env → process exits before we accept
// traffic. Path to .env is anchored to the monorepo root so cwd differences
// between `npm run dev` and `npm test` cannot send us looking in the wrong
// place.
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
// here = apps/api/src  (dev)  or  apps/api/dist  (build)
loadEnv({ path: resolve(here, '../../../.env') });

// Boolean-ish env parser. Zod's `z.coerce.boolean()` treats any non-empty
// string as true — including the literal string "false". This enum-based
// parser is unambiguous and rejects typos at boot.
const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .default('true')
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65_535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((s) => /^postgres(ql)?:\/\//.test(s), 'DATABASE_URL must be a postgres:// URL'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),

  // Reservation TTL and inventory implementation switch.
  RESERVATION_TTL_MINUTES: z.coerce.number().int().positive().max(120).default(10),
  INVENTORY_IMPL: z.enum(['conditional', 'for-update']).default('conditional'),

  // Production hardening.
  PG_POOL_MAX: z.coerce.number().int().positive().max(100).default(20),
  RATE_LIMIT_ENABLED: booleanish,
  // Bearer token required to read /metrics when NODE_ENV=production. Empty
  // in dev (metrics are open); in production the deploy sets this and the
  // scrape config injects it.
  METRICS_TOKEN: z.string().default(''),

  // M-Pesa Daraja.
  MPESA_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  MPESA_CONSUMER_KEY: z.string().default(''),
  MPESA_CONSUMER_SECRET: z.string().default(''),
  MPESA_SHORTCODE: z.string().default('174379'),
  MPESA_PASSKEY: z.string().default(''),
  MPESA_CALLBACK_URL: z.string().default(''),

  // Stripe.
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),

  // Email.
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_FROM: z.string().default('Ticketing <noreply@ticketing.local>'),

  // Public URLs. PUBLIC_APP_URL is comma-separated to support multiple
  // origins (web + scanner) in production CORS.
  PUBLIC_API_URL: z.string().default('http://localhost:3000'),
  PUBLIC_APP_URL: z.string().default('http://localhost:5173'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const config = parsed.data;
export type Config = typeof config;