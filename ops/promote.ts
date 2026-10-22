// C199: promote one frozen RELEASE SET to the `live` environment (PROD). The only way a set reaches live.
//   node ops/promote.ts --set <dir>/RS-<n>.json [--dry-run] [--environment live]
// 1. Reads and validates the set ({id, createdAt, notes, portalCore, adminGui?, portalGui, website, bridge, apps, cli, previous}).
// 2. Verifies: every SHA has a green Woodpecker pipeline (GitHub commit status `ci/woodpecker/push/ci` = success); the
//    bridge and every app version is a STABLE release in the published release index (with an image digest); the CLI
//    version has a release in its repo (warning only: the CLI is not deployed by this script).
// 3. Deploys in a fixed order — portal-core → admin-gui (when the set has one, RS-2+) → portal-gui → website — with ops/railway-deploy.ts (pinned SHA, C141),
//    waits for Railway SUCCESS (Core's health check runs after its migrations, so SUCCESS = migrated + healthy), and
//    smoke-tests after each step. A service already running the set's SHA is skipped, unless --repoint (C206): then every
//    service is redeployed at the set's SHA from its CURRENT GitHub source (railway-deploy sets source = OWNER/<repo>), so a
//    same-SHA promote re-points live to the org repos; the record goes to RS-<n>.repointed.json (the promotion record stays).
// 4. Stops at the first failure and prints the rollback command (promote the previous set). Writes
//    <dir>/RS-<n>.promoted.json (the promotion record, also on failure). --dry-run prints the plan and the checks only.
// Apps and the bridge are never deployed here: app updates on live stay owner-triggered in the Portal (C199 (4)).
// Uses the operator's Railway CLI login and gh login; prints no variable values (it never reads variables).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { railwayToken } from "./railway-token.ts";

export const PROJECT = "15297ce5-0283-4901-a408-9c802e6ac53a"; // Railway project "opt2"
/** C206: the opt2 repos live in the Tealbrick org (GitHub redirects the old Martin-Atrin paths; we do not rely on that). */
export const OWNER = "Tealbrick";
export const INDEX_URL = `https://github.com/${OWNER}/opt2-tealbrick-platform/releases/download/registry/index.json`;
export const CI_CONTEXT = "ci/woodpecker/push/ci";
/** A manual Woodpecker run of the same commit (e.g. re-run after an infrastructure failure during the org move) counts too. */
export const CI_CONTEXT_MANUAL = "ci/woodpecker/manual/ci";

