import express, { Express } from 'express';
import { RegistryCache } from './registry/registryCache';
import { TenantPoolManager } from './pool/tenantPoolManager';
import { JwtKeys } from './auth/jwt';
import { AuthService } from './auth/authService';
import { authRouter } from './auth/routes';
import { authMiddleware } from './auth/authMiddleware';
import { tenantResolverMiddleware } from './middleware/tenantResolver';
import { config } from './config';
import { errorMiddleware, notFoundMiddleware } from './http/context';
import { corePeopleRouter, corePeopleInternalRouter } from './services/corePeople';
import { academicOpsRouter, academicOpsInternalRouter } from './services/academicOps';
import { financeRouter } from './services/finance';
import { systemRouter, systemInternalRouter } from './services/system';
import { dashboardsRouter } from './services/gateway/dashboards';
import { reportsRouter } from './services/reports';
import { transportRouter } from './services/transport';

export interface TenantAppDeps {
  cache: RegistryCache;
  pools: TenantPoolManager;
  keys: JwtKeys;
  baseDomain: string; // e.g. schoolmgmt.com
}

/**
 * Phase 1 modular monolith (base doc §1): one Express app that resolves the
 * tenant from the Host, authenticates, then serves every domain service from a
 * shared process against the per-tenant database.
 *
 * Wiring order (base doc §8.1):
 *   health → tenantResolver → [auth routes] → JWT → [service routes] → errors
 */
/**
 * Match a browser Origin against CORS_ORIGINS. Entries are exact origins, "*"
 * for any, or a wildcard host suffix like "*.vercel.app" — preview deployments
 * get a fresh hostname every push, so an exact list cannot keep up with them.
 */
export function originAllowed(origin: string, allowed: string[]): boolean {
  return allowed.some((entry) => {
    if (entry === '*' || entry === origin) return true;
    if (!entry.startsWith('*.')) return false;
    try {
      return new URL(origin).hostname.endsWith(entry.slice(1));
    } catch {
      return false;
    }
  });
}

export function createTenantApp(deps: TenantAppDeps): Express {
  const { cache, pools, keys, baseDomain } = deps;
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // The browser app is served from a different origin than the API (a Cloud Run
  // URL), and it sends Authorization + X-Tenant-Subdomain — both of which make
  // every request preflighted. Without this the browser blocks them all.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && originAllowed(origin, config.corsOrigins)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, X-Tenant-Subdomain',
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Tenant-ID');
    res.setHeader('Access-Control-Max-Age', '3600');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Liveness — no tenant needed.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', pools: pools.activePoolCount, cache_tenants: cache.size });
  });

  // Every request below is scoped to a tenant, resolved from the
  // X-Tenant-Subdomain header or, failing that, the Host header.
  app.use(tenantResolverMiddleware(cache, baseDomain));

  const authService = new AuthService(pools, keys);

  // Auth endpoints (login/refresh are public; logout/me guard themselves).
  app.use('/api/v1/auth', authRouter(authService, keys));

  // Internal service-to-service endpoints: tenant-scoped, but NOT behind the
  // gateway JWT (protect with NetworkPolicy + an internal token at the edge).
  app.use('/internal', corePeopleInternalRouter(pools));
  app.use('/internal', academicOpsInternalRouter(pools));
  app.use('/internal', systemInternalRouter(pools));

  // Everything else under /api/v1 requires a valid access token.
  app.use('/api/v1', authMiddleware(keys));
  app.use('/api/v1', corePeopleRouter(pools));
  app.use('/api/v1', academicOpsRouter(pools));
  app.use('/api/v1', financeRouter(pools));
  app.use('/api/v1', systemRouter(pools));
  app.use('/api/v1', dashboardsRouter(pools));
  app.use('/api/v1', reportsRouter(pools));
  app.use('/api/v1', transportRouter(pools));

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);
  return app;
}
