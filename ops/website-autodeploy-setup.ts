// C293a: Martin stores the website deploy token in Woodpecker. Agents never run the real mode and never see the token.
//   node ops/website-autodeploy-setup.ts --dry-run   prints what this script would do (no prompt, no network call)
//   node ops/website-autodeploy-setup.ts             asks for the GitHub fine-grained token (hidden input), stores it as the
//                                                    Woodpecker repo secret `site_deploy_token` of Tealbrick/opt2-tealbrick-website
//                                                    (events push and tag only, no image filter), then lists the secret NAMES
// The token: a GitHub fine-grained token, ONLY repo opt2-tealbrick-website, Contents read and write, expiry 1 year. It lets the
// workflow .woodpecker/site-deploy.yaml move the branches site-dev and site-live and write the release record (Railway deploys
// from those branches; no Railway token exists in CI).
// Rules: the value is never printed, never on argv, never in a file, never in a URL. Woodpecker URL and the Woodpecker token come from
// the operator config (~/.config/opt2-tealbrick/hosts.env and woodpecker-token; the loader of ops/wp-failed.ts).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { askHidden } from "./prod-secrets.ts";
import { loadConfig, redact as redactWp } from "./wp-failed.ts";

export const REPO = "Tealbrick/opt2-tealbrick-website";
/** Woodpecker may still name a moved repo by its old owner (C206); looked up in this order. */
export const REPO_LOOKUP = [REPO, "Martin-Atrin/opt2-tealbrick-website"] as const;
export const SECRET_NAME = "site_deploy_token";
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

export function planLines(): string[] {
  return [
    `repo: ${REPO} (Woodpecker repo secret, this repo only)`,
    `secret name: ${SECRET_NAME}`,
    `events: ${EVENTS.join(", ")} (never pull_request, never manual); no image filter`,
    "you paste: a GitHub fine-grained token (only repo opt2-tealbrick-website; Contents read and write; expiry 1 year)",
    "afterwards the script lists the secret NAMES of the repo and checks the events; it never prints the value",
  ];
}

export function parseArgs(argv: readonly string[]): { dryRun: boolean } {
  for (const a of argv) if (a !== "--dry-run") throw new Error(`unknown option ${a}`);
  return { dryRun: argv.includes("--dry-run") };
}

/** Stores the secret and verifies it. Returns the lines to print. Every Woodpecker error is redacted before it is thrown. */
export async function storeSecret(wp: WpConfig, ghToken: string, f: Fetch = fetch): Promise<string[]> {
  const secrets = [ghToken, wp.token];
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

  const exists = (await call("GET", `/repos/${repoId}/secrets/${SECRET_NAME}`)).status === 200;
  const body = { name: SECRET_NAME, value: ghToken, events: [...EVENTS], images: [] as string[] };
  const write = exists ? await call("PATCH", `/repos/${repoId}/secrets/${SECRET_NAME}`, body) : await call("POST", `/repos/${repoId}/secrets`, body);
  ok(write.status, `${exists ? "update" : "create"} secret ${SECRET_NAME}`);

  // Verify: names and event filters only. Woodpecker never returns a value.
  const list = await call<SecretInfo[]>("GET", `/repos/${repoId}/secrets`);
  ok(list.status, "list secrets");
  const names = (list.json ?? []).map((s) => s.name).sort();
  const mine = (list.json ?? []).find((s) => s.name === SECRET_NAME);
  if (!mine) throw new Error(`${SECRET_NAME} is not in the secret list after the write; names: ${names.join(", ") || "(none)"}`);
  const events = [...(mine.events ?? [])].sort();
  if (events.join(",") !== [...EVENTS].sort().join(","))
    throw new Error(`${SECRET_NAME} has the events [${events.join(", ")}] but must have exactly [${EVENTS.join(", ")}]`);
  if ((mine.images ?? []).length > 0) throw new Error(`${SECRET_NAME} has an image filter; Woodpecker refuses image filters on command steps`);
  return [`${exists ? "updated" : "created"} ${SECRET_NAME} for ${REPO} (events ${events.join(", ")})`, `secret names of ${REPO}: ${names.join(", ")}`, "done"];
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv.slice(2));
  if (dryRun) {
    for (const l of planLines()) console.log(l);
    return;
  }
  if (!process.stdin.isTTY) throw new Error("run this in a terminal (hidden input needs a TTY); the token is never read from a pipe");
  const wp = loadConfig();
  let token = "";
  for (let attempt = 1; ; attempt++) {
    const v = await askHidden("GitHub fine-grained token for opt2-tealbrick-website: ");
    const why = checkToken(v);
    if (!why) {
      token = v;
      console.log(`  received the token: ${v.length} characters`);
      break;
    }
    console.log(`  refused (${why})`);
    if (attempt >= 3) throw new Error("three refused attempts; nothing was stored");
  }
  try {
    for (const l of await storeSecret(wp, token)) console.log(l);
  } finally {
    token = "";
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(`website-autodeploy-setup: FAIL: ${redact((e as Error).message, [])}`);
    process.exit(1);
  });
}
