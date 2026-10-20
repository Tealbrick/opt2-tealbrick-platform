// C293a: builds the website deploy plugin image and pushes it to the Forgejo container registry. An operator runs it; agents never do.
//   node ops/site-deploy-plugin-publish.ts                       dry run (default): prints what --push would do; no network, no docker
//   node ops/site-deploy-plugin-publish.ts --push --user <name>  builds (linux/amd64 + linux/arm64) and pushes forge.polygonface.com/polygonface/tb-site-deploy:<VERSION>
// <VERSION> is the content of ops/site-deploy-plugin/VERSION. A tag is NEVER reused: if the tag already exists in the registry the script refuses
// (bump VERSION, update the workflow and the Woodpecker secret filters instead). The image is multi-arch because the Woodpecker agents are
// not all the same CPU (foxy is arm64).
// Token: a Forgejo token with write:package, in ~/.config/opt2-tealbrick/forge-packages-token (mode 600). It is read from the file, sent to
// `docker login --password-stdin` and as an Authorization header to Forgejo; never printed, never on argv. --user is the Forgejo login name
// that owns the token (or the environment variable FORGE_USER).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_NAME, pluginVersion, REGISTRY_HOST } from "./site-deploy-plugin/image.ts";

export const TOKEN_FILE = join(homedir(), ".config", "opt2-tealbrick", "forge-packages-token");
export const PLATFORMS = "linux/amd64,linux/arm64";
const CONTEXT = fileURLToPath(new URL("./site-deploy-plugin/", import.meta.url));
const OWNER = "polygonface";
const PACKAGE = "tb-site-deploy";

type Fetch = typeof fetch;
export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export interface Deps {
  fetch: Fetch;
  /** Runs a command; `input` goes to its stdin. Tests replace it. */
  run: (cmd: string, args: string[], input?: string) => RunResult;
  readToken: () => string;
  log: (line: string) => void;
}

export function redact(text: string, token: string): string {
  let out = token.length >= 4 ? text.split(token).join("***") : text;
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "***");
  return out.replace(/(authorization:\s*)\S+(\s+\S+)?/gi, "$1***");
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): { push: boolean; user: string | null } {
  let push = false;
  let user: string | null = env.FORGE_USER?.trim() || null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--push") push = true;
    else if (a === "--user") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error("--user needs a value");
      user = v;
    } else throw new Error(`unknown option ${a} (usage: [--push --user <forgejo login>])`);
  }
  if (user !== null && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}$/.test(user)) throw new Error("--user: not a Forgejo login name");
  return { push, user };
}

/** Reads the token file. The file must not be readable by group or others. */
export function readTokenFile(path: string = TOKEN_FILE): string {
  let mode: number;
  let text: string;
  try {
    mode = statSync(path).mode & 0o777;
    text = readFileSync(path, "utf8").trim();
  } catch {
    throw new Error(`no token file at ${path} (a Forgejo token with write:package, mode 600)`);
  }
  if (mode & 0o077) throw new Error(`${path} must be mode 600 (now ${mode.toString(8)}): chmod 600 ${path}`);
  if (!text || /\s/.test(text)) throw new Error(`${path} must hold exactly one token`);
  return text;
}

export function planLines(version: string): string[] {
  return [
    `image: ${IMAGE_NAME}:${version}`,
    `platforms: ${PLATFORMS}`,
    `build context: ops/site-deploy-plugin (Dockerfile, site-deploy.ts, VERSION)`,
    `registry: ${REGISTRY_HOST}`,
    `token file: ${TOKEN_FILE} (write:package; read at --push only)`,
    "--push: (1) refuse if the tag already exists in the registry, (2) docker login, (3) docker buildx build --push, (4) docker logout, (5) print the digest",
    "dry run: nothing was built, nothing was pushed",
  ];
}

/** True when the version tag already exists in the registry (Forgejo packages API). Fails closed on anything but 200 or 404. */
export async function tagExists(f: Fetch, token: string, version: string): Promise<boolean> {
  let res: Response;
  try {
    res = await f(`https://${REGISTRY_HOST}/api/v1/packages/${OWNER}/container/${PACKAGE}/${version}`, {
      headers: { authorization: `token ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Error(redact(`cannot ask the registry whether ${version} exists: ${(e as Error).message}`, token));
  }
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`cannot tell whether ${IMAGE_NAME}:${version} exists (registry answered HTTP ${res.status}); nothing was pushed`);
}

/** The whole publish. Returns the lines to print. */
export async function publish(opts: { push: boolean; user: string | null }, deps: Deps, version: string = pluginVersion()): Promise<string[]> {
  if (!opts.push) return planLines(version);
  if (!opts.user) throw new Error("--push needs --user <forgejo login> (or FORGE_USER)");
  const token = deps.readToken();
  const out: string[] = [];
  const guard = (r: RunResult, what: string): RunResult => {
    if (r.status !== 0) throw new Error(redact(`${what} failed (exit ${r.status}): ${`${r.stderr}${r.stdout}`.trim().slice(-400)}`, token));
    return r;
  };
  if (await tagExists(deps.fetch, token, version)) {
    throw new Error(
      `${IMAGE_NAME}:${version} already exists in the registry. A tag is never reused: raise ops/site-deploy-plugin/VERSION, then update the website workflow and the secret filters. Nothing was pushed.`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "tb-site-deploy-publish-"));
  const meta = join(dir, "metadata.json");
  let loggedIn = false;
  try {
    guard(deps.run("docker", ["login", REGISTRY_HOST, "--username", opts.user, "--password-stdin"], `${token}\n`), "docker login");
    loggedIn = true;
    guard(
      deps.run("docker", [
        "buildx",
        "build",
        "--platform",
        PLATFORMS,
        "--provenance=false",
        "--tag",
        `${IMAGE_NAME}:${version}`,
        "--metadata-file",
        meta,
        "--push",
        CONTEXT,
      ]),
      "docker buildx build --push",
    );
    let digest = "";
    try {
      digest = (JSON.parse(readFileSync(meta, "utf8")) as { "containerimage.digest"?: string })["containerimage.digest"] ?? "";
    } catch {
      /* reported below */
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("the build did not report an image digest; check the registry before you go on");
    out.push(`pushed ${IMAGE_NAME}:${version}`, `digest ${digest}`, `image reference: ${IMAGE_NAME}:${version}@${digest}`);
  } finally {
    if (loggedIn) deps.run("docker", ["logout", REGISTRY_HOST]);
    try {
      unlinkSync(meta);
    } catch {
      /* not written */
    }
    try {
      rmdirSync(dir);
    } catch {
      /* not empty or gone */
    }
  }
  return out;
}

function realRun(cmd: string, args: string[], input?: string): RunResult {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30 * 60 * 1000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${r.error ? ` ${r.error.message}` : ""}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    for (const l of await publish(opts, { fetch, run: realRun, readToken: () => readTokenFile(), log: console.log })) console.log(l);
  } catch (e) {
    console.error(`site-deploy-plugin-publish: FAIL: ${redact((e as Error).message, "")}`);
    process.exit(1);
  }
}
