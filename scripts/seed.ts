// scripts/seed.ts
//
// Creates 6 demo events owned by a dedicated seed organizer. Idempotent:
// rerunning skips events that already exist (matched by name). Designed to be
// safe to run any number of times.
//
// Requires the API to be running (npm run dev:api in another terminal). It
// talks to the API over HTTP so it exercises the real validation and
// state-machine paths — if the seed fails, the API is also broken.
//
// The "sold" backfill at the end updates ticket_tiers.sold directly, which
// is a shortcut: real sales create orders and tickets. For a demo it is
// enough to make the availability numbers look realistic. If you later run
// `npm test`, the truncate step wipes everything, and `npm run seed` restores
// it.
import 'dotenv/config';
import { Client } from 'pg';

const BASE = process.env.API_URL ?? 'http://localhost:3000';
const ORG_EMAIL = 'seed-org@demo.io';
const ORG_PASSWORD = 'seed-organizer-password-12';

interface TierSpec {
  name: string;
  priceMinor: number;
  capacity: number;
  perOrderMax: number;
  /** Tickets already sold. capacity - sold = available. */
  sold: number;
}

interface EventSpec {
  name: string;
  description: string;
  venue: string;
  daysFromNow: number;
  durationHours: number;
  tiers: TierSpec[];
}

const EVENTS: EventSpec[] = [
  {
    name: 'Nairobi Jazz Night',
    description:
      'An evening of contemporary jazz featuring the Nairobi Jazz Collective and special guests. Doors open at 6pm.',
    venue: 'KICC Amphitheatre',
    daysFromNow: 21,
    durationHours: 4,
    tiers: [
      { name: 'Early Bird', priceMinor: 200_000, capacity: 100, perOrderMax: 4, sold: 100 },
      { name: 'General',    priceMinor: 300_000, capacity: 200, perOrderMax: 6, sold: 185 },
      { name: 'VIP',        priceMinor: 600_000, capacity: 30,  perOrderMax: 2, sold: 25  },
    ],
  },
  {
    name: 'Afrobeats Live',
    description: 'The biggest Afrobeats names in East Africa, one stage, one night.',
    venue: 'Uhuru Gardens',
    daysFromNow: 14,
    durationHours: 5,
    tiers: [
      { name: 'GA',  priceMinor: 350_000, capacity: 500, perOrderMax: 10, sold: 120 },
      { name: 'VIP', priceMinor: 800_000, capacity: 50,  perOrderMax: 4,  sold: 30  },
    ],
  },
  {
    name: 'Startup Pitch Night',
    description:
      'Five early-stage founders pitch to a panel of investors and an audience of builders. Networking after.',
    venue: 'iHub, Ngong Road',
    daysFromNow: 7,
    durationHours: 3,
    tiers: [
      { name: 'Standard', priceMinor: 100_000, capacity: 80, perOrderMax: 3, sold: 40 },
      { name: 'Investor', priceMinor: 500_000, capacity: 20, perOrderMax: 2, sold: 15 },
    ],
  },
  {
    name: 'Comedy Store Nairobi',
    description: 'Stand-up from the city\u2019s sharpest comedians. Strictly 18+. Two-drink minimum.',
    venue: 'Carnivore Grounds',
    daysFromNow: 3,
    durationHours: 2,
    tiers: [
      { name: 'Regular', priceMinor: 250_000, capacity: 150, perOrderMax: 6, sold: 120 },
    ],
  },
  {
    name: 'Safari Photography Workshop',
    description:
      'A hands-on day in Karura Forest with wildlife photographers. Bring your own camera; lunch provided.',
    venue: 'Karura Forest',
    daysFromNow: 12,
    durationHours: 6,
    tiers: [
      { name: 'Workshop Pass', priceMinor: 450_000, capacity: 40, perOrderMax: 2, sold: 32 },
    ],
  },
  {
    name: 'Rooftop Sundowner',
    description:
      'Live DJs, cocktails, and the best view of the Nairobi skyline at sunset. Dress code: smart casual.',
    venue: 'Westlands Rooftop',
    daysFromNow: 1,
    durationHours: 4,
    tiers: [
      { name: 'Early Access', priceMinor: 150_000, capacity: 60,  perOrderMax: 4, sold: 60 },
      { name: 'GA',           priceMinor: 200_000, capacity: 120, perOrderMax: 6, sold: 60 },
    ],
  },
];

async function http<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  // Only declare a JSON content-type when we actually send a JSON body.
  // Fastify (and most servers) reject "content-type: application/json" with
  // an empty body as a 400 VALIDATION_ERROR. Endpoints like
  // POST /events/:id/publish take no body at all — their route signature is
  // `async (req) => ...` without `req.body` — so we must not pretend we are
  // sending one.
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = parsed as { error?: { code?: string; message?: string } } | null;
    throw new Error(
      `${method} ${path} \u2192 ${res.status} ${err?.error?.code ?? ''}: ${err?.error?.message ?? text}`,
    );
  }
  return parsed as T;
}

