// C293a: Martin stores the website deploy secrets and the plugin-image registry credential in Woodpecker. Agents never run the real mode and never see the values.
//   node ops/website-autodeploy-setup.ts --dry-run   prints what this script would do (no prompt, no network call)
//   --image-filter <value>   the secret image filter. Default: the exact digest-pinned image name:tag@sha256:<digest> recorded by the publish script
//                            (ops/site-deploy-plugin/IMAGE-DIGEST). Fallback if Woodpecker does not match digests: --image-filter name:tag
//                            (then a writer of the registry could replace the tag: residual = registry write, ops only).
//   node ops/website-autodeploy-setup.ts             asks for the values (hidden input), stores them as Woodpecker repo secrets of
//                                                    Tealbrick/opt2-tealbrick-website (events push and tag only, image filter = exactly the
//                                                    plugin image forge.polygonface.com/polygonface/tb-site-deploy:<VERSION>) and sets the
//                                                    repo's registry credential for forge.polygonface.com, then lists NAMES and filters only
//   registry           a Forgejo login name and a Forgejo token with read:package ONLY: Woodpecker agents use it to pull the plugin image.
//                      Publish the image first (ops/site-deploy-plugin-publish.ts).
//   site_deploy_key    the PRIVATE half of a WRITE deploy key of the website repo (ed25519, no passphrase). It is the only thing that
//                      moves the branches site-dev and site-live (git push over SSH from .woodpecker/site-deploy.yaml).
//   site_deploy_token  a GitHub fine-grained token, ONLY repo opt2-tealbrick-website, Contents read and write, expiry 1 year. It writes the
//                      GitHub release record and does reads. It no longer moves branches.
// Railway deploys from those branches; no Railway token exists in CI.
// Rules: values are never printed, never on argv, never in a file, never in a URL. The Woodpecker URL must be https. Woodpecker URL and
// token come from the operator config (~/.config/opt2-tealbrick/hosts.env and woodpecker-token; the loader of ops/wp-failed.ts).
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { askHidden } from "./prod-secrets.ts";
import { checkFilter, pinnedImage, pluginImage, REGISTRY_HOST } from "./site-deploy-plugin/image.ts";
import { loadConfig, redact as redactWp } from "./wp-failed.ts";

export const REPO = "Tealbrick/opt2-tealbrick-website";
/** Woodpecker may still name a moved repo by its old owner (C206); looked up in this order. */
export const REPO_LOOKUP = [REPO, "Martin-Atrin/opt2-tealbrick-website"] as const;
export const TOKEN_SECRET = "site_deploy_token";
export const KEY_SECRET = "site_deploy_key";
/** The two secrets this script stores, in this order. */
export const SECRET_NAMES: readonly string[] = [TOKEN_SECRET, KEY_SECRET];
/** The secret reaches push and tag pipelines only. Never pull_request, never manual. */
export const EVENTS: readonly string[] = ["push", "tag"];
/** A GitHub fine-grained personal access token. */
export const TOKEN_RE = /^github_pat_[A-Za-z0-9_]{20,}$/;

type Fetch = typeof fetch;
export interface WpConfig {
  url: string;
  token: string;
}
export interface SecretInfo {
  name: string;
  events?: string[];
  images?: string[];
}

const KEY_BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";
const KEY_END = "-----END OPENSSH PRIVATE KEY-----";

/** Why a pasted private key is refused, or null. Needs an unencrypted OpenSSH ed25519 key (the format `ssh-keygen -t ed25519 -N ""` writes). */
export function checkKey(value: string): string | null {
  const text = value.trim().replace(/\r\n/g, "\n");
  if (text === "") return "a value is required";
  if (!text.startsWith(KEY_BEGIN) || !text.endsWith(KEY_END)) return `must be an OpenSSH private key (from "${KEY_BEGIN}" to "${KEY_END}")`;
  const body = text.slice(KEY_BEGIN.length, text.length - KEY_END.length).replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(body)) return "the key text is damaged (not base64)";
  const raw = Buffer.from(body, "base64");
  // openssh-key-v1 layout: "openssh-key-v1\0", then the cipher name as a length-prefixed string; "none" means no passphrase.
  if (raw.subarray(0, 15).toString("latin1") !== "openssh-key-v1\0") return "not an openssh-key-v1 key";
  if (raw.subarray(15, 23).toString("latin1") !== "\0\0\0\u0004none") return "the key has a passphrase: create it with an empty passphrase";
  if (!raw.includes(Buffer.from("ssh-ed25519"))) return "must be an ed25519 key (ssh-keygen -t ed25519)";
  return null;
}

