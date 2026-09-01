# ---- build stage ----
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build            # -> dist/

# ---- runtime stage ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY src/sql ./src/sql

# Uploads only land here when STORAGE_DRIVER=local; on Cloud Run they go to GCS
# and this stays empty. Created up front so the non-root user can write to it.
RUN mkdir -p /app/var/documents && chown -R node:node /app/var

# Never run the API as root.
USER node

# Documentation only — Cloud Run injects PORT and the server reads it. Do not
# hardcode a port anywhere; the server binds 0.0.0.0:$PORT (default 8080).
EXPOSE 8080

# Cloud SQL is reached over the unix socket Cloud Run mounts at
# /cloudsql/<connection-name>; there is no Cloud SQL Proxy sidecar to run.
# Migrations are a separate entrypoint: `node dist/scripts/migrate.js`.
CMD ["node", "dist/server.js"]
