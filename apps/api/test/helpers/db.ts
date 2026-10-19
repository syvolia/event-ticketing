import { pool } from '../../src/db/pool.js';

export async function truncateAll(): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename
       FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  await pool.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}