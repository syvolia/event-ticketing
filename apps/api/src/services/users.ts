// User-facing authentication service. All DB writes go through
// withTransaction() so a lost connection mid-insert cannot leave a
// half-committed row behind.
import type { UserRole } from '@ticketing/shared';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { conflict } from '../errors.js';

export interface UserRecord {
  id: string;
  email: string;
  role: UserRole;
  displayName: string;
  phone: string | null;
}

interface DbUserRow {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  display_name: string;
  phone: string | null;
}

// Pre-computed at module load. Used to make an unknown-email login take the
// same CPU time as a known-email one, so timing cannot reveal which accounts
// exist. Top-level await is fine in ESM.
const DUMMY_HASH = await hashPassword('__timing_dummy_never_matches__');

function toUser(row: DbUserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    displayName: row.display_name,
    phone: row.phone,
  };
}

export interface CreateUserInput {
  email: string;
  password: string;
  displayName: string;
  role: UserRole;
  // Explicitly typed as `string | undefined` because callers pass the output
  // of a Zod `.optional()` field, which under exactOptionalPropertyTypes
  // does not unify with `?: string`.
  phone?: string | undefined;
}

export async function createUser(input: CreateUserInput): Promise<UserRecord> {
  // Hash BEFORE the transaction. Argon2 is CPU-bound and can take tens of ms;
  // holding a DB transaction open during it needlessly occupies a connection.
  const passwordHash = await hashPassword(input.password);

  return withTransaction(
    async (client) => {
      try {
        const { rows } = await client.query<DbUserRow>(
          `INSERT INTO users (email, password_hash, role, display_name, phone)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, email, password_hash, role, display_name, phone`,
          [input.email, passwordHash, input.role, input.displayName, input.phone ?? null],
        );
        return toUser(rows[0]!);
      } catch (err) {
        // The DB's UNIQUE on users.email is the arbiter. Two concurrent
        // registrations for the same email resolve deterministically: the
        // loser gets a unique_violation which we map to a 409. No TOCTOU gap.
        const e = err as { code?: string; constraint?: string };
        if (e.code === '23505' && e.constraint === 'users_email_key') {
          throw conflict('An account with that email already exists');
        }
        throw err;
      }
    },
    { label: 'createUser' },
  );
}

export async function authenticate(email: string, password: string): Promise<UserRecord | null> {
  const { rows } = await pool.query<DbUserRow>(
    `SELECT id, email, password_hash, role, display_name, phone
     FROM users WHERE email = $1`,
    [email],
  );
  const row = rows[0];
  if (!row) {
    // Equalize timing with the success path. We do not care about the result.
    await verifyPassword(DUMMY_HASH, password);
    return null;
  }
  const ok = await verifyPassword(row.password_hash, password);
  if (!ok) return null;
  return toUser(row);
}

export async function getUserById(id: string): Promise<UserRecord | null> {
  const { rows } = await pool.query<DbUserRow>(
    `SELECT id, email, password_hash, role, display_name, phone
     FROM users WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? toUser(row) : null;
}