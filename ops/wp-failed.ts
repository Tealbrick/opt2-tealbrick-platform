// Read a Woodpecker pipeline's step states and the log tail of its first failed step — READ ONLY (GET requests only).
//   node ops/wp-failed.ts <owner/repo> <commit sha (7..40 hex) | pipeline number>
// Config (never printed): ~/.config/opt2-tealbrick/woodpecker-token (Woodpecker personal access token) and
// ~/.config/opt2-tealbrick/hosts.env (WOODPECKER_URL=…; the WOODPECKER_URL environment variable wins).
// Output: one line per non-skipped step (workflow/step, state, exit code), then the last 40 log lines of the first failed
// step, after a redaction pass (GitHub, Stripe, webhook secrets, bearer tokens, the token itself).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WpStep {
  id: number;
  pid?: number;
  name: string;
  state: string;
  exit_code?: number;
}
export interface WpWorkflow {
  id: number;
  name: string;
  state: string;
  children?: WpStep[];
}
export interface WpPipeline {
  number: number;
  status: string;
  commit: string;
  event?: string;
  branch?: string;
  workflows?: WpWorkflow[];
}

const TAIL = 40;
/** Patterns that must never reach a terminal: GitHub tokens, Stripe keys, webhook secrets, bearer headers, PATs. */
const REDACT: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b(?:rk|sk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
  /\bwhsec_[A-Za-z0-9]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

export function redact(line: string, extra: readonly string[] = []): string {
  // terminal control sequences from step output (colours, cursor moves, OSC titles) never reach the reader's terminal
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  let out = line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  for (const secret of extra) if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  for (const re of REDACT) out = out.replace(re, "[redacted]");
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, dir = join(homedir(), ".config", "opt2-tealbrick")): { url: string; token: string } {
  let url = env.WOODPECKER_URL?.trim();
  if (!url) {
    try {
      const hosts = readFileSync(join(dir, "hosts.env"), "utf8");
      url = /^\s*WOODPECKER_URL\s*=\s*"?([^"\s]+)"?\s*$/m.exec(hosts)?.[1];
    } catch {
      /* reported below */
    }
  }
  if (!url) throw new Error(`WOODPECKER_URL is not set (env or ${join(dir, "hosts.env")})`);
  let token: string;
  try {
    token = readFileSync(join(dir, "woodpecker-token"), "utf8").trim();
  } catch {
    throw new Error(`no Woodpecker token file at ${join(dir, "woodpecker-token")}`);
  }
  if (!token) throw new Error("the Woodpecker token file is empty");
  return { url: url.replace(/\/+$/, ""), token };
}

type Fetch = typeof fetch;

/** GET only: the one HTTP helper of this script (it never sends a body or another method). */
function getter(base: string, token: string, f: Fetch) {
  return async <T>(path: string): Promise<T> => {
    const res = await f(`${base}/api${path}`, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  };
}

export async function findPipeline(get: ReturnType<typeof getter>, repoId: number, ref: string): Promise<WpPipeline> {
  if (/^\d{1,9}$/.test(ref)) return get<WpPipeline>(`/repos/${repoId}/pipelines/${ref}`);
  if (!/^[0-9a-f]{7,40}$/i.test(ref)) throw new Error("second argument: a commit sha (7..40 hex) or a pipeline number");
  for (let page = 1; page <= 5; page++) {
    const list = await get<WpPipeline[]>(`/repos/${repoId}/pipelines?page=${page}&perPage=50`);
    const hit = list.find((p) => p.commit.toLowerCase().startsWith(ref.toLowerCase()));
    if (hit) return get<WpPipeline>(`/repos/${repoId}/pipelines/${hit.number}`);
    if (list.length < 50) break;
  }
  throw new Error(`no pipeline for commit ${ref} in the last 250 pipelines`);
}

/** Woodpecker log entries carry base64 `data` (one line each). */
function decodeLine(entry: { data?: string | null }): string {
  if (!entry.data) return "";
  return Buffer.from(entry.data, "base64")
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

export async function report(slug: string, ref: string, opts: { url: string; token: string; fetch?: Fetch }): Promise<string[]> {
  const get = getter(opts.url, opts.token, opts.fetch ?? fetch);
  const [owner, name] = slug.split("/");
  if (!owner || !name) throw new Error("first argument: <owner/repo>");
  const repo = await get<{ id: number; full_name?: string }>(`/repos/lookup/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  const p = await findPipeline(get, repo.id, ref);
  const out: string[] = [`${slug} pipeline ${p.number} (${p.event ?? "?"} ${p.branch ?? ""} ${p.commit.slice(0, 12)}): ${p.status}`];
  let failed: { wf: WpWorkflow; step: WpStep } | null = null;
  for (const wf of p.workflows ?? []) {
    for (const step of wf.children ?? []) {
      if (step.state === "skipped") continue;
      out.push(`  ${wf.name}/${step.name}: ${step.state}${step.exit_code !== undefined ? ` (exit ${step.exit_code})` : ""}`);
      if (!failed && (step.state === "failure" || step.state === "error" || step.state === "killed")) failed = { wf, step };
    }
  }
  if (!failed) {
    out.push("no failed step");
    return out;
  }
  const logs = await get<{ data?: string | null }[]>(`/repos/${repo.id}/logs/${p.number}/${failed.step.id}`);
  const lines = logs.map(decodeLine);
  out.push(`last ${Math.min(TAIL, lines.length)} log lines of ${failed.wf.name}/${failed.step.name}:`);
  for (const l of lines.slice(-TAIL)) out.push(`    ${redact(l, [opts.token])}`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [slug, ref] = process.argv.slice(2);
  if (!slug || !ref) {
    console.error("usage: node ops/wp-failed.ts <owner/repo> <commit-sha | pipeline-number>");
    process.exit(2);
  }
  try {
    const cfg = loadConfig();
    for (const line of await report(slug, ref, cfg)) console.log(line);
  } catch (e) {
    console.error(`wp-failed: ${redact((e as Error).message)}`);
    process.exit(1);
  }
}
