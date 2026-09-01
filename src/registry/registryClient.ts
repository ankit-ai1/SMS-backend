import { Pool } from 'pg';
import { config } from '../config';
import { DbInstance, Tenant, TenantContext, TenantStatus } from './types';

/**
 * Talks to the central tenant_registry database. This is the only place that
 * knows the tenant -> instance mapping.
 */
export class RegistryClient {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({
      host: config.registry.host,
      port: config.registry.port,
      database: config.registry.database,
      user: config.registry.user,
      password: config.registry.password,
      max: config.registry.max,
    });
  }

  /** Load every active tenant joined with its instance (used to warm the cache). */
  async loadAllActiveContexts(): Promise<TenantContext[]> {
    const { rows } = await this.pool.query(`
      SELECT
        t.id            AS tenant_id,
        t.slug          AS tenant_slug,
        t.subdomain     AS tenant_subdomain,
        t.db_name       AS tenant_db_name,
        t.db_instance_id AS tenant_db_instance_id,
        t.status        AS tenant_status,
        i.id            AS instance_id,
        i.name          AS instance_name,
        i.connection_name AS instance_connection_name,
        i.private_ip    AS instance_private_ip,
        i.proxy_port    AS instance_proxy_port,
        i.max_tenants   AS instance_max_tenants,
        i.tenant_count  AS instance_tenant_count,
        i.status        AS instance_status
      FROM tenants t
      JOIN db_instances i ON i.id = t.db_instance_id
      WHERE t.status = 'active'
    `);
    return rows.map(mapContextRow);
  }

  /**
   * Pick the least-loaded active instance that still has capacity, and reserve
   * a slot atomically. FOR UPDATE SKIP LOCKED prevents two concurrent
   * provisions from over-filling the same instance. Returns null if the fleet
   * is full (caller should provision a new Cloud SQL instance).
   */
  async reserveInstanceSlot(): Promise<DbInstance | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`
        SELECT * FROM db_instances
        WHERE status = 'active' AND tenant_count < max_tenants
        ORDER BY tenant_count ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      const inst = rows[0];
      const newCount = inst.tenant_count + 1;
      const newStatus = newCount >= inst.max_tenants ? 'full' : 'active';
      await client.query(
        `UPDATE db_instances SET tenant_count = $1, status = $2 WHERE id = $3`,
        [newCount, newStatus, inst.id],
      );
      await client.query('COMMIT');
      return mapInstanceRow({
        ...inst,
        tenant_count: newCount,
        status: newStatus,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Release a reserved slot if provisioning failed after reserveInstanceSlot(). */
  async releaseInstanceSlot(instanceId: string): Promise<void> {
    await this.pool.query(
      `UPDATE db_instances
         SET tenant_count = GREATEST(tenant_count - 1, 0),
             status = CASE WHEN status = 'full' THEN 'active' ELSE status END
       WHERE id = $1`,
      [instanceId],
    );
  }

  async insertTenant(t: {
    slug: string;
    subdomain: string;
    dbName: string;
    dbInstanceId: string;
    status: TenantStatus;
  }): Promise<Tenant> {
    const { rows } = await this.pool.query(
      `INSERT INTO tenants (slug, subdomain, db_name, db_instance_id, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, slug, subdomain, db_name, db_instance_id, status`,
      [t.slug, t.subdomain, t.dbName, t.dbInstanceId, t.status],
    );
    return mapTenantRow(rows[0]);
  }

  async setTenantStatus(tenantId: string, status: TenantStatus): Promise<void> {
    await this.pool.query(`UPDATE tenants SET status = $1 WHERE id = $2`, [
      status,
      tenantId,
    ]);
  }

  async getInstanceById(id: string): Promise<DbInstance | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM db_instances WHERE id = $1`,
      [id],
    );
    return rows.length ? mapInstanceRow(rows[0]) : null;
  }

  // ---- Provisioning-service reads/writes (control plane) ----

  async listTenants(status?: string): Promise<Tenant[]> {
    const rows = status
      ? (await this.pool.query(`SELECT * FROM tenants WHERE status = $1 ORDER BY created_at DESC`, [status])).rows
      : (await this.pool.query(`SELECT * FROM tenants ORDER BY created_at DESC`)).rows;
    return rows.map(mapTenantRow);
  }

  async getTenantById(id: string): Promise<Tenant | null> {
    const { rows } = await this.pool.query(`SELECT * FROM tenants WHERE id = $1`, [id]);
    return rows.length ? mapTenantRow(rows[0]) : null;
  }

  /** All tenants with their instance, for fleet-wide migration. */
  async listTenantsWithInstance(): Promise<{ tenant: Tenant; instance: DbInstance }[]> {
    const { rows } = await this.pool.query(`
      SELECT t.*, i.id AS i_id, i.name AS i_name, i.connection_name AS i_cn,
             i.private_ip AS i_ip, i.proxy_port AS i_port, i.max_tenants AS i_max,
             i.tenant_count AS i_count, i.status AS i_status
        FROM tenants t JOIN db_instances i ON i.id = t.db_instance_id`);
    return rows.map((r) => ({
      tenant: mapTenantRow(r),
      instance: mapInstanceRow({
        id: r.i_id, name: r.i_name, connection_name: r.i_cn, private_ip: r.i_ip,
        proxy_port: r.i_port, max_tenants: r.i_max, tenant_count: r.i_count, status: r.i_status,
      }),
    }));
  }

  async addAuditLog(tenantId: string | null, action: string, actor: string | null, details?: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO tenant_audit_logs (tenant_id, action, actor, details) VALUES ($1,$2,$3,$4)`,
      [tenantId, action, actor, details ? JSON.stringify(details) : null],
    );
  }

  async listDomains(tenantId: string): Promise<unknown[]> {
    const { rows } = await this.pool.query(
      `SELECT id, domain, is_primary, verified FROM tenant_domains WHERE tenant_id = $1`, [tenantId]);
    return rows;
  }

  async addDomain(tenantId: string, domain: string, isPrimary: boolean): Promise<string> {
    const { rows } = await this.pool.query(
      `INSERT INTO tenant_domains (tenant_id, domain, is_primary) VALUES ($1,$2,$3)
       ON CONFLICT (domain) DO NOTHING RETURNING id`, [tenantId, domain, isPrimary]);
    if (!rows.length) throw new Error('domain already registered');
    return rows[0].id;
  }

  async deleteDomain(tenantId: string, domainId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM tenant_domains WHERE id = $1 AND tenant_id = $2`, [domainId, tenantId]);
    return !!rowCount;
  }

  async listAdmins(tenantId: string): Promise<unknown[]> {
    const { rows } = await this.pool.query(
      `SELECT id, email, name, created_at FROM tenant_admins WHERE tenant_id = $1`, [tenantId]);
    return rows;
  }

  async addAdmin(tenantId: string, email: string, name: string | null): Promise<string> {
    const { rows } = await this.pool.query(
      `INSERT INTO tenant_admins (tenant_id, email, name) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, email) DO NOTHING RETURNING id`, [tenantId, email, name]);
    if (!rows.length) throw new Error('admin already exists for tenant');
    return rows[0].id;
  }

  async listInstances(): Promise<DbInstance[]> {
    const { rows } = await this.pool.query(`SELECT * FROM db_instances ORDER BY name`);
    return rows.map(mapInstanceRow);
  }

  async addInstance(i: {
    name: string; connectionName: string; proxyPort: number; privateIp?: string | null; maxTenants?: number;
  }): Promise<string> {
    const { rows } = await this.pool.query(
      `INSERT INTO db_instances (name, connection_name, proxy_port, private_ip, max_tenants)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [i.name, i.connectionName, i.proxyPort, i.privateIp ?? null, i.maxTenants ?? 25]);
    return rows[0].id;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ---- row mappers (snake_case DB -> camelCase domain) ----

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapInstanceRow(r: any): DbInstance {
  return {
    id: r.id,
    name: r.name,
    connectionName: r.connection_name,
    privateIp: r.private_ip,
    proxyPort: r.proxy_port,
    maxTenants: r.max_tenants,
    tenantCount: r.tenant_count,
    status: r.status,
  };
}

function mapTenantRow(r: any): Tenant {
  return {
    id: r.id,
    slug: r.slug,
    subdomain: r.subdomain,
    dbName: r.db_name,
    dbInstanceId: r.db_instance_id,
    status: r.status,
  };
}

function mapContextRow(r: any): TenantContext {
  return {
    tenant: {
      id: r.tenant_id,
      slug: r.tenant_slug,
      subdomain: r.tenant_subdomain,
      dbName: r.tenant_db_name,
      dbInstanceId: r.tenant_db_instance_id,
      status: r.tenant_status,
    },
    instance: {
      id: r.instance_id,
      name: r.instance_name,
      connectionName: r.instance_connection_name,
      privateIp: r.instance_private_ip,
      proxyPort: r.instance_proxy_port,
      maxTenants: r.instance_max_tenants,
      tenantCount: r.instance_tenant_count,
      status: r.instance_status,
    },
  };
}
