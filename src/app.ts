import express, { Express } from 'express';
import { RegistryCache } from './registry/registryCache';
import { TenantPoolManager } from './pool/tenantPoolManager';
import { JwtKeys } from './auth/jwt';
import { AuthService } from './auth/authService';
import { authRouter } from './auth/routes';
import { authMiddleware } from './auth/authMiddleware';
import { tenantResolverMiddleware } from './middleware/tenantResolver';
import { errorMiddleware, notFoundMiddleware } from './http/context';
import { corePeopleRouter, corePeopleInternalRouter } from './services/corePeople';
import { academicOpsRouter, academicOpsInternalRouter } from './services/academicOps';
import { financeRouter } from './services/finance';
import { systemRouter, systemInternalRouter } from './services/system';
import { dashboardsRouter } from './services/gateway/dashboards';

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
export function createTenantApp(deps: TenantAppDeps): Express {
  const { cache, pools, keys, baseDomain } = deps;
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Liveness — no tenant needed.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', pools: pools.activePoolCount, cache_tenants: cache.size });
  });

  // Every request below is scoped to a tenant resolved from the Host header.
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

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);
  return app;
}
