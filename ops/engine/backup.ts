// Off-box backup of an own-server workspace box (S1-4b, REDTEAM M6): the Openship control plane, the workspace stacks' data
// volumes, the edge state (certificates) and the paths the host agent adds. Encrypted restic repository OFF the box.
//
//   node ops/engine/backup.ts run      # one backup; exit 0 only when the snapshot exists and verifies
//   node ops/engine/backup.ts prune    # retention; run it from the operator side, NOT from the box (see below)
//   node ops/engine/backup.ts status   # prints last-backup.json
//
// Env (usually from a root-only EnvironmentFile; the file is checked to be 0600): RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE (0600),
// the backend credentials restic reads itself (AWS_ACCESS_KEY_ID ...), TB_BACKUP_HOST_ID (default: hostname), TB_BACKUP_INIT=1 (first
// run only: create the repository), TB_BACKUP_DEEP_PERCENT (default 0: metadata check only; N = also read N % of the data),
// TB_BACKUP_EXTRA_PATHS (colon list, the host agent's state dir), TB_ENGINE_* (layout, see box.ts).
//
// What is consistent, what is not (be exact, the drill checks the first two):
//   - Openship's Postgres and every companion Postgres container of a workspace stack: `pg_dump -Fc` (consistent). Their raw
//     data volumes are NOT copied.
//   - compose dir (.env holds the keys that decrypt Openship's stored secrets, host-ssh holds the host key), edge state: files.
//   - Other workspace volumes (SQLite apps, bridge identity): copied while the app runs = crash-consistent. The apps' own
//     pre-update dumps in their `backup` volume are the consistent source (SDK, C226); they are in the same snapshot.
//
// Trust: the box holds the repository password and write credentials. A compromised box must not be able to destroy the history, so
// the box's credentials must be append-only (restic REST server --append-only, or an object-store key without delete). This script
// never runs `forget`; `prune` needs TB_BACKUP_ALLOW_PRUNE=1 and belongs to a machine that is not the box.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type BoxLayout,
  execRunner,
  insideOrThrow,
  layoutFromEnv,
  parseEnvFile,
  type Runner,
  requireRootOnly,
  run,
  STACK_VOLUME_RE,
  sha256File,
  ts,
} from "./box.ts";

export const BACKUP_SCHEMA = "tb.engine-backup/1";
export const BACKUP_TAG = "tb-engine";
export const MIN_FREE_BYTES = 1024 ** 3;

