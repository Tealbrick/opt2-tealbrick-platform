// Restore drill and restore for an own-server workspace box (S1-4b, REDTEAM M6).
//
//   node ops/engine/restore.ts drill [--snapshot <id>]                 # SAFE on a live box: restores into a scratch dir and a throwaway
//                                                                      # Postgres, checks everything, touches nothing that runs.
//   node ops/engine/restore.ts restore --confirm-empty-box [--snapshot <id>]   # disaster recovery onto an EMPTY box
//
// The drill is the done-when "restore works": until `drill` has passed on the real box (and `restore` on a throwaway VPS, QA S1-8)
// the product label stays "preview: no customer data". What the drill proves, one check each (names are stable, QA greps them):
//   snapshot-structure   restic check (+ N % of the data) passes
//   manifest             BACKUP-MANIFEST.json is in the snapshot and has our schema
//   dump:<file>          the restored dump has the sha256 recorded at backup time
//   path:<path>          every recorded compose/host-state/extra path came back
//   volume:<name>        every recorded volume directory came back
//   compose-env          .env came back byte-equal (sha256) with the same key names and mode 0600; host-ssh key came back
//   db:<file>            the dump restores into a throwaway Postgres (same image as the box, NO network, trust auth, no secret)
//                        and the table set equals the one recorded at backup time
// The drill never pulls an image, never joins a network, never mounts docker.sock into anything, and removes only the container and
// scratch directory it created (names and paths are checked before every removal).
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKUP_SCHEMA, BACKUP_TAG, type BackupItem, type BackupManifest, type ResticConfig, resticConfigFromEnv, resticEnv, stagingDir } from "./backup.ts";
import { type BoxLayout, execRunner, insideOrThrow, layoutFromEnv, parseEnvFile, type Runner, requireRootOnly, run, sha256File, ts } from "./box.ts";

export interface DrillCheck {
  name: string;
  ok: boolean;
  detail: string;
}
export interface DrillResult {
  ok: boolean;
  kind: "restore-drill" | "restore";
  runId: string;
  snapshotId: string;
  at: string;
  seconds: number;
  checks: DrillCheck[];
}
export interface RestoreDeps {
  r: Runner;
  layout: BoxLayout;
  restic: ResticConfig;
  snapshot?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** GET of the engine API health (restore only). */
  health?: (url: string) => Promise<boolean>;
}

export const DRILL_PREFIX = "tbdrill-";
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function resolveSnapshot(r: Runner, rc: ResticConfig, wanted: string | undefined): Promise<string> {
  const env = resticEnv(rc);
  if (wanted) {
    if (!/^[0-9a-f]{8,64}$/.test(wanted)) throw new Error("--snapshot must be a restic snapshot id (hex)");
    return wanted;
  }
  const res = await run(r, "restic", ["snapshots", "--tag", BACKUP_TAG, "--latest", "1", "--json"], { env });
  const list = JSON.parse(res.stdout || "[]") as { id: string; time: string }[];
  const last = list.sort((a, b) => a.time.localeCompare(b.time)).pop();
  if (!last) throw new Error(`no snapshot with tag ${BACKUP_TAG} in the repository`);
  return last.id;
}

/** Where a path of the snapshot lands inside the scratch restore. */
export function inScratch(scratch: string, abs: string): string {
  return join(scratch, abs);
}

async function waitReady(deps: RestoreDeps, container: string, user: string): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  for (let i = 0; i < 60; i++) {
    const res = await deps.r("docker", ["exec", container, "pg_isready", "-U", user], {});
    if (res.code === 0) return;
    await sleep(1000);
  }
  throw new Error(`${container}: Postgres did not become ready in 60 s`);
}

