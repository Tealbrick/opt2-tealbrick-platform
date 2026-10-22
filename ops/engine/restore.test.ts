import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runBackup, stagingDir } from "./backup.ts";
import { type FakeBox, makeBox } from "./fake-box.ts";
import { runDrill, runRestore } from "./restore.ts";

const noSleep = async () => undefined;

async function boxWithSnapshot(): Promise<{ box: FakeBox; snapshotId: string }> {
  const box = makeBox();
  const b = await runBackup({ r: box.r, layout: box.layout, restic: box.restic });
  assert.equal(b.ok, true, b.problem);
  return { box, snapshotId: b.snapshotId as string };
}
const checkOf = (res: { checks: { name: string; ok: boolean; detail: string }[] }, name: string) => res.checks.find((c) => c.name === name);

test("drill: restores into scratch and a throwaway Postgres, every check passes, nothing is left behind", async () => {
  const { box } = await boxWithSnapshot();
  const res = await runDrill({ r: box.r, layout: box.layout, restic: box.restic, sleep: noSleep });
  assert.equal(res.ok, true, JSON.stringify(res.checks.filter((c) => !c.ok)));
  const names = res.checks.map((c) => c.name);
  for (const n of ["snapshot-structure", "manifest", "dump:openship.dump", "compose-env", `path:${box.layout.composeDir}`, "volume:openship-wsa_bridge_data"])
    assert.ok(names.includes(n), `check ${n}`);
  assert.ok(names.some((n) => n.startsWith("db:openship.dump")) && names.some((n) => n.startsWith("db:companion-")));
  assert.ok(res.checks.some((c) => c.name.startsWith("db:") && /tables restored/.test(c.detail)));

  // isolation: no network, trust auth (no secret), no docker.sock / bind mount, never pulls, only drill containers are removed
  const runs = box.calls.filter((c) => c.cmd === "docker" && c.args[0] === "run");
  assert.equal(runs.length, 2);
  for (const c of runs) {
    assert.ok(c.args.includes("--network") && c.args[c.args.indexOf("--network") + 1] === "none");
    assert.ok(!c.args.some((a) => a === "-v" || a === "--volume" || a === "--mount" || a.includes("docker.sock")));
    assert.ok(c.args.includes("POSTGRES_HOST_AUTH_METHOD=trust"));
    assert.ok(c.args[c.args.indexOf("--name") + 1]?.startsWith("tbdrill-"));
  }
  assert.ok(!box.calls.some((c) => c.cmd === "docker" && (c.args[0] === "pull" || c.args.includes("pull"))));
  const rms = box.calls.filter((c) => c.cmd === "docker" && c.args[0] === "rm");
  assert.equal(rms.length, 2);
  assert.ok(rms.every((c) => (c.args[c.args.length - 1] as string).startsWith("tbdrill-")));
  assert.equal(box.state.drillContainers.size, 0, "throwaway containers removed");
  for (const secret of box.secrets)
    assert.ok(
      !box.calls
        .map((c) => c.args.join(" "))
        .join("\n")
        .includes(secret),
    );
  // the live engine was not touched
  assert.ok(!box.calls.some((c) => c.cmd === "docker" && c.args[0] === "compose"));
  assert.ok(!box.calls.some((c) => c.cmd === "docker" && ["stop", "start", "restart", "kill"].includes(c.args[0] as string)));
  // scratch removed, result logged
  assert.deepEqual(existsSync(join(box.layout.stateDir, "drill")) ? readdirSync(join(box.layout.stateDir, "drill")) : [], []);
  const log = readFileSync(join(box.layout.stateDir, "drills.jsonl"), "utf8").trim().split("\n");
  assert.equal(JSON.parse(log[log.length - 1] as string).kind, "restore-drill");
});

test("drill: a damaged dump in the repository fails the drill (sha256), and cleanup still happens", async () => {
  const { box, snapshotId } = await boxWithSnapshot();
  writeFileSync(join(box.repo, snapshotId, stagingDir(box.layout), "openship.dump"), "tampered");
  const res = await runDrill({ r: box.r, layout: box.layout, restic: box.restic, snapshot: snapshotId, sleep: noSleep });
  assert.equal(res.ok, false);
  assert.equal(checkOf(res, "dump:openship.dump")?.ok, false);
  assert.match(checkOf(res, "dump:openship.dump")?.detail ?? "", /sha256/);
  assert.equal(box.state.drillContainers.size, 0);
});

test("drill: a snapshot without the compose .env fails (the stored Openship secrets could not be decrypted)", async () => {
  const { box, snapshotId } = await boxWithSnapshot();
  rmSync(join(box.repo, snapshotId, box.layout.composeDir, ".env"));
  const res = await runDrill({ r: box.r, layout: box.layout, restic: box.restic, snapshot: snapshotId, sleep: noSleep });
  assert.equal(res.ok, false);
  assert.match(checkOf(res, "compose-env")?.detail ?? "", /\.env is not in the snapshot/);
});

test("drill: a changed .env, a missing host key and a missing volume are each a failed check", async () => {
  const { box, snapshotId } = await boxWithSnapshot();
  writeFileSync(join(box.repo, snapshotId, box.layout.composeDir, ".env"), "OPENSHIP_VERSION=0.9.3\n");
  rmSync(join(box.repo, snapshotId, box.layout.composeDir, "host-ssh"), { recursive: true });
  rmSync(join(box.repo, snapshotId, box.root, "docker-volumes", "openship-wsa_bridge_data"), { recursive: true });
  const res = await runDrill({ r: box.r, layout: box.layout, restic: box.restic, snapshot: snapshotId, sleep: noSleep });
  assert.equal(res.ok, false);
  assert.equal(checkOf(res, "compose-env")?.ok, false);
  assert.equal(checkOf(res, "volume:openship-wsa_bridge_data")?.ok, false);
});