/** The Woodpecker URL must be https: the Woodpecker token and the secret values travel to it. */
export function requireHttps(url: string): void {
  if (!/^https:\/\/[^/\s]+/i.test(url)) throw new Error("WOODPECKER_URL must start with https:// (the secrets are sent to it); refused");
}

/** Why a pasted value is refused, or null when it is accepted. The text never holds the value. */
export function checkToken(value: string): string | null {
  if (value === "") return "a value is required";
  if (/\s/.test(value)) return "the value contains spaces or line breaks";
  if (!TOKEN_RE.test(value)) return 'must be a GitHub fine-grained token (starts with "github_pat_")';
  return null;
}

/** Removes the secret values and anything token-shaped from a text before it is shown. */
export function redact(text: string, values: readonly string[]): string {
  return redactWp(text, values);
}

/** The secret image filter: the --image-filter value, else the recorded digest-pinned image. Throws while the image is not recorded. */
export function imageFilter(arg: string | null, recorded: string | null = pinnedImage()): string {
  const value = arg ?? recorded;
  if (!value)
    throw new Error(
      "the plugin image is not recorded yet (ops/site-deploy-plugin/IMAGE-DIGEST is still the placeholder): publish it first, or pass --image-filter <name:tag>",
    );
  const why = checkFilter(value);
  if (why) throw new Error(why);
  return value;
}

export function planLines(image: string = pinnedImage() ?? `${pluginImage()}@sha256:<digest, after the publish>`): string[] {
  return [
    `repo: ${REPO} (Woodpecker repo secrets and registry credential, this repo only)`,
    `secret names: ${SECRET_NAMES.join(", ")}`,
    `events: ${EVENTS.join(", ")} (never pull_request, never manual)`,
    `image filter: exactly ${image} (only the deploy plugin image can read the secrets)`,
    `registry credential: ${REGISTRY_HOST} (agents pull the plugin image with it)`,
    `${KEY_SECRET}: you paste the PRIVATE key of a write deploy key (ed25519, no passphrase)`,
    `${TOKEN_SECRET}: you paste a GitHub fine-grained token (only repo opt2-tealbrick-website; Contents read and write; expiry 1 year; release record only)`,
    `registry: you type your Forgejo login name and paste a Forgejo token with read:package ONLY`,
    "afterwards the script lists the secret NAMES, their events and image filters, and the registry address; it never prints a value",
  ];
}

/** A Forgejo access token (40 hex characters from the UI). */
export const FORGE_TOKEN_RE = /^[A-Za-z0-9]{20,}$/;
export const FORGE_USER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}$/;

export interface SetupValues {
  [TOKEN_SECRET]: string;
  [KEY_SECRET]: string;
  /** Forgejo login and read:package token for the registry credential */
  forgeUser: string;
  forgeToken: string;
}

export function parseArgs(argv: readonly string[]): { dryRun: boolean; imageFilter: string | null } {
  let dryRun = false;
  let filter: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--dry-run") dryRun = true;
    else if (a === "--image-filter") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error("--image-filter needs a value");
      filter = v;
    } else throw new Error(`unknown option ${a}`);
  }
  return { dryRun, imageFilter: filter };
}

