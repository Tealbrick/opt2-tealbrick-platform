// Activate opt2 repos in Woodpecker and set the CI secrets. Run on the operator machine:
//   WOODPECKER_URL=<server url> node ops/woodpecker-activate.ts [--repo <name>]
// --repo (C259 backlog): touch ONE repo only (activation, settings, its repo secrets); no other repo and no org-level secret
// is read or changed. <name> = "fleet", "opt2-tealbrick-fleet" or "Tealbrick/opt2-tealbrick-fleet"; it must be a listed repo.
// Reads tokens from files (never argv, never printed):
//   ~/.config/opt2-tealbrick/woodpecker-token   Woodpecker personal access token (required)
// Secrets (C72): Woodpecker holds none; the script deletes any org-level or repo secret it finds. See ci/README.md.
// C222 exception: KEEP lists hand-made repo secrets (Martin creates them in the Woodpecker UI). The script never deletes,
// writes or reads their value; it only checks their event filter.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PRIVATE_REPOS } from "../ci/tb-ci.ts";

/** C206: the opt2 repos move to the Tealbrick org in batches; during the move some still live under the user account. Each
 *  repo's CURRENT owner is read from GitHub (first match wins), so one run works before, during and after the move. */
const OWNERS = ["Tealbrick", "Martin-Atrin"] as const;
const REPOS = [
  "specs",
  "sdk",
  "bridge",
  "packages",
  "portal-core",
  "portal-gui",
  "website",
  "knowledge",
  "connect",
  "tbd",
  "platform",
  "qa",
  "samples",
  "kanban",
  "rules",
  "inbox",
  "fleet",
  "evolution",
  "cli", // C173/C177: private repo (exists since 2026-10-15)
  "observer", // C258a: public since 2026-10-18; moved out of ACTIVATE_PRIVATE
  "live-artifacts", // C249 (ci-v9.15): public; moved out of ACTIVATE_PRIVATE
].map((n) => `opt2-tealbrick-${n}`);
/** C203: private repos activated here that are NOT opt2 release repos (not in OPT2_REPOS / PRIVATE_REPOS: no releases, no
 *  registry-sync, no template audit). Woodpecker visibility private (pipeline logs of proprietary code). */
//  opt2-tealbrick-live-artifacts (C230 note, Coordinator 2026-10-17): a new mini app built privately before its first release; it
//  moves into OPT2_REPOS (and out of this list) with the public flip and Martin's yes, before v0.1.0. Same for
//  opt2-tealbrick-creative (C190) (Coordinator OK 2026-10-17). opt2-tealbrick-observer (C258a) and opt2-tealbrick-live-artifacts (ci-v9.15) moved to REPOS with their public flips.
const ACTIVATE_PRIVATE: readonly string[] = ["opt2-tealbrick-admin", "opt2-tealbrick-creative"];
const ALL_REPOS = [...REPOS, ...ACTIVATE_PRIVATE];

/** The repos this run touches: all of them, or the one `--repo` names (a listed repo only; anything else is an error). */
export function selectRepos(argv: readonly string[], all: readonly string[]): { only: string | null; repos: string[] } {
  const i = argv.indexOf("--repo");
  const extra = argv.filter((a, k) => !(i >= 0 && (k === i || k === i + 1)) && !(a === "--repo"));
  if (extra.length > 0) throw new Error(`unknown argument ${JSON.stringify(extra[0])} (usage: [--repo <name>])`);
  if (i < 0) return { only: null, repos: [...all] };
  const raw = argv[i + 1];
  if (!raw || raw.startsWith("--")) throw new Error("--repo needs a repo name");
  if (argv.indexOf("--repo", i + 1) >= 0) throw new Error("--repo given twice");
  const bare = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  const name = bare.startsWith("opt2-tealbrick-") ? bare : `opt2-tealbrick-${bare}`;
  if (!all.includes(name)) throw new Error(`--repo ${JSON.stringify(raw)}: not a repo this script manages`);
  return { only: name, repos: [name] };
}
const { only, repos: TARGETS } = selectRepos(process.argv.slice(2), ALL_REPOS);
if (only) console.log(`--repo: only ${only} (no other repo, no org-level secret)`);
const CFG = join(homedir(), ".config/opt2-tealbrick");

const base = process.env.WOODPECKER_URL?.replace(/\/$/, "");
if (!base) throw new Error("WOODPECKER_URL is required");
const token = readFileSync(join(CFG, "woodpecker-token"), "utf8").trim();

