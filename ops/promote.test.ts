// C199: planning logic of ops/promote.ts (no network, no Railway).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adminReachable,
  CI_CONTEXT,
  checkIndex,
  ciGreen,
  INDEX_URL,
  indexProblems,
  ORDER,
  OWNER,
  parseArgs,
  parseSet,
  planSteps,
  previousRule,
  type ReleaseSet,
  recordPath,
  rollbackCommand,
  smokeHost,
} from "./promote.ts";

const sha = (c: string) => c.repeat(40);
const base = (over: Record<string, unknown> = {}) => ({
  id: "RS-2",
  createdAt: "2026-10-15T10:00:00Z",
  notes: "test",
  portalCore: { repo: "opt2-tealbrick-portal-core", sha: sha("a") },
  portalGui: { repo: "opt2-tealbrick-portal-gui", sha: sha("b") },
  website: { repo: "opt2-tealbrick-website", sha: sha("c") },
  bridge: { version: "0.1.29" },
  apps: [
    { product: "connect", version: "0.5.8" },
    { product: "knowledge", version: "0.1.19" },
  ],
  cli: { version: "0.1.22" },
  previous: "RS-1",
  ...over,
});

test("parseSet: a valid set passes; RS-1 has previous null", () => {
  const s = parseSet(base());
  assert.equal(s.id, "RS-2");
  assert.equal(s.previous, "RS-1");
  assert.equal(parseSet(base({ id: "RS-1", previous: null })).previous, null);
});

