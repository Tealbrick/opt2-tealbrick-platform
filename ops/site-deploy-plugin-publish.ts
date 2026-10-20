// C293a: builds the website deploy plugin image and pushes it to the Forgejo container registry. An operator runs it; agents never do.
//   node ops/site-deploy-plugin-publish.ts                       dry run (default): prints what --push would do; no network, no docker
//   node ops/site-deploy-plugin-publish.ts --push --user <name>  builds (linux/amd64 + linux/arm64) and pushes forge.polygonface.com/polygonface/tb-site-deploy:<VERSION>
// <VERSION> is the content of ops/site-deploy-plugin/VERSION. A tag is NEVER reused: if the tag already exists in the registry the script refuses
// (bump VERSION, update the workflow and the Woodpecker secret filters instead). The image is multi-arch because the Woodpecker agents are
// not all the same CPU (one agent is arm64).
// Token: a Forgejo token with write:package, in ~/.config/opt2-tealbrick/forge-packages-token (mode 600). It is read from the file, sent to
// `docker login --password-stdin` and as an Authorization header to Forgejo; never printed, never on argv. --user is the Forgejo login name
// that owns the token (or the environment variable FORGE_USER).
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DIGEST_FILE, IMAGE_NAME, pluginVersion, REGISTRY_HOST } from "./site-deploy-plugin/image.ts";

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
  run: (cmd: string, args: string[], input?: string) => RunResult | Promise<RunResult>;
  readToken: () => string;
  log: (line: string) => void;
  /** Records the pushed digest for this version (the file ops/site-deploy-plugin/IMAGE-DIGEST). Tests replace it. */
  writeDigest: (version: string, digest: string) => void;
  /** Signal hooks (default: process). Tests replace it. */
  signals: {
    on: (sig: "SIGINT" | "SIGTERM", fn: () => void | Promise<void>) => void;
    off: (sig: "SIGINT" | "SIGTERM", fn: () => void | Promise<void>) => void;
    exit: (code: number) => void;
  };
  /** Stops a running child (on a signal). */
  killChild: () => void;
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

/**
 * True when the version tag already exists in the registry (Forgejo packages API). FAILS CLOSED. A bare 404 on the tag is not trusted
 * (a wrong path, owner or proxy also gives 404). So: (1) the owner's package list must answer 200 with a JSON array (a known-good endpoint:
 * the API, the owner and the token work); (2) the list must not hold this version; (3) only then a 404 on the version path means "does not
 * exist". Any other status, a bad body, or a full page of 50 results stops the script.
 */
export async function tagExists(f: Fetch, token: string, version: string): Promise<boolean> {
  const get = async (path: string): Promise<Response> => {
    try {
      return await f(`https://${REGISTRY_HOST}/api/v1/packages/${OWNER}${path}`, {
        headers: { authorization: `token ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new Error(redact(`cannot ask the registry whether ${version} exists: ${(e as Error).message}`, token));
    }
  };
  const stop = (why: string): never => {
    throw new Error(`cannot tell whether ${IMAGE_NAME}:${version} exists (${why}); nothing was pushed`);
  };
  const list = await get(`?type=container&q=${PACKAGE}&limit=50`);
  if (list.status !== 200) stop(`the package list answered HTTP ${list.status}`);
  let entries: { name?: string; version?: string }[] = [];
  try {
    const body = (await list.json()) as unknown;
    if (!Array.isArray(body)) stop("the package list is not a JSON array");
    entries = body as { name?: string; version?: string }[];
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("cannot tell")) throw e;
    stop("the package list is not JSON");
  }
  if (entries.length >= 50) stop("the package list is full (50 entries); narrow it by hand");
  if (entries.some((x) => x.name === PACKAGE && x.version === version)) return true;
  const one = await get(`/container/${PACKAGE}/${version}`);
  if (one.status === 200) return true;
  if (one.status === 404) return false;
  return stop(`the version path answered HTTP ${one.status}`);
}

/** The whole publish. Returns the lines to print. */
export async function publish(opts: { push: boolean; user: string | null }, deps: Deps, version: string = pluginVersion()): Promise<string[]> {
  if (!opts.push) return planLines(version);
  if (!opts.user) throw new Error("--push needs --user <forgejo login> (or FORGE_USER)");
  const token = deps.readToken();
  const out: string[] = [];
  const guard = async (pending: RunResult | Promise<RunResult>, what: string): Promise<RunResult> => {
    const r = await pending;
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
  const logout = async (): Promise<void> => {
    if (!loggedIn) return;
    loggedIn = false;
    await deps.run("docker", ["logout", REGISTRY_HOST]);
  };
  // docker logout also on Ctrl+C and on a terminate signal: the login must not stay on the operator's machine.
  const onSignal = (code: number) => async () => {
    deps.killChild();
    await logout();
    deps.signals.exit(code);
  };
  const onInt = onSignal(130);
  const onTerm = onSignal(143);
  deps.signals.on("SIGINT", onInt);
  deps.signals.on("SIGTERM", onTerm);
  try {
    await guard(deps.run("docker", ["login", REGISTRY_HOST, "--username", opts.user, "--password-stdin"], `${token}\n`), "docker login");
    loggedIn = true;
    await guard(
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
    deps.writeDigest(version, digest);
    out.push(
      `pushed ${IMAGE_NAME}:${version}`,
      `digest ${digest}`,
      `image reference: ${IMAGE_NAME}:${version}@${digest}`,
      "recorded in ops/site-deploy-plugin/IMAGE-DIGEST (commit it)",
      `next: put the image reference above in .woodpecker/site-deploy.yaml of the website repo (both steps), then run ops/website-autodeploy-setup.ts`,
    );
  } finally {
    deps.signals.off("SIGINT", onInt);
    deps.signals.off("SIGTERM", onTerm);
    await logout();
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

let child: ChildProcess | null = null;
function realRun(cmd: string, args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const c = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    child = c;
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    c.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    c.on("error", (e) => resolvePromise({ status: null, stdout, stderr: `${stderr} ${e.message}` }));
    c.on("close", (code) => {
      child = null;
      resolvePromise({ status: code, stdout, stderr });
    });
    c.stdin.end(input ?? "");
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const deps: Deps = {
      fetch,
      run: realRun,
      readToken: () => readTokenFile(),
      log: console.log,
      writeDigest: (version, digest) => writeFileSync(DIGEST_FILE, `${version} ${digest}\n`),
      signals: {
        on: (sig, fn) => process.on(sig, fn),
        off: (sig, fn) => process.off(sig, fn),
        exit: (code) => process.exit(code),
      },
      killChild: () => child?.kill("SIGTERM"),
    };
    for (const l of await publish(opts, deps)) console.log(l);
  } catch (e) {
    console.error(`site-deploy-plugin-publish: FAIL: ${redact((e as Error).message, "")}`);
    process.exit(1);
  }
}