/** Restores one dump into a throwaway container and compares the table set. Always removes the container it started. */
async function checkDump(
  deps: RestoreDeps,
  runId: string,
  n: number,
  dump: string,
  image: string,
  user: string,
  db: string,
  wantTables: string[],
): Promise<DrillCheck> {
  const { r } = deps;
  const name = `${DRILL_PREFIX}${runId}-${n}`;
  const label = `db:${dump.split("/").pop()}`;
  try {
    const have = await r("docker", ["image", "inspect", image], {});
    if (have.code !== 0) return { name: label, ok: false, detail: `image ${image} is not on this box (the drill never pulls)` };
    await run(r, "docker", [
      "run",
      "-d",
      "--name",
      name,
      "--network",
      "none",
      "--memory",
      "768m",
      "--label",
      `tb.drill=${runId}`,
      "-e",
      `POSTGRES_USER=${user}`,
      "-e",
      `POSTGRES_DB=${db}`,
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      image,
    ]);
    await waitReady(deps, name, user);
    await run(r, "docker", ["cp", dump, `${name}:/tmp/restore.dump`]);
    await run(r, "docker", ["exec", name, "pg_restore", "-U", user, "-d", db, "--no-owner", "--exit-on-error", "/tmp/restore.dump"]);
    const t = await run(r, "docker", [
      "exec",
      name,
      "psql",
      "-U",
      user,
      "-d",
      db,
      "-Atc",
      "select table_schema||'.'||table_name from information_schema.tables where table_schema not in ('pg_catalog','information_schema') order by 1",
    ]);
    const got = t.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const missing = wantTables.filter((x) => !got.includes(x));
    const extra = got.filter((x) => !wantTables.includes(x));
    if (missing.length || extra.length)
      return {
        name: label,
        ok: false,
        detail: `table set differs: missing ${missing.slice(0, 5).join(",") || "-"}; extra ${extra.slice(0, 5).join(",") || "-"}`,
      };
    if (got.length === 0) return { name: label, ok: false, detail: "restored database has no tables" };
    return { name: label, ok: true, detail: `${got.length} tables restored, set equals the backup manifest` };
  } catch (e) {
    return { name: label, ok: false, detail: (e as Error).message };
  } finally {
    if (name.startsWith(DRILL_PREFIX)) await r("docker", ["rm", "-f", "-v", name], {}).catch(() => undefined);
  }
}

/** Every check that needs the restored files (shared by drill and restore). */
export async function verifyRestored(deps: RestoreDeps, scratch: string, runId: string): Promise<{ manifest: BackupManifest | null; checks: DrillCheck[] }> {
  const { layout: l } = deps;
  const checks: DrillCheck[] = [];
  const stage = inScratch(scratch, stagingDir(l));
  const mfile = join(stage, "BACKUP-MANIFEST.json");
  if (!existsSync(mfile))
    return { manifest: null, checks: [{ name: "manifest", ok: false, detail: `BACKUP-MANIFEST.json is not in the snapshot (${stagingDir(l)})` }] };
  const manifest = JSON.parse(readFileSync(mfile, "utf8")) as BackupManifest;
  if (manifest.schema !== BACKUP_SCHEMA)
    return { manifest, checks: [{ name: "manifest", ok: false, detail: `schema ${String(manifest.schema)} is not ${BACKUP_SCHEMA}` }] };
  checks.push({ name: "manifest", ok: true, detail: `run ${manifest.runId}, engine ${manifest.engine.version ?? "unknown"}, ${manifest.items.length} items` });

  let n = 0;
  for (const it of manifest.items as BackupItem[]) {
    if (it.kind === "openship-db" || it.kind === "companion-db") {
      const file = join(stage, it.file);
      const got = existsSync(file) ? await sha256File(file) : "missing";
      checks.push({
        name: `dump:${it.file}`,
        ok: got === it.sha256,
        detail: got === it.sha256 ? "sha256 equals the backup record" : `sha256 ${got} != ${it.sha256}`,
      });
      if (got === it.sha256) {
        const image =
          it.kind === "openship-db"
            ? (manifest.engine.images[l.postgresContainer]?.repoDigests[0] ?? manifest.engine.images[l.postgresContainer]?.image ?? "postgres:16-alpine")
            : it.image;
        const user = it.kind === "openship-db" ? l.postgresUser : it.user;
        const db = it.kind === "openship-db" ? l.postgresDb : it.db;
        checks.push(await checkDump(deps, runId, n++, file, image, user, db, it.tables));
      }
    } else if (it.kind === "path") {
      const ok = existsSync(inScratch(scratch, it.path));
      checks.push({ name: `path:${it.path}`, ok, detail: ok ? `${it.role} restored` : "not in the snapshot" });
    } else {
      const p = inScratch(scratch, it.path);
      const ok = existsSync(p) && statSync(p).isDirectory();
      checks.push({ name: `volume:${it.name}`, ok, detail: ok ? "directory restored" : "not in the snapshot" });
    }
  }

  if (manifest.composeEnv) {
    const envFile = join(inScratch(scratch, l.composeDir), ".env");
    if (!existsSync(envFile))
      checks.push({ name: "compose-env", ok: false, detail: ".env is not in the snapshot: the stored Openship secrets could not be decrypted" });
    else {
      const sameHash = (await sha256File(envFile)) === manifest.composeEnv.sha256;
      const keys = Object.keys(parseEnvFile(readFileSync(envFile, "utf8"))).sort();
      const sameKeys = JSON.stringify(keys) === JSON.stringify(manifest.composeEnv.keys);
      const modeOk = (statSync(envFile).mode & 0o077) === 0;
      const sshKey = existsSync(join(inScratch(scratch, l.composeDir), "host-ssh", "id_ed25519"));
      const ok = sameHash && sameKeys && modeOk && sshKey;
      checks.push({
        name: "compose-env",
        ok,
        detail: ok
          ? "byte-equal, same key names, mode 0600, host-ssh key present"
          : `hash ${sameHash}, keys ${sameKeys}, mode0600 ${modeOk}, host-ssh key ${sshKey}`,
      });
    }
  }
  return { manifest, checks };
}

