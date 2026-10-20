/**
 * C293/C293a: the website deploy PLUGIN (Woodpecker plugin image forge.polygonface.com/polygonface/tb-site-deploy:<VERSION>).
 * ONE source of truth: this file. The website repo keeps no deploy code; its .woodpecker/site-deploy.yaml only runs this image with settings.
 * A plugin step cannot have commands, entrypoint or environment, and the two secrets are limited to this image (Woodpecker secret image
 * filter), so a writer's branch workflow cannot read them: the only thing it can do with them is run THIS code, which verifies everything.
 *
 * Inputs (Woodpecker plugin settings arrive as PLUGIN_* environment variables):
 *   PLUGIN_MODE        dev | live
 *   PLUGIN_TOKEN       GitHub fine-grained token (Contents read + write): read-only checks and the release record; does not move branches
 *   PLUGIN_DEPLOY_KEY  the WRITE deploy key (OpenSSH private key): the only thing that moves site-dev / site-live, over SSH
 *   CI_COMMIT_SHA, CI_COMMIT_TAG  the CANDIDATE commit / tag from the pipeline
 * Settings supply only the secrets and the mode. Every security decision is verified through the GitHub API: the candidate commit against
 * refs/heads/main read fresh (compared as a SHA), the Woodpecker status ci/woodpecker/push/ci = success, for live the tag ref on GitHub
 * (peeled) pointing at the candidate and matching site-vX.Y.Z. Repo, branch names and URLs are constants of this file.
 *   dev   push a main commit to site-dev, wait for DEV to serve it (/version.txt), smoke DEV
 *   live  (only for a commit DEV already has: the tip of site-dev or older, read fresh) push the tag's commit to site-live, wait for LIVE, smoke LIVE, write the GitHub release record
 * Railway deploys the website from the branches site-dev (DEV) and site-live (LIVE). No Railway token exists in CI.
 * Rules: keys and tokens come from the env and are never printed (also stripped from every error text); the push is a plain
 * `git push <sha>:refs/heads/<branch>`, never --force, so a non-fast-forward is refused by GitHub; nothing here deletes or moves a tag.
 * Rollback = a revert commit on main + a new site tag. Emergency = Martin pauses the site-* ruleset, an operator resets site-live.
 * Exit codes: 0 done, 1 refused or failed, 2 wrong input.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = "Tealbrick/opt2-tealbrick-website";
export const DEV_BRANCH = "site-dev";
export const LIVE_BRANCH = "site-live";
export const TAG_RE = /^site-v\d+\.\d+\.\d+$/;
export const SHA_RE = /^[0-9a-f]{40}$/;
/** The DEV website (Railway project opt2, environment production). Source: platform repo ops/ENVIRONMENTS.md ("public preview only, no custom domain"). A constant, not a setting. */
export const DEV_URL = "https://website-production-66a1.up.railway.app";
export const LIVE_URL = "https://tealbrick.com";
/** SSH remote of the website repo (the deploy key is a deploy key of this repo). */
export const SSH_REMOTE = "git@github.com:Tealbrick/opt2-tealbrick-website.git";
/** GitHub's published ed25519 host key (docs.github.com "GitHub's SSH key fingerprints": SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU). */
export const GITHUB_HOST_KEY = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
export const POLL_TIMEOUT_MS = 15 * 60 * 1000;
export const POLL_INTERVAL_MS = 15 * 1000;
/** One HTTP request never waits longer than this. */
export const REQUEST_TIMEOUT_MS = 30 * 1000;
export const ROLLBACK_HINT =
  "Rollback: merge a revert commit on main, then tag a new site version. A failure after the push leaves the new version online. Emergency (LIVE is broken now): Martin pauses the site-* ruleset and an operator resets the branch site-live to the last good commit.";

export class DeployError extends Error {}

export interface Env {
  [name: string]: string | undefined;
}
export interface GitResult {
  status: number | null;
  stderr: string;
}
export interface Deps {
  fetch: typeof fetch;
  /** Runs `git <args>` with this environment. Tests replace it; the default is child_process.spawnSync. */
  git: (args: string[], env: Record<string, string>) => GitResult;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}
export interface Ctx {
  token: string;
  /** The private deploy key (OpenSSH text). Used only by pushBranch. */
  key: string;
  /** Where the pipeline cloned the repo (default: the current folder). Read-only source of commit objects for the push. */
  workspace?: string;
  deps: Deps;
}
export interface PollOptions {
  timeoutMs?: number;
  intervalMs?: number;
}
export interface SmokeResult {
  path: string;
  ok: boolean;
  detail: string;
}

