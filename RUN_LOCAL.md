# Where to run this — and how

Three places, simplest first.

## 1. Your laptop (dev / testing)

No database needed for the test suite (it uses in-process Postgres):

```bash
npm install
npm test          # build + full end-to-end smoke test
```

To run the **real server** locally with a real Postgres, use Docker:

```bash
# generate dev JWT keys into your shell (never commit these)
export JWT_PRIVATE_KEY_PEM="$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null | awk '{printf "%s\\n", $0}')"
export JWT_PUBLIC_KEYS="{\"k1\":\"$(echo "$JWT_PRIVATE_KEY_PEM" | sed 's/\\n/\n/g' | openssl rsa -pubout 2>/dev/null | awk '{printf "%s\\n", $0}')\"}"

docker compose up --build      # starts Postgres + the API on :8080
```

First-time seed (in another terminal) — create the registry, one instance row,
and one tenant DB:

```bash
# registry schema
docker compose exec db psql -U school_mgmt_app -d tenant_registry -f - < src/sql/registry_schema.sql

# one Cloud SQL "instance" = this local Postgres (proxy_port 5432)
docker compose exec db psql -U school_mgmt_app -d tenant_registry -c \
 "INSERT INTO db_instances(name,connection_name,proxy_port) VALUES('local','local:5432',5432);"

# a tenant DB for subdomain 'sunrise'
docker compose exec db psql -U school_mgmt_app -d tenant_registry -c \
 "INSERT INTO tenants(slug,subdomain,db_name,db_instance_id,status)
  SELECT 'sunrise','sunrise','tenant_sunrise_db',id,'active' FROM db_instances WHERE name='local';"
docker compose exec db psql -U school_mgmt_app -c "CREATE DATABASE tenant_sunrise_db;"
for f in migrations/001_schema_v1.sql migrations/002_auth_tokens.sql migrations/004_calendar_events.sql; do
  docker compose exec -T db psql -U school_mgmt_app -d tenant_sunrise_db < "$f"
done
```

Now the tenant is reachable at `http://sunrise.lvh.me:8080` (lvh.me points every
subdomain at 127.0.0.1 — no /etc/hosts editing needed). Create an admin user in
`tenant_sunrise_db.users`, then `POST /api/v1/auth/login`.

## 2. Google Cloud Run (recommended to go live fast)

Container + Cloud SQL, auto-scaling, low ops. Fits inside your GCP design.

```bash
gcloud sql instances create school-mgmt-sql-01 --database-version=POSTGRES_15 \
  --region=asia-south1 --availability-type=REGIONAL
gcloud run deploy school-mgmt-api --source . --region=asia-south1 \
  --add-cloudsql-instances=PROJECT:asia-south1:school-mgmt-sql-01 \
  --set-secrets=JWT_PRIVATE_KEY_PEM=jwt-priv:latest,JWT_PUBLIC_KEYS=jwt-pub:latest \
  --set-env-vars=TENANT_DB_HOST=/cloudsql/PROJECT:asia-south1:school-mgmt-sql-01,BASE_DOMAIN=schoolmgmt.com
```

Point `*.schoolmgmt.com` at the Cloud Run URL. Secrets live in Secret Manager.

## 3. GKE (production target — your architecture diagram)

Private GKE cluster, Global HTTPS LB + Cloud Armor, NGINX Ingress, and a
**Cloud SQL Proxy sidecar** per pod (app connects on 127.0.0.1). This is the
full design; needs K8s manifests / Helm (a separate deliverable). The same
container image from the Dockerfile is what you deploy here.

## Still to decide (flagged in the audit)

- **Region:** `asia-south1` (Mumbai) recommended for India data residency.
- **TLS termination:** Global LB (managed cert) vs NGINX (wildcard) — pick one.
