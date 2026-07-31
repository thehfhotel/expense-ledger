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
default in production (see docker-compose.yml). `EBK_SECURITY_ENABLE_API_TOKEN`
also defaults to `true` there (upstream defaults `security.enable_api_token`
to `false`, which rejects API-type tokens outright — `pkg/middlewares/
authorization.go` — and the frontend's `src/server/engine.ts` sends exactly
that kind of token on every call). To create the single ledger account:

**Ordering matters**: `EBK_SECURITY_SECRET_KEY` must already be its FINAL
production value (see "Gotchas" below) before step 3 mints a token — rotating
the secret key invalidates every previously issued token, so a token minted
before the key is finalized stops working the moment the key changes.

1. On evergreen, temporarily flip registration on and restart just the
   engine: `EBK_USER_ENABLE_REGISTER=true docker compose up -d engine` (or
   edit the deployed `.env` and re-run `docker compose up -d engine`, then
   revert).
2. Reach the engine over the loopback host-port mapping (`127.0.0.1:4051`) —
   e.g. an SSH tunnel from your laptop — and register the one account through
   ezBookkeeping's own UI.
3. Sign in, then **Settings > API token** and mint a token as
   **non-expiring** (`expiresInSeconds=0` — pick "never expires" if the UI
   offers an expiry choice; an expiring token silently breaks the frontend's
   engine client the moment it lapses, surfacing as `engine_unreachable`).
   That value is `ENGINE_API_TOKEN` — set it as a GitHub secret and redeploy
   so the frontend's `src/server/engine.ts` client can use it.
4. Set `EBK_USER_ENABLE_REGISTER` back to `false` (the compose default) and
   redeploy, so the registration page can never create a second account.

## Migration runbook