/** Removes secrets (the token, the deploy key and each line of it) and anything token- or key-shaped from a text before it is shown or stored. */
export function redact(text: string, ...secrets: string[]): string {
  let out = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "***");
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join("***");
    for (const line of secret.split(/\r?\n/)) if (line.trim().length >= 12) out = out.split(line.trim()).join("***");
  }
  return out.replace(/\b(?:github_pat_[A-Za-z0-9_]{10,}|gh[pousr]_[A-Za-z0-9]{10,})\b/g, "***").replace(/(authorization:\s*)\S+(\s+\S+)?/gi, "$1***");
}
const scrub = (ctx: Ctx, text: string) => redact(text, ctx.token, ctx.key);

const utc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

async function gh<T>(ctx: Ctx, method: string, path: string, body?: unknown, okStatuses: readonly number[] = []): Promise<{ status: number; json: T }> {
  let res: Response;
  try {
    res = await ctx.deps.fetch(`https://api.github.com/repos/${REPO}${path}`, {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${ctx.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "opt2-tealbrick-website-site-deploy",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    throw new DeployError(scrub(ctx, `${method} ${path}: ${(e as Error).message}`));
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* an empty body is fine */
  }
  if (!res.ok && !okStatuses.includes(res.status)) {
    const message = (json as { message?: string } | null)?.message ?? "";
    throw new DeployError(scrub(ctx, `${method} ${path}: HTTP ${res.status} ${message}`.trim()));
  }
  return { status: res.status, json: json as T };
}

export type Relation = "identical" | "ahead" | "behind" | "diverged";
/** How `head` relates to `base` (GitHub compare): "ahead" = head has commits that base lacks and contains base. */
export async function compare(ctx: Ctx, base: string, head: string): Promise<Relation> {
  const r = await gh<{ status?: string }>(ctx, "GET", `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  const s = r.json?.status;
  if (s === "identical" || s === "ahead" || s === "behind" || s === "diverged") return s;
  throw new DeployError(`compare ${base.slice(0, 12)}...${head.slice(0, 12)}: unexpected status ${JSON.stringify(s)}`);
}

/** The commit main points to. Asked as refs/heads/main and used as a SHA, so a tag named "main" cannot change the answer (S3-a). */
export async function mainCommit(ctx: Ctx): Promise<string> {
  const r = await gh<{ object?: { sha?: string } }>(ctx, "GET", "/git/ref/heads/main");
  const sha = r.json?.object?.sha ?? "";
  if (!SHA_RE.test(sha)) throw new DeployError("GitHub did not return the commit of main");
  return sha;
}

/** Throws unless main is identical to or ahead of the commit (the commit is part of main). */
export async function requireOnMain(ctx: Ctx, sha: string): Promise<void> {
  const rel = await compare(ctx, sha, await mainCommit(ctx));
  if (rel !== "identical" && rel !== "ahead") throw new DeployError(`commit ${sha.slice(0, 12)} is not on main (main is ${rel} of it): refused`);
}

/** The commit a tag points to (a lightweight tag, or an annotated tag followed to its commit). */
export async function tagCommit(ctx: Ctx, tag: string): Promise<string> {
  const ref = await gh<{ object?: { type?: string; sha?: string } }>(ctx, "GET", `/git/ref/tags/${encodeURIComponent(tag)}`, undefined, [404]);
  if (ref.status === 404) throw new DeployError(`tag ${tag} does not exist on GitHub`);
  let obj = ref.json?.object;
  for (let depth = 0; depth < 4 && obj?.type === "tag" && obj.sha; depth++) {
    obj = (await gh<{ object?: { type?: string; sha?: string } }>(ctx, "GET", `/git/tags/${obj.sha}`)).json?.object;
  }
  if (obj?.type !== "commit" || !obj.sha || !SHA_RE.test(obj.sha)) throw new DeployError(`tag ${tag} does not point to a commit`);
  return obj.sha;
}

const BRANCHES: readonly string[] = [DEV_BRANCH, LIVE_BRANCH];
export const CI_CONTEXT = "ci/woodpecker/push/ci";
export const STATUS_WAIT_MS = 3 * 60 * 1000;
export const STATUS_INTERVAL_MS = 10 * 1000;

/** Requires the Woodpecker status ci/woodpecker/push/ci = success on the commit (asked of GitHub, not taken from the pipeline). A pending
 *  or missing status is awaited for up to 3 minutes (the ci workflow may have finished a moment ago); failure/error is refused at once. */
export async function requireGreen(ctx: Ctx, sha: string): Promise<void> {
  const start = ctx.deps.now();
  for (;;) {
    const r = await gh<{ statuses?: { context?: string; state?: string }[] }>(ctx, "GET", `/commits/${sha}/status?per_page=100`);
    const st = r.json?.statuses?.find((x) => x.context === CI_CONTEXT);
    if (st?.state === "success") return;
    if (st && st.state !== "pending") throw new DeployError(`commit ${sha.slice(0, 12)}: ${CI_CONTEXT} is "${st.state}", not "success". Refused.`);
    if (ctx.deps.now() - start + STATUS_INTERVAL_MS > STATUS_WAIT_MS) {
      throw new DeployError(`commit ${sha.slice(0, 12)}: ${CI_CONTEXT} is ${st ? "still pending" : "missing"} after ${STATUS_WAIT_MS / 60000} min. Refused.`);
    }
    await ctx.deps.sleep(STATUS_INTERVAL_MS);
  }
}

/** Removes a directory tree the plugin made itself (files first, then folders). */
function removeTree(path: string): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(path);
  } catch {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
    return;
  }
  for (const name of entries) {
    const child = join(path, name);
    if (lstatSync(child).isDirectory()) removeTree(child);
    else unlinkSync(child);
  }
  try {
    rmdirSync(path);
  } catch {
    /* not empty or gone */
  }
}

/** The ONLY environment a git child gets: no PLUGIN_*, no CI_*, no secret. HOME is the temp folder; no global or system git config is read. */
export function gitEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

/** LIVE only takes a commit that DEV already has: the commit must be the tip of site-dev or an ancestor of it. site-dev is read fresh and resolved to a SHA. */
export async function requireDeployedToDev(ctx: Ctx, sha: string): Promise<void> {
  const r = await gh<{ object?: { sha?: string } }>(ctx, "GET", `/git/ref/heads/${DEV_BRANCH}`, undefined, [404]);
  const dev = r.json?.object?.sha ?? "";
  if (r.status === 404 || !SHA_RE.test(dev))
    throw new DeployError(`branch ${DEV_BRANCH} does not exist or has no commit: LIVE needs a commit that DEV already has`);
  const rel = await compare(ctx, dev, sha); // the commit as seen from site-dev: identical or behind = DEV has it
  if (rel !== "identical" && rel !== "behind") {
    throw new DeployError(
      `commit ${sha.slice(0, 12)}: this commit has not been deployed to DEV yet: merge to main, wait for DEV, then tag (site-dev is at ${dev.slice(0, 12)}, the commit is ${rel === "ahead" ? "newer than DEV" : "not on the DEV line"}). Refused.`,
    );
  }
}

/** Pushes `sha` to refs/heads/<branch> over SSH with the deploy key: a plain push, never --force. The key lives in a 0600 file for the
 *  length of the call and is deleted afterwards; the host key of github.com is pinned.
 *  S4: git never runs in the pipeline workspace. It runs in a FRESH bare repo in a temp folder (no hooks, no repo config of the workspace is
 *  read); the commit objects are read from the workspace through GIT_ALTERNATE_OBJECT_DIRECTORIES (and its shallow file is copied). The child
 *  gets a minimal environment (gitEnv + GIT_SSH_COMMAND); `--no-verify` and `core.hooksPath=/dev/null` switch hooks off a second time.
 *  `remote` and `workspace` are parameters for the tests only; run() never passes them. */
export function pushBranch(ctx: Ctx, branch: string, sha: string, remote: string = SSH_REMOTE, workspace: string = ctx.workspace ?? process.cwd()): void {
  if (!BRANCHES.includes(branch) || !SHA_RE.test(sha))
    throw new DeployError(`refusing to push "${branch}": only ${BRANCHES.join(" and ")} take a full commit SHA`);
  const dir = mkdtempSync(join(tmpdir(), "site-deploy-"));
  const keyFile = join(dir, "key");
  const hostsFile = join(dir, "known_hosts");
  const gitDir = join(dir, "repo.git");
  try {
    writeFileSync(keyFile, `${ctx.key.trim()}\n`, { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    writeFileSync(hostsFile, `${GITHUB_HOST_KEY}\n`, { mode: 0o600 });
    const ssh = [
      "ssh",
      "-F",
      "/dev/null",
      "-i",
      keyFile,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      `UserKnownHostsFile=${hostsFile}`,
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "BatchMode=yes",
    ];
    const init = ctx.deps.git(["init", "--bare", "--quiet", "--template=", gitDir], gitEnv(dir));
    if (init.status !== 0) throw new DeployError(scrub(ctx, `git init of the temporary repo failed (exit ${init.status}): ${init.stderr.trim().slice(-200)}`));
    const shallow = join(workspace, ".git", "shallow");
    if (existsSync(shallow)) writeFileSync(join(gitDir, "shallow"), readFileSync(shallow));
    const r = ctx.deps.git(
      ["-c", "core.hooksPath=/dev/null", "push", "--no-verify", remote, `${sha}:refs/heads/${branch}`],
      gitEnv(dir, {
        GIT_DIR: gitDir,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(workspace, ".git", "objects"),
        GIT_SSH_COMMAND: ssh.join(" "),
      }),
    );
    if (r.status !== 0) {
      throw new DeployError(
        scrub(ctx, `git push of ${sha.slice(0, 12)} to ${branch} was refused or failed (exit ${r.status}): ${r.stderr.trim().slice(-300)}`),
      );
    }
  } finally {
    try {
      unlinkSync(keyFile);
    } catch {
      /* already gone */
    }
    removeTree(dir);
  }
}

/** Moves refs/heads/<branch> to `sha`, only forward. The read-only checks (branch exists, commit is ahead) come first for a clear message;
 *  GitHub enforces the same rule on the push. "Already there" is a success; a branch that is ahead of or apart from `sha` is refused. */
export async function fastForward(ctx: Ctx, branch: string, sha: string): Promise<"moved" | "already"> {
  if (!BRANCHES.includes(branch)) throw new DeployError(`refusing to move "${branch}": only ${BRANCHES.join(" and ")} are deploy branches`);
  const cur = await gh<{ object?: { sha?: string } }>(ctx, "GET", `/git/ref/heads/${branch}`, undefined, [404]);
  if (cur.status === 404)
    throw new DeployError(`branch ${branch} does not exist: an operator creates it once (see ops/C293-MARTIN-STEPS.md in the platform repo)`);
  const have = cur.json?.object?.sha ?? "";
  if (!SHA_RE.test(have)) throw new DeployError(`branch ${branch}: GitHub did not return a commit`);
  if (have === sha) {
    ctx.deps.log(`${branch} is already at ${sha.slice(0, 12)}`);
    return "already";
  }
  const rel = await compare(ctx, have, sha);
  if (rel === "identical") return "already";
  if (rel !== "ahead") {
    throw new DeployError(
      `${branch} (${have.slice(0, 12)}) cannot fast-forward to ${sha.slice(0, 12)}: the commit is ${rel === "behind" ? "older than the branch" : "on another line of history"}. Refused.`,
    );
  }
  pushBranch(ctx, branch, sha);
  ctx.deps.log(`${branch}: ${have.slice(0, 12)} -> ${sha.slice(0, 12)} (fast-forward push)`);
  return "moved";
}

async function getText(deps: Deps, url: string): Promise<{ status: number; text: string }> {
  const res = await deps.fetch(url, {
    method: "GET",
    headers: { "cache-control": "no-cache", "user-agent": "opt2-tealbrick-website-site-deploy" },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: res.status, text: await res.text() };
}

/** Polls <base>/version.txt until it holds `sha`. Returns what it saw last and when it matched; throws after the time limit. */
export async function pollVersion(deps: Deps, base: string, sha: string, opts: PollOptions = {}): Promise<{ answer: string; seenAt: number }> {
  const timeoutMs = opts.timeoutMs ?? POLL_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const start = deps.now();
  let last = "(no answer yet)";
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await getText(deps, `${base}/version.txt?c=${deps.now()}`);
      last = r.status === 200 ? r.text.trim().slice(0, 80) : `HTTP ${r.status}`;
      if (r.status === 200 && r.text.trim().toLowerCase() === sha) return { answer: r.text.trim(), seenAt: deps.now() };
    } catch (e) {
      last = `request failed: ${(e as Error).message}`.slice(0, 120);
    }
    if (deps.now() - start + intervalMs > timeoutMs) {
      throw new DeployError(`${base}/version.txt did not show ${sha.slice(0, 12)} within ${Math.round(timeoutMs / 60000)} min (last answer: ${last})`);
    }
    if (attempt === 1 || attempt % 4 === 0) deps.log(`waiting for ${base}/version.txt = ${sha.slice(0, 12)} (now: ${last})`);
    await deps.sleep(intervalMs);
  }
}

/** The website smoke: `/` 200, `/robots.txt` 200, `/.well-known/security.txt` 200 with a Contact: line. Never throws; the caller reads the list. */
export async function smoke(deps: Deps, base: string): Promise<SmokeResult[]> {
  const results: SmokeResult[] = [];
  for (const path of ["/", "/robots.txt", "/.well-known/security.txt"]) {
    try {
      const r = await getText(deps, `${base}${path}`);
      if (r.status !== 200) results.push({ path, ok: false, detail: `HTTP ${r.status}` });
      else if (path === "/.well-known/security.txt" && !/^Contact:\s*\S+/im.test(r.text))
        results.push({ path, ok: false, detail: "HTTP 200 but no Contact: line" });
      else results.push({ path, ok: true, detail: path === "/.well-known/security.txt" ? "HTTP 200, Contact: line present" : "HTTP 200" });
    } catch (e) {
      results.push({ path, ok: false, detail: `request failed: ${(e as Error).message}`.slice(0, 120) });
    }
  }
  return results;
}

function requireSmokeOk(log: (line: string) => void, label: string, results: SmokeResult[]): void {
  for (const r of results) log(`${label} smoke ${r.path}: ${r.ok ? "ok" : "FAILED"} (${r.detail})`);
  const bad = results.filter((r) => !r.ok);
  if (bad.length) throw new DeployError(`${label} smoke failed: ${bad.map((b) => `${b.path} ${b.detail}`).join("; ")}`);
}
/** `dev <sha>`: site-dev follows main. */
export async function deployDev(ctx: Ctx, sha: string, devUrl: string, poll: PollOptions = {}): Promise<void> {
  if (!SHA_RE.test(sha)) throw new DeployError("dev: the pipeline commit (CI_COMMIT_SHA) must be a full 40-character lower-case SHA");
  const log = ctx.deps.log;
  await requireOnMain(ctx, sha);
  await requireGreen(ctx, sha);
  await fastForward(ctx, DEV_BRANCH, sha);
  const seen = await pollVersion(ctx.deps, devUrl, sha, poll);
  log(`DEV serves ${seen.answer.slice(0, 12)} (${devUrl}/version.txt)`);
  requireSmokeOk(log, "DEV", await smoke(ctx.deps, devUrl));
  log(`DEV deploy done: ${sha.slice(0, 12)}`);
}

export interface LiveOptions extends PollOptions {
  liveUrl?: string;
}

/** The GitHub release record for a LIVE deploy: commit, the /version.txt answer, the smoke results and UTC times. */
export function releaseBody(i: {
  tag: string;
  sha: string;
  answer: string;
  url: string;
  results: SmokeResult[];
  startedAt: number;
  seenAt: number;
  finishedAt: number;
}): string {
  return [
    `Website release ${i.tag}, deployed to LIVE by the site-deploy workflow (C293).`,
    "",
    `- Commit: ${i.sha}`,
    `- ${i.url}/version.txt answered: ${i.answer}`,
    `- Started (UTC): ${utc(i.startedAt)}`,
    `- LIVE served the commit (UTC): ${utc(i.seenAt)}`,
    `- Finished (UTC): ${utc(i.finishedAt)}`,
    "",
    "Smoke results:",
    ...i.results.map((r) => `- ${r.path}: ${r.ok ? "ok" : "FAILED"} (${r.detail})`),
    "",
    "Rollback: merge a revert commit on main, then tag a new site version.",
  ].join("\n");
}

/** Creates the release for the tag; if the tag already has one (a re-run), the record is updated instead. */
export async function writeRelease(ctx: Ctx, tag: string, body: string): Promise<void> {
  const existing = await gh<{ id?: number }>(ctx, "GET", `/releases/tags/${encodeURIComponent(tag)}`, undefined, [404]);
  if (existing.status === 200 && typeof existing.json?.id === "number") {
    await gh(ctx, "PATCH", `/releases/${existing.json.id}`, { name: `Website ${tag}`, body });
    ctx.deps.log(`release ${tag}: record updated`);
    return;
  }
  await gh(ctx, "POST", "/releases", { tag_name: tag, name: `Website ${tag}`, body, draft: false, prerelease: false });
  ctx.deps.log(`release ${tag}: record created`);
}

/** `live <tag>`: site-live follows a site-vX.Y.Z tag on a main commit. */
export async function deployLive(ctx: Ctx, tag: string, ciSha: string, opts: LiveOptions = {}): Promise<void> {
  if (!SHA_RE.test(ciSha)) throw new DeployError("live: the commit CI ran on (CI_COMMIT_SHA) must be a full 40-character lower-case SHA");
  if (!TAG_RE.test(tag)) throw new DeployError(`live: "${tag}" is not a website tag (want site-vX.Y.Z, for example site-v1.2.0). Refused.`);
  const log = ctx.deps.log;
  const url = opts.liveUrl ?? LIVE_URL;
  const startedAt = ctx.deps.now();
  const sha = await tagCommit(ctx, tag);
  log(`${tag} -> ${sha}`);
  // S2-a: a tag can be moved between the ci run and this step. Deploy only the commit CI ran on.
  if (sha !== ciSha) throw new DeployError(`tag ${tag} now points to ${sha.slice(0, 12)} but CI ran on ${ciSha.slice(0, 12)}: the tag was moved. Refused.`);
  await requireOnMain(ctx, sha);
  await requireGreen(ctx, sha);
  await requireDeployedToDev(ctx, sha);
  await fastForward(ctx, LIVE_BRANCH, sha);
  const seen = await pollVersion(ctx.deps, url, sha, opts);
  log(`LIVE serves ${seen.answer.slice(0, 12)} (${url}/version.txt)`);
  const results = await smoke(ctx.deps, url);
  requireSmokeOk(log, "LIVE", results); // a failed smoke leaves no release record: the record is proof of a good deploy
  await writeRelease(ctx, tag, releaseBody({ tag, sha, answer: seen.answer, url, results, startedAt, seenAt: seen.seenAt, finishedAt: ctx.deps.now() }));
  log(`LIVE deploy done: ${tag} = ${sha.slice(0, 12)}`);
}

export type Inputs = { mode: "dev"; sha: string } | { mode: "live"; tag: string; sha: string };

/** Reads the mode and the pipeline's candidate commit/tag. Everything read here is only a CANDIDATE and is verified through the GitHub API. */
export function parseInputs(env: Env): Inputs {
  const mode = (env.PLUGIN_MODE ?? "").trim();
  const sha = (env.CI_COMMIT_SHA ?? "").trim();
  if (mode === "dev") return { mode, sha };
  if (mode === "live") return { mode, tag: (env.CI_COMMIT_TAG ?? "").trim(), sha };
  throw new DeployError('usage: the setting "mode" must be dev or live');
}

/** The plugin version (VERSION file next to this file), for the log. */
export function pluginVersion(): string {
  try {
    return readFileSync(new URL("./VERSION", import.meta.url), "utf8").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export async function run(env: Env, deps: Deps, liveOpts: LiveOptions = {}): Promise<number> {
  const token = (env.PLUGIN_TOKEN ?? "").trim();
  const key = (env.PLUGIN_DEPLOY_KEY ?? "").trim();
  try {
    deps.log(`tb-site-deploy ${pluginVersion()}`);
    const inputs = parseInputs(env);
    if (!token) throw new DeployError('the setting "token" is empty (Woodpecker secret site_deploy_token, limited to this plugin image)');
    if (!/^-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*-----END OPENSSH PRIVATE KEY-----$/.test(key)) {
      throw new DeployError(
        'the setting "deploy_key" is empty or not an OpenSSH private key (Woodpecker secret site_deploy_key, limited to this plugin image)',
      );
    }
    // Repo, branches and URLs are constants of this file: no input (setting, CI_* value) names them.
    const ctx: Ctx = { token, key, deps };
    if (inputs.mode === "dev") await deployDev(ctx, inputs.sha, DEV_URL, liveOpts);
    else await deployLive(ctx, inputs.tag, inputs.sha, liveOpts);
    return 0;
  } catch (e) {
    const message = redact((e as Error).message, token, key);
    deps.log(`FAILED: ${message}`);
    if (e instanceof DeployError && /^usage:/.test(message)) return 2;
    deps.log(ROLLBACK_HINT);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const deps: Deps = {
    fetch,
    git: (args, extra) => {
      const r = spawnSync("git", args, { env: extra, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
      return { status: r.status, stderr: `${r.stderr ?? ""}${r.error ? ` ${r.error.message}` : ""}` };
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (l) => console.log(l),
  };
  process.exitCode = await run(process.env, deps);
}
