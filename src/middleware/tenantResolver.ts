import { RegistryCache } from '../registry/registryCache';
import { TenantContext } from '../registry/types';

/** Thrown when the Host maps to no active tenant (unknown or suspended). */
export class TenantResolutionError extends Error {
  constructor(
    public code:
      | 'NO_HOST'
      | 'BAD_HOST'
      | 'TENANT_NOT_FOUND'
      | 'TENANT_SUSPENDED',
    message: string,
  ) {
    super(message);
    this.name = 'TenantResolutionError';
  }
}

/**
 * Extract the tenant subdomain from a Host header.
 * sunrise-academy.schoolmgmt.com -> "sunrise-academy"
 * Returns null if the host has no tenant label.
 */
export function subdomainFromHost(
  host: string | undefined,
  baseDomain: string,
): string | null {
  if (!host) return null;
  const hostname = host.split(':')[0].toLowerCase(); // strip port
  const base = baseDomain.toLowerCase();
  if (hostname === base || !hostname.endsWith('.' + base)) return null;
  const label = hostname.slice(0, hostname.length - base.length - 1);
  // Only the left-most label is the tenant (ignore any deeper subdomains).
  const parts = label.split('.');
  return parts[parts.length - 1] || null;
}

/**
 * Resolve a Host header to a TenantContext using the cache. Pure function so it
 * can be unit-tested and reused outside Express.
 */
export function resolveTenant(
  cache: RegistryCache,
  host: string | undefined,
  baseDomain: string,
): TenantContext {
  if (!host) {
    throw new TenantResolutionError('NO_HOST', 'Missing Host header');
  }
  const subdomain = subdomainFromHost(host, baseDomain);
  if (!subdomain) {
    throw new TenantResolutionError(
      'BAD_HOST',
      `Host has no tenant subdomain: ${host}`,
    );
  }
  const ctx = cache.get(subdomain);
  if (!ctx) {
    // The cache only holds active tenants, so a miss is either unknown or
    // suspended. Both surface as 403/404 upstream; we can't tell them apart
    // without a registry hit, which we deliberately avoid on the hot path.
    throw new TenantResolutionError(
      'TENANT_NOT_FOUND',
      `No active tenant for subdomain: ${subdomain}`,
    );
  }
  return ctx;
}

// ---- Minimal Express-style adapter (no express dependency needed) ----

interface ReqLike {
  headers: Record<string, string | string[] | undefined>;
  tenantContext?: TenantContext;
}
interface ResLike {
  status(code: number): ResLike;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}
type NextLike = (err?: unknown) => void;

/**
 * Express/Connect middleware factory. Attaches req.tenantContext and injects
 * the downstream headers the base doc §8 describes (X-Tenant-ID, X-Tenant-DB),
 * plus X-Tenant-Instance so services know which proxy port to use.
 */
export function tenantResolverMiddleware(
  cache: RegistryCache,
  baseDomain: string,
) {
  return (req: ReqLike, res: ResLike, next: NextLike): void => {
    const hostHeader = req.headers['host'];
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    try {
      const ctx = resolveTenant(cache, host, baseDomain);
      req.tenantContext = ctx;
      res.setHeader('X-Tenant-ID', ctx.tenant.id);
      res.setHeader('X-Tenant-DB', ctx.tenant.dbName);
      res.setHeader('X-Tenant-Instance', ctx.instance.id);
      next();
    } catch (err) {
      if (err instanceof TenantResolutionError) {
        const status = err.code === 'TENANT_SUSPENDED' ? 403 : 404;
        res.status(status).json({
          status: 'error',
          error: { code: err.code, message: err.message },
        });
        return;
      }
      next(err);
    }
  };
}