One-time (or monthly, for a new month's workbook) steps to seed the chart of
accounts/categories and import a paper Excel workbook into the engine.
`scripts/seed.ts` and `scripts/import-workbook.ts` are plain `bun` scripts —
they talk to the engine directly over its loopback host-port mapping
(`127.0.0.1:4051`), the same way an operator reaches it in the "First-boot
procedure" above (from evergreen itself, or an SSH tunnel from your laptop).
They read `EBK_URL` (defaults to `http://127.0.0.1:4051`) and `EBK_TOKEN` —
`EBK_TOKEN` can be the exact same API token minted in first-boot step 3
(the one set as the `ENGINE_API_TOKEN` GitHub secret); it's just exported
under a different env var name here because these scripts run from an
operator's shell, not inside the frontend container. Both scripts default to
a dry-run that only reads from the engine and prints a plan — pass `--apply`
to actually write.

Exact order:

1. **Engine up.** `docker compose up -d engine` (or confirm it's already
   running: `docker compose ps`).
2. **Registration temporarily on** — see "First-boot procedure" step 1.
3. **Create the ledger user** through ezBookkeeping's own UI over
   `127.0.0.1:4051` — "First-boot procedure" step 2.
4. **Mint a token** — Settings > API token in that UI ("First-boot
   procedure" step 3). Export it locally:
   ```sh
   export EBK_URL=http://127.0.0.1:4051   # or your SSH tunnel's local port
   export EBK_TOKEN=<the token you just minted>
   ```
5. **Seed the chart of accounts/categories** (idempotent — safe to re-run):
   ```sh
   bun scripts/seed.ts            # dry-run: prints what it would create
   bun scripts/seed.ts --apply    # creates the 16 primary + secondary
                                   # expense categories and the two
                                   # accounts (เงินสด, ธนาคาร) from
                                   # scripts/categories.json
   ```
6. **Import the month's workbook:**
   ```sh
   bun scripts/import-workbook.ts --file <path-to-workbook.xlsx>            # dry-run
   bun scripts/import-workbook.ts --file <path-to-workbook.xlsx> --apply    # writes + reconciles
   ```
   Re-importing the same month refuses with a clear error unless you pass
   `--force` (which first deletes exactly that month's previously-imported
   transactions, identified by their `import:<YYYY-MM>` tag, before
   re-importing).
7. **The reconciliation table printed at the end of `--apply` must be
   all-zero diffs.** If any row shows a nonzero diff, the script exits 1 —
   treat that month as NOT safely imported until it's investigated (the
   likely causes are a categories.json / column mapping drift, or a
   partially-failed write) and re-run with `--force` once fixed.
8. **Registration off** — set `EBK_USER_ENABLE_REGISTER` back to `false` and
   redeploy, exactly as in "First-boot procedure" step 4.

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

The frontend's `src/server/engine.ts` also wraps the following, verified the
same way (tag `v1.6.1`) and cross-checked against `scripts/lib/ezbk-client.ts`
(the migration scripts' independently-sourced client, which cites
`pkg/models/transaction.go`, `transaction_category.go`, `account.go` and
`pkg/core/context_web.go` directly):

- **Month transaction list**: `GET /api/v1/transactions/list/by_month.json?
  year=&month=&type=3` returns the WHOLE month in one call (no page/count
  cap) — unlike the general `transactions/list.json`, which caps at 50 and
  needs a page loop. `type=3` is `TRANSACTION_TYPE_EXPENSE` (the
  `pkg/models/transaction.go` enum: `MODIFY_BALANCE=1, INCOME=2, EXPENSE=3,
  TRANSFER=4`).
- **Categories**: `GET /api/v1/transaction/categories/list.json?type=2`
  (`CATEGORY_TYPE_EXPENSE=2` — a SEPARATE enum from the transaction type
  above, `pkg/models/transaction_category.go`: `INCOME=1, EXPENSE=2,
  TRANSFER=3`) returns a response **keyed by stringified category type**
  (`result["2"]`), each entry a primary category with a nested
  `subCategories[]`. This app's 21 leaves are seeded (`scripts/seed.ts`) as
  one secondary per `src/shared/categories.ts` group — named by `building`
  for the three building-scoped groups (water/electricity/phone) or by the
  same label as the primary otherwise — so `engine.ts` matches on
  `(primary.name === label, secondary.name === building ?? label)`, never a
  hardcoded id.
- **Accounts**: `GET /api/v1/accounts/list.json` — `category` is a plain
  numeric `AccountCategory` enum (`pkg/models/account.go`: `CASH=1,
  CHECKING=2`); this app's two seeded accounts (เงินสด / ธนาคาร) are matched
  on that field, not by name.
- **Create/modify/delete**: `POST /transactions/add.json` /
  `/transactions/modify.json` / `/transactions/delete.json`. Modify is a
  FULL OVERWRITE (every field required, not a patch) — `engine.ts` fetches
  the current transaction (`GET /transactions/get.json?id=`) before any
  single-field edit or photo attach/detach so untouched fields are resent
  unchanged. `time` is Unix seconds; `sourceAmount` is the smallest currency
  unit, numerically identical to this app's own satang for THB.
- **Timezone headers**: `X-Timezone-Name` (e.g. `Asia/Bangkok`) and
  `X-Timezone-Offset` (minutes, `420` for Bangkok) are sent on every call —
  `pkg/core/context_web.go`'s `GetClientTimezone()` is consulted broadly
  across transaction/account endpoints and errors without a resolvable one.

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
- `security.enable_api_token` (`EBK_SECURITY_ENABLE_API_TOKEN`) defaults to
  `false` upstream, which makes `pkg/middlewares/authorization.go` reject
  API-type tokens outright — the exact kind `src/server/engine.ts` sends as
  a Bearer credential on every call. docker-compose.yml and deploy.yml both
  default this to `true`; don't unset it or the frontend's engine client
  fails every request even with a valid, non-expired `ENGINE_API_TOKEN`.
- **Fresh-volume first boot crash-loops the engine** unless
  `docker-compose.yml`'s `engine-init` one-shot service runs first. Upstream's
  `docker/docker-entrypoint.sh` (verified at tag `v1.6.1`) execs the server
  directly with no setup step, and its `Dockerfile` only pre-creates the
  *default* `/ezbookkeeping/storage` at build time — it has no idea we've
  redirected storage to `/ezbookkeeping/data/storage` via
  `EBK_STORAGE_LOCAL_FILESYSTEM_PATH` (see the gotcha above). On a brand new
  `expense_data` volume that directory doesn't exist, so the engine refuses
  to boot with `cannot load configuration, because invalid local file
  system storage path` and restarts forever. `engine-init` runs
  `mkdir -p /ezbookkeeping/data/storage` against the same volume (using the
  same pinned engine image, so its shell/user behavior needs no separate
  verification) and `engine` only starts once it exits 0
  (`depends_on: engine-init: condition: service_completed_successfully`).
  It's a no-op on every later deploy since the directory already exists —
  safe to leave in place permanently, not just for the first boot.