/** Stores the registry credential and the two secrets and verifies them. Returns the lines to print. Every Woodpecker error is redacted before it is thrown. */
export async function storeSecrets(wp: WpConfig, values: SetupValues, image: string, f: Fetch = fetch): Promise<string[]> {
  requireHttps(wp.url);
  const secrets = [values[TOKEN_SECRET], values[KEY_SECRET], values.forgeToken, wp.token, ...values[KEY_SECRET].split(/\r?\n/)];
  const call = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T | null }> => {
    let res: Response;
    try {
      res = await f(`${wp.url}/api${path}`, {
        method,
        signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${wp.token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      throw new Error(redact(`${method} ${path}: ${(e as Error).message}`, secrets));
    }
    let json: T | null = null;
    try {
      json = (await res.json()) as T;
    } catch {
      /* an empty body is fine */
    }
    return { status: res.status, json };
  };
  const ok = (status: number, what: string): void => {
    if (status < 200 || status >= 300) throw new Error(`${what}: HTTP ${status}`);
  };

  let repoId: number | null = null;
  for (const name of REPO_LOOKUP) {
    const r = await call<{ id?: number; active?: boolean }>("GET", `/repos/lookup/${name}`);
    if (r.status === 200 && typeof r.json?.id === "number") {
      repoId = r.json.id;
      break;
    }
  }
  if (repoId === null) throw new Error(`${REPO} is not in Woodpecker (activate it first: node ops/woodpecker-activate.ts --repo website)`);

  const done: string[] = [];
  // The registry credential: Woodpecker agents pull the plugin image from the Forgejo registry with it. The list never returns the password.
  const regExists = (await call("GET", `/repos/${repoId}/registries/${encodeURIComponent(REGISTRY_HOST)}`)).status === 200;
  const regBody = { address: REGISTRY_HOST, username: values.forgeUser, password: values.forgeToken };
  const regWrite = regExists
    ? await call("PATCH", `/repos/${repoId}/registries/${encodeURIComponent(REGISTRY_HOST)}`, regBody)
    : await call("POST", `/repos/${repoId}/registries`, regBody);
  ok(regWrite.status, `${regExists ? "update" : "create"} registry ${REGISTRY_HOST}`);
  done.push(`${regExists ? "updated" : "created"} registry ${REGISTRY_HOST}`);
  for (const name of SECRET_NAMES) {
    const exists = (await call("GET", `/repos/${repoId}/secrets/${name}`)).status === 200;
    const body = { name, value: values[name as keyof typeof values], events: [...EVENTS], images: [image] };
    const write = exists ? await call("PATCH", `/repos/${repoId}/secrets/${name}`, body) : await call("POST", `/repos/${repoId}/secrets`, body);
    ok(write.status, `${exists ? "update" : "create"} secret ${name}`);
    done.push(`${exists ? "updated" : "created"} ${name}`);
  }

  // Verify: names and event filters only. Woodpecker never returns a value.
  const list = await call<SecretInfo[]>("GET", `/repos/${repoId}/secrets`);
  ok(list.status, "list secrets");
  const names = (list.json ?? []).map((s) => s.name).sort();
  for (const name of SECRET_NAMES) {
    const mine = (list.json ?? []).find((s) => s.name === name);
    if (!mine) throw new Error(`${name} is not in the secret list after the write; names: ${names.join(", ") || "(none)"}`);
    const events = [...(mine.events ?? [])].sort();
    if (events.join(",") !== [...EVENTS].sort().join(","))
      throw new Error(`${name} has the events [${events.join(", ")}] but must have exactly [${EVENTS.join(", ")}]`);
    const images = [...(mine.images ?? [])].sort();
    if (images.join(",") !== image) throw new Error(`${name} has the image filter [${images.join(", ")}] but must be exactly [${image}]`);
  }
  const regList = await call<{ address?: string; username?: string }[]>("GET", `/repos/${repoId}/registries`);
  ok(regList.status, "list registries");
  const reg = (regList.json ?? []).find((r) => r.address === REGISTRY_HOST);
  if (!reg) throw new Error(`the registry ${REGISTRY_HOST} is not in the registry list after the write`);
  if (reg.username !== values.forgeUser) throw new Error(`the registry ${REGISTRY_HOST} has another username than the one you typed`);
  return [
    ...done.map((d) => `${d} for ${REPO}`),
    `secrets: events ${EVENTS.join(", ")}, image filter ${image}`,
    `secret names of ${REPO}: ${names.join(", ")}`,
    `registry addresses of ${REPO}: ${(regList.json ?? []).map((r) => r.address).join(", ")}`,
    "done",
  ];
}

async function askVisible(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const answer = await new Promise<string>((r) => rl.question(prompt, r));
  rl.close();
  return answer.trim();
}

/** Hidden multi-line paste: reads until the END line of an OpenSSH private key (or Ctrl+C). Nothing is echoed or printed. */
async function askHiddenKey(prompt: string): Promise<string> {
  process.stderr.write(`${prompt}(hidden: paste the whole key file with Cmd+V, nothing shows; it ends by itself) `);
  const stdin = process.stdin;
  return await new Promise<string>((resolvePromise, reject) => {
    let buf = "";
    const finish = (fn: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      fn();
    };
    const onData = (chunk: Buffer) => {
      const text = chunk
        .toString("utf8")
        .replaceAll(`${String.fromCharCode(27)}[200~`, "")
        .replaceAll(`${String.fromCharCode(27)}[201~`, "")
        .replaceAll("\r\n", "\n")
        .replaceAll("\r", "\n");
      for (const ch of text) {
        if (ch === "\u0003") return finish(() => reject(new Error("stopped (Ctrl+C); nothing was stored")));
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch === "\n" || ch >= " ") buf += ch;
      }
      if (buf.includes(KEY_END)) finish(() => resolvePromise(buf.trim()));
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const { dryRun, imageFilter: filterArg } = parseArgs(process.argv.slice(2));
  if (dryRun) {
    for (const l of planLines(filterArg ?? undefined)) console.log(l);
    return;
  }
  const filter = imageFilter(filterArg);
  if (!process.stdin.isTTY) throw new Error("run this in a terminal (hidden input needs a TTY); values are never read from a pipe");
  const wp = loadConfig();
  requireHttps(wp.url);
  const values: SetupValues = { [KEY_SECRET]: "", [TOKEN_SECRET]: "", forgeUser: "", forgeToken: "" };
  for (let attempt = 1; ; attempt++) {
    const v = await askHiddenKey("Deploy PRIVATE key (the whole file, ed25519, no passphrase): ");
    const why = checkKey(v);
    if (!why) {
      values[KEY_SECRET] = v;
      console.log("  received the key: an unencrypted ed25519 OpenSSH key");
      break;
    }
    console.log(`  refused (${why})`);
    if (attempt >= 3) throw new Error("three refused attempts; nothing was stored");
  }
  for (let attempt = 1; ; attempt++) {
    const v = await askHidden("GitHub fine-grained token for opt2-tealbrick-website (release record only): ");
    const why = checkToken(v);
    if (!why) {
      values[TOKEN_SECRET] = v;
      console.log(`  received the token: ${v.length} characters`);
      break;
    }
    console.log(`  refused (${why})`);
    if (attempt >= 3) throw new Error("three refused attempts; nothing was stored");
  }
  values.forgeUser = await askVisible(`Your Forgejo login name (the owner of the read:package token) for ${REGISTRY_HOST}: `);
  if (!FORGE_USER_RE.test(values.forgeUser)) throw new Error("that is not a Forgejo login name; nothing was stored");
  for (let attempt = 1; ; attempt++) {
    const v = await askHidden("Forgejo token with read:package ONLY: ");
    if (FORGE_TOKEN_RE.test(v)) {
      values.forgeToken = v;
      console.log(`  received the Forgejo token: ${v.length} characters`);
      break;
    }
    console.log("  refused (a Forgejo token is letters and digits only, 20 or more)");
    if (attempt >= 3) throw new Error("three refused attempts; nothing was stored");
  }
  try {
    for (const l of await storeSecrets(wp, values, filter)) console.log(l);
  } finally {
    values[KEY_SECRET] = "";
    values[TOKEN_SECRET] = "";
    values.forgeToken = "";
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(`website-autodeploy-setup: FAIL: ${redact((e as Error).message, [])}`);
    process.exit(1);
  });
}
