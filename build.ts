// Production client build: bundles src/client/index.html (React 19 +
// Tailwind v4) into dist/client, the shape src/server/server.ts's
// serveStatic() expects. Deliberately kept at the repo root, not under
// scripts/ — see CLAUDE.md for why (that directory is the migration
// tooling's, a disjoint concern from this build). Mirrors income-ledger's
// scripts/build.ts (same Bun.build + bun-plugin-tailwind pipeline); see
// that repo if this ever needs to grow a splitting/precompression story.
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";

const outdir = "dist/client";

rmSync("dist", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/client/index.html"],
  outdir,
  target: "browser",
  minify: true,
  sourcemap: "linked",
  plugins: [tailwind],
  publicPath: "/",
  naming: {
    entry: "[name]-[hash].[ext]",
    asset: "[name]-[hash].[ext]",
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  console.error("[build] failed");
  process.exit(1);
}

// Bun emits index-<hash>.html — rename to index.html for the server fallback.
for (const f of readdirSync(outdir)) {
  if (/^index-[a-z0-9]+\.html$/i.test(f)) {
    renameSync(join(outdir, f), join(outdir, "index.html"));
    break;
  }
}

// Bun's HTML bundler emits relative asset URLs (./chunk-xxx.js) regardless
// of publicPath. Landing on a nested SPA route like /month/2026-07 makes the
// browser resolve "./chunk-xxx.js" to "/month/chunk-xxx.js", which 404s and
// blanks the page. Rewrite ./ -> / so asset URLs are absolute from the
// document root — same fix income-ledger's build carries for the same
// reason (its nested routes are /:property/day/:date etc).
{
  const indexPath = join(outdir, "index.html");
  if (existsSync(indexPath)) {
    let html = readFileSync(indexPath, "utf8");
    html = html.replace(/(href|src)="\.\/(?!\/)/g, '$1="/').replace(/(href|src)='\.\/(?!\/)/g, "$1='/");
    writeFileSync(indexPath, html);
  }
}

console.log(`[build] artifacts in ${outdir}`);
for (const f of readdirSync(outdir)) console.log("  -", f);
