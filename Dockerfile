# ============================================================================
# Dockerfile for Sticker WhatsApp Bot
# Multi-stage build for Railway — native module support (better-sqlite3, sharp)
# ============================================================================

# ---- Stage 1: Install all dependencies (including native compilation) ----
FROM node:22-bookworm AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-dev make g++ pkg-config libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

COPY pnpm-lock.yaml package.json pnpm-workspace.yaml .npmrc ./
COPY tsconfig.base.json tsconfig.json ./
COPY artifacts/ artifacts/
COPY lib/ lib/

RUN pnpm install --frozen-lockfile

# ---- Stage 2: Build the application ----
FROM deps AS builder

RUN corepack enable

# Build the API server
RUN pnpm --filter @workspace/api-server run build

# Remove source files to reduce image size
RUN rm -rf artifacts/api-server/src \
    artifacts/api-server/build.mjs \
    artifacts/api-server/tsconfig.json \
    lib/api-zod/src

# ---- Stage 3: Production runtime (lean image) ----
FROM node:22-bookworm-slim

# Install runtime SQLite library
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -r -s /usr/sbin/nologin appuser

WORKDIR /app

# Copy workspace config files (needed for pnpm workspace:* resolution)
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/.npmrc ./

# Copy built artifacts (dist folder with bundled code)
COPY --from=builder /app/artifacts/ ./artifacts/

# Copy lib workspace (workspace:* dependency)
COPY --from=builder /app/lib/ ./lib/

# Copy root node_modules
COPY --from=builder /app/node_modules/ ./node_modules/

# Copy api-server node_modules (native modules: better-sqlite3, sharp)
COPY --from=builder /app/artifacts/api-server/node_modules/ ./artifacts/api-server/node_modules/

USER appuser

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/healthz || exit 1

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
