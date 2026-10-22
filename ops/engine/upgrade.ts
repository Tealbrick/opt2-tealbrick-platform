// Openship upgrade and rollback for an own-server box (S1-4b, REDTEAM M3 + M6). An engine bump is a pin in the signed release index
// (registry/engines.json -> kind `engine`), never `openship upgrade` on the box: Openship rewrites its compose file and migrates its
// database on its own schedule, and its images are mutable tags.
//
//   node ops/engine/upgrade.ts apply --pin <engine-record.json> [--token-file <file> --smoke-path </api/...>]
//   node ops/engine/upgrade.ts rollback --run <runId>
//   node ops/engine/upgrade.ts drill --pin <engine-record.json>     # the M6 done-when, see below
//
// `--pin` is the index record the host agent already verified against the root-signed index (kind engine, 5 images by digest in our
// mirror). This script re-checks its shape (engineEntryProblem) and then compares what RUNS to it. It does not fetch or trust anything
// else.
//
// How the digests reach Openship without editing its managed file: a compose override `docker-compose.digests.yml` beside
// docker-compose.yml sets `image:` of postgres, redis, api, dashboard and edge to the pinned `name@sha256:...`. Our calls always use
// `-f docker-compose.yml -f docker-compose.digests.yml`. The host agent therefore never runs `openship up` or `openship upgrade`
// (either would regenerate docker-compose.yml and could pull a tag).
//
// apply: off-box snapshot (must pass) -> local safety copy (compose dir + pg_dump + container list) -> pull the pinned images BEFORE
// anything changes -> `up -d` -> health -> verify (every control-plane container runs the pinned reference; workspace stack containers
// unchanged; Openship tables still there) -> done. Any failure after `up`: ROLLBACK = stop api+dashboard, restore the compose files and
// the database from the local copy (the new API may have migrated the schema, an old image on a new schema is not a rollback), `up -d`
// the old set, verify it matches the recorded pre-state.
//
// drill (what `evidence.upgradeDrill` in registry/engines.json points to): (1) apply with a FORCED failure after `up` -> must roll back
// and verify; (2) apply for real; (3) restore drill (restore.ts) on the snapshot taken before step 2. Pass = all three pass.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ENGINE_ROLES, type EngineRole, engineEntryProblem, type IndexRelease } from "../../ci/tb-ci.ts";
import { type BackupResult, type ResticConfig, resticConfigFromEnv, runBackup } from "./backup.ts";
import { type BoxLayout, execRunner, layoutFromEnv, parseEnvFile, type Runner, requireRootOnly, run, ts } from "./box.ts";
import { type DrillResult, runDrill } from "./restore.ts";

export const OVERRIDE_FILE = "docker-compose.digests.yml";
/** compose service name for each pinned role (the same names, kept explicit so a rename in Openship fails a test, not a box). */
export const SERVICE_OF: Readonly<Record<EngineRole, string>> = { api: "api", dashboard: "dashboard", edge: "edge", postgres: "postgres", redis: "redis" };

