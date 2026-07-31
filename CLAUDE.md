# Claude Code Instructions — Expense Ledger (`expense-ledger`)

## What this is

HF Hotel's company expense ledger. A custom Bun frontend
(`src/server/server.ts` + a client the frontend implementation agent builds
out under `src/client/`) talks to a headless
[ezBookkeeping](https://ezbookkeeping.mayswind.net/) engine
(`expense-ledger-engine`, `mayswind/ezbookkeeping` mirrored to our own GHCR
and pinned by digest) over the compose `default` network. The engine owns
accounts, categories, transactions, and receipt photo storage; this repo's
server never talks to a database of its own — everything durable lives in the
engine, reached only through `src/server/engine.ts`.

Stack: Bun runtime, 2-stage `oven/bun` Dockerfile, forced-command SSH deploy
to evergreen (same pattern as `income-ledger` / `hf-erp-portal` /
`room-daily-reporter`).

## Identity table

| Item | Value |
|---|---|
| Hostname | `expense.thehfhotel.org` |
| Host port (frontend) | `4050` |
| Engine host port | `127.0.0.1:4051` (loopback only) |
| Frontend container | `expense-ledger` (internal `:3000`) |
| Engine container | `expense-ledger-engine` (internal `:8080`) |
| Volume | `expense_data:/ezbookkeeping/data` |
| Frontend image | `ghcr.io/thehfhotel/expense-ledger` |
| Engine image | `ghcr.io/thehfhotel/ezbookkeeping` (pinned by digest) |

See README.md for the full first-boot / upgrade / backup procedures.

## Commands

```sh
bun install
bun run dev          # Bun --hot on http://localhost:3000
bun run build         # scripts/build.ts -> dist/client
bun run start          # NODE_ENV=production bun src/server/server.ts
bun run typecheck      # tsc --noEmit
bun test
```

CI runs typecheck, `bun test`, then build, in that order, so broken code
cannot reach prod (`.github/workflows/ci.yml` on every push/PR,
`.github/workflows/deploy.yml`'s build job on `main`).

## Hard rules

- **`GET /healthz` stays engine-free and DB-free.** It lives outside any
  `/api` prefix, needs no auth, and must respond even if
  `expense-ledger-engine` is briefly unavailable — the deploy shim only
  retries a bounded number of times. Never make it call out to the engine.
  See `src/server/server.ts`.
- **UI language is Thai only**, matching income-ledger's convention for this
  estate's front-of-house tools. No `name_en` field, no English-first copy.
- **No CSP header.** The estate shell script (`hf-bar.js`, served from
  `erp.thehfhotel.org/shell/*`) must load unrestricted, same rule as every
  other estate app under the erp shell.
- **The engine must never be reachable off-host.** Its compose service joins
  only the `default` network (never `shared-nginx`), and its host-port
  mapping is `127.0.0.1:4051:8080` — loopback only. Do not add a public
  hostname, do not join it to `shared-nginx`, do not widen that port
  mapping.
- **`ENGINE_API_TOKEN` is a server-only secret.** The frontend's
  `src/server/engine.ts` is the ONLY thing that may hold or send it.  Never
  forward it to the browser (no embedding in client JS, no proxying it
  through a client-readable header, no logging it). Every engine call must
  originate server-side.
- **Never commit secrets.** `.env` is gitignored; `.env.example` carries
  empty placeholders only. Runtime env (`ENGINE_API_TOKEN`, `ACCESS_AUD`,
  `ACCESS_TEAM_DOMAIN`, `EBK_SECURITY_SECRET_KEY`) is materialized into the
  container's `.env` by `.github/workflows/deploy.yml` from GitHub secrets —
  reference locations, never values, in this repo.
- **This repo is public.** Keep LAN IPs, internal network topology, and
  `hostnames.json`-level Cloudflare details out of it — that context lives
  in the (private) `HF-erp` repo, which owns Cloudflare-as-code for the
  whole estate. Public hostname and container names are fine to state.
- **No emojis anywhere** — UI text, code, comments, commit messages.
- **The engine image is pinned by digest, never a moving tag.** Bumping it
  is a deliberate action via `.github/workflows/mirror-engine.yml` — see
  README.md "Upgrade procedure". Don't hand-edit the digest without running
  that workflow first (a digest that was never actually mirrored to our GHCR
  will fail to pull).
- **`github.com/thehfhotel/ezbookkeeping` (the source fork) is insurance
  only.** We consume upstream's published image via our GHCR mirror; we do
  not build images from the fork under normal operation. Only fall back to
  building from it if upstream's Docker Hub image disappears.
