# ============================================================================
# Dockerfile for Sticker WhatsApp Bot on Railway
# Multi-stage build with proper pnpm workspace symlink handling
# ============================================================================

# ---- Stage 1: Install dependencies (including native compilation) ----
FROM node:22-bookworm AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-dev make g++ pkg-config libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# Copy workspace configuration
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml .npmrc ./
COPY tsconfig.base.json tsconfig.json ./
COPY artifacts/ artifacts/
COPY lib/ lib/

# Install all dependencies (pnpm install compiles native modules and creates symlinks)
RUN pnpm install --frozen-lockfile

# ---- Stage 2: Build the application ----
FROM deps AS builder

WORKDIR /app

# Build the API server
RUN pnpm --filter @workspace/api-server run build

# Remove source files to reduce image size (keep node_modules intact)
RUN rm -rf artifacts/api-server/src \
    artifacts/api-server/build.mjs \
    artifacts/api-server/tsconfig.json \
    lib/api-zod/src

# ---- Stage 3: Production runtime ----
FROM node:22-bookworm AS production

# Install runtime SQLite library and wget for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsqlite3-0 \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the ENTIRE app directory from builder to preserve pnpm symlinks
# This is critical: pnpm uses a content-addressable store (.pnpm) with symlinks
# Copying individual directories breaks the symlink structure
COPY --from=builder /app .

# Remove dev dependencies and unnecessary files
RUN rm -rf artifacts/api-server/node_modules/esbuild \
    artifacts/api-server/node_modules/esbuild-plugin-pino \
    artifacts/api-server/node_modules/pino-pretty \
    artifacts/api-server/node_modules/@types

# Create required runtime directories with correct ownership BEFORE switching user
RUN mkdir -p /app/data /app/sessions

# Create non-root user and set ownership of the entire app directory
RUN useradd -r -s /usr/sbin/nologin appuser && \
    chown -R appuser:appuser /app

USER appuser

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/healthz || exit 1

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