export interface UpgradeDeps {
  r: Runner;
  layout: BoxLayout;
  restic: ResticConfig;
  pin: IndexRelease;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  health?: (url: string, token?: string) => Promise<boolean>;
  token?: string;
  smokePath?: string;
  /** Drill only: fail on purpose right after `up`, to prove the rollback. */
  forceFail?: boolean;
  backup?: typeof runBackup;
}
export interface UpgradeStep {
  step: string;
  ok: boolean;
  detail: string;
}
export interface UpgradeResult {
  ok: boolean;
  rolledBack: boolean;
  runId: string;
  from: string | null;
  to: string;
  snapshotId?: string;
  steps: UpgradeStep[];
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const defaultHealth = async (url: string, token?: string) => {
  const res = await fetch(url, token ? { headers: { authorization: `Bearer ${token}` } } : {}).catch(() => null);
  return res?.ok === true;
};

/** The override file text for a pin. Every value was matched against the mirror-by-digest pattern by engineEntryProblem. */
export function overrideYaml(pin: IndexRelease): string {
  const images = pin.engine?.images ?? [];
  const lines = [
    "# Written by ops/engine/upgrade.ts from the signed engine pin. Do not edit.",
    `# engine ${pin.product} ${pin.version} (${pin.id})`,
    "services:",
  ];
  for (const role of ENGINE_ROLES) {
    const im = images.find((i) => i.role === role);
    if (!im) throw new Error(`pin has no ${role} image`);
    lines.push(`  ${SERVICE_OF[role]}:`, `    image: ${im.image}`);
  }
  return `${lines.join("\n")}\n`;
}

interface Row {
  name: string;
  image: string;
  state: string;
  status: string;
}
async function containers(r: Runner): Promise<Row[]> {
  const res = await run(r, "docker", ["ps", "-a", "--format", "{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}"]);
  return res.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name, image, state, status] = l.split("\t") as [string, string, string, string];
      return { name, image, state, status };
    });
}
/** Container name of a compose service: `<project>-<service>-1`, except the edge, which has a fixed name. */
const containerOf = (l: BoxLayout, svc: string) => (svc === "edge" ? "openship-edge" : `${l.composeProject}-${svc}-1`);
/** Exactly the five control-plane containers. Workspace stacks are also named `openship-<project>-...`, so a prefix test is wrong
 *  (the unit test with a workspace container named like that caught it). */
const isControlPlane = (l: BoxLayout, name: string) => Object.values(SERVICE_OF).some((svc) => containerOf(l, svc) === name);

function composeArgs(l: BoxLayout, withOverride: boolean): string[] {
  const files = [
    "-f",
    join(l.composeDir, "docker-compose.yml"),
    ...(withOverride && existsSync(join(l.composeDir, OVERRIDE_FILE)) ? ["-f", join(l.composeDir, OVERRIDE_FILE)] : []),
  ];
  return ["compose", "--project-name", l.composeProject, "--project-directory", l.composeDir, ...files];
}

async function tables(r: Runner, l: BoxLayout): Promise<string[]> {
  const res = await run(r, "docker", [
    "exec",
    l.postgresContainer,
    "psql",
    "-U",
    l.postgresUser,
    "-d",
    l.postgresDb,
    "-Atc",
    "select table_schema||'.'||table_name from information_schema.tables where table_schema not in ('pg_catalog','information_schema') order by 1",
  ]);
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function waitHealthy(deps: UpgradeDeps, seconds: number): Promise<boolean> {
  const health = deps.health ?? defaultHealth;
  const sleep = deps.sleep ?? defaultSleep;
  for (let i = 0; i < seconds; i++) {
    if (await health(`${deps.layout.apiUrl}/api/health`)) {
      // the authenticated smoke the host agent asked for (its own adapter probe); the token never goes to a log
      if (!deps.smokePath || (await health(`${deps.layout.apiUrl}${deps.smokePath}`, deps.token))) return true;
    }
    await sleep(1000);
  }
  return false;
}

/** Compares what runs with a recorded or pinned reference set. Returns the problems. */
function imageProblems(l: BoxLayout, rows: Row[], want: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [svc, image] of Object.entries(want)) {
    const name = containerOf(l, svc);
    const row = rows.find((x) => x.name === name);
    if (!row) out.push(`${name} is not present`);
    else if (row.image !== image) out.push(`${name} runs ${row.image}, expected ${image}`);
    else if (row.state !== "running") out.push(`${name} is ${row.state}`);
    else if (/\((unhealthy|health: starting)\)/.test(row.status)) out.push(`${name} is ${/unhealthy/.test(row.status) ? "unhealthy" : "still starting"}`);
  }
  return out;
}

function postgresMajor(ref: string): string | null {
  const m = /(?:^|\/)postgres:(\d+)/.exec(ref);
  return m ? (m[1] as string) : null;
}