export async function runDrill(deps: RestoreDeps): Promise<DrillResult> {
  const { r, layout: l, restic: rc } = deps;
  const now = deps.now ?? (() => new Date());
  const t0 = now();
  const runId = ts(t0);
  const env = resticEnv(rc);
  const checks: DrillCheck[] = [];
  let snapshotId = "";
  const scratch = insideOrThrow(l.stateDir, join(l.stateDir, "drill", runId));
  try {
    requireRootOnly(rc.passwordFile);
    snapshotId = await resolveSnapshot(r, rc, deps.snapshot);
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    // room for the restore: restic reports the restore size; keep 20 % spare
    const stats = JSON.parse((await run(r, "restic", ["stats", "--mode", "restore-size", "--json", snapshotId], { env })).stdout || "{}") as {
      total_size?: number;
    };
    const free = Number((await run(r, "df", ["-Pk", scratch])).stdout.trim().split("\n").pop()?.split(/\s+/)[3]) * 1024;
    if (stats.total_size !== undefined && free < stats.total_size * 1.2)
      throw new Error(`restore needs ${stats.total_size} bytes and only ${free} are free in ${l.stateDir}; the drill must not fill the box`);
    const deep = Math.max(rc.deepPercent, 10);
    await run(r, "restic", ["check", `--read-data-subset=${deep}%`], { env });
    checks.push({ name: "snapshot-structure", ok: true, detail: `restic check passed (structure + ${deep} % of the data)` });
    await run(r, "restic", ["restore", snapshotId, "--target", scratch], { env });
    checks.push(...(await verifyRestored(deps, scratch, runId)).checks);
  } catch (e) {
    checks.push({ name: "drill", ok: false, detail: (e as Error).message });
  } finally {
    if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true }); // own scratch, guarded by insideOrThrow
  }
  const result: DrillResult = {
    ok: checks.length > 0 && checks.every((c) => c.ok),
    kind: "restore-drill",
    runId,
    snapshotId,
    at: t0.toISOString(),
    seconds: Math.round((now().getTime() - t0.getTime()) / 1000),
    checks,
  };
  mkdirSync(l.stateDir, { recursive: true, mode: 0o700 });
  appendFileSync(join(l.stateDir, "drills.jsonl"), `${JSON.stringify(result)}\n`, { mode: 0o600 });
  return result;
}

/** Disaster recovery onto an EMPTY box: control plane + data back, then the engine answers. Workspace stack containers and the
 *  companion databases are re-created by the host agent from Core's current plan (the agent state is in the snapshot when the
 *  agent lead lists it in TB_BACKUP_EXTRA_PATHS). Companion dumps are left in <stateDir>/restored/ for that step. */