async function wp(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** The repo as GitHub names it now (owner/name) and its numeric id (unchanged by a transfer). Never a redirect: the API answers
 *  an old owner path with the moved repo, so full_name is always the current one. */
function githubRepo(repo: string): { fullName: string; id: number } {
  for (const owner of OWNERS) {
    try {
      const out = execFileSync("gh", ["api", `repos/${owner}/${repo}`, "-q", '.full_name + " " + (.id | tostring)'], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const [fullName, id] = out.split(" ");
      if (fullName && id) return { fullName, id: Number(id) };
    } catch {
      // not under this owner: try the next
    }
  }
  throw new Error(`${repo}: not found under ${OWNERS.join(" or ")}`);
}
const gh = new Map<string, { fullName: string; id: number }>();
for (const repo of TARGETS) gh.set(repo, githubRepo(repo));

const me = await wp("GET", "/user");
if (me.status !== 200) throw new Error(`token rejected by Woodpecker (HTTP ${me.status})`);
console.log(`woodpecker user: ${me.json.login}`);

for (const repo of TARGETS) {
  const cur = gh.get(repo) as { fullName: string; id: number };
  let look = await wp("GET", `/repos/lookup/${cur.fullName}`);
  if (look.status !== 200) {
    // C206: Woodpecker still holds the pre-transfer owner until a repair (POST /repos/<id>/repair) or the next hook
    for (const owner of OWNERS) {
      const old = await wp("GET", `/repos/lookup/${owner}/${repo}`);
      if (old.status === 200) {
        look = old;
        console.log(`${repo}: Woodpecker still names it ${old.json?.full_name ?? `${owner}/${repo}`} (GitHub: ${cur.fullName}); run the repair`);
        break;
      }
    }
  }
  if (look.status === 200 && look.json?.forge_remote_id !== undefined && String(look.json.forge_remote_id) !== String(cur.id))
    throw new Error(`${repo}: Woodpecker forge_remote_id ${look.json.forge_remote_id} != GitHub id ${cur.id}; stop and check`);
  let id: number | null = look.status === 200 && look.json?.active ? look.json.id : null;
  if (!id) {
    const act = await wp("POST", `/repos?forge_remote_id=${cur.id}`);
    if (act.status !== 200) {
      console.log(`${repo}: activation FAILED (HTTP ${act.status})`);
      continue;
    }
    id = act.json.id;
    console.log(`${repo}: activated (id ${id})`);
  } else {
    console.log(`${repo}: already active (id ${id})`);
  }
  // Fork PRs need approval; no trusted/privileged settings. C154: a private GitHub repo gets private Woodpecker visibility
  // (pipeline logs of proprietary code only for users with repo access); every other repo stays public.
  const visibility = ACTIVATE_PRIVATE.includes(repo) ? "private" : PRIVATE_REPOS.includes(repo) ? "private" : "public";
  const patched = await wp("PATCH", `/repos/${id}`, { require_approval: "forks", visibility, timeout: 60 });
  console.log(`${repo}: settings ${patched.status === 200 ? "ok" : `FAILED (HTTP ${patched.status})`} (visibility ${visibility})`);
}

// ---- Secrets (C67): NO org-level or global secrets. Each secret lives only on the repos that need it, for the
// events that need it. Values come from 0600 files and are never printed.
// C72: Woodpecker holds NO secrets at all. Image/kit/package publishing runs in each repo's GitHub Actions
// workflow with the built-in GITHUB_TOKEN; the release signer runs in the platform repo's GitHub Actions
// (environment "registry", secret RELEASE_SIGNING_KEY, main only). This script removes any Woodpecker secret.
interface Want {
  repo: string;
  name: string;
  file: string;
  events: string[];
}
const WANT: Want[] = [];
/** C222 (template ci-v9.10, C232 ci-v9.11): repo secrets made by hand and used ONLY by one step of .woodpecker/release.yaml each
 *  (release-publish: tb_release_token; release-image-push: tb_ghcr_token) and, for the website, site_deploy_token (C293a). Never
 *  deleted or written here; the script warns when the event filter is not exactly these events or an image filter is set
 *  (Woodpecker refuses image-filtered secrets on command steps). */
interface Keep {
  repo: string;
  name: string;
  events: string[];
}
// C232 (template ci-v9.11): the bridge repo releases its image on Woodpecker. tb_ghcr_token (classic PAT, write:packages only, of the
// machine user) is read ONLY by the release-image-push step; tb_release_token (publish step) is the same as in the cli repo.
const KEEP: Keep[] = [
  { repo: "opt2-tealbrick-cli", name: "tb_release_token", events: ["manual", "tag"] },
  { repo: "opt2-tealbrick-bridge", name: "tb_release_token", events: ["manual", "tag"] },
  { repo: "opt2-tealbrick-bridge", name: "tb_ghcr_token", events: ["manual", "tag"] },
  // C293a: the website self-service deploy. site_deploy_token (GitHub fine-grained token, this one repo, Contents read and write) is
  // read ONLY by .woodpecker/site-deploy.yaml of opt2-tealbrick-website. Martin stores it with ops/website-autodeploy-setup.ts.
  { repo: "opt2-tealbrick-website", name: "site_deploy_token", events: ["push", "tag"] },
];

// C72: no org-level secrets in the opt2 Woodpecker org. ONLY the Martin-Atrin org (opt2 only). NEVER the Tealbrick org: it is
// shared with the v1 repos and their own org secrets (C206 incident 2026-10-16: an earlier version of this loop deleted the
// v1 Tealbrick org secrets registry_host/registry_username/registry_password).
const CLEAN_ORG_SECRETS_OF = "Martin-Atrin";
if (!only) {
  const org = await wp("GET", `/orgs/lookup/${CLEAN_ORG_SECRETS_OF}`);
  if (org.status !== 200 && org.status !== 404) throw new Error(`org lookup ${CLEAN_ORG_SECRETS_OF} failed (HTTP ${org.status})`);
  if (org.status === 200) {
    for (const sec of ((await wp("GET", `/orgs/${org.json.id}/secrets`)).json ?? []) as { name: string }[]) {
      const d = await wp("DELETE", `/orgs/${org.json.id}/secrets/${sec.name}`);
      console.log(`org ${CLEAN_ORG_SECRETS_OF} secret ${sec.name}: ${d.status < 300 ? "deleted (no org-level secrets)" : `DELETE FAILED (HTTP ${d.status})`}`);
    }
  }
}
const ids = new Map<string, number>();
for (const repo of TARGETS) {
  for (const name of [(gh.get(repo) as { fullName: string }).fullName, ...OWNERS.map((o) => `${o}/${repo}`)]) {
    const r = await wp("GET", `/repos/lookup/${name}`);
    if (r.status === 200) {
      ids.set(repo, r.json.id as number);
      break;
    }
  }
  if (!ids.has(repo)) throw new Error(`${repo}: not found in Woodpecker after activation`);
}
for (const repo of TARGETS) {
  const id = ids.get(repo) as number;
  const want = WANT.filter((w) => w.repo === repo);
  const keep = KEEP.filter((k) => k.repo === repo);
  const listed = ((await wp("GET", `/repos/${id}/secrets`)).json ?? []) as { name: string; events?: string[]; images?: string[] }[];
  for (const k of keep) {
    const sec = listed.find((s) => s.name === k.name);
    if (!sec) {
      console.log(`${repo} secret ${k.name}: MISSING (C222: Martin creates it; see coordination/leads/platform/WOODPECKER-RELEASE.md)`);
      continue;
    }
    const events = [...(sec.events ?? [])].sort();
    const ok = events.join(",") === [...k.events].sort().join(",") && (sec.images ?? []).length === 0;
    console.log(
      `${repo} secret ${k.name}: kept (hand-made, C222) [${events.join(",")}]${ok ? "" : ` WARNING: want events [${k.events.join(",")}] and no image filter`}`,
    );
  }
  for (const sec of listed) {
    if (keep.some((k) => k.name === sec.name)) continue;
    if (!want.some((w) => w.name === sec.name)) {
      const d = await wp("DELETE", `/repos/${id}/secrets/${sec.name}`);
      console.log(`${repo} secret ${sec.name}: ${d.status < 300 ? "deleted (not needed here)" : `DELETE FAILED (HTTP ${d.status})`}`);
    }
  }
  for (const w of want) {
    const p = join(CFG, w.file);
    if (!existsSync(p)) {
      console.log(`${repo} secret ${w.name}: SKIP (${w.file} not present)`);
      continue;
    }
    const body = { name: w.name, value: readFileSync(p, "utf8").trim(), events: w.events, images: [] };
    const exists = (await wp("GET", `/repos/${id}/secrets/${w.name}`)).status === 200;
    const r = exists ? await wp("PATCH", `/repos/${id}/secrets/${w.name}`, body) : await wp("POST", `/repos/${id}/secrets`, body);
    console.log(`${repo} secret ${w.name} [${w.events.join(",")}]: ${r.status === 200 ? (exists ? "updated" : "created") : `FAILED (HTTP ${r.status})`}`);
  }
}