export async function runUpgrade(deps: UpgradeDeps): Promise<UpgradeResult> {
  const { r, layout: l, pin } = deps;
  const now = deps.now ?? (() => new Date());
  const runId = ts(now());
  const steps: UpgradeStep[] = [];
  const res: UpgradeResult = { ok: false, rolledBack: false, runId, from: null, to: pin.version, steps };
  const step = (name: string, ok: boolean, detail: string) => steps.push({ step: name, ok, detail });
  const work = join(l.stateDir, "upgrade", runId);
  let changed = false; // the override file was written
  let switched = false; // `up -d` ran: containers may be new and the schema may be migrated
  let preImages: Record<string, string> = {};
  let svcs: string[] = [];
  let preTables: string[] = [];
  let preWorkspace: Row[] = [];
  try {
    const bad = engineEntryProblem(pin);
    if (bad) throw new Error(`pin refused: ${bad}`);
    if (!existsSync(join(l.composeDir, "docker-compose.yml"))) throw new Error(`${l.composeDir}/docker-compose.yml not found`);
    const envText = existsSync(join(l.composeDir, ".env")) ? readFileSync(join(l.composeDir, ".env"), "utf8") : "";
    res.from = parseEnvFile(envText).OPENSHIP_VERSION ?? null;

    const before = await containers(r);
    const pgNow = before.find((x) => x.name === l.postgresContainer);
    const pgPin = pin.engine?.images.find((i) => i.role === "postgres");
    if (pgNow && pgPin) {
      const have = postgresMajor(pgNow.image);
      const want = postgresMajor(pgPin.upstream);
      if (have && want && have !== want)
        throw new Error(`Postgres major ${have} -> ${want}: a data directory does not survive that; plan a dump/restore migration, not an image swap`);
      if (!want) throw new Error(`cannot read the Postgres major from the pin upstream ${pgPin.upstream}; refusing to swap the database image`);
    }
    preImages = Object.fromEntries(
      ENGINE_ROLES.map((role) => [SERVICE_OF[role], before.find((x) => x.name === containerOf(l, SERVICE_OF[role]))?.image ?? ""]).filter(([, v]) => v),
    );
    // only the services that exist on this box: a `--no-ui` install has no dashboard container and must not get one from `up -d`
    svcs = Object.keys(preImages);
    preWorkspace = before.filter((x) => !isControlPlane(l, x.name));
    preTables = await tables(r, l);
    const unhealthyNow = imageProblems(l, before, preImages);
    if (unhealthyNow.length) throw new Error(`the engine is not healthy before the upgrade: ${unhealthyNow.join("; ")}`);
    step(
      "preflight",
      true,
      `from ${res.from ?? "unknown"} to ${pin.version}; ${preTables.length} Openship tables; ${preWorkspace.length} workspace containers`,
    );

    // 1. off-box snapshot first: no snapshot, no upgrade
    const bk: BackupResult = await (deps.backup ?? runBackup)({ r, layout: l, restic: deps.restic, now: deps.now });
    if (!bk.ok) throw new Error(`pre-upgrade off-box backup failed: ${bk.problem}`);
    res.snapshotId = bk.snapshotId;
    step("backup", true, `snapshot ${bk.snapshotId}`);

    // 2. local safety copy for a fast rollback (the off-box snapshot is the disaster copy)
    mkdirSync(work, { recursive: true, mode: 0o700 });
    cpSync(l.composeDir, join(work, "compose"), { recursive: true, preserveTimestamps: true });
    await run(r, "docker", ["exec", l.postgresContainer, "pg_dump", "-U", l.postgresUser, "-d", l.postgresDb, "-Fc"], { stdoutFile: join(work, "pre.dump") });
    writeFileSync(
      join(work, "pre-state.json"),
      `${JSON.stringify({ at: now().toISOString(), from: res.from, images: preImages, tables: preTables, containers: before }, null, 2)}\n`,
      { mode: 0o600 },
    );
    step("safety-copy", true, `compose dir + database dump in ${work}`);

    // 3. new override, pull BEFORE touching anything that runs
    writeFileSync(join(l.composeDir, OVERRIDE_FILE), overrideYaml(pin), { mode: 0o600 });
    changed = true;
    await run(r, "docker", [...composeArgs(l, true), "pull", ...svcs]);
    step("pull", true, "pinned images pulled by digest from the mirror");

    // 4. switch
    switched = true;
    await run(r, "docker", [...composeArgs(l, true), "up", "-d", ...svcs]);
    step("up", true, `compose up -d ${svcs.join(" ")} with the digest override`);
    if (deps.forceFail) throw new Error("forced failure after up (drill)");
    if (!(await waitHealthy(deps, 180))) throw new Error("the Openship API did not become healthy in 180 s");
    step("health", true, "API healthy" + (deps.smokePath ? ` and ${deps.smokePath} answers with the token` : ""));

    // 5. verify what runs equals the pin; nothing else moved
    const want = Object.fromEntries((pin.engine?.images ?? []).filter((i) => svcs.includes(SERVICE_OF[i.role])).map((i) => [SERVICE_OF[i.role], i.image]));
    const after = await containers(r);
    const wrong = imageProblems(l, after, want);
    if (wrong.length) throw new Error(`running set differs from the pin: ${wrong.join("; ")}`);
    const moved = preWorkspace.filter((p) => !after.some((a) => a.name === p.name && a.image === p.image && a.state === p.state));
    if (moved.length) throw new Error(`workspace containers changed during the upgrade: ${moved.map((m) => m.name).join(", ")}`);
    const postTables = await tables(r, l);
    const lost = preTables.filter((t) => !postTables.includes(t));
    if (lost.length) throw new Error(`Openship tables disappeared: ${lost.slice(0, 5).join(", ")}`);
    step("verify", true, `control plane runs the pin; ${preWorkspace.length} workspace containers unchanged; ${postTables.length} tables`);
    res.ok = true;
  } catch (e) {
    step("failed", false, (e as Error).message);
    if (changed) await rollback(deps, work, preImages, preTables, svcs, steps, res, switched);
  }
  mkdirSync(l.stateDir, { recursive: true, mode: 0o700 });
  appendFileSync(join(l.stateDir, "upgrades.jsonl"), `${JSON.stringify({ at: now().toISOString(), ...res })}\n`, { mode: 0o600 });
  return res;
}