async function getOrganizerToken(): Promise<string> {
  // Try register first. On conflict, log in. Any other failure rethrows — we
  // do not want to silently swallow "database down" as "account exists".
  try {
    const res = await http<{ accessToken: string }>('POST', '/auth/register', {
      email: ORG_EMAIL,
      password: ORG_PASSWORD,
      displayName: 'Seed Organizer',
      role: 'organizer',
    });
    console.log(`\u2713 registered ${ORG_EMAIL}`);
    return res.accessToken;
  } catch (err) {
    const msg = (err as Error).message;
    if (!msg.includes('409') && !msg.includes('CONFLICT')) throw err;
    const res = await http<{ accessToken: string }>('POST', '/auth/login', {
      email: ORG_EMAIL,
      password: ORG_PASSWORD,
    });
    console.log(`\u2713 logged in as ${ORG_EMAIL}`);
    return res.accessToken;
  }
}

async function main(): Promise<void> {
  // Fail fast with a clear message if the API isn't running.
  try {
    await fetch(`${BASE}/health`);
  } catch {
    throw new Error(
      `API not reachable at ${BASE}. Start it with: npm run dev:api`,
    );
  }

  const token = await getOrganizerToken();

  // Existing events owned by the seed organizer — used for idempotency.
  const existing = await http<{ events: Array<{ id: string; name: string; status: string }> }>(
    'GET',
    '/organizer/events',
    undefined,
    token,
  );
  const existingByName = new Map(existing.events.map((e) => [e.name, e]));

  // Direct DB connection only for the `sold` backfill. Every other write
  // goes through the API.
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is required for the sold backfill');
  const db = new Client({ connectionString: dbUrl });
  await db.connect();

  try {
    for (const spec of EVENTS) {
      const prior = existingByName.get(spec.name);

      // If an event with this name exists but is still in draft (e.g. a
      // previous seed run failed at the publish step), publish it now and
      // backfill its `sold` counts. Otherwise skip it entirely.
      if (prior) {
        if (prior.status === 'draft') {
          console.log(`\u21bb repairing ${spec.name}  (found in draft; publishing)`);
          await http('POST', `/events/${prior.id}/publish`, undefined, token);
          // Re-read tiers so we can backfill sold for the expected tier names.
          const detail = await http<{
            event: { tiers: Array<{ id: string; name: string }> };
          }>('GET', `/events/${prior.id}`);
          for (const tier of spec.tiers) {
            const found = detail.event.tiers.find((t) => t.name === tier.name);
            if (found && tier.sold > 0) {
              await db.query('UPDATE ticket_tiers SET sold = $1 WHERE id = $2', [
                tier.sold,
                found.id,
              ]);
            }
          }
          const totalAvailable = spec.tiers.reduce(
            (n, t) => n + (t.capacity - t.sold),
            0,
          );
          console.log(`\u2713 repaired ${spec.name}  (${totalAvailable} tickets available)`);
          continue;
        }
        console.log(`= skip     ${spec.name}  (already exists)`);
        continue;
      }

      const now = Date.now();
      const startsAt = new Date(now + spec.daysFromNow * 86_400_000).toISOString();
      const endsAt = new Date(
        now + spec.daysFromNow * 86_400_000 + spec.durationHours * 3_600_000,
      ).toISOString();

      const { event } = await http<{ event: { id: string } }>(
        'POST',
        '/events',
        {
          name: spec.name,
          description: spec.description,
          venue: spec.venue,
          startsAt,
          endsAt,
        },
        token,
      );

      const tierIds: Array<{ id: string; sold: number }> = [];
      for (const tier of spec.tiers) {
        const { tier: created } = await http<{ tier: { id: string } }>(
          'POST',
          `/events/${event.id}/tiers`,
          {
            name: tier.name,
            priceMinor: tier.priceMinor,
            currency: 'KES',
            capacity: tier.capacity,
            perOrderMax: tier.perOrderMax,
            salesStart: new Date(now - 3_600_000).toISOString(),
            salesEnd: new Date(now + spec.daysFromNow * 86_400_000).toISOString(),
          },
          token,
        );
        tierIds.push({ id: created.id, sold: tier.sold });
      }

      await http('POST', `/events/${event.id}/publish`, undefined, token);

      for (const t of tierIds) {
        if (t.sold > 0) {
          await db.query('UPDATE ticket_tiers SET sold = $1 WHERE id = $2', [
            t.sold,
            t.id,
          ]);
        }
      }

      const totalAvailable = spec.tiers.reduce(
        (n, t) => n + (t.capacity - t.sold),
        0,
      );
      console.log(
        `\u2713 created  ${spec.name}  (${totalAvailable} tickets available)`,
      );
    }
  } finally {
    await db.end();
  }

  // Final summary from the public catalog.
  const list = await http<{
    events: Array<{ name: string; tiers: Array<{ available: number }> }>;
  }>('GET', '/events');

  console.log('');
  console.log(`Public catalog now has ${list.events.length} event(s):`);
  for (const e of list.events) {
    const available = e.tiers.reduce((n, t) => n + t.available, 0);
    console.log(`  \u00b7 ${e.name}  \u2014  ${available} available`);
  }
  console.log('');
  console.log('Open http://localhost:5173/ to see them.');
}

main().catch((err) => {
  console.error('\u2716 seed failed');
  console.error(err);
  process.exit(1);
});