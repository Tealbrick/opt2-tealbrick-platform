// Trigger a MANUAL Woodpecker pipeline for <owner/repo> on <branch> and (optionally) wait for its result (C254).
//   node ops/wp-run.ts <owner/repo> <branch> [--var KEY=VALUE]... [--wait] [--timeout-min 30]
// Use: a hotfix branch gets no push pipeline (ci.yaml runs push only on main), so the exact commit has no Woodpecker
// status; a manual run gives it `ci/woodpecker/manual/ci`, which ops/promote.ts accepts. The release check is NOT loosened.
// Config (never printed, never in argv): ~/.config/opt2-tealbrick/woodpecker-token and WOODPECKER_URL (env or hosts.env),
// read by wp-failed.ts loadConfig. Output: pipeline number, branch, commit and state only (no logs, no variables).

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "./redact.ts";
import { loadConfig } from "./wp-failed.ts";

export interface RunOptions {
  slug: string;
  branch: string;
  variables: Record<string, string>;
  wait: boolean;
  timeoutMin: number;
}

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const VAR_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Terminal pipeline states in Woodpecker. */
export const FINAL = new Set(["success", "failure", "error", "killed", "declined", "blocked", "skipped"]);

export function parseArgs(argv: readonly string[]): RunOptions {
  const pos: string[] = [];
  const variables: Record<string, string> = {};
  let wait = false;
  let timeoutMin = 30;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--wait") wait = true;
    else if (a === "--var") {
      const kv = argv[++i];
      const eq = kv?.indexOf("=") ?? -1;
      if (!kv || eq < 1) throw new Error("--var needs KEY=VALUE");
      const k = kv.slice(0, eq);
      if (!VAR_KEY.test(k)) throw new Error(`--var key ${k} must be UPPER_SNAKE (A-Z, 0-9, _)`);
      variables[k] = kv.slice(eq + 1);
    } else if (a === "--timeout-min") {
      timeoutMin = Number(argv[++i]);
      if (!Number.isInteger(timeoutMin) || timeoutMin < 1 || timeoutMin > 180) throw new Error("--timeout-min must be 1..180");
    } else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else pos.push(a);
  }
  const [slug, branch] = pos;
  if (!slug || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) throw new Error("first argument: <owner/repo>");
  if (!branch || !BRANCH.test(branch) || branch.includes("..")) throw new Error("second argument: a branch name");
  if (pos.length > 2) throw new Error("too many arguments");
  return { slug, branch, variables, wait, timeoutMin };
}

interface Pipeline {
  number: number;
  status: string;
  commit?: string;
  branch?: string;
  event?: string;
}

export function line(slug: string, p: Pipeline): string {
  return `${slug} pipeline ${p.number} (${p.event ?? "manual"} ${p.branch ?? ""} ${(p.commit ?? "").slice(0, 12)}): ${p.status}`;
}

export async function run(
  o: RunOptions,
  cfg: { url: string; token: string; fetch?: typeof fetch; sleepMs?: number; now?: () => number },
  out: (s: string) => void = console.log,
): Promise<Pipeline> {
  const f = cfg.fetch ?? fetch;
  const headers = { authorization: `Bearer ${cfg.token}`, accept: "application/json" };
  const call = async <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const res = await f(`${cfg.url}/api${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  const [owner, name] = o.slug.split("/") as [string, string];
  const repo = await call<{ id: number }>("GET", `/repos/lookup/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  let p = await call<Pipeline>("POST", `/repos/${repo.id}/pipelines`, { branch: o.branch, variables: o.variables });
  out(line(o.slug, p));
  if (!o.wait) return p;
  const now = cfg.now ?? Date.now;
  const end = now() + o.timeoutMin * 60_000;
  let last = p.status;
  while (!FINAL.has(p.status)) {
    if (now() > end) throw new Error(`timeout after ${o.timeoutMin} min: pipeline ${p.number} is ${p.status}`);
    await new Promise((r) => setTimeout(r, cfg.sleepMs ?? 15_000));
    p = await call<Pipeline>("GET", `/repos/${repo.id}/pipelines/${p.number}`);
    if (p.status !== last) {
      out(line(o.slug, p));
      last = p.status;
    }
  }
  return p;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const p = await run(o, loadConfig());
    if (o.wait && p.status !== "success") process.exit(1);
  } catch (e) {
    console.error(`wp-run: ${redact((e as Error).message)}`);
    process.exit(1);
  }
}
