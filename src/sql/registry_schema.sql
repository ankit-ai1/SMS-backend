-- ============================================================================
-- registry_schema.sql  —  Central control-plane database (tenant_registry).
-- Applied ONCE to the registry DB (not per tenant). Holds the tenant -> instance
-- mapping, custom domains, tenant admins, config, and a control-plane audit log.
-- Supersedes registry_extensions.sql (which was the incremental db_instances add).
-- ============================================================================

-- gen_random_uuid() is built into PostgreSQL 13+.

-- Cloud SQL instances that host tenant databases.
CREATE TABLE IF NOT EXISTS db_instances (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name             VARCHAR(100) NOT NULL UNIQUE,
    connection_name  VARCHAR(200) NOT NULL,
    private_ip       INET,
    proxy_port       INTEGER NOT NULL,
    max_tenants      INTEGER NOT NULL DEFAULT 25,
    tenant_count     INTEGER NOT NULL DEFAULT 0,
    status           VARCHAR(20) NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','draining','full')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_proxy_port   CHECK (proxy_port BETWEEN 1 AND 65535),
    CONSTRAINT chk_tenant_count CHECK (tenant_count >= 0),
    CONSTRAINT chk_capacity     CHECK (tenant_count <= max_tenants)
);
CREATE INDEX IF NOT EXISTS idx_db_instances_capacity
    ON db_instances (status, tenant_count) WHERE status = 'active';

-- One row per school (tenant).
CREATE TABLE IF NOT EXISTS tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            VARCHAR(50) NOT NULL UNIQUE,
    subdomain       VARCHAR(63) NOT NULL UNIQUE,
    name            VARCHAR(200),
    db_name         VARCHAR(100) NOT NULL,
    db_instance_id  UUID REFERENCES db_instances(id),
    status          VARCHAR(20) NOT NULL DEFAULT 'provisioning'
                    CHECK (status IN ('provisioning','active','suspended','deprovisioned')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tenants_instance ON tenants (db_instance_id);
CREATE INDEX IF NOT EXISTS idx_tenants_active_subdomain
    ON tenants (subdomain) WHERE status = 'active';

-- Custom domains mapped to a tenant (beyond the default *.schoolmgmt.com).
CREATE TABLE IF NOT EXISTS tenant_domains (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    domain      VARCHAR(255) NOT NULL UNIQUE,
    is_primary  BOOLEAN NOT NULL DEFAULT FALSE,
    verified    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_domains_tenant ON tenant_domains (tenant_id);

-- People allowed to administer a tenant (seeded as the first admin user).
CREATE TABLE IF NOT EXISTS tenant_admins (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email       VARCHAR(255) NOT NULL,
    name        VARCHAR(200),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_tenant_admin UNIQUE (tenant_id, email)
);

-- Per-tenant control-plane config (branding, feature flags, etc.).
CREATE TABLE IF NOT EXISTS tenant_configs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key         VARCHAR(100) NOT NULL,
    value       JSONB NOT NULL,
    CONSTRAINT uq_tenant_config UNIQUE (tenant_id, key)
);

-- Control-plane audit (provisioning, suspension, domain changes).
CREATE TABLE IF NOT EXISTS tenant_audit_logs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID REFERENCES tenants(id) ON DELETE SET NULL,
    action      VARCHAR(100) NOT NULL,
    actor       VARCHAR(255),
    details     JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tenant_audit_tenant ON tenant_audit_logs (tenant_id);
