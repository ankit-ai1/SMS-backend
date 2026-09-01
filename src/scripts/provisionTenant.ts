/**
 * Provision one tenant end to end, and seed its first admin login.
 *
 *   node dist/scripts/provisionTenant.js <slug> <subdomain> <admin-email> <admin-password> [school-name]
 *
 * What it does, in order:
 *   1. CREATE DATABASE tenant_<slug>_db on the instance with free capacity
 *   2. apply every migrations/NNN_*.sql to it (recorded in schema_migrations)
 *   3. INSERT the tenant row so the registry cache can resolve it
 *   4. INSERT the first admin user, so somebody can actually log in
 *
 * Steps 1-3 are TenantProvisioner.provision(); step 4 exists because
 * POST /api/v1/users needs an admin token, which nobody has yet.
 *
 * Re-running with the same slug is safe: an existing tenant is reused and only
 * the admin user is topped up (existing email left untouched).
 *
 * Requires a db_instances row — see the runbook.
 */
import { RegistryClient } from '../registry/registryClient';
import { AdminPools } from '../provisioning/adminPools';
import { TenantProvisioner } from '../provisioning/provisioner';
import { hashPassword, isPasswordAcceptable } from '../auth/passwords';

async function main(): Promise<void> {
  const [slug, subdomain, email, password, schoolName] = process.argv.slice(2);
  if (!slug || !subdomain || !email || !password) {
    throw new Error(
      'usage: provisionTenant <slug> <subdomain> <admin-email> <admin-password> [school-name]',
    );
  }
  if (!isPasswordAcceptable(password)) {
    throw new Error('admin password must be at least 8 characters');
  }

  const registry = new RegistryClient();
  const admin = new AdminPools();
  try {
    const existing = (await registry.loadAllActiveContexts()).find(
      (c) => c.tenant.slug === slug.toLowerCase(),
    );

    let dbName: string;
    let instance;
    if (existing) {
      dbName = existing.tenant.dbName;
      instance = existing.instance;
      console.log(`[provision] tenant "${slug}" already exists -> ${dbName}`);
    } else {
      const result = await new TenantProvisioner(registry, admin).provision({ slug, subdomain, schoolName: schoolName ?? slug });
      dbName = result.databaseName;
      instance = (await registry.loadAllActiveContexts()).find(
        (c) => c.tenant.slug === slug.toLowerCase(),
      )!.instance;
      console.log(
        `[provision] created ${dbName} on ${result.instanceName}; ` +
          `migrations: ${result.migrationsApplied.join(', ') || 'none pending'}`,
      );
    }

    // First admin login, straight into the tenant DB.
    const pool = admin.poolForDatabase(instance, dbName);
    try {
      const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, role, full_name)
         VALUES ($1,$2,'admin',$3)
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [email, await hashPassword(password), 'Administrator'],
      );
      console.log(
        rows.length
          ? `[provision] admin ${email} created (id ${rows[0].id})`
          : `[provision] admin ${email} already existed — password left unchanged`,
      );
    } finally {
      await pool.end();
    }

    console.log(`[provision] done — send requests with X-Tenant-Subdomain: ${subdomain}`);
  } finally {
    await admin.closeAll();
    await registry.close();
  }
}

main().catch((err) => {
  console.error('[provision] failed:', err);
  process.exit(1);
});
