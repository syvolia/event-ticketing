// Signing-key store. One active key, N retired keys.
//
// Keys are loaded from the DB on demand and cached for 30 seconds. The cache
// means ticket issuance and verification do not hit the DB on the hot path.
// Rotation is a two-statement transaction: retire the current, insert the new.
// Verification looks up any key by kid (active or retired) so previously
// issued tickets keep working.
import { randomBytes, randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';

export interface SigningKey {
  kid: string;
  secret: Buffer;
  isActive: boolean;
}

interface Cache {
  byKid: Map<string, SigningKey>;
  active: SigningKey | null;
  loadedAt: number;
}

const CACHE_TTL_MS = 30_000;
let cache: Cache | null = null;

function newKid(): string {
  // k_YYYYMMDD_<8 hex>. Human-readable, sortable by date, unambiguous across
  // rotations within the same day.
  const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `k_${yyyymmdd}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

async function loadFromDb(force: boolean): Promise<Cache> {
  const now = Date.now();
  if (!force && cache && now - cache.loadedAt < CACHE_TTL_MS) return cache;

  const { rows } = await pool.query<{ kid: string; secret: Buffer; is_active: boolean }>(
    `SELECT kid, secret, is_active FROM qr_signing_keys`,
  );
  const byKid = new Map<string, SigningKey>();
  let active: SigningKey | null = null;
  for (const r of rows) {
    const k: SigningKey = { kid: r.kid, secret: r.secret, isActive: r.is_active };
    byKid.set(k.kid, k);
    if (k.isActive) active = k;
  }
  cache = { byKid, active, loadedAt: now };
  return cache;
}

export function _resetKeysCacheForTests(): void {
  cache = null;
}

/**
 * Return the key new tokens should be signed with. If no key exists yet, this
 * creates one. Safe to call from any path — first call in a fresh DB
 * bootstraps; subsequent calls are a cache hit.
 */
export async function getActiveKey(): Promise<SigningKey> {
  const c = await loadFromDb(false);
  if (c.active) return c.active;
  return ensureActiveSigningKey();
}

export async function ensureActiveSigningKey(): Promise<SigningKey> {
  const { rows } = await pool.query<{ kid: string; secret: Buffer }>(
    `SELECT kid, secret FROM qr_signing_keys WHERE is_active LIMIT 1`,
  );
  if (rows[0]) {
    const c = await loadFromDb(true);
    if (c.active) return c.active;
    return { kid: rows[0].kid, secret: rows[0].secret, isActive: true };
  }

  const kid = newKid();
  const secret = randomBytes(32);
  // ON CONFLICT (kid) DO NOTHING: if two processes race to create the first
  // key, only one insert wins, and the loser re-reads via getActiveKey below.
  await pool.query(
    `INSERT INTO qr_signing_keys (kid, secret, is_active) VALUES ($1, $2, true)
     ON CONFLICT (kid) DO NOTHING`,
    [kid, secret],
  );
  cache = null;
  return getActiveKey();
}

/**
 * Rotate. Retires the currently active key (kept in the table so existing
 * tickets still verify), inserts a new one, marks it active. Returns the new
 * active key.
 */
export async function rotateSigningKey(): Promise<SigningKey> {
  const newKey = { kid: newKid(), secret: randomBytes(32) };
  const result = await withTransaction(
    async (client) => {
      // Retire first so the partial unique index permits the new active row.
      await client.query(
        `UPDATE qr_signing_keys SET is_active = false, retired_at = now()
          WHERE is_active = true`,
      );
      await client.query(
        `INSERT INTO qr_signing_keys (kid, secret, is_active) VALUES ($1, $2, true)`,
        [newKey.kid, newKey.secret],
      );
    },
    { label: 'rotateSigningKey' },
  );
  cache = null;
  return { kid: newKey.kid, secret: newKey.secret, isActive: true };
}

/**
 * All keys, active or retired, keyed by kid. Used at verify time so tokens
 * issued under a previous key continue to work after rotation.
 */
export async function getKeysByKid(): Promise<Map<string, Buffer>> {
  const c = await loadFromDb(false);
  const m = new Map<string, Buffer>();
  for (const [kid, k] of c.byKid) m.set(kid, k.secret);
  return m;
}