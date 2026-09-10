import { readFile } from 'node:fs/promises';
import { pool } from './db.ts';

/**
 * db/*.sql only auto-runs via docker-entrypoint-initdb.d on a fresh local
 * container. A hosted Postgres (Render, etc.) has no such hook, so this runs
 * the same files by hand on boot. Idempotent: skips a file's table if it
 * already exists, so every later restart is a no-op.
 */
const MIGRATIONS: { file: string; table: string }[] = [
  { file: 'db/init.sql', table: 'kits' },
  { file: 'db/002_orders.sql', table: 'orders' },
];

export async function runMigrations(): Promise<void> {
  for (const { file, table } of MIGRATIONS) {
    const { rows } = await pool.query('SELECT to_regclass($1) AS exists', [table]);
    if (rows[0].exists) continue;
    await pool.query(await readFile(file, 'utf8'));
  }
}