/** Puts the box back to the recorded pre-state from the local copy. Never throws: its outcome is in the steps. */
async function rollback(
  deps: UpgradeDeps,
  work: string,
  preImages: Record<string, string>,
  preTables: string[],
  svcs: string[],
  steps: UpgradeStep[],
  res: UpgradeResult,
  switched: boolean,
): Promise<void> {
  const { r, layout: l } = deps;
  const step = (name: string, ok: boolean, detail: string) => steps.push({ step: name, ok, detail });
  try {
    // the new API may have migrated the schema: stop the writers first, then put the files and the data back
    if (switched) await run(r, "docker", [...composeArgs(l, true), "stop", ...svcs.filter((x) => x === "api" || x === "dashboard")], { allowFail: true });
    cpSync(join(work, "compose", "docker-compose.yml"), join(l.composeDir, "docker-compose.yml"));
    const oldOverride = join(work, "compose", OVERRIDE_FILE);
    if (existsSync(oldOverride)) cpSync(oldOverride, join(l.composeDir, OVERRIDE_FILE));
    else writeFileSync(join(l.composeDir, OVERRIDE_FILE), "# no override before the upgrade attempt\nservices: {}\n", { mode: 0o600 });
    if (!switched) {
      // nothing that runs was touched (the pull failed): the files are back, that is the whole rollback
      step("rollback", true, "nothing was switched; the previous compose files are back");
      res.rolledBack = true;
      return;
    }
    await run(r, "docker", ["cp", join(work, "pre.dump"), `${l.postgresContainer}:/tmp/pre.dump`]);
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
      "/tmp/pre.dump",
    ]);
    await run(r, "docker", ["exec", l.postgresContainer, "rm", "-f", "/tmp/pre.dump"]);
    await run(r, "docker", [...composeArgs(l, true), "up", "-d", ...svcs]);
    const healthy = await waitHealthy({ ...deps, smokePath: undefined }, 180);
    const rows = await containers(r);
    const problems = imageProblems(l, rows, preImages);
    const tbl = await tables(r, l);
    const gone = preTables.filter((t) => !tbl.includes(t));
    if (!healthy) problems.push("API not healthy after the rollback");
    if (gone.length) problems.push(`tables missing after the rollback: ${gone.slice(0, 5).join(", ")}`);
    step("rollback", problems.length === 0, problems.length ? problems.join("; ") : "pre-upgrade images, compose files and database are back; API healthy");
    res.rolledBack = problems.length === 0;
  } catch (e) {
    step("rollback", false, `ROLLBACK FAILED, restore by hand from ${work} or the off-box snapshot ${res.snapshotId ?? "(none)"}: ${(e as Error).message}`);
  }
}

