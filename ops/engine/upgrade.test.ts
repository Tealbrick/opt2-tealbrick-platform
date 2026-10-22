import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type EnginePin, engineReleases, type IndexRelease, validateEngines } from "../../ci/tb-ci.ts";
import { type FakeBox, makeBox, PIN_IMAGES } from "./fake-box.ts";
import { OVERRIDE_FILE, overrideYaml, runUpgrade, runUpgradeDrill } from "./upgrade.ts";

const noSleep = async () => undefined;
const ROLES = ["api", "dashboard", "edge", "postgres", "redis"] as const;

function pinRecord(over: { postgresUpstream?: string; images?: Record<string, string> } = {}): IndexRelease {
  const images = over.images ?? PIN_IMAGES;
  const pin = validateEngines([
    {
      product: "openship",
      version: "0.9.4",
      channel: "dev",
      artifact: {
        url: "https://github.com/Tealbrick/opt2-tealbrick-dist/releases/download/opt2-tealbrick-platform-engine-openship-v0.9.4/openship-0.9.4.tgz",
        sha256: `sha256:${"a".repeat(64)}`,
        integrity: `sha512-${"A".repeat(86)}==`,
      },
      images: ROLES.map((role) => ({
        role,
        image: (images as Record<string, string>)[role],
        upstream: role === "postgres" ? (over.postgresUpstream ?? "postgres:16-alpine") : `ghcr.io/oblien/openship-${role}:0.9.4`,
      })),
      noticeUrl: "https://example.com/NOTICE",
      decision: "C308",
      reviewedBy: "platform lead",
      reviewedAt: "2026-10-23T00:00:00Z",
      evidence: { h0: "h0-run.md" },
    },
  ])[0] as EnginePin;
  return engineReleases({ releases: [] }, [pin], { now: "2026-10-23T00:00:00.000Z", newId: () => "rel_01M5EEEEEEEEEEEEEEEEEEEEE0" }).add[0] as IndexRelease;
}

const deps = (box: FakeBox, pin: IndexRelease, extra: Record<string, unknown> = {}) => ({
  r: box.r,
  layout: box.layout,
  restic: box.restic,
  pin,
  sleep: noSleep,
  health: async () => box.state.apiHealthy,
  ...extra,
});
const imageOf = (box: FakeBox, name: string) => box.state.containers.find((c) => c.name === name)?.image;
const ran = (box: FakeBox, pred: (c: { cmd: string; args: string[] }) => boolean) => box.calls.some(pred);

