import { readFile } from 'node:fs/promises';
import pg from 'pg';

/**
 * db/*.sql only auto-runs via docker-entrypoint-initdb.d on a fresh local
 * container. Hosted Postgres (Render, etc.) has no such hook, so this runs
 * the same files by hand, once, as part of the build. Idempotent: skips a
 * file's table if it already exists, so redeploys are no-ops.
 */
const MIGRATIONS: { file: string; table: string }[] = [
  { file: 'db/init.sql', table: 'kits' },
  { file: 'db/002_orders.sql', table: 'orders' },
];

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

for (const { file, table } of MIGRATIONS) {
  const { rows } = await pool.query('SELECT to_regclass($1) AS exists', [table]);
  if (rows[0].exists) {
    console.log(`[migrate] ${table} already exists, skipping ${file}`);
    continue;
  }
  console.log(`[migrate] applying ${file}`);
  await pool.query(await readFile(file, 'utf8'));
}

await pool.end();
