import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config, pgPort } from '../config';
import { TenantContext } from '../registry/types';

interface PoolEntry {
  pool: Pool;
  lastUsed: number;
}

/**
 * Per-tenant connection pools, keyed by (instance, database).
 *
 * This is the concrete version of the base doc §8.3 pseudocode
 * (TenantPoolManager), extended for multiple Cloud SQL instances. Each tenant
 * DB gets its own small pool, created lazily and evicted when idle so that
 * inactive schools don't hold connections.
 *
 * Connection budget (per instance):  peak = tenants x poolSize x replicas
 * poolSize is kept small (config.pool.size, default 2) on purpose.
 */
export class TenantPoolManager {
  private pools = new Map<string, PoolEntry>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.sweepTimer = setInterval(
      () => this.evictIdle(),
      config.pool.evictSweepMs,
    );
    this.sweepTimer.unref?.();
  }

  private key(ctx: TenantContext): string {
    // instance + db uniquely identifies a physical database in the fleet.
    return `${ctx.instance.id}:${ctx.tenant.dbName}`;
  }

  private getOrCreate(ctx: TenantContext): Pool {
    const key = this.key(ctx);
    const existing = this.pools.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.pool;
    }

    const pool = new Pool({
      host: config.tenantDb.host, // 127.0.0.1 (Cloud SQL Proxy sidecar)
      port: pgPort(config.tenantDb.host, ctx.instance.proxyPort), // socket-aware
      database: ctx.tenant.dbName,
      user: config.tenantDb.user,
      password: config.tenantDb.password,
      max: config.pool.size,
      idleTimeoutMillis: config.pool.idleTimeoutMs,
      connectionTimeoutMillis: config.pool.connectionTimeoutMs,
    });

    // A pool-level error (e.g. backend terminated) must not crash the process.
    pool.on('error', (err) => {
      console.error(`[tenantPool] idle client error on ${key}:`, err.message);
    });

    this.pools.set(key, { pool, lastUsed: Date.now() });
    return pool;
  }

  /**
   * Run a query against a tenant's database. Acquire + release is handled for
   * you — this is the normal entry point for services.
   */
  async query<T extends QueryResultRow = QueryResultRow>(
    ctx: TenantContext,
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    const pool = this.getOrCreate(ctx);
    return pool.query<T>(text, params);
  }

  /**
   * Check out a client for a multi-statement transaction. Caller MUST release.
   *   const client = await mgr.acquire(ctx);
   *   try { await client.query('BEGIN'); ...; await client.query('COMMIT'); }
   *   finally { client.release(); }
   */
  async acquire(ctx: TenantContext): Promise<PoolClient> {
    const pool = this.getOrCreate(ctx);
    return pool.connect();
  }

  /** Convenience wrapper that runs fn inside a transaction. */
  async withTransaction<R>(
    ctx: TenantContext,
    fn: (client: PoolClient) => Promise<R>,
  ): Promise<R> {
    const client = await this.acquire(ctx);
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Tear down pools with no traffic for poolEvictAfterMs. */
  private evictIdle(): void {
    const cutoff = Date.now() - config.pool.poolEvictAfterMs;
    for (const [key, entry] of this.pools) {
      if (entry.lastUsed < cutoff) {
        this.pools.delete(key);
        entry.pool.end().catch((err) => {
          console.error(`[tenantPool] error closing ${key}:`, err.message);
        });
      }
    }
  }

  /** Live pool count — useful for a /metrics or /healthz endpoint. */
  get activePoolCount(): number {
    return this.pools.size;
  }

  /** Best-effort total connections currently held across all tenant pools. */
  get totalConnections(): number {
    let total = 0;
    for (const { pool } of this.pools.values()) total += pool.totalCount;
    return total;
  }

  async closeAll(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    const ends = Array.from(this.pools.values()).map((e) => e.pool.end());
    this.pools.clear();
    await Promise.allSettled(ends);
  }
}
