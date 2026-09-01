# Auth + HTTP kit (added on top of tenant-db)

Real, type-checked, and runtime-tested authentication for the School
Management System, plus the shared HTTP building blocks every one of the 132
endpoints will reuse.

## Auth — what's built

| File | Role |
|---|---|
| `auth/jwt.ts` | RS256 sign/verify. Keys loaded from env (Secret Manager), `kid` header supports **rotation** (JWKS-friendly). Fixes doc gaps: key source + rotation. |
| `auth/passwords.ts` | bcrypt hashing (pure-JS, no native build). |
| `auth/tokenStore.ts` | **refresh_tokens** store with rotation + reuse-detection, and **password_reset_tokens** — the storage the doc never defined. Only SHA-256 hashes are stored, never raw tokens. |
| `auth/authService.ts` | login / refresh / logout / me / changePassword / forgot / reset. Validates against the tenant's `users` table (doc §7.1). No account enumeration on forgot. |
| `auth/authMiddleware.ts` | Verifies Bearer JWT and enforces **JWT tenant == host tenant** (doc §8.1 step 4 → `TENANT_MISMATCH`). |
| `auth/routes.ts` | `/api/v1/auth/*` — real Express router. These ARE doc §5.1 endpoints (+ password reset). |
| `sql/system_auth.sql` | `users` + `refresh_tokens` + `password_reset_tokens` DDL. |

Audit gaps this closes: no refresh-token store, no password reset flow, JWT
key location + rotation unspecified.

## HTTP kit — reused by all endpoints

| File | Role |
|---|---|
| `http/envelope.ts` | `{status, data, meta}` / `{status, error}` — doc §10.1. |
| `http/errors.ts` | `AppError` + the 12 standard codes/status pairs — doc §10.2. |
| `http/context.ts` | `AppRequest` (tenant + auth on the request), `asyncHandler`, error + 404 middleware. |
| `http/rbac.ts` | `requireRole(...)` coarse role check — doc §6 gateway layer. |
| `http/pagination.ts` | `page/per_page/sort/order` parsing with a sort whitelist — doc §10.3. |

## Wiring order (important)

```
tenantResolver  ->  authMiddleware  ->  requireRole(...)  ->  handler
   (host->tenant)     (JWT + match)      (coarse RBAC)        (scope + logic)
```

Fine-grained scope (teacher-assigned, parent-own-child — doc §6.2) is enforced
**inside each service handler**, not here.

## Required env (from Secret Manager)

```
JWT_ACTIVE_KID=k1
JWT_PRIVATE_KEY_PEM=-----BEGIN PRIVATE KEY-----\n...      # active key only
JWT_PUBLIC_KEYS={"k1":"-----BEGIN PUBLIC KEY-----\n..."}  # all live kids
JWT_ISSUER=schoolmgmt.com
JWT_ACCESS_TTL=3600
TENANT_DB_PASSWORD=...   REGISTRY_DB_PASSWORD=...
```

## Status of the 132 endpoints

Done: the **8 auth/gateway** endpoints (login, refresh, logout, me, forgot,
reset) are real routes. The other ~124 (Core People, Academic Ops, Finance,
System, Tenant Provisioning) are **not built yet** — they need the 42-table
`001_schema_v1.sql` first, then can be generated service by service on top of
this exact kit (envelope + errors + RBAC + pagination + auth middleware).
