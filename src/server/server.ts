import { existsSync } from "node:fs";
import { join } from "node:path";

const isProd = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 3000);

const distDir = join(process.cwd(), "dist", "client");
const indexPath = join(distDir, "index.html");

// Paths that look like a real static asset (recognized extension) 404 when
// missing rather than falling back to the SPA shell — see income-ledger's
// server.ts for the same rule and its rationale (a stale client asking for
// a chunk a newer deploy purged must fail loudly, not get HTML back as JS).
const ASSET_PATH_RE = /\.(js|css|map|png|jpg|jpeg|webp|svg|ico|woff2?)$/i;

/** GET /healthz: 200 "ok", ZERO dependency on the engine or any DB — see
 * CLAUDE.md hard rules. The deploy shim's health check must pass even if
 * ezBookkeeping (expense-ledger-engine) is briefly unreachable. Never make
 * this call out to the engine. */
function healthz(): Response {
  return new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8" } });
}

async function serveStatic(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const filePath = url.pathname === "/" ? indexPath : join(distDir, url.pathname);
  // Prevent path traversal: the resolved file must stay inside distDir.
  if (!filePath.startsWith(distDir)) return new Response("nope", { status: 400 });

  const f = Bun.file(filePath);
  if (await f.exists()) return new Response(f);

  if (ASSET_PATH_RE.test(url.pathname)) {
    return new Response("not found", { status: 404 });
  }

  // SPA fallback for any other (extensionless) navigation.
  return new Response(Bun.file(indexPath), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

/** The full request dispatcher, exported so tests can drive it directly
 * without a live socket — see server.test.ts, same pattern as
 * income-ledger's exported `api.handle`. Real /api routes (backed by
 * src/server/access.ts + src/server/engine.ts) get added here once the
 * frontend implementation lands. */
export async function fetchHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/healthz") return healthz();
  return serveStatic(req);
}

if (isProd && !existsSync(indexPath)) {
  console.error(`[fatal] missing ${indexPath}. Run \`bun run build\` first.`);
  process.exit(1);
}

// Only start a real listener when run directly (`bun src/server/server.ts`),
// not when imported by the test suite.
if (import.meta.main) {
  const server = Bun.serve({ port, fetch: fetchHandler });
  console.log(`▶︎ http://localhost:${server.port} (${isProd ? "prod" : "dev"})`);
}
