import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type BackupManifest, resticConfigFromEnv, runBackup, runPrune, stagingDir } from "./backup.ts";
import { insideOrThrow, parseEnvFile, redact, requireRootOnly } from "./box.ts";
import { type FakeBox, makeBox } from "./fake-box.ts";

const argvText = (box: FakeBox) => box.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`).join("\n");
const resticBackup = (box: FakeBox) => box.calls.find((c) => c.cmd === "restic" && c.args[0] === "backup");

test("backup: dumps the databases, copies the right paths and volumes, verifies, records a good run", async () => {
  const box = makeBox();
  const res = await runBackup({ r: box.r, layout: box.layout, restic: box.restic, now: () => new Date("2026-10-23T01:00:00Z") });
  assert.equal(res.ok, true, res.problem);
  assert.match(res.snapshotId ?? "", /^[0-9a-f]{8}$/);

  const bk = resticBackup(box);
  assert.ok(bk, "restic backup ran");
  const paths = bk.args.filter((a) => a.startsWith("/"));
  assert.ok(paths.includes(box.layout.composeDir), "compose dir (.env keys, host-ssh) is backed up");
  assert.ok(paths.includes(join(box.root, "edge")) && paths.includes(join(box.root, "letsencrypt")), "edge state and certificates");
  assert.ok(!paths.includes(join(box.root, "missing-static")), "a host-state path that does not exist is skipped");
  const vols = paths.filter((p) => p.includes("docker-volumes"));
  assert.deepEqual(
    vols.map((p) => p.split("/").slice(-2, -1)[0]).sort(),
    ["openship-wsa_bridge_data", "openship-wsa_knowledge_data", "openship_redis_data"],
    "stack volumes + redis only: not the Postgres volumes (dumped), not other projects",
  );
  assert.ok(bk.args.includes("--host") && bk.args.includes("srv_test") && bk.args.includes("tb-engine"));
  assert.ok(bk.env.includes("RESTIC_REPOSITORY") && bk.env.includes("RESTIC_PASSWORD_FILE"));
  assert.ok(!box.calls.some((c) => c.cmd === "restic" && c.args[0] === "forget"), "the box never prunes");
  for (const secret of box.secrets) assert.ok(!argvText(box).includes(secret), "no secret value in any command line");

  // the manifest inside the snapshot
  const snapDir = join(box.repo, res.snapshotId as string);
  const manifest = JSON.parse(readFileSync(join(snapDir, stagingDir(box.layout), "BACKUP-MANIFEST.json"), "utf8")) as BackupManifest;
  assert.equal(manifest.schema, "tb.engine-backup/1");
  assert.equal(manifest.engine.version, "0.9.3");
  assert.equal(manifest.engine.images["openship-api-1"]?.image, "ghcr.io/oblien/openship-api:0.9.3");
  const kinds = manifest.items.map((i) => i.kind);
  assert.ok(kinds.includes("openship-db") && kinds.includes("companion-db"));
  const companion = manifest.items.find((i) => i.kind === "companion-db");
  assert.equal(companion?.kind === "companion-db" && companion.db, "appdb");
  assert.deepEqual(manifest.composeEnv?.keys, ["ENCRYPTION_KEY", "OPENSHIP_VERSION", "POSTGRES_PASSWORD"]);
  assert.ok(manifest.dumpedVolumes.includes("openship-wsa_gbrain-db_data"));
  const manifestText = readFileSync(join(snapDir, stagingDir(box.layout), "BACKUP-MANIFEST.json"), "utf8");
  for (const secret of box.secrets) assert.ok(!manifestText.includes(secret), "the manifest holds key names and a hash, never values");

  // good run recorded; staging and lock are gone
  const last = JSON.parse(readFileSync(join(box.layout.stateDir, "last-backup.json"), "utf8"));
  assert.equal(last.snapshotId, res.snapshotId);
  assert.ok(!existsSync(stagingDir(box.layout)));
  assert.ok(!existsSync(join(box.layout.stateDir, "backup.lock")));
});

test("backup: a failed run (restic exit 3) is a failure, keeps the last good record, and cleans up", async () => {
  const box = makeBox();
  const good = await runBackup({ r: box.r, layout: box.layout, restic: box.restic });
  assert.equal(good.ok, true);
  box.state.failBackupCode = 3;
  const bad = await runBackup({ r: box.r, layout: box.layout, restic: box.restic });
  assert.equal(bad.ok, false);
  assert.match(bad.problem ?? "", /restic backup .* exited 3/);
  const last = JSON.parse(readFileSync(join(box.layout.stateDir, "last-backup.json"), "utf8"));
  assert.equal(last.snapshotId, good.snapshotId, "last-backup.json still names the last GOOD snapshot");
  const log = readFileSync(join(box.layout.stateDir, "backup-log.jsonl"), "utf8").trim().split("\n");
  assert.equal(log.length, 2);
  assert.ok(!existsSync(stagingDir(box.layout)) && !existsSync(join(box.layout.stateDir, "backup.lock")));
});

test("backup: a snapshot that is not listed afterwards is a failure", async () => {
  const box = makeBox();
  box.state.hideSnapshot = true;
  const res = await runBackup({ r: box.r, layout: box.layout, restic: box.restic });
  assert.equal(res.ok, false);
  assert.match(res.problem ?? "", /not listed/);
  assert.ok(!existsSync(join(box.layout.stateDir, "last-backup.json")));
});

test("backup: an uninitialised repository is created only when asked (a wrong URL must not make a new repository)", async () => {
  const box = makeBox();
  box.state.resticInitialised = false;
  const no = await runBackup({ r: box.r, layout: box.layout, restic: box.restic });
  assert.equal(no.ok, false);
  assert.match(no.problem ?? "", /TB_BACKUP_INIT=1/);
  assert.ok(!box.calls.some((c) => c.cmd === "restic" && c.args[0] === "init"));
  const yes = await runBackup({ r: box.r, layout: box.layout, restic: { ...box.restic, init: true } });
  assert.equal(yes.ok, true, yes.problem);
  assert.ok(box.calls.some((c) => c.cmd === "restic" && c.args[0] === "init"));
});

test("backup: config refuses a repository on the box itself, a group-readable password file, and a bad deep percent", () => {
  const box = makeBox();
  assert.throws(() => resticConfigFromEnv({ RESTIC_REPOSITORY: "/var/backups/repo", RESTIC_PASSWORD_FILE: box.restic.passwordFile }), /off-box/);
  assert.throws(() => resticConfigFromEnv({ RESTIC_PASSWORD_FILE: "x" }), /RESTIC_REPOSITORY/);
  assert.throws(() => resticConfigFromEnv({ RESTIC_REPOSITORY: "s3:s3.example/b" }), /RESTIC_PASSWORD_FILE/);
  assert.throws(() => resticConfigFromEnv({ RESTIC_REPOSITORY: "s3:s3.example/b", RESTIC_PASSWORD_FILE: "x", TB_BACKUP_DEEP_PERCENT: "400" }), /0\.\.100/);
  assert.equal(resticConfigFromEnv({ RESTIC_REPOSITORY: "s3:s3.example/b", RESTIC_PASSWORD_FILE: "x", TB_BACKUP_HOST_ID: "srv_1" }).hostId, "srv_1");
  chmodSync(box.restic.passwordFile, 0o644);
  assert.throws(() => requireRootOnly(box.restic.passwordFile), /must not be readable/);
});

test("backup: a group-readable password file stops the run before anything is dumped", async () => {
  const box = makeBox();
  chmodSync(box.restic.passwordFile, 0o640);
  const res = await runBackup({ r: box.r, layout: box.layout, restic: box.restic });
  assert.equal(res.ok, false);
  assert.ok(!box.calls.some((c) => c.args.includes("pg_dump")));
});

test("backup: a second run while one is active is refused; a stale lock is taken over", async () => {
  const box = makeBox();
  writeFileSync(join(box.layout.stateDir, "backup.lock"), String(process.pid));
  await assert.rejects(() => runBackup({ r: box.r, layout: box.layout, restic: box.restic }), /another backup run is active/);
  writeFileSync(join(box.layout.stateDir, "backup.lock"), "2147483000");
  const res = await runBackup({ r: box.r, layout: box.layout, restic: box.restic });
  assert.equal(res.ok, true, res.problem);
});

test("backup: prune is not available to the box (needs an explicit flag, and uses restic forget with a keep policy)", async () => {
  const box = makeBox();
  await assert.rejects(() => runPrune({ r: box.r, restic: box.restic, env: {} }), /TB_BACKUP_ALLOW_PRUNE=1/);
  await runPrune({ r: box.r, restic: box.restic, env: { TB_BACKUP_ALLOW_PRUNE: "1" } });
  const f = box.calls.find((c) => c.args[0] === "forget");
  assert.ok(f?.args.includes("--keep-daily") && f.args.includes("--prune"));
});

test("box helpers: path guard, env parser, redaction", () => {
  assert.throws(() => insideOrThrow("/var/lib/tealbrick/engine", "/var/lib/tealbrick/engine"), /not inside/);
  assert.throws(() => insideOrThrow("/var/lib/tealbrick/engine", "/var/lib/tealbrick/engine/../x"), /not inside/);
  assert.throws(() => insideOrThrow("/var/lib/tealbrick/engine", "/etc"), /not inside/);
  assert.equal(insideOrThrow("/var/lib/tealbrick/engine", "/var/lib/tealbrick/engine/staging/current"), "/var/lib/tealbrick/engine/staging/current");
  assert.deepEqual(parseEnvFile('# c\nA=1\nB="two words"\n bad line\nC = x y \n'), { A: "1", B: "two words", C: "x y" });
  assert.equal(redact("POSTGRES_PASSWORD=abc token: xyz"), "POSTGRES_PASSWORD=<redacted> token: <redacted>");
});
