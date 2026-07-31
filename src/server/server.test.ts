// Server route tests. Mirrors income-ledger's src/server/server.test.ts
// pattern: drive the exported request handler directly, no live socket
// needed.

import { describe, expect, test } from "bun:test";
import { fetchHandler } from "./server.ts";

describe("GET /healthz", () => {
  test("returns 200 \"ok\" with no dependency on the engine or a DB", async () => {
    const res = await fetchHandler(new Request("http://localhost/healthz"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
