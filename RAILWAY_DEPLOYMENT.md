# Railway Deployment Guide — WhatsApp Sticker Bot

## Files Added (No Source Code Modified)

| File | Purpose |
|------|---------|
| `nixpacks.toml` | Railway build/deploy configuration (auto-detected) |
| `.dockerignore` | Excludes unnecessary files from build context |

## How Railway Deploys This Project

Railway automatically detects `nixpacks.toml` in the repo root and uses it as the build plan. The configuration:

1. **Setup Phase** — Installs system dependencies required by native packages (`better-sqlite3`, `sharp`).
2. **Install Phase** — Enables Corepack and runs `pnpm install --frozen-lockfile` at the monorepo root.
3. **Build Phase** — Runs TypeScript type-checking and builds the `api-server` artifact using esbuild.
4. **Start Phase** — Starts the WhatsApp bot server via `pnpm --filter @workspace/api-server run start`.

## Environment Variables to Set on Railway

| Variable | Description | Example |
|----------|-------------|---------|
| `PORT` | **Required** — The port the server listens on | `8080` |
| `NODE_ENV` | Set to `production` (Railway sets this automatically) | `production` |

## Steps to Deploy on Railway

### Option A: Via GitHub (Recommended)

1. Push the new files to your GitHub repo:
   ```bash
   git add nixpacks.toml .dockerignore
   git commit -m "Add Railway deployment configuration"
   git push
   ```

2. Go to [railway.com/new](https://railway.com/new) and select **Deploy from GitHub Repo**.
3. Select your repository (`atemmokhtar2-blip/Sticker`).
4. Railway will auto-detect the `api-server` package and offer to deploy it.
5. Set the `PORT` environment variable in Railway's service settings.
6. Click **Deploy**.

### Option B: Via Railway CLI

1. Install Railway CLI:
   ```bash
   npm i -g @railway/cli
   ```

2. Login and link:
   ```bash
   railway login
   railway link
   ```

3. Deploy:
   ```bash
   railway up
   ```

4. Set environment variables:
   ```bash
   railway variables set PORT=8080
   ```

## Persistent Data

The bot stores session credentials in `sessions/` and settings in `data/settings.db` relative to the server's working directory. On Railway, these files are stored on the persistent volume if you enable one in Railway settings.

**Important:** If you restart the server, the WhatsApp session will persist as long as the `sessions/` directory is preserved. Enable **Persistent Volume** in Railway service settings and mount it to `/app/sessions` and `/app/data`.

## Troubleshooting

### Build fails with `better-sqlite3` error
The `nixpacks.toml` installs `python3`, `build-essential`, and `libsqlite3-dev` to compile native modules. If the build still fails, try setting `NIXPACKS_NODE_VERSION=22` as a fallback.

### WhatsApp pairing code
On first deployment, the bot will print a pairing code in the Railway logs. Use this code to pair your WhatsApp account via the web client.

### Port mismatch
Railway automatically sets the `PORT` environment variable. The server reads it from `process.env.PORT`. If you want to override, set it in Railway's environment variables.
