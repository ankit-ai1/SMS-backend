import { promises as fs } from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { config } from '../config';
import { AdminPools } from './adminPools';
import { DbInstance } from '../registry/types';

/**
 * Applies ordered .sql migration files to a tenant database and records which
 * ones ran, in a schema_migrations table inside that same DB.
 *
 * This closes a gap in the base doc: it said "apply 001_schema_v1.sql then
 * 004_calendar_events.sql" and later "run schema migration on all tenant DBs",
 * but never tracked per-DB which migrations were already applied. Without that,
 * a fleet-wide migration cannot know where to resume.
 *
 * File naming convention:  NNN_description.sql  (e.g. 001_schema_v1.sql).
 * The numeric prefix defines apply order and is the recorded version.
 */
export class MigrationRunner {
  constructor(private admin: AdminPools) {}

  private async listMigrationFiles(): Promise<
    { version: string; name: string; fullPath: string }[]
  > {
    const dir = config.migrationsDir;
    const entries = await fs.readdir(dir);
    return entries
      .filter((f) => /^\d+.*\.sql$/i.test(f))
      .sort() // lexical sort works because of zero-padded numeric prefixes
      .map((name) => {
        const version = name.split('_')[0];
        return { version, name, fullPath: path.join(dir, name) };
      });
  }

  private async ensureMigrationsTable(pool: Pool): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     VARCHAR(20) PRIMARY KEY,
        name        VARCHAR(200) NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  private async appliedVersions(pool: Pool): Promise<Set<string>> {
    const { rows } = await pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations`,
    );
    return new Set(rows.map((r) => r.version));
  }

  /**
   * Bring a single tenant DB up to date. Returns the versions applied in this
   * run (empty if it was already current). Each file runs in its own
   * transaction; a failure aborts that file and leaves earlier files applied.
   */
  async migrateDatabase(
    instance: DbInstance,
    dbName: string,
  ): Promise<string[]> {
    const pool = this.admin.poolForDatabase(instance, dbName);
    const applied: string[] = [];
    try {
      await this.ensureMigrationsTable(pool);
      const done = await this.appliedVersions(pool);
      const files = await this.listMigrationFiles();

      for (const file of files) {
        if (done.has(file.version)) continue;
        const sql = await fs.readFile(file.fullPath, 'utf8');
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query(
            `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`,
            [file.version, file.name],
          );
          await client.query('COMMIT');
          applied.push(file.version);
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(
            `migration ${file.name} failed on ${dbName}: ${
              (err as Error).message
            }`,
          );
        } finally {
          client.release();
        }
      }
      return applied;
    } finally {
      await pool.end();
    }
  }
}
