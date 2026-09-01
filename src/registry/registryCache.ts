import { config } from '../config';
import { RegistryClient } from './registryClient';
import { TenantContext } from './types';

/**
 * In-memory cache of subdomain -> TenantContext, refreshed on a timer.
 *
 * Matches the base doc §8.3 note: "The tenant_registry cache in the API Gateway
 * is refreshed every 60 seconds. When a tenant is suspended, it takes at most
 * 60 seconds for the suspension to take effect." Each gateway replica keeps its
 * own copy, so this is eventually consistent across replicas.
 */
export class RegistryCache {
  private bySubdomain = new Map<string, TenantContext>();
  private timer: NodeJS.Timeout | null = null;
  private lastRefresh = 0;

  constructor(private registry: RegistryClient) {}

  /** Load once, then start the periodic refresh. Call at boot. */
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      this.refresh().catch((err) => {
        // Never let a refresh failure crash the process; keep serving stale
        // data until the next tick.
        console.error('[registryCache] refresh failed:', err);
      });
    }, config.registryCacheRefreshMs);
    // Do not keep the event loop alive solely for this timer.
    this.timer.unref?.();
  }

  async refresh(): Promise<void> {
    const contexts = await this.registry.loadAllActiveContexts();
    const next = new Map<string, TenantContext>();
    for (const ctx of contexts) next.set(ctx.tenant.subdomain, ctx);
    this.bySubdomain = next;
    this.lastRefresh = Date.now();
  }

  /** Only active tenants live in the cache; unknown/suspended -> undefined. */
  get(subdomain: string): TenantContext | undefined {
    return this.bySubdomain.get(subdomain.toLowerCase());
  }

  get size(): number {
    return this.bySubdomain.size;
  }

  get ageMs(): number {
    return Date.now() - this.lastRefresh;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
