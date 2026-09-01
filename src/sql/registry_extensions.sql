-- ============================================================================
-- Registry DB (tenant_registry) — instance routing extension
-- ----------------------------------------------------------------------------
-- Adds the tenant -> Cloud SQL instance mapping the base architecture doc did
-- not model. Apply once to the tenant_registry database (NOT to tenant DBs).
-- ============================================================================

-- One row per Cloud SQL instance that can host tenant databases.
CREATE TABLE IF NOT EXISTS db_instances (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name             VARCHAR(100) NOT NULL UNIQUE,   -- school-mgmt-sql-01
    connection_name  VARCHAR(200) NOT NULL,          -- project:region:instance
    private_ip       INET,
    proxy_port       INTEGER NOT NULL,               -- local port the sidecar exposes
    max_tenants      INTEGER NOT NULL DEFAULT 25,    -- soft capacity cap (see sizing math)
    tenant_count     INTEGER NOT NULL DEFAULT 0,
    status           VARCHAR(20) NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'draining', 'full')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_proxy_port     CHECK (proxy_port BETWEEN 1 AND 65535),
    CONSTRAINT chk_tenant_count   CHECK (tenant_count >= 0),
    CONSTRAINT chk_capacity       CHECK (tenant_count <= max_tenants)
);

-- Fast "least-loaded active instance with capacity" lookup used by the
-- provisioner's reserveInstanceSlot().
CREATE INDEX IF NOT EXISTS idx_db_instances_capacity
    ON db_instances (status, tenant_count)
    WHERE status = 'active';

-- Link each tenant to the instance hosting its database.
ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS db_instance_id UUID REFERENCES db_instances(id);

CREATE INDEX IF NOT EXISTS idx_tenants_instance ON tenants (db_instance_id);

-- Cache-warming query hits (subdomain, status); make sure it's indexed.
CREATE INDEX IF NOT EXISTS idx_tenants_active_subdomain
    ON tenants (subdomain)
    WHERE status = 'active';

-- Seed the first instance (edit connection_name / proxy_port for your project).
-- INSERT INTO db_instances (name, connection_name, proxy_port, max_tenants)
-- VALUES ('school-mgmt-sql-01', 'my-project:asia-south1:school-mgmt-sql-01', 5432, 25);