test("drill: a restored table set that differs from the manifest fails; an image that is not on the box is not pulled", async () => {
  const { box } = await boxWithSnapshot();
  box.state.drillTables = ["public.users"];
  const res = await runDrill({ r: box.r, layout: box.layout, restic: box.restic, sleep: noSleep });
  assert.equal(res.ok, false);
  assert.match(res.checks.find((c) => c.name === "db:openship.dump")?.detail ?? "", /table set differs/);
  const box2 = (await boxWithSnapshot()).box;
  box2.state.localImages.delete("postgres:16-alpine");
  const res2 = await runDrill({ r: box2.r, layout: box2.layout, restic: box2.restic, sleep: noSleep });
  assert.equal(res2.ok, false);
  assert.ok(res2.checks.some((c) => /never pulls/.test(c.detail)));
  assert.ok(!box2.calls.some((c) => c.cmd === "docker" && c.args.includes("pull")));
});

test("drill: no snapshot at all is a failed drill, not a pass", async () => {
  const box = makeBox();
  const res = await runDrill({ r: box.r, layout: box.layout, restic: box.restic, sleep: noSleep });
  assert.equal(res.ok, false);
  assert.match(res.checks[0]?.detail ?? "", /no snapshot/);
  const bad = await runDrill({ r: box.r, layout: box.layout, restic: box.restic, snapshot: "not-hex!", sleep: noSleep });
  assert.equal(bad.ok, false);
  assert.match(bad.checks[0]?.detail ?? "", /snapshot id/);
});

test("restore: refuses without --confirm-empty-box and on a box that already runs Openship", async () => {
  const { box } = await boxWithSnapshot();
  const a = await runRestore({ r: box.r, layout: box.layout, restic: box.restic, confirmEmptyBox: false, sleep: noSleep });
  assert.equal(a.ok, false);
  assert.match(a.checks[0]?.detail ?? "", /--confirm-empty-box/);
  const b = await runRestore({ r: box.r, layout: box.layout, restic: box.restic, confirmEmptyBox: true, sleep: noSleep });
  assert.equal(b.ok, false);
  assert.match(b.checks[0]?.detail ?? "", /already has Openship containers/);
  assert.ok(!box.calls.some((c) => c.args[0] === "restore" && c.args.includes("/")), "nothing was placed");
});

test("restore: onto an empty box - verify first, then files and volumes, Postgres, dump, the rest, API health", async () => {
  const { box } = await boxWithSnapshot();
  box.state.containers = []; // an empty box: no containers
  rmSync(join(box.layout.composeDir, "docker-compose.yml"));
  const res = await runRestore({ r: box.r, layout: box.layout, restic: box.restic, confirmEmptyBox: true, sleep: noSleep, health: async () => true });
  assert.equal(res.ok, true, JSON.stringify(res.checks.filter((c) => !c.ok)));
  assert.equal(res.kind, "restore");
  const restores = box.calls.filter((c) => c.cmd === "restic" && c.args[0] === "restore");
  assert.equal(restores.length, 2, "first into scratch (verified), then onto the box");
  assert.ok(restores[1]?.args.includes("/") && restores[1].args.includes("--include"));
  const order = (pred: (c: { cmd: string; args: string[] }) => boolean) => box.calls.findIndex(pred);
  const iVerifyDone = order((c) => c.cmd === "restic" && c.args[0] === "restore" && c.args.includes("/"));
  const iVolume = order((c) => c.args[0] === "volume" && c.args[1] === "create");
  const iPg = order((c) => c.args[0] === "compose" && c.args.includes("postgres"));
  const iRestore = order((c) => c.args.includes("pg_restore") && c.args.includes("--clean"));
  const iAll = order((c) => c.args[0] === "compose" && c.args.slice(-2).join(" ") === "up -d");
  assert.ok(iVolume >= 0 && iVolume < iVerifyDone, "volumes exist before the files are placed");
  assert.ok(iVerifyDone < iPg && iPg < iRestore && iRestore < iAll, "postgres up -> dump restored -> whole stack up");
  assert.ok(box.calls[iRestore]?.args.includes("--exit-on-error"));
  assert.ok(res.checks.some((c) => c.name === "api-health" && c.ok));
  assert.ok(existsSync(join(box.layout.stateDir, "restored")), "companion dumps are kept for the agent's re-apply step");
});

test("restore: a snapshot that fails the verification places nothing on the box", async () => {
  const { box, snapshotId } = await boxWithSnapshot();
  box.state.containers = [];
  rmSync(join(box.layout.composeDir, "docker-compose.yml"));
  writeFileSync(join(box.repo, snapshotId, stagingDir(box.layout), "openship.dump"), "tampered");
  const res = await runRestore({
    r: box.r,
    layout: box.layout,
    restic: box.restic,
    snapshot: snapshotId,
    confirmEmptyBox: true,
    sleep: noSleep,
    health: async () => true,
  });
  assert.equal(res.ok, false);
  assert.ok(!box.calls.some((c) => c.cmd === "restic" && c.args[0] === "restore" && c.args.includes("/")));
  assert.ok(!box.calls.some((c) => c.args.includes("--clean")));
});
