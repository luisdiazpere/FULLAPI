import { readFile } from 'node:fs/promises';
import { pool } from './db.ts';

/**
 * db/*.sql only auto-runs via docker-entrypoint-initdb.d on a fresh local
 * container. A hosted Postgres (Render, etc.) has no such hook, so this runs
 * the same files by hand on boot. Idempotent: skips a file's table if it
 * already exists, so every later restart is a no-op. A migration that can't
 * be expressed as "skip if table exists" (e.g. a DROP) is marked alwaysRun
 * instead — its SQL must be IF EXISTS-guarded so re-running it is a no-op.
 */
const MIGRATIONS: ({ file: string } & ({ table: string; alwaysRun?: false } | { alwaysRun: true }))[] = [
  { file: 'db/init.sql', table: 'kits' },
  { file: 'db/002_orders.sql', table: 'orders' },
  { file: 'db/003_users.sql', table: 'sessions' },
  { file: 'db/004_drop_users_fk.sql', alwaysRun: true },
];

export async function runMigrations(): Promise<void> {
  for (const migration of MIGRATIONS) {
    if (!migration.alwaysRun) {
      const { rows } = await pool.query('SELECT to_regclass($1) AS exists', [migration.table]);
      if (rows[0].exists) continue;
    }
    await pool.query(await readFile(migration.file, 'utf8'));
  }
}
