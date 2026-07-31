# Expense Ledger

HF Hotel's company expense ledger: a custom Bun frontend backed by a headless
[ezBookkeeping](https://ezbookkeeping.mayswind.net/) engine. Public repo — see
CLAUDE.md's public-repo hygiene rule (no LAN IPs, no internal topology).

## Identity table

| Item | Value |
|---|---|
| Hostname | `expense.thehfhotel.org` |
| Host port (frontend) | `4050` |
| Engine host port | `127.0.0.1:4051` (loopback only, never public) |
| Frontend container | `expense-ledger` (internal `:3000`) |
| Engine container | `expense-ledger-engine` (internal `:8080`) |
| Volume | `expense_data:/ezbookkeeping/data` (engine's SQLite + storage) |
| Frontend image | `ghcr.io/thehfhotel/expense-ledger` (+`:buildcache`) |
| Engine image | `ghcr.io/thehfhotel/ezbookkeeping` (our GHCR mirror of upstream, pinned by digest) |
| Engine source fork | `github.com/thehfhotel/ezbookkeeping` (insurance only — see "Upgrade procedure") |

## Commands

```sh
bun install
bun run dev          # Bun --hot on http://localhost:3000
bun run build         # scripts/build.ts -> dist/client
bun run start          # NODE_ENV=production bun src/server/server.ts
bun run typecheck      # tsc --noEmit
bun test               # bun:sqlite-free — server.test.ts drives fetchHandler directly
```

CI (`.github/workflows/ci.yml`) runs typecheck, `bun test`, then build, on every
push and PR. `.github/workflows/deploy.yml` runs the same gate before pushing
the frontend image and deploying — a red test suite cannot reach production.

**Repo status**: the deploy job will fail on GitHub Actions until the
one-time host setup below is done (SSH key + forced-command shim on
evergreen) and the `EVERGREEN_EXPENSE_LEDGER_DEPLOY_SSH_KEY` /
`EVERGREEN_HOST_KEY` secrets exist on this repo. That is expected for a
freshly-created repo — CI (typecheck/test/build) still passes and gates PRs
either way.

## One-time host setup (evergreen)

Same forced-command SSH deploy pattern as every other estate app (income-ledger,
hf-erp-portal, payroll, room-daily-reporter) — each app gets its **own**
ed25519 key pinned to its **own** forced-command shim; see `HF-erp/DEPLOY.md`
for the full walkthrough (that repo owns the shim template,
`scripts/deploy/run-deploy.sh`, and the estate's Cloudflare-as-code).

```sh
# 1. Generate a NEW ed25519 key for this app.
ssh-keygen -t ed25519 -a 100 -f /tmp/evergreen-expense-ledger-deploy \
  -C "gh-actions@thehfhotel-expense-ledger" -N ""

# 2. On evergreen as root: install a shim adapted from HF-erp's
#    scripts/deploy/run-deploy.sh template at
#    /srv/run-deploy-expense-ledger.sh (owned root:root, mode 755). Unlike
#    the portal's shim (a static SPA with no runtime secrets), this app's
#    tarball includes a .env — the shim's extract step must place BOTH
#    docker-compose.yml and .env into the deploy dir, then
#    `docker compose up -d --remove-orphans`, then poll
#    http://localhost:4050/healthz.

# 3. APPEND an entry to /home/deploy/.ssh/authorized_keys pinning the new
#    key to the shim:
sudo tee -a /home/deploy/.ssh/authorized_keys > /dev/null <<'EOF'
command="/srv/run-deploy-expense-ledger.sh",restrict ssh-ed25519 PUBKEY_FROM_STEP_1 gh-actions@thehfhotel-expense-ledger
EOF

# 4. Add GitHub secrets on this repo:
#    EVERGREEN_EXPENSE_LEDGER_DEPLOY_SSH_KEY  - private half of the key from step 1
#    EVERGREEN_HOST_KEY                        - already exists org-wide, reuse it
#    ENGINE_API_TOKEN, ACCESS_AUD, ACCESS_TEAM_DOMAIN (optional, has a default),
#    EBK_SECURITY_SECRET_KEY                   - see "First-boot procedure" below
```

`GITHUB_TOKEN` is provided automatically (GHCR push/pull).

## First-boot procedure

The engine ships with no users and `EBK_USER_ENABLE_REGISTER=false` by
default in production (see docker-compose.yml). To create the single ledger
account:

1. On evergreen, temporarily flip registration on and restart just the
   engine: `EBK_USER_ENABLE_REGISTER=true docker compose up -d engine` (or
   edit the deployed `.env` and re-run `docker compose up -d engine`, then
   revert).
2. Reach the engine over the loopback host-port mapping (`127.0.0.1:4051`) —
   e.g. an SSH tunnel from your laptop — and register the one account through
   ezBookkeeping's own UI.
3. Sign in, then **Settings > API token** and mint a token. That value is
   `ENGINE_API_TOKEN` — set it as a GitHub secret and redeploy so the
   frontend's `src/server/engine.ts` client can use it.
4. Set `EBK_USER_ENABLE_REGISTER` back to `false` (the compose default) and
   redeploy, so the registration page can never create a second account.

## Upgrade procedure (engine)

The engine image is consumed from our own GHCR mirror, pinned by digest in
`docker-compose.yml` — never a moving tag, and never built from our source
fork.

1. Check upstream's release notes
   (`github.com/mayswind/ezbookkeeping/releases`) for the new version, and
   check Dependabot alerts on our source fork
   (`github.com/thehfhotel/ezbookkeeping`) for anything urgent. The fork
   exists purely as insurance if upstream ever disappears — we do not build
   images from it under normal operation.
2. Run the mirror workflow for the new tag (Docker Hub tag naming has no
   leading `v`, e.g. `1.7.0`):
   ```sh
   gh workflow run mirror-engine.yml -f tag=1.7.0
   ```
3. Once it succeeds, read the digest it printed to the job summary and bump
   the `engine.image` line in `docker-compose.yml` to
   `ghcr.io/thehfhotel/ezbookkeeping@sha256:<new digest>`.
4. Commit, push, let the normal deploy pipeline ship the compose change,
   then verify the engine container came up healthy
   (`docker compose ps`, `curl http://localhost:4051/healthz.json` from the
   host).

## Backup

Nightly `tar` of the `expense_data` Docker volume — mirrors income-ledger's
arrangement for `ledger_data`. It holds the engine's SQLite database
(`/ezbookkeeping/data/ezbookkeeping.db`) and, per `EBK_STORAGE_LOCAL_FILESYSTEM_PATH`
in docker-compose.yml, all uploaded receipt photos under
`/ezbookkeeping/data/storage` — everything the engine owns lives under that
one mount, so one volume backup covers both the ledger and every receipt
image.

## ezBookkeeping API notes (dev reference)

Verified against the upstream source at tag `v1.6.1`
(`pkg/api/transaction_pictures.go`, `cmd/webserver.go`,
`pkg/models/transaction_picture_info.go`) — the frontend needs this for
receipt-photo upload, wrapped by `src/server/engine.ts`'s
`uploadTransactionPicture()`:

- **Endpoint**: `POST /api/v1/transaction/pictures/upload.json`
- **Auth**: `Authorization: Bearer <token>` (an ezBookkeeping API token or
  session JWT — same auth as every other `/api/v1/*` route)
- **Request**: `multipart/form-data` with a file field named `picture`
  (required, non-empty, must be a supported image extension), plus an
  optional `clientSessionId` string field the engine uses to dedupe a
  double-submit of the same upload.
- **Response** (ezBookkeeping's standard envelope): on success,
  `{ "success": true, "result": { "pictureId": "<int64 as string>",
  "originalUrl": "<url>" } }`; on failure, `{ "success": false, "errorCode":
  <int>, "errorMessage": "<string>" }` (e.g. no file, empty file, file too
  large, or an unsupported image type).
- Gated server-side by `user.enable_transaction_picture` (default `true`)
  and bounded by `user.max_transaction_picture_size` (default 10 MiB) in the
  engine's own config — both untouched by this repo, upstream defaults.

Full HTTP API reference: <https://ezbookkeeping.mayswind.net/httpapi/>.

## Gotchas

- The engine's default local-filesystem storage path (`storage/`, for
  receipt photos and avatars) resolves to `/ezbookkeeping/storage` —
  **outside** the mounted `expense_data` volume, which only covers
  `/ezbookkeeping/data`. docker-compose.yml sets
  `EBK_STORAGE_LOCAL_FILESYSTEM_PATH=/ezbookkeeping/data/storage` to
  redirect it inside the mount; do not remove that env var or receipt
  photos will vanish on the next container recreation.
- `security.secret_key` (`EBK_SECURITY_SECRET_KEY`) falls back to the
  literal, publicly-known string `"ezbookkeeping"` if left unset — the
  engine boots fine either way, but that default is insecure for anything
  holding real financial data. Always set it once the ledger has real
  content.
