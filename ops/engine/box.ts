// Shared helpers of the own-server engine scripts (S1 / C308): backup.ts, restore.ts, upgrade.ts.
// They run ON the box as root (the host agent calls them; an operator may run them by hand). Facts about the Openship layout were
// read from the S1 test box (moti, Openship 0.9.3, 2026-10-22): compose project `openship` in /root/.openship/compose, Postgres
// container `openship-postgres-1` (user and database `openship`, volume `openship_postgres_data`), Redis AOF volume
// `openship_redis_data`, edge state in /var/lib/openship/edge + /etc/letsencrypt + /opt/openship/static, workspace stacks as
// volumes `openship-<project>_<volume>` on networks `openship-<project>`.
// Rules for every script here: no shell (execFile style), secrets only through env or files and never in argv or logs, every
// delete is of the script's own scratch path or of a container named with our prefix, nothing global (no prune).
import { spawn } from "node:child_process";
import { createWriteStream, statSync } from "node:fs";
import { resolve, sep } from "node:path";

export interface RunOpts {
  /** Extra environment for the child (secrets go here, never in args). */
  env?: Record<string, string>;
  /** Write the child's stdout to this file (mode 0600) instead of capturing it (pg_dump). */
  stdoutFile?: string;
  /** Do not throw on a non-zero exit; the caller reads `code`. */
  allowFail?: boolean;
  timeoutMs?: number;
}
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs one program without a shell. The scripts take it as a parameter so tests can fake docker and restic. */
export type Runner = (cmd: string, args: readonly string[], opts?: RunOpts) => Promise<RunResult>;

const CAPTURE_MAX = 16 * 1024 * 1024;

export const execRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, [...args], { env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let out: ReturnType<typeof createWriteStream> | null = null;
    if (opts.stdoutFile) {
      out = createWriteStream(opts.stdoutFile, { mode: 0o600 });
      child.stdout.pipe(out);
    } else {
      child.stdout.on("data", (d: Buffer) => {
        if (stdout.length < CAPTURE_MAX) stdout += d.toString("utf8");
      });
    }
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 1024 * 1024) stderr += d.toString("utf8");
    });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const done = () => resolvePromise({ code: code ?? 1, stdout, stderr });
      if (out) out.end(done);
      else done();
    });
  });

/** Never lets a value that looks like a secret into a message. */
export function redact(text: string): string {
  return text.replace(/((?:password|passwd|secret|token|key)[A-Za-z_]*\s*[=:]\s*)\S+/gi, "$1<redacted>");
}

/** Runs and throws a readable error on a non-zero exit (unless allowFail). */
export async function run(r: Runner, cmd: string, args: readonly string[], opts: RunOpts = {}): Promise<RunResult> {
  const res = await r(cmd, args, opts);
  if (res.code !== 0 && !opts.allowFail) {
    const tail = redact(res.stderr.trim().split("\n").slice(-3).join(" | ")).slice(0, 400);
    throw new Error(`${cmd} ${redact(args.join(" ")).slice(0, 200)} exited ${res.code}: ${tail}`);
  }
  return res;
}

export interface BoxLayout {
  /** Where `openship up` keeps docker-compose.yml, .env and host-ssh/. */
  composeDir: string;
  composeProject: string;
  postgresContainer: string;
  postgresUser: string;
  postgresDb: string;
  /** Directories the Openship edge and API share with the host (vhosts, certificates, ACME webroot, static sites). */
  hostState: string[];
  /** Named volumes of the control plane. The Postgres one is covered by a dump, never copied raw. */
  postgresVolume: string;
  redisVolume: string;
  /** Our own state: staging, scratch, last-backup record, drill log. */
  stateDir: string;
  /** Extra paths the host agent wants in every snapshot (its state dir: host key, last applied seq). Chosen by the agent lead. */
  extraPaths: string[];
  /** Loopback address of the Openship API. */
  apiUrl: string;
}

export function layoutFromEnv(env: NodeJS.ProcessEnv = process.env): BoxLayout {
  const list = (v: string | undefined, d: string[]) => (v ? v.split(":").filter(Boolean) : d);
  return {
    composeDir: env.TB_ENGINE_COMPOSE_DIR || "/root/.openship/compose",
    composeProject: env.TB_ENGINE_COMPOSE_PROJECT || "openship",
    postgresContainer: env.TB_ENGINE_PG_CONTAINER || "openship-postgres-1",
    postgresUser: env.TB_ENGINE_PG_USER || "openship",
    postgresDb: env.TB_ENGINE_PG_DB || "openship",
    hostState: list(env.TB_ENGINE_HOST_STATE, ["/var/lib/openship/edge", "/etc/letsencrypt", "/opt/openship/static"]),
    postgresVolume: env.TB_ENGINE_PG_VOLUME || "openship_postgres_data",
    redisVolume: env.TB_ENGINE_REDIS_VOLUME || "openship_redis_data",
    stateDir: env.TB_ENGINE_STATE_DIR || "/var/lib/tealbrick/engine",
    extraPaths: list(env.TB_BACKUP_EXTRA_PATHS, []),
    apiUrl: env.TB_ENGINE_API_URL || "http://127.0.0.1:4000",
  };
}

/** A workspace stack volume: `openship-<project>_<volume>` (the control-plane volumes are `openship_*`). */
export const STACK_VOLUME_RE = /^openship-[a-z0-9][a-z0-9-]*_[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Throws unless `path` is inside `root` (after normalising) and is not `root` itself. Guards every delete the scripts do. */
export function insideOrThrow(root: string, path: string): string {
  const r = resolve(root);
  const p = resolve(path);
  if (!p.startsWith(r + sep) || p === r) throw new Error(`refusing to touch ${p}: not inside ${r}`);
  return p;
}

/** Root-only file check for secret files (restic password file, backup env file). */
export function requireRootOnly(path: string): void {
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) throw new Error(`${path} must not be readable by group or others (chmod 600)`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${path} must be owned by the user that runs the script`);
}

/** KEY=VALUE lines (no export, no quotes handling beyond one pair of quotes). Values are returned, never logged. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2] as string;
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    out[m[1] as string] = v;
  }
  return out;
}

export function ts(now: Date = new Date()): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/** `sha256:<hex>` of a file, streaming. */
export async function sha256File(path: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { createReadStream } = await import("node:fs");
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return `sha256:${h.digest("hex")}`;
}