export interface RepoSha {
  repo: string;
  sha: string;
}
export interface ReleaseSet {
  id: string;
  createdAt: string;
  notes: string;
  portalCore: RepoSha;
  /** C203/C214: Tealbrick Admin GUI (optional: RS-1 has none) */
  adminGui?: RepoSha;
  portalGui: RepoSha;
  website: RepoSha;
  bridge: { version: string };
  apps: { product: string; version: string }[];
  /** repo: where the `cli-v<version>` release lives (default opt2-tealbrick-bridge; the C157 split moves it to opt2-tealbrick-cli) */
  cli: { version: string; repo?: string };
  previous: string | null;
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;
/** RS-<n> (release train) or RS-<n>.<h> (hotfix h on top of RS-<n>, e.g. RS-7.1). */
const SET_ID = /^RS-(\d+)(?:\.(\d+))?$/;

/** The previous set a set must name: RS-1 none; RS-n.1 → RS-n; RS-n.h → RS-n.(h-1); RS-n → RS-(n-1) or any hotfix of it. */
export function previousRule(id: string): { none: true } | { exact: string } | { major: number } | null {
  const m = SET_ID.exec(id);
  if (!m) return null;
  const n = Number(m[1]);
  const h = m[2] === undefined ? 0 : Number(m[2]);
  if (h > 0) return { exact: h === 1 ? `RS-${n}` : `RS-${n}.${h - 1}` };
  return n === 1 ? { none: true } : { major: n - 1 };
}

/** Validates a parsed release-set file. Throws with every problem listed. */
export function parseSet(raw: unknown): ReleaseSet {
  const errs: string[] = [];
  const o = (raw ?? {}) as Record<string, unknown>;
  const id = String(o.id ?? "");
  const m = SET_ID.exec(id);
  if (!m) errs.push("id must be RS-<n> or RS-<n>.<h>");
  if (typeof o.createdAt !== "string" || Number.isNaN(Date.parse(o.createdAt))) errs.push("createdAt must be an ISO date");
  if (typeof o.notes !== "string") errs.push("notes must be a string");
  for (const k of ["portalCore", "adminGui", "portalGui", "website"] as const) {
    const v = o[k] as RepoSha | undefined;
    if (k === "adminGui" && v === undefined) continue;
    if (!v || !/^opt2-tealbrick-[a-z0-9-]+$/.test(String(v.repo))) errs.push(`${k}.repo must be opt2-tealbrick-<x>`);
    if (!v || !SHA.test(String(v.sha))) errs.push(`${k}.sha must be a full 40-hex SHA`);
  }
  if (!SEMVER.test(String((o.bridge as { version?: unknown } | undefined)?.version))) errs.push("bridge.version must be x.y.z (stable)");
  if (!SEMVER.test(String((o.cli as { version?: unknown } | undefined)?.version))) errs.push("cli.version must be x.y.z");
  const cliRepo = (o.cli as { repo?: unknown } | undefined)?.repo;
  if (cliRepo !== undefined && !/^opt2-tealbrick-[a-z0-9-]+$/.test(String(cliRepo))) errs.push("cli.repo must be opt2-tealbrick-<x>");
  const apps = o.apps as { product?: unknown; version?: unknown }[] | undefined;
  if (!Array.isArray(apps) || apps.length === 0) errs.push("apps must be a non-empty list");
  else {
    const seen = new Set<string>();
    for (const a of apps) {
      if (!/^[a-z][a-z0-9-]*$/.test(String(a.product))) errs.push(`app product ${String(a.product)} is not an id`);
      if (!SEMVER.test(String(a.version))) errs.push(`app ${String(a.product)} version must be x.y.z (stable)`);
      if (seen.has(String(a.product))) errs.push(`app ${String(a.product)} is listed twice`);
      seen.add(String(a.product));
    }
  }
  const rule = previousRule(id);
  if (rule && "none" in rule && o.previous !== null && o.previous !== undefined) errs.push("RS-1 has no previous set (previous: null)");
  if (rule && "exact" in rule && o.previous !== rule.exact) errs.push(`previous must be ${rule.exact}`);
  if (rule && "major" in rule && !new RegExp(`^RS-${rule.major}(\\.\\d+)?$`).test(String(o.previous)))
    errs.push(`previous must be RS-${rule.major} or one of its hotfixes (RS-${rule.major}.<h>)`);
  if (errs.length) throw new Error(`release set invalid:\n  - ${errs.join("\n  - ")}`);
  return { ...(o as unknown as ReleaseSet), previous: rule && "none" in rule ? null : (o.previous as string) };
}

export type ServiceName = "portal-core" | "admin-gui" | "portal-gui" | "website";
export interface Step {
  service: ServiceName;
  repo: string;
  sha: string;
  /** true = live already runs this SHA (SUCCESS); nothing to deploy */
  skip: boolean;
}

/** Fixed order (C199): Core first (migrations), then the Admin GUI (its gateway calls Core's admin routes), then the
 *  customer GUI gateway, then the website. */
export const ORDER: readonly ServiceName[] = ["portal-core", "admin-gui", "portal-gui", "website"];

/** The repo + SHA of each service the set contains (admin-gui only when the set has it). */
export function sourcesOf(set: ReleaseSet): Partial<Record<ServiceName, RepoSha>> {
  return { "portal-core": set.portalCore, ...(set.adminGui ? { "admin-gui": set.adminGui } : {}), "portal-gui": set.portalGui, website: set.website };
}

/** `repoint` (C206): never skip, so every service is redeployed (and its Railway source re-set) at the set's SHA. */
export function planSteps(set: ReleaseSet, running: Partial<Record<ServiceName, string | null>>, repoint = false): Step[] {
  const src = sourcesOf(set);
  return ORDER.flatMap((service) => {
    const v = src[service];
    return v ? [{ service, repo: v.repo, sha: v.sha, skip: !repoint && running[service] === v.sha }] : [];
  });
}

/** GitHub combined status (latest status per context) → green when the NEWEST Woodpecker ci result of this commit, push
 *  or manual, is success. A later failed run makes it red again; other contexts (conformance, …) do not decide. */
export function ciGreen(statuses: { context: string; state: string; updated_at?: string; created_at?: string }[]): boolean {
  const ours = statuses
    .filter((s) => s.context === CI_CONTEXT || s.context === CI_CONTEXT_MANUAL)
    .sort((a, b) => String(b.updated_at ?? b.created_at ?? "").localeCompare(String(a.updated_at ?? a.created_at ?? "")));
  return ours[0]?.state === "success";
}

interface IndexRelease {
  product: string;
  kind: string;
  version: string;
  channel: string;
  image?: string | null;
}

/** Bridge + apps must be STABLE releases with a pinned image digest in the release index. Returns the problems. */
export function checkIndex(set: ReleaseSet, releases: readonly IndexRelease[]): string[] {
  const problems: string[] = [];
  const find = (kind: string, product: string, version: string) =>
    releases.find((r) => r.kind === kind && r.product === product && r.version === version && r.channel === "stable");
  const want = [
    { kind: "bridge", product: "bridge", version: set.bridge.version },
    ...set.apps.map((a) => ({ kind: "app", product: a.product, version: a.version })),
  ];
  for (const w of want) {
    const r = find(w.kind, w.product, w.version);
    if (!r) problems.push(`${w.product}@${w.version} is not a stable ${w.kind} release in the index`);
    else if (!/@sha256:[0-9a-f]{64}$/.test(String(r.image ?? ""))) problems.push(`${w.product}@${w.version} has no image digest`);
  }
  return problems;
}

/** The host a smoke test uses: a custom domain that is not a www alias (www only 301s to the apex), else the Railway
 *  service domain, else a www alias (C214: the Railway smoke domains are removed after the DNS switch). */
export function smokeHost(custom: readonly string[], service: readonly string[]): string | null {
  return custom.find((h) => !h.startsWith("www.")) ?? service[0] ?? custom[0] ?? null;
}

/** Cloudflare Access in front of the admin GUI (be.tealbrick.com, C203) answers an anonymous request with a redirect to
 *  its login (or 401/403): that proves the host serves, so it counts as reachable for the smoke. */
export function adminReachable(status: number, location: string | null): boolean {
  if (status === 200) return true;
  if ([301, 302, 303, 307].includes(status)) return /cloudflareaccess\.com|\/cdn-cgi\/access\//.test(location ?? "");
  return status === 401 || status === 403;
}

/** Index (app/bridge) problems block a promotion, except for a rollback, where they are warnings (apps are not deployed). */
export function indexProblems(problems: readonly string[], rollback: boolean): { fatal: string[]; warnings: string[] } {
  return rollback ? { fatal: [], warnings: [...problems] } : { fatal: [...problems], warnings: [] };
}

/** The rollback for a failed promotion: promote the previous set (or, for RS-1, remove the live deployments by hand). */
export function rollbackCommand(set: ReleaseSet, setFile: string): string {
  if (!set.previous) return "no previous set (RS-1): Railway → live → <service> → Deployments → remove the failed deployment; live had nothing before";
  return `node ops/promote.ts --rollback --set ${join(dirname(setFile), `${set.previous}.json`)}`;
}

export interface StepResult {
  service: ServiceName;
  sha: string;
  skipped: boolean;
  deploymentId: string | null;
  status: string;
  smoke: { check: string; ok: boolean; detail: string }[];
}
export interface PromotionRecord {
  set: string;
  environment: string;
  startedAt: string;
  finishedAt: string;
  outcome: "promoted" | "failed";
  steps: StepResult[];
  failure: string | null;
  rollback: string;
}

export function recordPath(setFile: string, id: string, repoint = false): string {
  return join(dirname(setFile), `${id}.${repoint ? "repointed" : "promoted"}.json`);
}

export interface Options {
  setFile: string;
  environment: string;
  dryRun: boolean;
  /** C206: redeploy every service at the set's SHA from its current (org) source, even when it already runs that SHA */
  repoint: boolean;
  /** --rollback: re-promote an older (immutable) set. Its app list may name versions that were delisted since (e.g. fleet,
   *  C208); apps are never deployed here, so app/bridge index problems become warnings. Service SHAs and CI stay checked. */
  rollback: boolean;
}
export function parseArgs(argv: readonly string[]): Options {
  const val = (f: string) => {
    const i = argv.indexOf(f);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) throw new Error(`${f} needs a value`);
    return v;
  };
  for (const a of argv)
    if (a.startsWith("--") && !["--set", "--environment", "--dry-run", "--repoint", "--rollback"].includes(a)) throw new Error(`unknown option ${a}`);
  const setFile = val("--set");
  if (!setFile) throw new Error("--set <dir>/RS-<n>.json is required");
  if (!SET_ID.test(basename(setFile, ".json"))) throw new Error("the set file must be named RS-<n>.json or RS-<n>.<h>.json");
  const environment = val("--environment") ?? "live";
  if (environment === "production") throw new Error('refusing "production": that is DEV; deploy dev with ops/railway-deploy.ts');
  return { setFile, environment, dryRun: argv.includes("--dry-run"), repoint: argv.includes("--repoint"), rollback: argv.includes("--rollback") };
}

