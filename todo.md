# Sticker — Railway Deployment Fix (Round 2)

## Fix railpack build failure ("railpack process exited with an error")
- [x] Add `packageManager` field to root package.json (pin to pnpm@9.15.9)
- [x] Clean pnpm-workspace.yaml: remove minimumReleaseAge, remove Replit catalog entries
- [x] Add zod to catalog (needed by lib/api-zod)
- [x] Remove deployAptPackages (not a valid root-level field in railpack.json)
- [x] Verify `pnpm install --frozen-lockfile` still works
- [x] Verify `pnpm --filter @workspace/api-server run build` still works
- [ ] Push changes to GitHub
