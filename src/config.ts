/**
 * Runtime configuration.
 *
 * In production these come from environment variables that GKE injects from
 * Secret Manager / ConfigMaps (see architecture doc §GCP: Secret Manager).
 * Nothing sensitive is hard-coded here.
 */

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name} is not a number: ${raw}`);
  return n;
}

function str(name: string, fallback?: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required env: ${name}`);
  }
  return raw;
}

export const config = {
  /** The central registry database (tenant_registry). */
  registry: {
    host: str('REGISTRY_DB_HOST', '127.0.0.1'),
    port: int('REGISTRY_DB_PORT', 5432),
    database: str('REGISTRY_DB_NAME', 'tenant_registry'),
    user: str('REGISTRY_DB_USER', 'school_mgmt_app'),
    password: str('REGISTRY_DB_PASSWORD', 'changeme'),
    max: int('REGISTRY_DB_POOL_SIZE', 5),
  },

  /**
   * Credentials used to connect to every TENANT database. All tenant DBs on
   * every instance share the same app role (per doc §8.3: user
   * 'school_mgmt_app'). The Cloud SQL Proxy sidecar handles TLS + IAM; the app
   * connects to 127.0.0.1 at each instance's local proxy port.
   */
  tenantDb: {
    host: str('TENANT_DB_HOST', '127.0.0.1'), // Cloud SQL Proxy sidecar
    user: str('TENANT_DB_USER', 'school_mgmt_app'),
    password: str('TENANT_DB_PASSWORD', 'changeme'),
  },

  /**
   * Per-tenant pool sizing. Kept deliberately small because with
   * database-per-tenant the connection budget is:
   *   peak = tenants_on_instance x poolSize x replicas
   * A small poolSize (2) + idle eviction lets ~25 tenants share one Cloud SQL
   * instance safely. See instanceRouter.ts for the capacity cap.
   */
  pool: {
    size: int('TENANT_POOL_SIZE', 2),
    idleTimeoutMs: int('TENANT_POOL_IDLE_MS', 300_000), // 5 min
    connectionTimeoutMs: int('TENANT_POOL_CONN_TIMEOUT_MS', 5_000),
    /** A whole tenant pool with no traffic for this long is torn down. */
    poolEvictAfterMs: int('TENANT_POOL_EVICT_MS', 600_000), // 10 min
    evictSweepMs: int('TENANT_POOL_EVICT_SWEEP_MS', 60_000), // sweep every 60s
  },

  /** Registry cache refresh interval (doc §8.3: refreshed every 60 seconds). */
  registryCacheRefreshMs: int('REGISTRY_CACHE_REFRESH_MS', 60_000),

  /** Directory holding ordered tenant-DB migration files (001_*.sql, 004_*.sql). */
  migrationsDir: str('TENANT_MIGRATIONS_DIR', './migrations'),

  /**
   * Root for uploaded student documents. Keys stored in the DB are relative to
   * this, so pointing the app at a GCS bucket later needs no data change.
   */
  documentsDir: str('DOCUMENTS_DIR', './var/documents'),

  /**
   * Timezone the school runs on. Used wherever 'today' has to mean the same
   * day to a user as it does to the query — the container clock is UTC.
   */
  schoolTimezone: str('SCHOOL_TIMEZONE', 'Asia/Kolkata'),

  /** 'local' (disk, dev) or 'gcs' (bucket, Cloud Run — uses the runtime SA). */
  storageDriver: str('STORAGE_DRIVER', 'local'),
  gcsBucket: str('GCS_BUCKET', ''),

  /**
   * Browser origins allowed to call this API. Comma-separated; "*" allows any.
   * The frontend runs on its own origin, so this must name it in production.
   */
  corsOrigins: str('CORS_ORIGINS', '*')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
};

export type AppConfig = typeof config;

/**
 * Cloud SQL on Cloud Run is reached through a unix socket mounted at
 * /cloudsql/<project>:<region>:<instance>, not a host:port. node-postgres treats
 * a host starting with "/" as a socket directory and appends `.s.PGSQL.<port>`,
 * and Cloud SQL only ever creates `.s.PGSQL.5432` — so the per-instance proxy
 * port from the registry does not apply there.
 */
export function isUnixSocket(host: string): boolean {
  return host.startsWith('/');
}

/** The port to dial: the configured one over TCP, always 5432 over a socket. */
export function pgPort(host: string, port: number): number {
  return isUnixSocket(host) ? 5432 : port;
}