test("override: one digest image per role, from the pin only", () => {
  const y = overrideYaml(pinRecord());
  for (const role of ROLES) assert.ok(y.includes(`  ${role}:\n    image: ${PIN_IMAGES[role]}`), role);
  assert.match(y, /services:/);
  assert.ok(!/:\d+\.\d+/.test(y.replace(/#.*$/gm, "")), "no tag form in the override");
});

test("upgrade: snapshot first, safety copy, pull before up, then the pinned set runs and the workspace is untouched", async () => {
  const box = makeBox();
  const pin = pinRecord();
  const res = await runUpgrade(deps(box, pin));
  assert.equal(res.ok, true, JSON.stringify(res.steps));
  assert.equal(res.from, "0.9.3");
  assert.equal(res.to, "0.9.4");
  assert.deepEqual(
    res.steps.map((s) => s.step),
    ["preflight", "backup", "safety-copy", "pull", "up", "health", "verify"],
  );
  // order of the real commands: restic backup < pg_dump (safety copy) < compose pull < compose up
  const idx = (pred: (c: { cmd: string; args: string[] }) => boolean) => box.calls.findIndex(pred);
  const iBackup = idx((c) => c.cmd === "restic" && c.args[0] === "backup");
  const iPull = idx((c) => c.args[0] === "compose" && c.args.includes("pull"));
  const iUp = idx((c) => c.args[0] === "compose" && c.args.includes("up"));
  assert.ok(iBackup >= 0 && iBackup < iPull && iPull < iUp);
  assert.ok(existsSync(join(box.layout.composeDir, OVERRIDE_FILE)));
  for (const role of ROLES) assert.equal(imageOf(box, role === "edge" ? "openship-edge" : `openship-${role}-1`), PIN_IMAGES[role]);
  assert.equal(imageOf(box, "openship-wsa-tb-bridge-1")?.startsWith("ghcr.io/tealbrick/opt2-tealbrick-bridge-server"), true, "workspace container untouched");
  assert.ok(
    ran(box, (c) => c.args[0] === "compose" && c.args.includes("-f") && c.args.some((a) => a.endsWith(OVERRIDE_FILE))),
    "our calls use the override files",
  );
  assert.ok(
    !ran(box, (c) => c.args.includes("openship") && (c.args.includes("up") || c.args.includes("upgrade")) && c.cmd === "openship"),
    "never `openship up/upgrade`",
  );
  // the safety copy and the log exist
  const runDir = join(box.layout.stateDir, "upgrade", res.runId);
  assert.ok(existsSync(join(runDir, "pre.dump")) && existsSync(join(runDir, "compose", ".env")) && existsSync(join(runDir, "pre-state.json")));
  const state = readFileSync(join(runDir, "pre-state.json"), "utf8");
  for (const secret of box.secrets) assert.ok(!state.includes(secret));
  assert.ok(readFileSync(join(box.layout.stateDir, "upgrades.jsonl"), "utf8").includes(res.runId));
});

test("upgrade: services are limited to what runs - a --no-ui box does not get a dashboard", async () => {
  const box = makeBox({ dashboard: false });
  const res = await runUpgrade(deps(box, pinRecord()));
  assert.equal(res.ok, true, JSON.stringify(res.steps));
  const up = box.calls.find((c) => c.args[0] === "compose" && c.args.includes("up"));
  assert.ok(up && !up.args.includes("dashboard") && up.args.includes("api") && up.args.includes("edge"));
});

test("upgrade: no off-box snapshot, no upgrade - nothing is written", async () => {
  const box = makeBox();
  box.state.failBackupCode = 3;
  const res = await runUpgrade(deps(box, pinRecord()));
  assert.equal(res.ok, false);
  assert.match(res.steps.find((s) => s.step === "failed")?.detail ?? "", /pre-upgrade off-box backup failed/);
  assert.ok(!existsSync(join(box.layout.composeDir, OVERRIDE_FILE)));
  assert.ok(!ran(box, (c) => c.args[0] === "compose"));
});

test("upgrade: a failed pull aborts before anything runs differently; the previous compose files stay", async () => {
  const box = makeBox();
  box.state.failPull = true;
  const res = await runUpgrade(deps(box, pinRecord()));
  assert.equal(res.ok, false);
  assert.equal(res.rolledBack, true);
  assert.ok(!ran(box, (c) => c.args[0] === "compose" && c.args.includes("up")), "no up");
  assert.ok(!ran(box, (c) => c.args.includes("pg_restore")), "the database was not touched");
  assert.equal(imageOf(box, "openship-api-1"), "ghcr.io/oblien/openship-api:0.9.3");
});

test("upgrade: unhealthy API after up -> rollback restores compose files and the database, old images run again", async () => {
  const box = makeBox();
  let up = 0;
  const base = deps(box, pinRecord());
  // healthy before, unhealthy while the new set runs, healthy again after the rollback
  const r = box.r;
  const wrapped = async (cmd: string, args: readonly string[], o?: Parameters<typeof r>[2]) => {
    const res = await r(cmd, args, o);
    if (cmd === "docker" && args[0] === "compose" && args.includes("up")) up++;
    box.state.apiHealthy = up !== 1;
    return res;
  };
  const res = await runUpgrade({ ...base, r: wrapped });
  assert.equal(res.ok, false);
  assert.equal(res.rolledBack, true, JSON.stringify(res.steps));
  assert.deepEqual(
    res.steps.map((s) => s.step),
    ["preflight", "backup", "safety-copy", "pull", "up", "failed", "rollback"],
  );
  assert.ok(ran(box, (c) => c.args.includes("pg_restore") && c.args.includes("--clean") && c.args.includes("--exit-on-error")));
  assert.ok(
    ran(box, (c) => c.args[0] === "compose" && c.args.includes("stop") && c.args.includes("api")),
    "writers stopped before the data is put back",
  );
  assert.equal(imageOf(box, "openship-api-1"), "ghcr.io/oblien/openship-api:0.9.3");
  assert.equal(imageOf(box, "openship-edge"), "ghcr.io/oblien/openship-edge:0.9.3");
  assert.ok(!box.state.tables.includes("public.migrated_new"), "the migrated schema is gone: the database came back from the dump");
});

test("upgrade: workspace containers that changed during the upgrade trigger the rollback", async () => {
  const box = makeBox();
  box.state.moveWorkspaceOnUp = true;
  const res = await runUpgrade(deps(box, pinRecord()));
  assert.equal(res.ok, false);
  assert.match(res.steps.find((s) => s.step === "failed")?.detail ?? "", /workspace containers changed during the upgrade: openship-wsa-tb-bridge-1/);
  assert.ok(res.steps.some((s) => s.step === "rollback"));
});

test("upgrade: a Postgres major change is refused before anything is done", async () => {
  const box = makeBox();
  const res = await runUpgrade(deps(box, pinRecord({ postgresUpstream: "postgres:17-alpine" })));
  assert.equal(res.ok, false);
  assert.match(res.steps.find((s) => s.step === "failed")?.detail ?? "", /Postgres major 16 -> 17/);
  assert.ok(!ran(box, (c) => c.cmd === "restic"), "not even a backup was started");
});

test("upgrade: a pin that is not digest-in-our-mirror is refused (engineEntryProblem)", async () => {
  const box = makeBox();
  const bad = pinRecord();
  const tagged = {
    ...bad,
    engine: {
      ...(bad.engine as object),
      images: (bad.engine?.images ?? []).map((i, n) => (n === 0 ? { ...i, image: "ghcr.io/oblien/openship-api:0.9.4" } : i)),
    },
  } as IndexRelease;
  const res = await runUpgrade(deps(box, tagged));
  assert.equal(res.ok, false);
  assert.match(res.steps.find((s) => s.step === "failed")?.detail ?? "", /pin refused/);
  assert.ok(!ran(box, (c) => c.cmd === "restic" || c.args[0] === "compose"));
});

test("upgrade: authenticated smoke path and token are used for the health gate and never put in argv", async () => {
  const box = makeBox();
  const seen: { url: string; token?: string }[] = [];
  const res = await runUpgrade({
    ...deps(box, pinRecord()),
    token: "tok-very-secret",
    smokePath: "/api/projects",
    health: async (url: string, token?: string) => {
      seen.push({ url, token });
      return true;
    },
  });
  assert.equal(res.ok, true, JSON.stringify(res.steps));
  assert.ok(seen.some((s) => s.url.endsWith("/api/projects") && s.token === "tok-very-secret"));
  assert.ok(!box.calls.some((c) => c.args.join(" ").includes("tok-very-secret")));
});

test("upgrade drill: forced failure must roll back and verify, then the real upgrade, then the restore drill on its snapshot", async () => {
  const box = makeBox();
  const res = await runUpgradeDrill({ ...deps(box, pinRecord()) });
  assert.equal(res.forcedFailure.ok, false);
  assert.equal(res.forcedFailure.rolledBack, true, JSON.stringify(res.forcedFailure.steps));
  assert.equal(res.upgrade?.ok, true, JSON.stringify(res.upgrade?.steps));
  assert.equal(res.restoreDrill?.snapshotId, res.upgrade?.snapshotId, "the restore drill checks the snapshot taken before the real upgrade");
  assert.equal(res.restoreDrill?.ok, true, JSON.stringify(res.restoreDrill?.checks.filter((c) => !c.ok)));
  assert.equal(res.ok, true);
  const log = readFileSync(join(box.layout.stateDir, "drills.jsonl"), "utf8");
  assert.ok(log.includes('"kind":"upgrade-drill"'));
});

test("upgrade drill: a forced failure that does NOT end in a verified rollback fails the drill and stops", async () => {
  const box = makeBox();
  const base = deps(box, pinRecord());
  const r = box.r;
  // the old API never comes back after the rollback
  const res = await runUpgradeDrill({
    ...base,
    health: async () => false,
    r,
    sleep: noSleep,
  });
  assert.equal(res.ok, false);
  assert.equal(res.upgrade, null);
  assert.equal(res.restoreDrill, null);
});
