# Railway Deployment Guide — WhatsApp Sticker Bot

## Files Added (No Source Code Modified)

| File | Purpose |
|------|---------|
| `railpack.json` | Railway Railpack build/deploy configuration (auto-detected) |
| `.dockerignore` | Excludes unnecessary files from build context |

## How Railway Deploys This Project

Railway automatically detects `railpack.json` in the repo root and uses it as the build plan. The configuration:

1. **Setup** — Sets Node.js 24, installs system dependencies (`build-essential`, `libsqlite3-dev`, `python3`) required by native packages (`better-sqlite3`, `sharp`).
2. **Install** — Enables Corepack and runs `pnpm install --frozen-lockfile` at the monorepo root.
3. **Build** — Runs TypeScript type-checking and builds the `api-server` artifact using esbuild.
4. **Start** — Starts the WhatsApp bot server via `pnpm --filter @workspace/api-server run start`.

## Environment Variables to Set on Railway

| Variable | Description | Example |
|----------|-------------|---------|
| `PORT` | **Required** — The port the server listens on | `8080` |
| `PHONE_NUMBER` | **Required** — WhatsApp account number in international format (no `+`) | `201044568121` |
| `NODE_ENV` | Set to `production` (Railway sets this automatically) | `production` |

> **Why `PHONE_NUMBER` is required:** The bot reads the phone number from the SQLite settings database (`data/settings.db`). On Railway, this file does not exist on first boot unless you use a Persistent Volume. Setting `PHONE_NUMBER` as an environment variable ensures the bot can request its pairing code even without a pre-existing database.

## Steps to Deploy on Railway

### Option A: Via GitHub (Recommended)

1. Push the new files to your GitHub repo:
   ```bash
   git add railpack.json .dockerignore
   git commit -m "Add Railway Railpack deployment configuration"
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
The `railpack.json` installs `python3`, `build-essential`, and `libsqlite3-dev` to compile native modules. If the build still fails, try setting `RAILPACK_NODE_VERSION=22` in Railway's environment variables.

### WhatsApp pairing code
On first deployment, the bot will print a pairing code in the Railway logs. Use this code to pair your WhatsApp account via the web client.

### Port mismatch
Railway automatically sets the `PORT` environment variable. The server reads it from `process.env.PORT`. If you want to override, set it in Railway's environment variables.