// ---- side effects below (not unit-tested; exercised by --dry-run and the live run) ----

const here = dirname(fileURLToPath(import.meta.url));

function token(): string {
  return railwayToken();
}
async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json", "user-agent": "opt2-promote" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || body.errors?.length) throw new Error(`Railway API: ${body.errors?.map((e) => e.message).join("; ") ?? res.status}`);
  return body.data as T;
}

function ghJson<T>(path: string): T | null {
  const r = spawnSync("gh", ["api", path], { encoding: "utf8" });
  return r.status === 0 ? (JSON.parse(r.stdout) as T) : null;
}

interface Ctx {
  envId: string;
  services: Record<ServiceName, string>;
}
async function context(environment: string): Promise<Ctx> {
  const d = await gql<{
    project: { environments: { edges: { node: { id: string; name: string } }[] }; services: { edges: { node: { id: string; name: string } }[] } };
  }>("query($id:String!){ project(id:$id){ environments{ edges{ node{ id name } } } services{ edges{ node{ id name } } } } }", { id: PROJECT });
  const envId = d.project.environments.edges.find((e) => e.node.name === environment)?.node.id;
  if (!envId) throw new Error(`environment ${environment} not in project opt2`);
  const services = {} as Record<ServiceName, string>;
  for (const s of ORDER) {
    const id = d.project.services.edges.find((e) => e.node.name === s)?.node.id;
    if (!id) throw new Error(`service ${s} not in project opt2`);
    services[s] = id;
  }
  return { envId, services };
}