export interface ResticConfig {
  repository: string;
  passwordFile: string;
  hostId: string;
  init: boolean;
  /** 0 = `restic check` (structure) only; N = also `--read-data-subset=N%`. */
  deepPercent: number;
}
export function resticConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ResticConfig {
  const repository = env.RESTIC_REPOSITORY;
  const passwordFile = env.RESTIC_PASSWORD_FILE;
  if (!repository) throw new Error("RESTIC_REPOSITORY is not set (the off-box repository)");
  if (!passwordFile) throw new Error("RESTIC_PASSWORD_FILE is not set (a root-only file; the password is never passed in argv or env)");
  if (/^local:|^\//.test(repository) && env.TB_BACKUP_ALLOW_LOCAL !== "1")
    throw new Error("RESTIC_REPOSITORY is a path on this box; an off-box backup needs sftp:, rest:, s3: or b2: (TB_BACKUP_ALLOW_LOCAL=1 is for tests only)");
  const deep = Number(env.TB_BACKUP_DEEP_PERCENT ?? "0");
  if (!Number.isFinite(deep) || deep < 0 || deep > 100) throw new Error("TB_BACKUP_DEEP_PERCENT must be 0..100");
  return { repository, passwordFile, hostId: env.TB_BACKUP_HOST_ID || hostname(), init: env.TB_BACKUP_INIT === "1", deepPercent: deep };
}
/** The environment restic gets: repository and password file by name; backend credentials pass through from the caller's env. */
export function resticEnv(c: ResticConfig): Record<string, string> {
  return { RESTIC_REPOSITORY: c.repository, RESTIC_PASSWORD_FILE: c.passwordFile };
}

export interface BackupManifest {
  schema: typeof BACKUP_SCHEMA;
  runId: string;
  at: string;
  hostId: string;
  engine: {
    name: "openship";
    /** OPENSHIP_VERSION from the compose .env, null when unset. */
    version: string | null;
    /** compose service container name -> image reference as the container runs it, plus the digests the daemon knows. */
    images: Record<string, { image: string; repoDigests: string[] }>;
  };
  items: BackupItem[];
  /** Key NAMES of the compose .env and the sha256 of the file: the drill checks the keys that decrypt stored secrets came back. */
  composeEnv: { keys: string[]; sha256: string } | null;
  /** Volumes covered by a dump and therefore not copied raw. */
  dumpedVolumes: string[];
  consistency: { databases: "dump"; stackVolumes: "crash-consistent" };
}
export type BackupItem =
  | { kind: "openship-db"; file: string; sha256: string; tables: string[] }
  | { kind: "companion-db"; container: string; image: string; file: string; sha256: string; tables: string[]; user: string; db: string }
  | { kind: "path"; role: "compose-dir" | "host-state" | "extra"; path: string }
  | { kind: "volume"; name: string; path: string };

export interface BackupResult {
  ok: boolean;
  runId: string;
  snapshotId?: string;
  startedAt: string;
  finishedAt: string;
  items: number;
  problem?: string;
}

function imageRepo(ref: string): string {
  const noDigest = ref.split("@")[0] as string;
  const slash = noDigest.lastIndexOf("/");
  const base = noDigest.slice(slash + 1);
  return (base.split(":")[0] as string).toLowerCase();
}

export function stagingDir(l: BoxLayout): string {
  return join(l.stateDir, "staging", "current");
}

/** Table names of the public schema of a database inside a container (psql over the container's local socket; no password). */
async function tableNames(r: Runner, container: string, user: string, db: string): Promise<string[]> {
  const res = await run(r, "docker", [
    "exec",
    container,
    "psql",
    "-U",
    user,
    "-d",
    db,
    "-Atc",
    "select table_schema||'.'||table_name from information_schema.tables where table_schema not in ('pg_catalog','information_schema') order by 1",
  ]);
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function dumpDb(r: Runner, container: string, user: string, db: string, file: string): Promise<{ sha256: string; tables: string[] }> {
  const tables = await tableNames(r, container, user, db);
  await run(r, "docker", ["exec", container, "pg_dump", "-U", user, "-d", db, "-Fc"], { stdoutFile: file });
  return { sha256: await sha256File(file), tables };
}

interface Inspected {
  Name: string;
  Config: { Image: string; Env?: string[] };
  Mounts?: { Type: string; Name?: string }[];
}
async function inspect(r: Runner, container: string): Promise<Inspected> {
  const res = await run(r, "docker", ["inspect", container]);
  const arr = JSON.parse(res.stdout) as Inspected[];
  if (!arr[0]) throw new Error(`docker inspect ${container}: no result`);
  return arr[0];
}
/** Only the named variables; every other env value of a container (secrets) is dropped at once. */
export function pickEnv(env: string[] | undefined, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of env ?? []) {
    const i = e.indexOf("=");
    if (i > 0 && names.includes(e.slice(0, i))) out[e.slice(0, i)] = e.slice(i + 1);
  }
  return out;
}

async function freeBytes(r: Runner, dir: string): Promise<number> {
  const res = await run(r, "df", ["-Pk", dir]);
  const cols = (res.stdout.trim().split("\n").pop() ?? "").split(/\s+/);
  return Number(cols[3]) * 1024;
}

async function engineFacts(r: Runner, l: BoxLayout): Promise<BackupManifest["engine"]> {
  let version: string | null = null;
  const envFile = join(l.composeDir, ".env");
  if (existsSync(envFile)) version = parseEnvFile(readFileSync(envFile, "utf8")).OPENSHIP_VERSION ?? null;
  const ps = await run(r, "docker", ["ps", "-a", "--filter", `label=com.docker.compose.project=${l.composeProject}`, "--format", "{{.Names}}\t{{.Image}}"]);
  const images: BackupManifest["engine"]["images"] = {};
  for (const line of ps.stdout.split("\n").filter(Boolean)) {
    const [name, image] = line.split("\t") as [string, string];
    const d = await run(r, "docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", image], { allowFail: true });
    let repoDigests: string[] = [];
    try {
      repoDigests = d.code === 0 ? (JSON.parse(d.stdout.trim()) as string[]) : [];
    } catch {
      repoDigests = [];
    }
    images[name] = { image, repoDigests };
  }
  return { name: "openship", version, images };
}

