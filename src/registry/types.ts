export type InstanceStatus = 'active' | 'draining' | 'full';
export type TenantStatus =
  | 'provisioning'
  | 'active'
  | 'suspended'
  | 'deprovisioned';

/**
 * A Cloud SQL instance that hosts one or more tenant databases.
 * This is the "which bank is the school in" record — the gap the base doc
 * did not model (it only stored db_name, not which instance).
 */
export interface DbInstance {
  id: string;
  name: string; // e.g. school-mgmt-sql-01
  connectionName: string; // project:region:instance (for Cloud SQL Proxy)
  privateIp: string | null;
  proxyPort: number; // local port the sidecar exposes this instance on
  maxTenants: number; // soft capacity cap
  tenantCount: number;
  status: InstanceStatus;
}

export interface Tenant {
  id: string;
  slug: string;
  subdomain: string;
  dbName: string; // tenant_<slug>_db
  dbInstanceId: string;
  status: TenantStatus;
}

/** Everything a request needs to reach the right database. */
export interface TenantContext {
  tenant: Tenant;
  instance: DbInstance;
}