async function runningSha(ctx: Ctx, service: ServiceName): Promise<string | null> {
  const d = await gql<{ deployments: { edges: { node: { status: string; meta: { commitHash?: string } | null } }[] } }>(
    "query($p:String!,$e:String!,$s:String!){ deployments(first:10, input:{projectId:$p, environmentId:$e, serviceId:$s}){ edges{ node{ status meta } } } }",
    { p: PROJECT, e: ctx.envId, s: ctx.services[service] },
  );
  return d.deployments.edges.find((e) => e.node.status === "SUCCESS")?.node.meta?.commitHash ?? null;
}

async function publicUrl(ctx: Ctx, service: ServiceName): Promise<string | null> {
  const d = await gql<{ serviceInstance: { domains: { serviceDomains: { domain: string }[]; customDomains: { domain: string }[] } } | null }>(
    "query($e:String!,$s:String!){ serviceInstance(environmentId:$e, serviceId:$s){ domains{ serviceDomains{ domain } customDomains{ domain } } } }",
    { e: ctx.envId, s: ctx.services[service] },
  );
  const host = smokeHost(
    d.serviceInstance?.domains.customDomains.map((c) => c.domain) ?? [],
    d.serviceInstance?.domains.serviceDomains.map((c) => c.domain) ?? [],
  );
  return host ? `https://${host}` : null;
}

async function waitDeployment(id: string, timeoutMs = 20 * 60_000): Promise<string> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const d = await gql<{ deployment: { status: string } }>("query($id:String!){ deployment(id:$id){ status } }", { id });
    const st = d.deployment.status;
    if (["SUCCESS", "FAILED", "CRASHED", "REMOVED", "SKIPPED"].includes(st)) return st;
    if (Date.now() > end) return `TIMEOUT(${st})`;
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