test("parseSet: lists every problem", () => {
  const err = (() => {
    try {
      parseSet(
        base({
          id: "R-2",
          portalCore: { repo: "portal-core", sha: "abc" },
          bridge: { version: "0.1.29-dev.1" },
          apps: [
            { product: "connect", version: "0.5.8" },
            { product: "connect", version: "0.5.8" },
          ],
        }),
      );
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  })();
  for (const want of ["id must be RS-<n>", "portalCore.repo", "portalCore.sha", "bridge.version", "listed twice"]) assert.ok(err.includes(want), want);
});

test("parseSet: previous must be the set before", () => {
  assert.throws(() => parseSet(base({ previous: "RS-0" })), /previous must be RS-1/);
  assert.throws(() => parseSet(base({ id: "RS-1", previous: "RS-0" })), /RS-1 has no previous/);
  assert.throws(() => parseSet(base({ apps: [] })), /non-empty/);
});

test("planSteps: fixed order core → gui → website; running SHA is skipped (set without admin-gui)", () => {
  const s = parseSet(base());
  const steps = planSteps(s, { "portal-core": sha("a"), "portal-gui": sha("9"), website: null });
  assert.deepEqual(
    steps.map((x) => x.service),
    ["portal-core", "portal-gui", "website"],
  );
  assert.deepEqual(ORDER, ["portal-core", "admin-gui", "portal-gui", "website"]);
  assert.deepEqual(
    steps.map((x) => x.skip),
    [true, false, false],
  );
  assert.equal(steps[1]?.sha, sha("b"));
  // C206 --repoint: nothing is skipped, so every service is redeployed from its (org) source at the same SHA
  assert.deepEqual(
    planSteps(s, { "portal-core": sha("a"), "portal-gui": sha("b"), website: sha("c") }, true).map((x) => x.skip),
    [false, false, false],
  );
});

test("planSteps: a set with adminGui deploys core → admin-gui → gui → website", () => {
  const s = parseSet(base({ adminGui: { repo: "opt2-tealbrick-admin", sha: sha("e") } }));
  const steps = planSteps(s, { "admin-gui": sha("e") });
  assert.deepEqual(
    steps.map((x) => `${x.service}:${x.skip}`),
    ["portal-core:false", "admin-gui:true", "portal-gui:false", "website:false"],
  );
  assert.throws(() => parseSet(base({ adminGui: { repo: "admin", sha: "x" } })), /adminGui.repo[\s\S]*adminGui.sha/);
});

test("ciGreen: the newest Woodpecker ci result (push or manual) decides", () => {
  assert.equal(
    ciGreen([
      { context: CI_CONTEXT, state: "failure", updated_at: "2026-10-16T17:07:53Z" },
      { context: "ci/woodpecker/manual/ci", state: "success", updated_at: "2026-10-16T17:43:25Z" },
    ]),
    true,
  );
  assert.equal(
    ciGreen([
      { context: CI_CONTEXT, state: "failure", updated_at: "2026-10-16T18:00:00Z" },
      { context: "ci/woodpecker/manual/ci", state: "success", updated_at: "2026-10-16T17:43:25Z" },
    ]),
    false,
  );
});

test("ciGreen: only the Woodpecker ci contexts count", () => {
  assert.equal(ciGreen([{ context: CI_CONTEXT, state: "success" }]), true);
  assert.equal(ciGreen([{ context: CI_CONTEXT, state: "pending" }]), false);
  assert.equal(ciGreen([{ context: "other", state: "success" }]), false);
  assert.equal(ciGreen([]), false);
});

test("checkIndex: stable + digest required for bridge and every app", () => {
  const s = parseSet(base());
  const dig = `@sha256:${"d".repeat(64)}`;
  const releases = [
    { kind: "bridge", product: "bridge", version: "0.1.29", channel: "stable", image: `ghcr.io/x/bridge${dig}` },
    { kind: "app", product: "connect", version: "0.5.8", channel: "stable", image: `ghcr.io/x/connect${dig}` },
    { kind: "app", product: "knowledge", version: "0.1.19", channel: "dev", image: `ghcr.io/x/knowledge${dig}` },
  ];
  assert.deepEqual(checkIndex(s, releases), ["knowledge@0.1.19 is not a stable app release in the index"]);
  const noDigest = releases.map((r) => (r.product === "connect" ? { ...r, image: "ghcr.io/x/connect:0.5.8" } : r));
  assert.ok(checkIndex(s, noDigest).includes("connect@0.5.8 has no image digest"));
  const ok = releases.map((r) => ({ ...r, channel: "stable" }));
  assert.deepEqual(checkIndex(s, ok), []);
});

test("rollbackCommand + recordPath", () => {
  const s: ReleaseSet = parseSet(base());
  assert.equal(rollbackCommand(s, "/x/releases/RS-2.json"), "node ops/promote.ts --rollback --set /x/releases/RS-1.json");
  assert.match(rollbackCommand(parseSet(base({ id: "RS-1", previous: null })), "/x/releases/RS-1.json"), /no previous set/);
  assert.equal(recordPath("/x/releases/RS-2.json", "RS-2"), "/x/releases/RS-2.promoted.json");
  assert.equal(recordPath("/x/releases/RS-2.json", "RS-2", true), "/x/releases/RS-2.repointed.json", "C206: the promotion record is kept");
});

test("parseArgs: --set required and named RS-<n>.json; production (dev) refused", () => {
  assert.deepEqual(parseArgs(["--set", "r/RS-3.json"]), { setFile: "r/RS-3.json", environment: "live", dryRun: false, repoint: false, rollback: false });
  assert.equal(parseArgs(["--set", "r/RS-3.json", "--repoint"]).repoint, true);
  assert.equal(parseArgs(["--set", "r/RS-3.json", "--dry-run"]).dryRun, true);
  assert.throws(() => parseArgs([]), /--set/);
  assert.throws(() => parseArgs(["--set", "r/set.json"]), /RS-<n>.json/);
  assert.throws(() => parseArgs(["--set", "r/RS-3.json", "--environment", "production"]), /DEV/);
  assert.throws(() => parseArgs(["--set", "r/RS-3.json", "--force"]), /unknown option/);
});

test("parseSet: cli.repo optional, must be an opt2 repo", () => {
  assert.equal(parseSet(base({ cli: { version: "0.1.22", repo: "opt2-tealbrick-bridge" } })).cli.repo, "opt2-tealbrick-bridge");
  assert.throws(() => parseSet(base({ cli: { version: "0.1.22", repo: "evil/repo" } })), /cli.repo/);
});

test("C206: promote reads and deploys from the Tealbrick org", () => {
  assert.equal(OWNER, "Tealbrick");
  assert.equal(INDEX_URL, "https://github.com/Tealbrick/opt2-tealbrick-platform/releases/download/registry/index.json");
});

test("--rollback: app-index problems become warnings; services still checked", () => {
  assert.equal(parseArgs(["--set", "r/RS-1.json", "--rollback"]).rollback, true);
  assert.equal(parseArgs(["--set", "r/RS-2.json"]).rollback, false);
  const p = ["fleet@0.1.10 is not a stable app release in the index"];
  assert.deepEqual(indexProblems(p, true), { fatal: [], warnings: p });
  assert.deepEqual(indexProblems(p, false), { fatal: p, warnings: [] });
});

test("smokeHost: custom non-www first, then the Railway domain, then www", () => {
  assert.equal(smokeHost(["www.tealbrick.com", "tealbrick.com"], ["website-live.up.railway.app"]), "tealbrick.com");
  assert.equal(smokeHost(["www.tealbrick.com"], ["website-live.up.railway.app"]), "website-live.up.railway.app");
  assert.equal(smokeHost(["www.tealbrick.com"], []), "www.tealbrick.com");
  assert.equal(smokeHost([], []), null);
});

test("adminReachable: 200, or the Cloudflare Access login", () => {
  assert.equal(adminReachable(200, null), true);
  assert.equal(adminReachable(302, "https://tealbrick.cloudflareaccess.com/cdn-cgi/access/login/be.tealbrick.com"), true);
  assert.equal(adminReachable(403, null), true);
  assert.equal(adminReachable(302, "https://evil.example/"), false);
  assert.equal(adminReachable(404, null), false);
  assert.equal(adminReachable(502, null), false);
});

test("hotfix sets: RS-7.1 → RS-7, RS-7.2 → RS-7.1, RS-8 → RS-7 or RS-7.<h>", () => {
  assert.deepEqual(previousRule("RS-7.1"), { exact: "RS-7" });
  assert.deepEqual(previousRule("RS-7.2"), { exact: "RS-7.1" });
  assert.deepEqual(previousRule("RS-8"), { major: 7 });
  assert.deepEqual(previousRule("RS-1"), { none: true });
  assert.equal(previousRule("RS-7.x"), null);
  assert.equal(parseSet(base({ id: "RS-7.1", previous: "RS-7" })).previous, "RS-7");
  assert.throws(() => parseSet(base({ id: "RS-7.1", previous: "RS-6" })), /previous must be RS-7/);
  assert.equal(parseSet(base({ id: "RS-8", previous: "RS-7.1" })).previous, "RS-7.1");
  assert.equal(parseSet(base({ id: "RS-8", previous: "RS-7" })).previous, "RS-7");
  assert.throws(() => parseSet(base({ id: "RS-8", previous: "RS-6.1" })), /RS-7 or one of its hotfixes/);
  assert.equal(parseArgs(["--set", "r/RS-7.1.json"]).setFile, "r/RS-7.1.json");
  assert.equal(rollbackCommand(parseSet(base({ id: "RS-7.1", previous: "RS-7" })), "/x/RS-7.1.json"), "node ops/promote.ts --rollback --set /x/RS-7.json");
});
