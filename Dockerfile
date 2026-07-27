# ============================================================================
# Dockerfile for Sticker API Server on Railway
# Multi-stage build optimized for native module compilation
# ============================================================================

# ---- Stage 1: Install dependencies (including native modules) ----
FROM node:22-bookworm AS deps

# Install build tools needed for native modules (better-sqlite3, sharp, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-dev make g++ pkg-config libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# Copy workspace configuration files
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml .npmrc ./
COPY tsconfig.base.json tsconfig.json ./

# Copy workspace packages
COPY artifacts/ artifacts/
COPY lib/ lib/

# Install all dependencies (this compiles native modules)
RUN pnpm install --frozen-lockfile

# ---- Stage 2: Build the application ----
FROM node:22-bookworm AS builder

RUN corepack enable

WORKDIR /app

# Copy from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/artifacts/api-server/node_modules ./artifacts/api-server/node_modules
COPY . .

# Build the API server
RUN pnpm --filter @workspace/api-server run build

# Remove source files to reduce image size
RUN rm -rf artifacts/api-server/src \
    artifacts/api-server/build.mjs \
    artifacts/api-server/tsconfig.json \
    lib/api-zod/src

# ---- Stage 3: Production runtime ----
FROM node:22-bookworm-slim

# Install runtime dependency for SQLite
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Create non-root user
RUN useradd -r -s /usr/sbin/nologin appuser

WORKDIR /app

# Copy workspace config (needed for pnpm to resolve workspace:* packages)
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/.npmrc ./

# Copy built artifacts
COPY --from=builder /app/artifacts/ ./artifacts/

# Copy lib workspace package (needed for workspace:* resolution)
COPY --from=builder /app/lib/ ./lib/

# Copy root node_modules
COPY --from=builder /app/node_modules/ ./node_modules/

# Copy api-server specific node_modules (for native modules)
COPY --from=builder /app/artifacts/api-server/node_modules/ ./artifacts/api-server/node_modules/

USER appuser

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/healthz || exit 1

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