async function httpCheck(
  name: string,
  url: string,
  expect: (res: Response, body: string) => boolean,
  init: RequestInit = {},
): Promise<{ check: string; ok: boolean; detail: string }> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000) });
      const body = await res.text();
      if (expect(res, body)) return { check: name, ok: true, detail: `${res.status}` };
      if (attempt === 6) return { check: name, ok: false, detail: `${res.status} ${body.slice(0, 80).replace(/\s+/g, " ")}` };
    } catch (e) {
      if (attempt === 6) return { check: name, ok: false, detail: (e as Error).message.slice(0, 120) };
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return { check: name, ok: false, detail: "unreachable" };
}

async function smoke(ctx: Ctx, service: ServiceName): Promise<{ check: string; ok: boolean; detail: string }[]> {
  if (service === "admin-gui") {
    // Admin GUI: only /healthz (no anonymous admin page). No domain yet = Railway health check only.
    const admin = await publicUrl(ctx, "admin-gui");
    if (!admin) return [{ check: "admin-gui", ok: true, detail: "no admin-gui domain: Railway health check only" }];
    return [
      await httpCheck("admin-gui /healthz (200, or the Cloudflare Access login)", `${admin}/healthz`, (r) =>
        adminReachable(r.status, r.headers.get("location")),
      ),
    ];
  }
  const gui = await publicUrl(ctx, "portal-gui");
  if (service === "portal-core" || service === "portal-gui") {
    if (!gui) return [{ check: "gateway", ok: service === "portal-core", detail: "no portal-gui domain yet (Core: Railway health check only)" }];
    // First promotion: the GUI has a domain but no deployment yet ("Application not found"); Core's Railway health check
    // (after migrations) is then the Core smoke, and the gateway checks run in the GUI step.
    if (service === "portal-core" && !(await runningSha(ctx, "portal-gui")))
      return [{ check: "gateway", ok: true, detail: "portal-gui not deployed yet: Core = Railway health check only; gateway checked in the GUI step" }];
    return [
      await httpCheck("gui / 200", `${gui}/`, (r) => r.status === 200),
      await httpCheck("gateway → Core: /api/v1/me 401 error", `${gui}/api/v1/me`, (r, b) => r.status === 401 && b.includes('"error"')),
      await httpCheck(
        "stripe webhook refuses an unsigned POST (401)",
        `${gui}/api/v1/stripe/webhook`,
        (r, b) => r.status === 401 && b.includes("stripe_signature_invalid"),
        {
          method: "POST",
          headers: { "stripe-signature": "t=1,v1=00", "content-type": "application/json" },
          body: "{}",
        },
      ),
    ];
  }
  const web = await publicUrl(ctx, "website");
  if (!web) return [{ check: "website domain", ok: false, detail: "no website domain" }];
  return [
    await httpCheck("website / 200", `${web}/`, (r) => r.status === 200),
    await httpCheck(
      "security.txt text/plain",
      `${web}/.well-known/security.txt`,
      (r) => r.status === 200 && (r.headers.get("content-type") ?? "").startsWith("text/plain"),
    ),
    await httpCheck("robots.txt allows indexing", `${web}/robots.txt`, (r, b) => r.status === 200 && !/^Disallow:\s*\/\s*$/m.test(b)),
  ];
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const setFile = resolve(opts.setFile);
  const set = parseSet(JSON.parse(readFileSync(setFile, "utf8")));
  if (basename(setFile, ".json") !== set.id) throw new Error(`file name ${basename(setFile)} does not match id ${set.id}`);
  if (set.previous && !existsSync(join(dirname(setFile), `${set.previous}.json`)))
    throw new Error(`previous set ${set.previous}.json not found next to ${set.id}`);
  console.log(
    `release set ${set.id} → environment ${opts.environment}${opts.dryRun ? " (dry run)" : ""}${opts.repoint ? " (repoint: redeploy every service from its org source)" : ""}\n  ${set.notes}`,
  );

  // Checks (always, also in --dry-run).
  const problems: string[] = [];
  for (const [k, v] of Object.entries(sourcesOf(set)) as [ServiceName, RepoSha][]) {
    const st = ghJson<{ statuses: { context: string; state: string; updated_at?: string; created_at?: string }[] }>(
      `repos/${OWNER}/${v.repo}/commits/${v.sha}/status`,
    );
    const ok = !!st && ciGreen(st.statuses);
    console.log(`  CI ${k.padEnd(11)} ${v.repo}@${v.sha.slice(0, 7)}: ${ok ? "green" : "NOT green"}`);
    if (!ok) problems.push(`${k} ${v.sha.slice(0, 7)} has no green Woodpecker pipeline`);
  }
  const index = (await (await fetch(INDEX_URL)).json()) as { generatedAt: string; releases: IndexRelease[] };
  const ip = checkIndex(set, index.releases);
  console.log(
    `  index ${index.generatedAt}: bridge ${set.bridge.version}, ${set.apps.map((a) => `${a.product} ${a.version}`).join(", ")}: ${ip.length ? "PROBLEMS" : "all stable with digests"}`,
  );
  const ix = indexProblems(ip, opts.rollback);
  for (const w of ix.warnings) console.log(`  WARNING (rollback): ${w}`);
  problems.push(...ix.fatal);
  const cliRel = ghJson<{ tag_name: string }>(`repos/${OWNER}/${set.cli.repo ?? "opt2-tealbrick-bridge"}/releases/tags/cli-v${set.cli.version}`);
  console.log(`  cli ${set.cli.version}: ${cliRel ? "release exists" : `WARNING: no release cli-v${set.cli.version} visible (not deployed by this script)`}`);
  if (problems.length) throw new Error(`checks failed; nothing deployed:\n  - ${problems.join("\n  - ")}`);

  const ctx = await context(opts.environment);
  const running: Partial<Record<ServiceName, string | null>> = {};
  for (const s of ORDER) running[s] = await runningSha(ctx, s);
  const steps = planSteps(set, running, opts.repoint);
  for (const s of steps)
    console.log(
      `  plan ${s.service.padEnd(11)} ${s.repo}@${s.sha.slice(0, 7)}${s.skip ? "  (already running: skip)" : `  (running: ${running[s.service]?.slice(0, 7) ?? "none"})`}`,
    );
  const rollback = rollbackCommand(set, opts.setFile);
  console.log(`  rollback: ${rollback}`);
  if (opts.dryRun) return;

  const record: PromotionRecord = {
    set: set.id,
    environment: opts.environment,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    outcome: "promoted",
    steps: [],
    failure: null,
    rollback,
  };
  const out = recordPath(setFile, set.id, opts.repoint);
  const save = () => writeFileSync(out, `${JSON.stringify({ ...record, finishedAt: new Date().toISOString() }, null, 2)}\n`);
  try {
    for (const step of steps) {
      const res: StepResult = { service: step.service, sha: step.sha, skipped: step.skip, deploymentId: null, status: step.skip ? "SKIPPED" : "", smoke: [] };
      record.steps.push(res);
      if (!step.skip) {
        const r = spawnSync(
          "node",
          [join(here, "railway-deploy.ts"), "--environment", opts.environment, "--service", step.service, "--repo", step.repo, "--sha", step.sha],
          { encoding: "utf8" },
        );
        const id = /deployment ([0-9a-f-]{36})/.exec(r.stdout ?? "")?.[1];
        if (r.status !== 0 || !id) throw new Error(`${step.service}: deploy did not start: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
        res.deploymentId = id;
        console.log(`  ${step.service}: deployment ${id} …`);
        res.status = await waitDeployment(id);
        console.log(`  ${step.service}: ${res.status}`);
        if (res.status !== "SUCCESS") throw new Error(`${step.service}: deployment ${id} ended ${res.status}`);
      }
      res.smoke = await smoke(ctx, step.service);
      for (const c of res.smoke) console.log(`    smoke ${c.ok ? "ok  " : "FAIL"} ${c.check} (${c.detail})`);
      const bad = res.smoke.find((c) => !c.ok);
      if (bad) throw new Error(`${step.service}: smoke failed: ${bad.check} (${bad.detail})`);
    }
    console.log(`${set.id} promoted to ${opts.environment}. Record: ${out}`);
  } catch (e) {
    record.outcome = "failed";
    record.failure = (e as Error).message;
    console.error(`promote: FAIL: ${record.failure}\nROLLBACK: ${rollback}`);
    process.exitCode = 1;
  } finally {
    save();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(`promote: FAIL: ${(e as Error).message}`);
    process.exit(1);
  });
}
