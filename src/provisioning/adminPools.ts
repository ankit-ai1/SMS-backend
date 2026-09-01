import { Pool } from 'pg';
import { config, pgPort } from '../config';
import { DbInstance } from '../registry/types';

/**
 * Admin connections used only for provisioning work: CREATE DATABASE, and the
 * first connection into a brand-new tenant DB to apply its schema.
 *
 * These connect to the registry/maintenance database ("tenant_registry"), not to a
 * tenant DB, because CREATE DATABASE cannot run while connected to the DB being
 * created and cannot run inside a transaction.
 */
export class AdminPools {
  private pools = new Map<string, Pool>();

  private maintenancePool(instance: DbInstance): Pool {
    const existing = this.pools.get(instance.id);
    if (existing) return existing;
    const pool = new Pool({
      host: config.tenantDb.host,
      port: pgPort(config.tenantDb.host, instance.proxyPort),
      database: 'tenant_registry', // maintenance DB
      user: config.tenantDb.user,
      password: config.tenantDb.password,
      max: 2,
      idleTimeoutMillis: 30_000,
    });
    pool.on('error', (err) =>
      console.error(`[adminPool] ${instance.name}:`, err.message),
    );
    this.pools.set(instance.id, pool);
    return pool;
  }

  /** A one-off pool bound to a specific (already created) database. */
  poolForDatabase(instance: DbInstance, dbName: string): Pool {
    return new Pool({
      host: config.tenantDb.host,
      port: pgPort(config.tenantDb.host, instance.proxyPort),
      database: dbName,
      user: config.tenantDb.user,
      password: config.tenantDb.password,
      max: 1,
      idleTimeoutMillis: 10_000,
    });
  }

  /**
   * CREATE DATABASE <name>. dbName is validated by the caller and quoted as an
   * identifier — never interpolate user text unquoted.
   */
  async createDatabase(instance: DbInstance, dbName: string): Promise<void> {
    const pool = this.maintenancePool(instance);
    await pool.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
  }

  async databaseExists(instance: DbInstance, dbName: string): Promise<boolean> {
    const pool = this.maintenancePool(instance);
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName],
    );
    return rows.length > 0;
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.pools.values()).map((p) => p.end()),
    );
    this.pools.clear();
  }
}

/** Double-quote a Postgres identifier, escaping embedded quotes. */
export function quoteIdent(ident: string): string {
  return '"' + ident.replace(/"/g, '""') + '"';
}
