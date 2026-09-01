-- registry schema
\i /docker-entrypoint-initdb.d/registry_schema.sql

-- create the default tenant DB and seed one instance + tenant
CREATE DATABASE tenant_sunrise_db;

INSERT INTO db_instances(name, connection_name, proxy_port)
VALUES ('local', 'local:5432', 5432);

INSERT INTO tenants(slug, subdomain, db_name, db_instance_id, status)
SELECT 'sunrise', 'sunrise', 'tenant_sunrise_db', id, 'active'
FROM db_instances WHERE name = 'local';

\c tenant_sunrise_db
\i /docker-entrypoint-initdb.d/001_schema_v1.sql
\i /docker-entrypoint-initdb.d/002_auth_tokens.sql
\i /docker-entrypoint-initdb.d/004_calendar_events.sql
\i /docker-entrypoint-initdb.d/005_document_files.sql
