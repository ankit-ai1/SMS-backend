import { config } from './config';
import { RegistryClient } from './registry/registryClient';
import { RegistryCache } from './registry/registryCache';
import { TenantPoolManager } from './pool/tenantPoolManager';
import { loadJwtKeysFromEnv } from './auth/jwt';
import { createTenantApp } from './app';

/**
 * Boot the Phase 1 modular monolith. This is the real process entrypoint:
 * it wires the registry, the per-tenant pool manager, and JWT keys, then
 * starts the HTTP server.
 *
 * Required env (see .env.example): REGISTRY_DB_*, TENANT_DB_*, JWT_*.
 * BASE_DOMAIN defaults to schoolmgmt.com; PORT defaults to 8080 (the gateway
 * port in the architecture doc).
 */
async function main(): Promise<void> {
  const port = Number(process.env.PORT || 8080);
  const baseDomain = process.env.BASE_DOMAIN || 'schoolmgmt.com';

  const registry = new RegistryClient();
  const cache = new RegistryCache(registry);
  const pools = new TenantPoolManager();
  const keys = loadJwtKeysFromEnv();

  // The DB container can still be warming up on first boot, so give the initial
  // registry load a few tries before failing the process.
  const attempts = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      await cache.start(); // initial load + 60s refresh
      break;
    } catch (err) {
      if (attempt === attempts) throw err;
      console.warn(
        `[server] registry not ready (attempt ${attempt}/${attempts}): ` +
          `${(err as Error).message} — retrying in 2s`,
      );
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  const app = createTenantApp({ cache, pools, keys, baseDomain });

  const server = app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] listening on :${port} (base domain ${baseDomain})`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[server] ${signal} received, shutting down...`);
    server.close();
    cache.stop();
    await pools.closeAll();
    await registry.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
