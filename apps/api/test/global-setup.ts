// Runs once before any test file: recreates a pristine `ticketing_test`
// database and applies every migration in order. No mocks; tests hit a real
// Postgres instance.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../../../migrations');

const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ??
  'postgres://ticketing:ticketing@localhost:5432/postgres';
const TEST_DB = 'ticketing_test';
const TEST_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`);

export default async function setup(): Promise<void> {
  // 1. Drop & recreate the test database.
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DB],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }

  // 2. Apply migrations against the test database, exactly as the runtime
  //    migration runner does. `schema_migrations` is created here so a test
  //    run and a dev run share the same bookkeeping shape.
  const client = new Client({ connectionString: TEST_URL });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [file, 'test-checksum'],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}