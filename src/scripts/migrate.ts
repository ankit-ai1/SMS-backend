/**
 * Schema migrator — the deployable replacement for the docker initdb mount,
 * which only ever runs against an empty data directory and so never runs on
 * Cloud SQL at all.
 *
 * Applies, in order:
 *   1. src/sql/registry_schema.sql to the registry DB (idempotent, IF NOT EXISTS)
 *   2. every migrations/NNN_*.sql to each active tenant DB, skipping the ones
 *      already recorded in that DB's schema_migrations table
 *
 * Run it as a Cloud Run Job (same image, different command) before or after a
 * deploy:  node dist/scripts/migrate.js
 *
 * Safe to re-run: MigrationRunner records each applied version per database.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { config, pgPort } from '../config';
import { RegistryClient } from '../registry/registryClient';
import { AdminPools } from '../provisioning/adminPools';
import { MigrationRunner } from '../provisioning/migrations';

async function applyRegistrySchema(): Promise<void> {
  const sql = readFileSync(path.resolve('./src/sql/registry_schema.sql'), 'utf8');
  const pool = new Pool({
    host: config.registry.host,
    port: pgPort(config.registry.host, config.registry.port),
    database: config.registry.database,
    user: config.registry.user,
    password: config.registry.password,
    max: 1,
  });
  try {
    await pool.query(sql);
    console.log(`[migrate] registry schema applied to ${config.registry.database}`);
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  await applyRegistrySchema();

  const registry = new RegistryClient();
  const admin = new AdminPools();
  const runner = new MigrationRunner(admin);
  let failures = 0;
  try {
    const contexts = await registry.loadAllActiveContexts();
    if (contexts.length === 0) {
      console.log('[migrate] no active tenants yet — registry schema only');
    }
    for (const ctx of contexts) {
      try {
        const applied = await runner.migrateDatabase(ctx.instance, ctx.tenant.dbName);
        console.log(
          applied.length
            ? `[migrate] ${ctx.tenant.slug} (${ctx.tenant.dbName}): ${applied.join(', ')}`
            : `[migrate] ${ctx.tenant.slug} (${ctx.tenant.dbName}): already up to date`,
        );
      } catch (err) {
        failures++;
        console.error(`[migrate] ${ctx.tenant.slug} FAILED:`, err);
      }
    }
  } finally {
    await admin.closeAll();
    await registry.close();
  }
  if (failures) throw new Error(`${failures} tenant database(s) failed to migrate`);
  console.log('[migrate] done');
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
