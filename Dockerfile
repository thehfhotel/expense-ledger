# syntax=docker/dockerfile:1.7
# ────────────────────────────────────────────────────────────────────────────
# Build stage: install deps and produce dist/client.
# ────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS build

WORKDIR /app

COPY package.json bun.lock* bunfig.toml ./
RUN bun install --frozen-lockfile

COPY tsconfig.json build.ts ./
COPY src ./src
COPY scripts ./scripts

RUN bun run build

# ────────────────────────────────────────────────────────────────────────────
# Runtime stage: production-only deps + built client + server source.
# ────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile

COPY tsconfig.json ./
# Copies ALL of src/ (server + client), not a subset — a new top-level src/
# directory needs no Dockerfile change as a result. A new import path
# OUTSIDE src/ (or scripts/) DOES need a Dockerfile `COPY` added, in both
# stages (a missed one crash-loops prod at container start, not at build
# time — verify working before every deploy).
COPY src ./src
COPY scripts ./scripts
COPY --from=build /app/dist ./dist

EXPOSE 3000

# /healthz is DB- and engine-free by design (see src/server/server.ts) so
# this stays fast even if expense-ledger-engine is briefly unavailable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT}/healthz" >/dev/null 2>&1 || exit 1

CMD ["bun", "src/server/server.ts"]