export interface UpgradeDrillResult {
  ok: boolean;
  runId: string;
  forcedFailure: UpgradeResult;
  upgrade: UpgradeResult | null;
  restoreDrill: DrillResult | null;
}

/** The M6 upgrade + restore drill (see the header). */
export async function runUpgradeDrill(deps: UpgradeDeps & { drill?: typeof runDrill }): Promise<UpgradeDrillResult> {
  const now = deps.now ?? (() => new Date());
  const runId = ts(now());
  const forced = await runUpgrade({ ...deps, forceFail: true });
  // a forced failure must END in a verified rollback; ok=false is the expected answer of that run
  if (forced.ok || !forced.rolledBack) return { ok: false, runId, forcedFailure: forced, upgrade: null, restoreDrill: null };
  const real = await runUpgrade({ ...deps, forceFail: false });
  if (!real.ok) return { ok: false, runId, forcedFailure: forced, upgrade: real, restoreDrill: null };
  const drill = await (deps.drill ?? runDrill)({
    r: deps.r,
    layout: deps.layout,
    restic: deps.restic,
    snapshot: real.snapshotId,
    now: deps.now,
    sleep: deps.sleep,
  });
  const out: UpgradeDrillResult = { ok: drill.ok, runId, forcedFailure: forced, upgrade: real, restoreDrill: drill };
  appendFileSync(join(deps.layout.stateDir, "drills.jsonl"), `${JSON.stringify({ kind: "upgrade-drill", at: now().toISOString(), ...out })}\n`, {
    mode: 0o600,
  });
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (n: string) => {
    const i = rest.indexOf(n);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  try {
    const envFile = process.env.TB_BACKUP_ENV_FILE ?? "/etc/tealbrick/backup.env";
    if (existsSync(envFile)) {
      requireRootOnly(envFile);
      for (const [k, v] of Object.entries(parseEnvFile(readFileSync(envFile, "utf8")))) if (process.env[k] === undefined) process.env[k] = v;
    }
    const pinFile = arg("--pin");
    if (!pinFile) throw new Error("usage: upgrade.ts apply|drill --pin <engine-record.json> [--token-file <f> --smoke-path </api/...>]");
    const tokenFile = arg("--token-file");
    if (tokenFile) requireRootOnly(tokenFile);
    const deps: UpgradeDeps = {
      r: execRunner,
      layout: layoutFromEnv(),
      restic: resticConfigFromEnv(),
      pin: JSON.parse(readFileSync(pinFile, "utf8")) as IndexRelease,
      token: tokenFile ? readFileSync(tokenFile, "utf8").trim() : undefined,
      smokePath: arg("--smoke-path"),
    };
    const out = cmd === "apply" ? await runUpgrade(deps) : cmd === "drill" ? await runUpgradeDrill(deps) : null;
    if (!out) throw new Error("unknown command (apply | drill)");
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(out.ok ? 0 : 1);
  } catch (e) {
    process.stderr.write(`engine upgrade: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
