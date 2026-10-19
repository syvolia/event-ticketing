// scripts/migrate.ts
// Plain-SQL migration runner. Each file is applied inside a single transaction
// unless it opts out with the directive `-- migrate:no-transaction` on the
// first line (needed for ALTER TYPE ... ADD VALUE, which cannot run in a
// transaction block on some Postgres versions). Files are recorded in
// schema_migrations with a checksum; editing an applied file is a hard error.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import 'dotenv/config';

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations');
const STATUS_ONLY = process.argv.includes('--status');
const NO_TX_DIRECTIVE = '-- migrate:no-transaction';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function isNoTx(sql: string): boolean {
  // Only look at the first ~200 chars so an accidental mention in a comment
  // body does not flip a migration into non-transactional mode.
  return sql.slice(0, 200).includes(NO_TX_DIRECTIVE);
}

async function ensureMigrationsTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function loadApplied(
  client: Client,
): Promise<Map<string, { checksum: string; appliedAt: Date }>> {
  const { rows } = await client.query<{ name: string; checksum: string; applied_at: Date }>(
    'SELECT name, checksum, applied_at FROM schema_migrations',
  );
  const m = new Map<string, { checksum: string; appliedAt: Date }>();
  for (const r of rows) m.set(r.name, { checksum: r.checksum, appliedAt: r.applied_at });
  return m;
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await loadApplied(client);
    const files = await listMigrationFiles();

    if (STATUS_ONLY) {
      for (const file of files) {
        const rec = applied.get(file);
        const state = rec ? `applied ${rec.appliedAt.toISOString()}` : 'PENDING';
        console.log(`${file.padEnd(48)}  ${state}`);
      }
      return;
    }

    let appliedCount = 0;
    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = sha256(sql);
      const existing = applied.get(file);

      if (existing) {
        if (existing.checksum !== checksum) {
          throw new Error(
            `Migration ${file} checksum mismatch. Was it edited after being applied? ` +
              `expected=${existing.checksum} got=${checksum}`,
          );
        }
        continue;
      }

      const noTx = isNoTx(sql);
      console.log(`▶ applying ${file}${noTx ? ' (no transaction)' : ''}`);
      if (!noTx) await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [file, checksum],
        );
        if (!noTx) await client.query('COMMIT');
        appliedCount += 1;
      } catch (err) {
        if (!noTx) await client.query('ROLLBACK');
        throw err;
      }
    }

    console.log(
      appliedCount === 0
        ? '✔ no pending migrations'
        : `✔ applied ${appliedCount} migration(s)`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('✖ migration failed');
  console.error(err);
  process.exit(1);
});