export async function runRestore(deps: RestoreDeps & { confirmEmptyBox: boolean }): Promise<DrillResult> {
  const { r, layout: l, restic: rc } = deps;
  const now = deps.now ?? (() => new Date());
  const t0 = now();
  const runId = ts(t0);
  const env = resticEnv(rc);
  const checks: DrillCheck[] = [];
  let snapshotId = "";
  const scratch = insideOrThrow(l.stateDir, join(l.stateDir, "restore", runId));
  try {
    if (!deps.confirmEmptyBox)
      throw new Error("restore replaces the engine of this box: pass --confirm-empty-box on a box that has no Openship (QA: a throwaway VPS)");
    requireRootOnly(rc.passwordFile);
    const live = await run(r, "docker", ["ps", "-a", "--format", "{{.Names}}"]);
    if (live.stdout.split("\n").some((n) => n.startsWith("openship")))
      throw new Error("this box already has Openship containers; restore only onto an empty box");
    if (existsSync(join(l.composeDir, "docker-compose.yml"))) throw new Error(`${l.composeDir} already has a compose file; restore only onto an empty box`);
    snapshotId = await resolveSnapshot(r, rc, deps.snapshot);
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    await run(r, "restic", ["restore", snapshotId, "--target", scratch], { env });
    const { manifest, checks: pre } = await verifyRestored(deps, scratch, runId);
    checks.push(...pre);
    if (!manifest || pre.some((c) => !c.ok)) throw new Error("the restored snapshot failed the drill checks; nothing was placed on the box");

    // place files: the paths and the volume directories (volumes are created first so docker knows them)
    const include: string[] = [];
    for (const it of manifest.items) {
      if (it.kind === "path") include.push(it.path);
      if (it.kind === "volume") {
        await run(r, "docker", ["volume", "create", it.name]);
        include.push(it.path);
      }
    }
    await run(r, "restic", ["restore", snapshotId, "--target", "/", ...include.flatMap((p) => ["--include", p])], { env });
    checks.push({ name: "place-files", ok: true, detail: `${include.length} paths/volumes restored to their original locations` });

    // Postgres first, then the dump, then the rest of the stack
    const files = [
      "-f",
      join(l.composeDir, "docker-compose.yml"),
      ...(existsSync(join(l.composeDir, "docker-compose.digests.yml")) ? ["-f", join(l.composeDir, "docker-compose.digests.yml")] : []),
    ];
    const compose = (...a: string[]) => run(r, "docker", ["compose", "--project-name", l.composeProject, "--project-directory", l.composeDir, ...files, ...a]);
    await compose("up", "-d", "postgres");
    await waitReady(deps, l.postgresContainer, l.postgresUser);
    const main = join(inScratch(scratch, stagingDir(l)), "openship.dump");
    await run(r, "docker", ["cp", main, `${l.postgresContainer}:/tmp/restore.dump`]);
    await run(r, "docker", [
      "exec",
      l.postgresContainer,
      "pg_restore",
      "-U",
      l.postgresUser,
      "-d",
      l.postgresDb,
      "--clean",
      "--if-exists",
      "--no-owner",
      "--exit-on-error",
      "/tmp/restore.dump",
    ]);
    await run(r, "docker", ["exec", l.postgresContainer, "rm", "-f", "/tmp/restore.dump"]);
    checks.push({ name: "openship-db", ok: true, detail: "Openship database restored" });
    await compose("up", "-d");
    const sleep = deps.sleep ?? defaultSleep;
    const health = deps.health ?? (async (u: string) => (await fetch(u).catch(() => null))?.ok === true);
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      up = await health(`${l.apiUrl}/api/health`);
      if (!up) await sleep(1000);
    }
    checks.push({ name: "api-health", ok: up, detail: up ? "Openship API answers on loopback" : "Openship API did not answer in 120 s" });
    // companion dumps for the agent's re-apply step
    const out = join(l.stateDir, "restored");
    mkdirSync(out, { recursive: true, mode: 0o700 });
    for (const it of manifest.items)
      if (it.kind === "companion-db") await run(r, "cp", ["-p", join(inScratch(scratch, stagingDir(l)), it.file), join(out, it.file)]);
  } catch (e) {
    checks.push({ name: "restore", ok: false, detail: (e as Error).message });
  } finally {
    if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  }
  const result: DrillResult = {
    ok: checks.length > 0 && checks.every((c) => c.ok),
    kind: "restore",
    runId,
    snapshotId,
    at: t0.toISOString(),
    seconds: Math.round((now().getTime() - t0.getTime()) / 1000),
    checks,
  };
  mkdirSync(l.stateDir, { recursive: true, mode: 0o700 });
  appendFileSync(join(l.stateDir, "drills.jsonl"), `${JSON.stringify(result)}\n`, { mode: 0o600 });
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const envFile = process.env.TB_BACKUP_ENV_FILE ?? "/etc/tealbrick/backup.env";
  if (existsSync(envFile)) {
    requireRootOnly(envFile);
    for (const [k, v] of Object.entries(parseEnvFile(readFileSync(envFile, "utf8")))) if (process.env[k] === undefined) process.env[k] = v;
  }
  try {
    const deps = { r: execRunner, layout: layoutFromEnv(), restic: resticConfigFromEnv(), snapshot: arg("--snapshot") };
    const out =
      cmd === "drill" ? await runDrill(deps) : cmd === "restore" ? await runRestore({ ...deps, confirmEmptyBox: rest.includes("--confirm-empty-box") }) : null;
    if (!out) throw new Error("usage: restore.ts drill|restore [--snapshot <id>] [--confirm-empty-box]");
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(out.ok ? 0 : 1);
  } catch (e) {
    process.stderr.write(`engine restore: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