function lockPath(l: BoxLayout): string {
  return join(l.stateDir, "backup.lock");
}
function takeLock(l: BoxLayout): () => void {
  mkdirSync(l.stateDir, { recursive: true, mode: 0o700 });
  const p = lockPath(l);
  try {
    writeFileSync(p, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch {
    const pid = Number(readFileSync(p, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) throw new Error(`another backup run is active (pid ${pid})`);
    writeFileSync(p, String(process.pid), { mode: 0o600 });
  }
  return () => rmSync(p, { force: true });
}

export async function runBackup(deps: { r: Runner; layout: BoxLayout; restic: ResticConfig; now?: () => Date }): Promise<BackupResult> {
  const { r, layout: l, restic: rc } = deps;
  const now = deps.now ?? (() => new Date());
  const started = now();
  const runId = ts(started);
  const res: BackupResult = { ok: false, runId, startedAt: started.toISOString(), finishedAt: "", items: 0 };
  const env = resticEnv(rc);
  const staging = insideOrThrow(l.stateDir, stagingDir(l));
  const release = takeLock(l);
  try {
    requireRootOnly(rc.passwordFile);
    if (!existsSync(l.composeDir)) throw new Error(`compose dir ${l.composeDir} not found (Openship not installed?)`);
    await run(r, "restic", ["version"]);
    const repo = await run(r, "restic", ["cat", "config"], { env, allowFail: true });
    if (repo.code !== 0) {
      if (!rc.init)
        throw new Error(
          "the restic repository is not reachable or not initialised (first run: set TB_BACKUP_INIT=1; a wrong URL must not create a new repository by accident)",
        );
      await run(r, "restic", ["init"], { env });
    }
    mkdirSync(join(l.stateDir, "staging"), { recursive: true, mode: 0o700 });
    rmSync(staging, { recursive: true, force: true }); // own scratch, guarded by insideOrThrow above
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    if ((await freeBytes(r, staging)) < MIN_FREE_BYTES)
      throw new Error("less than 1 GiB free for the staging dumps; refusing (a full disk would hurt the workspace)");

    const items: BackupItem[] = [];
    // 1. Openship's own database
    const main = join(staging, "openship.dump");
    const d = await dumpDb(r, l.postgresContainer, l.postgresUser, l.postgresDb, main);
    items.push({ kind: "openship-db", file: "openship.dump", sha256: d.sha256, tables: d.tables });
    const dumpedVolumes = [l.postgresVolume];

    // 2. companion Postgres containers of the workspace stacks: dump, and leave their raw volumes out
    const ps = await run(r, "docker", ["ps", "-a", "--format", "{{.Names}}\t{{.Image}}"]);
    for (const line of ps.stdout.split("\n").filter(Boolean)) {
      const [name, image] = line.split("\t") as [string, string];
      if (name === l.postgresContainer || imageRepo(image) !== "postgres") continue;
      const info = await inspect(r, name);
      const pe = pickEnv(info.Config.Env, ["POSTGRES_USER", "POSTGRES_DB"]);
      const user = pe.POSTGRES_USER || "postgres";
      const db = pe.POSTGRES_DB || user;
      const file = `companion-${name.replace(/[^A-Za-z0-9._-]/g, "_")}.dump`;
      const c = await dumpDb(r, name, user, db, join(staging, file));
      items.push({ kind: "companion-db", container: name, image, file, sha256: c.sha256, tables: c.tables, user, db });
      for (const m of info.Mounts ?? []) if (m.Type === "volume" && m.Name) dumpedVolumes.push(m.Name);
    }

    // 3. paths and volumes that are copied as files
    const paths: string[] = [staging];
    const add = (role: "compose-dir" | "host-state" | "extra", p: string, must: boolean) => {
      if (existsSync(p)) {
        paths.push(p);
        items.push({ kind: "path", role, path: p });
      } else if (must) throw new Error(`${role} path ${p} does not exist`);
    };
    add("compose-dir", l.composeDir, true);
    for (const p of l.hostState) add("host-state", p, false);
    for (const p of l.extraPaths) add("extra", p, true);
    const vols = (await run(r, "docker", ["volume", "ls", "--format", "{{.Name}}"])).stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const name of vols) {
      if (dumpedVolumes.includes(name)) continue;
      if (name !== l.redisVolume && !STACK_VOLUME_RE.test(name)) continue; // not ours (other docker volumes on the box stay out)
      const mp = (await run(r, "docker", ["volume", "inspect", "--format", "{{.Mountpoint}}", name])).stdout.trim();
      paths.push(mp);
      items.push({ kind: "volume", name, path: mp });
    }

    // 4. manifest
    const envFile = join(l.composeDir, ".env");
    const composeEnv = existsSync(envFile)
      ? { keys: Object.keys(parseEnvFile(readFileSync(envFile, "utf8"))).sort(), sha256: await sha256File(envFile) }
      : null;
    const manifest: BackupManifest = {
      schema: BACKUP_SCHEMA,
      runId,
      at: started.toISOString(),
      hostId: rc.hostId,
      engine: await engineFacts(r, l),
      items,
      composeEnv,
      dumpedVolumes,
      consistency: { databases: "dump", stackVolumes: "crash-consistent" },
    };
    writeFileSync(join(staging, "BACKUP-MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    // 5. snapshot. restic exit 3 = some file could not be read: that is a failed backup here.
    const bk = await run(r, "restic", ["backup", "--json", "--exclude-caches", "--tag", BACKUP_TAG, "--tag", `run:${runId}`, "--host", rc.hostId, ...paths], {
      env,
    });
    const summary = bk.stdout
      .split("\n")
      .filter((s) => s.startsWith("{"))
      .map((s) => JSON.parse(s) as { message_type?: string; snapshot_id?: string })
      .find((m) => m.message_type === "summary");
    if (!summary?.snapshot_id) throw new Error("restic backup printed no summary/snapshot id");
    res.snapshotId = summary.snapshot_id;

    // 6. verify before we call it good
    const snap = await run(r, "restic", ["snapshots", "--json", summary.snapshot_id], { env });
    const found = (JSON.parse(snap.stdout || "[]") as { id: string }[]).some(
      (s) => s.id.startsWith(summary.snapshot_id as string) || (summary.snapshot_id as string).startsWith(s.id),
    );
    if (!found) throw new Error(`snapshot ${summary.snapshot_id} is not listed after the backup`);
    await run(r, "restic", rc.deepPercent > 0 ? ["check", `--read-data-subset=${rc.deepPercent}%`] : ["check"], { env });

    res.ok = true;
    res.items = items.length;
  } catch (e) {
    res.problem = (e as Error).message;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    release();
  }
  res.finishedAt = now().toISOString();
  // last-backup.json only ever holds a GOOD run; failures go to the log so a run of failures never hides the last good snapshot
  appendFileSync(join(l.stateDir, "backup-log.jsonl"), `${JSON.stringify(res)}\n`, { mode: 0o600 });
  if (res.ok) {
    const tmp = join(l.stateDir, "last-backup.json.tmp");
    writeFileSync(tmp, `${JSON.stringify(res, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, join(l.stateDir, "last-backup.json"));
  }
  return res;
}

/** Retention. Run from the operator side with credentials that may delete. Never from the box. */
export async function runPrune(deps: { r: Runner; restic: ResticConfig; env?: NodeJS.ProcessEnv }): Promise<void> {
  if ((deps.env ?? process.env).TB_BACKUP_ALLOW_PRUNE !== "1")
    throw new Error("prune needs TB_BACKUP_ALLOW_PRUNE=1 and belongs on a machine that is not the box (the box holds append-only credentials)");
  await run(
    deps.r,
    "restic",
    ["forget", "--tag", BACKUP_TAG, "--group-by", "host,tags", "--keep-daily", "7", "--keep-weekly", "4", "--keep-monthly", "6", "--prune"],
    { env: resticEnv(deps.restic) },
  );
}

function loadEnvFile(path: string | undefined): void {
  if (!path || !existsSync(path)) return;
  requireRootOnly(path);
  for (const [k, v] of Object.entries(parseEnvFile(readFileSync(path, "utf8")))) if (process.env[k] === undefined) process.env[k] = v;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const cmd = process.argv[2] ?? "run";
  loadEnvFile(process.env.TB_BACKUP_ENV_FILE ?? "/etc/tealbrick/backup.env");
  const layout = layoutFromEnv();
  try {
    if (cmd === "status") {
      process.stdout.write(readFileSync(join(layout.stateDir, "last-backup.json"), "utf8"));
    } else if (cmd === "prune") {
      await runPrune({ r: execRunner, restic: resticConfigFromEnv() });
    } else if (cmd === "run") {
      const out = await runBackup({ r: execRunner, layout, restic: resticConfigFromEnv() });
      process.stdout.write(`${JSON.stringify(out)}\n`);
      process.exit(out.ok ? 0 : 1);
    } else throw new Error(`unknown command ${cmd} (run | prune | status)`);
  } catch (e) {
    process.stderr.write(`engine backup: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
