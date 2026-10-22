// Runs the engine conformance suite against the compose+Caddy fixture and prints the rows as JSON (exit 1 on any failing row).
//   node ops/engine/fixture/run.ts                       # static rows E-1..E-10 (CI, no Docker)
//   TB_FIXTURE_LIVE=1 TB_FIXTURE_IMAGE=<name@sha256:...> TB_FIXTURE_PORT=8080 TB_FIXTURE_CADDY_IMAGE=<caddy@sha256:...> \
//     TB_FIXTURE_STATE_DIR=<dir> node ops/engine/fixture/run.ts   # + live rows on a box with Docker
// The host agent's release gate runs the same `runConformance` against its Openship adapter (see ops/engine/README.md).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execRunner } from "../box.ts";
import { ComposeCaddyAdapter } from "./compose-caddy.ts";
import { runConformance } from "./conformance.ts";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const live = process.env.TB_FIXTURE_LIVE === "1";
  const adapter = new ComposeCaddyAdapter({
    r: execRunner,
    stateDir: process.env.TB_FIXTURE_STATE_DIR ?? mkdtempSync(join(tmpdir(), "tb-fixture-")),
    acmeEmail: process.env.TB_FIXTURE_ACME_EMAIL ?? "ops@example.net",
    caddyImage: process.env.TB_FIXTURE_CADDY_IMAGE ?? `caddy@sha256:${"0".repeat(64)}`,
  });
  const image = process.env.TB_FIXTURE_IMAGE;
  if (live && !image) {
    process.stderr.write("TB_FIXTURE_LIVE=1 needs TB_FIXTURE_IMAGE (a digest-pinned test image that answers GET /healthz)\n");
    process.exit(2);
  }
  const res = await runConformance(adapter, live && image ? { live: { image, port: Number(process.env.TB_FIXTURE_PORT ?? "8080") } } : {});
  process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  process.exit(res.ok ? 0 : 1);
}
