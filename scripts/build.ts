// Placeholder build step. Today it just copies the static client shell into
// dist/client — src/server/server.ts already serves whatever ends up there,
// unchanged, so a real bundler (React, Tailwind, whatever the frontend
// implementation agent picks) can replace this file's guts later without
// touching the server.
import { mkdir, cp } from "node:fs/promises";

const outDir = "dist/client";
await mkdir(outDir, { recursive: true });
await cp("src/client/index.html", `${outDir}/index.html`);

console.log(`built -> ${outDir}/index.html`);
