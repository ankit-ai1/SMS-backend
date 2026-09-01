/**
 * tenant-db: tenant -> instance routing + per-tenant connection pooling for the
 * School Management System. Wire it together at boot like this:
 *
 *   const registry = new RegistryClient();
 *   const cache = new RegistryCache(registry);
 *   await cache.start();                         // 60s refresh
 *   const pools = new TenantPoolManager();
 *   const admin = new AdminPools();
 *   const provisioner = new TenantProvisioner(registry, admin);
 *
 *   app.use(tenantResolverMiddleware(cache, 'schoolmgmt.com'));
 *
 *   // in a handler:
 *   const ctx = req.tenantContext!;
 *   const { rows } = await pools.query(ctx, 'SELECT * FROM students LIMIT 20');
 */

export { config } from './config';
export * from './registry/types';
export { RegistryClient } from './registry/registryClient';
export { RegistryCache } from './registry/registryCache';
export { TenantPoolManager } from './pool/tenantPoolManager';
export { AdminPools, quoteIdent } from './provisioning/adminPools';
export { MigrationRunner } from './provisioning/migrations';
export {
  TenantProvisioner,
  FleetFullError,
  ProvisionInput,
  ProvisionResult,
} from './provisioning/provisioner';
export {
  resolveTenant,
  subdomainFromHost,
  tenantResolverMiddleware,
  TenantResolutionError,
} from './middleware/tenantResolver';

// ---- HTTP kit (shared by every endpoint) ----
export * from './http/envelope';
export { AppError, ErrorCode } from './http/errors';
export {
  asyncHandler,
  errorMiddleware,
  notFoundMiddleware,
  AppRequest,
  AuthContext,
  Role,
} from './http/context';
export { requireRole, requireAuth } from './http/rbac';
export { parsePage, pageMeta, PageParams } from './http/pagination';

// ---- Auth ----
export { AuthService, LoginResult } from './auth/authService';
export { authMiddleware } from './auth/authMiddleware';
export { authRouter } from './auth/routes';
export {
  loadJwtKeysFromEnv,
  signAccessToken,
  verifyAccessToken,
  JwtKeys,
} from './auth/jwt';
export { hashPassword, verifyPassword } from './auth/passwords';
export {
  RefreshTokenStore,
  PasswordResetStore,
  newOpaqueToken,
} from './auth/tokenStore';

// ---- Core People service (base doc §5.2 / §5.7) ----
export {
  corePeopleRouter,
  corePeopleInternalRouter,
} from './services/corePeople';

// ---- Academic Ops service (base doc §5.3 / §4 / §5.7) ----
export {
  academicOpsRouter,
  academicOpsInternalRouter,
} from './services/academicOps';

// ---- Finance service (base doc §5.4) ----
export { financeRouter } from './services/finance';

// ---- System service (base doc §5.5 / §5.7) ----
export { systemRouter, systemInternalRouter } from './services/system';

// ---- Tenant Provisioning service (base doc §5.6) ----
export { provisioningRouter } from './services/provisioning';

// ---- API Gateway: dashboards + composition root (base doc §5.1 / §1) ----
export { dashboardsRouter } from './services/gateway/dashboards';
export { createTenantApp, TenantAppDeps } from './app';
