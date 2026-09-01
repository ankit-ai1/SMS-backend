import { RegistryClient } from '../registry/registryClient';
import { Tenant, DbInstance } from '../registry/types';
import { AdminPools } from './adminPools';
import { MigrationRunner } from './migrations';

export interface ProvisionInput {
  schoolName: string;
  slug: string; // sunrise-academy
  subdomain: string; // sunrise-academy
}

export interface ProvisionResult {
  tenant: Tenant;
  databaseName: string;
  instanceName: string;
  migrationsApplied: string[];
}

export class FleetFullError extends Error {
  constructor() {
    super('No Cloud SQL instance has capacity; provision a new instance.');
    this.name = 'FleetFullError';
  }
}

const SLUG_RE = /^[a-z][a-z0-9-]{1,48}[a-z0-9]$/;

/**
 * Concrete implementation of the base doc's POST /api/v1/tenants flow, with the
 * instance-selection and migration-tracking steps the doc left unspecified:
 *
 *   1. reserve a slot on the least-loaded active instance (atomic)
 *   2. CREATE DATABASE tenant_<slug>_db on that instance
 *   3. apply ordered migrations (001_schema_v1, 004_calendar_events, ...)
 *   4. insert the tenant row (status = active)
 *
 * On any failure after the slot is reserved, the slot is released so capacity
 * accounting stays correct.
 */
export class TenantProvisioner {
  private migrations: MigrationRunner;

  constructor(
    private registry: RegistryClient,
    private admin: AdminPools,
  ) {
    this.migrations = new MigrationRunner(admin);
  }

  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    const slug = input.slug.toLowerCase();
    if (!SLUG_RE.test(slug)) {
      throw new Error(`invalid slug: ${input.slug}`);
    }
    const dbName = `tenant_${slug.replace(/-/g, '_')}_db`;

    // 1. Reserve capacity on an instance.
    const instance = await this.registry.reserveInstanceSlot();
    if (!instance) throw new FleetFullError();

    try {
      // 2. Create the database (idempotent-ish: skip if it already exists).
      const exists = await this.admin.databaseExists(instance, dbName);
      if (!exists) {
        await this.admin.createDatabase(instance, dbName);
      }

      // 3. Apply schema migrations and record versions.
      const migrationsApplied = await this.migrations.migrateDatabase(
        instance,
        dbName,
      );

      // 4. Register the tenant as active.
      const tenant = await this.registry.insertTenant({
        slug,
        subdomain: input.subdomain.toLowerCase(),
        dbName,
        dbInstanceId: instance.id,
        status: 'active',
      });

      return {
        tenant,
        databaseName: dbName,
        instanceName: instance.name,
        migrationsApplied,
      };
    } catch (err) {
      // Roll back the capacity reservation so the instance isn't wrongly full.
      await this.registry
        .releaseInstanceSlot(instance.id)
        .catch(() => undefined);
      throw err;
    }
  }

  /**
   * Run pending migrations against one tenant's DB. Concrete, resumable form of
   * the base doc's "run schema migration on all tenant DBs" — safe because
   * MigrationRunner tracks applied versions per DB (schema_migrations table).
   */
  async migrateTenant(instance: DbInstance, dbName: string): Promise<string[]> {
    return this.migrations.migrateDatabase(instance, dbName);
  }

  /**
   * Fleet-wide migration. Iterates every tenant, applying pending migrations.
   * Returns a per-tenant result so a partial failure is visible rather than
   * silently swallowed. Long-running: callers should treat it as a job.
   */
  async migrateAllTenants(
    tenants: { tenant: { id: string; dbName: string }; instance: DbInstance }[],
  ): Promise<{ tenantId: string; applied?: string[]; error?: string }[]> {
    const results: { tenantId: string; applied?: string[]; error?: string }[] = [];
    for (const { tenant, instance } of tenants) {
      try {
        const applied = await this.migrations.migrateDatabase(instance, tenant.dbName);
        results.push({ tenantId: tenant.id, applied });
      } catch (err) {
        results.push({ tenantId: tenant.id, error: (err as Error).message });
      }
    }
    return results;
  }
}
