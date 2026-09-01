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
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY src/sql ./src/sql
EXPOSE 8080
# Cloud SQL Proxy runs as a sidecar (GKE) or as the Cloud Run built-in
# connector; the app talks to it on 127.0.0.1 (see TENANT_DB_HOST).
CMD ["node", "dist/server.js"]
