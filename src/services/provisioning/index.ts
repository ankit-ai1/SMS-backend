import { Router } from 'express';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/rbac';
import { RegistryClient } from '../../registry/registryClient';
import { FleetFullError, TenantProvisioner } from '../../provisioning/provisioner';
import { requireFields } from '../corePeople/students';

/**
 * Base doc §5.6 — Tenant Provisioning service. Operates on the REGISTRY DB (the
 * control plane), so there is no tenant resolver here — only platform operators
 * (super_admin) may call these.
 */
export function provisioningRouter(
  registry: RegistryClient,
  provisioner: TenantProvisioner,
): Router {
  const r = Router();
  const ONLY = requireRole('super_admin');

  // GET /tenants — list (optionally by status)
  r.get('/tenants', ONLY, asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    res.json(ok(await registry.listTenants(status)));
  }));

  // GET /tenants/:id
  r.get('/tenants/:id', ONLY, asyncHandler(async (req, res) => {
    const t = await registry.getTenantById(req.params.id);
    if (!t) throw AppError.notFound('Tenant');
    res.json(ok(t));
  }));

  // POST /tenants — provision a new school
  r.post('/tenants', ONLY, asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['school_name', 'slug', 'subdomain']);
    try {
      const result = await provisioner.provision({
        schoolName: b.school_name, slug: b.slug, subdomain: b.subdomain,
      });
      await registry.addAuditLog(result.tenant.id, 'tenant.provisioned', req.auth!.userId,
        { instance: result.instanceName, db: result.databaseName });
      res.status(201).json(ok(result));
    } catch (err) {
      if (err instanceof FleetFullError) {
        throw new AppError('CONFLICT', err.message);
      }
      throw err;
    }
  }));

  // PUT /tenants/:id/suspend
  r.put('/tenants/:id/suspend', ONLY, asyncHandler(async (req, res) => {
    const t = await registry.getTenantById(req.params.id);
    if (!t) throw AppError.notFound('Tenant');
    await registry.setTenantStatus(t.id, 'suspended');
    await registry.addAuditLog(t.id, 'tenant.suspended', req.auth!.userId, { reason: req.body?.reason ?? null });
    res.json(ok({ status: 'suspended' }));
  }));

  // PUT /tenants/:id/activate
  r.put('/tenants/:id/activate', ONLY, asyncHandler(async (req, res) => {
    const t = await registry.getTenantById(req.params.id);
    if (!t) throw AppError.notFound('Tenant');
    await registry.setTenantStatus(t.id, 'active');
    await registry.addAuditLog(t.id, 'tenant.activated', req.auth!.userId);
    res.json(ok({ status: 'active' }));
  }));

  // ---- Custom domains ----
  r.get('/tenants/:id/domains', ONLY, asyncHandler(async (req, res) => {
    res.json(ok(await registry.listDomains(req.params.id)));
  }));

  r.post('/tenants/:id/domains', ONLY, asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['domain']);
    try {
      const id = await registry.addDomain(req.params.id, String(b.domain).toLowerCase(), !!b.is_primary);
      await registry.addAuditLog(req.params.id, 'domain.added', req.auth!.userId, { domain: b.domain });
      res.status(201).json(ok({ id }));
    } catch {
      throw new AppError('CONFLICT', 'Domain already registered');
    }
  }));

  r.delete('/tenants/:id/domains/:domainId', ONLY, asyncHandler(async (req, res) => {
    const removed = await registry.deleteDomain(req.params.id, req.params.domainId);
    if (!removed) throw AppError.notFound('Domain');
    res.json(ok({ deleted: true }));
  }));

  // ---- Tenant admins ----
  r.get('/tenants/:id/admins', ONLY, asyncHandler(async (req, res) => {
    res.json(ok(await registry.listAdmins(req.params.id)));
  }));

  r.post('/tenants/:id/admins', ONLY, asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['email']);
    try {
      const id = await registry.addAdmin(req.params.id, String(b.email).toLowerCase(), b.name ?? null);
      res.status(201).json(ok({ id }));
    } catch {
      throw new AppError('CONFLICT', 'Admin already exists for this tenant');
    }
  }));

  // ---- Instances (Cloud SQL fleet) ----
  r.get('/instances', ONLY, asyncHandler(async (_req, res) => {
    res.json(ok(await registry.listInstances()));
  }));

  r.post('/instances', ONLY, asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['name', 'connection_name', 'proxy_port']);
    const id = await registry.addInstance({
      name: b.name, connectionName: b.connection_name, proxyPort: Number(b.proxy_port),
      privateIp: b.private_ip ?? null, maxTenants: b.max_tenants ?? undefined,
    });
    res.status(201).json(ok({ id }));
  }));

  // ---- Fleet migration ----
  r.post('/tenants/migrate-schema', ONLY, asyncHandler(async (req, res) => {
    const tenantId = req.body?.tenant_id;
    if (tenantId) {
      const t = await registry.getTenantById(tenantId);
      if (!t) throw AppError.notFound('Tenant');
      const inst = await registry.getInstanceById(t.dbInstanceId);
      if (!inst) throw AppError.notFound('Instance');
      const applied = await provisioner.migrateTenant(inst, t.dbName);
      res.json(ok({ results: [{ tenantId: t.id, applied }] }));
      return;
    }
    const all = await registry.listTenantsWithInstance();
    const results = await provisioner.migrateAllTenants(
      all.map((x) => ({ tenant: { id: x.tenant.id, dbName: x.tenant.dbName }, instance: x.instance })),
    );
    res.json(ok({ migrated: results.length, results }));
  }));

  return r;
}
