// opt2 CI runner (one file, no dependencies of its own, Node 24+ runs it directly).
// Fetched by every repo's .woodpecker/ci.yaml at a pinned tag + sha256.
// Commands:
//   setup                       template drift + config + package rules
//   install                     install dependencies per project path (frozen lockfile)
//   run <script>                run a standard script per project path (typecheck|lint|test|conformance|build)
//   gen                         BSA-03: committed gen/ not stale, `gen` script produces every tb-gen kind, tb-gen check passes
//   pre-release                 ci-v9.6: run tealbrick-ci.json preReleaseChecks (repo scripts) on every pipeline; gh-build runs them again on the tag
//   osv-check <report.json>     ci-v9.14 (C262): judge the osv-scanner JSON report of the osv-scan step; fails on HIGH/CRITICAL/unknown
//                               severity not covered by a valid osvIgnore entry (reason + expiry, at most 90 days)
//   audit-templates             (platform cron) every opt2 repo's template ref >= ci/MIN_TEMPLATE
//   plan-images                 write .tb-ci/images.sh for the kaniko steps
//   release-record              (tag v*) validate + print the release; no token, no key (C62); the platform signer indexes it
//   registry-sync               (platform signer pipeline only) verify candidates independently, index + sign
//   pin-tarballs [<repoDir>]    (local) pin sha512 of GitHub-release tarballs the lockfile has no integrity for (S3)
//   package-pack                (tag <pkg>-v*) npm pack --ignore-scripts without tokens, then the pack guard (used by gh-build after the build)
//   gh-build / gh-publish       (C72, GitHub Actions) build without a write token / push images + attach assets, no repo code
//   wp-build / wp-publish       (C222, Woodpecker .woodpecker/release.yaml) the same split for private repos: build with no
//                               token / attach assets with the repo secret tb_release_token, no repo code, never replace an asset
//   wp-push                     (C232, ci-v9.11) push the kaniko image tarballs to ghcr with the repo secret tb_ghcr_token (crane,
//                               hash-checked), no repo code, never overwrite a tag that points to another digest
//   registry-add-desktop ...    (TBD release, on the Mac) add a desktop entry to the signed release index (GitHub asset URL or a platform dist host)
//   registry-sign               re-sign the index (offers changed, or before the envelope expires)
//   registry-add-source ...     (C29 interim) dev entry built from source at a pushed commit
//   adopt <repoDir> --kind <k>  (local) install the standard into a repo
//   stamp                       (platform maintainers) write the runner sha256 into the template
// Crypto and canonical JSON come ONLY from @opt2-tealbrick/manifest (CORE §3: one owner of primitives),
// loaded at run time from its GitHub release tarball (TB_MANIFEST_PKG) for the registry commands.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

/** C206 (ci-v9.8): the GitHub org every opt2 repo lives in. New records, reads and writes use it. */
export const OWNER = "Tealbrick";
/** C206: owners the opt2 repos lived under before the org move. GitHub redirects their old paths (git, API reads and writes,
 *  raw, release downloads; NOT uploads.github.com). Accepted ONLY where existing data is READ: signed index entries, lockfile
 *  and pipeline pins, harness icons, products.json `formerRepos`, image labels/namespaces of releases tagged before the move.
 *  Never written into a new record. Never create a repo under these owners again (it would delete GitHub's redirects). */
export const LEGACY_OWNERS: readonly string[] = ["Martin-Atrin"];
/** OWNER first, then LEGACY_OWNERS. */
export const KNOWN_OWNERS: readonly string[] = [OWNER, ...LEGACY_OWNERS];
/** Regex alternation of KNOWN_OWNERS (owner names hold no regex specials). */
const OWNERS_RE = KNOWN_OWNERS.join("|");
export const REGISTRY_HOST = "ghcr.io";
/** ci-v9.8: images live in ghcr.io/<lowercased owner of the repo that builds them> (the org GITHUB_TOKEN can push only there). */
export function imageNamespace(owner: string = OWNER): string {
  return `${REGISTRY_HOST}/${owner.toLowerCase()}`;
}
export const IMAGE_NAMESPACE = imageNamespace(OWNER);
/** C206: namespaces an indexed image may come from. Old packages under ghcr.io/martin-atrin stay (they hold every signed digest
 *  before the move; never delete or privatise them); releases from the org push to ghcr.io/tealbrick. */
export const IMAGE_NAMESPACES: readonly string[] = KNOWN_OWNERS.map((o) => imageNamespace(o));
/** ci-v9.8: owner/name of the repo a write goes to. In GitHub Actions GITHUB_REPOSITORY names the running repo (the workflow
 *  token can write only there); elsewhere OWNER/<repo>. An owner outside KNOWN_OWNERS is refused. */
export function repoFullName(repo: string, env: NodeJS.ProcessEnv = process.env): string {
  const gr = env.GITHUB_REPOSITORY;
  if (gr?.endsWith(`/${repo}`)) {
    const owner = gr.slice(0, -(repo.length + 1));
    if (!KNOWN_OWNERS.includes(owner)) throw new Error(`GITHUB_REPOSITORY ${gr}: owner ${owner} is not an opt2 owner (${KNOWN_OWNERS.join(", ")})`);
    return gr;
  }
  return `${OWNER}/${repo}`;
}
/** C206: the repo strings one product binding stands for: the bound repo first, then its former names. */
export function repoAliases(b: { repo: string; formerRepos?: readonly string[] }): string[] {
  return [b.repo, ...(b.formerRepos ?? [])];
}
export const PLATFORM_REPO = "opt2-tealbrick-platform";
export const INDEX_PATH = "registry/index.json";
export const ENVELOPE_PATH = "registry/index.jws";
export const OFFERS_PATH = "registry/offers.json";
export const HARNESSES_PATH = "registry/harnesses.json";
/** C207 E4: recorded promotions dev → stable (reviewed input, PR only). */
export const PROMOTIONS_PATH = "registry/promotions.json";
/** C207 E1: tags the release guard must never index again (reviewed input, PR only): [{repo, tag, reason, decision}]. */
export const IGNORED_TAGS_PATH = "registry/ignored-tags.json";
/** GTP-01: the reviewed product → {repo, kind} binding the signer enforces (change by platform PR only). */
export const PRODUCTS_PATH = "registry/products.json";
export const REGISTRY_RELEASE_TAG = "registry";
/** Public files that travel with the index as `registry` release assets ([repo path, asset name]): the release-key set
 *  (D12/C30) and the root-signed Portal key-set statement (BSD-08). Core reads the statement from PORTAL_KEYSET_URL or, by
 *  default, `portal-keyset.jws` next to RELEASE_INDEX_URL; before 2026-10-15 only the raw `main` copy existed (asset 404). */
export const REGISTRY_EXTRA_ASSETS: readonly (readonly [string, string])[] = [
  ["registry/keys.json", "keys.json"],
  ["registry/portal-keyset.jws", "portal-keyset.jws"],
];
export const INDEX_SCHEMA = "opt2.release-index/v2";
export const INDEX_TYP = "tb-release-index+jws";
export const INDEX_ISS = "tb:releases";
export const INDEX_AUD = "tb:portal";
export const MANIFEST_FILE = "tealbrick.manifest.json";

export const KINDS = ["library", "service", "miniapp", "bridge", "portal", "web", "static", "desktop", "specs", "tests"] as const;
export const OPT2_REPOS = [
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
  "cli",
  "observer", // C258a (ci-v9.13): public since 2026-10-18 (Martin yes, C249); was activated privately before its first release
  "live-artifacts", // C249 (ci-v9.15): public since its flip (Coordinator); was activated privately before its first release
].map((n) => `opt2-tealbrick-${n}`);
/** Repos in OPT2_REPOS whose GitHub repo does not exist yet. The template audit and registry-sync skip a 404 for these and ONLY
 *  these; a 404 for any other repo stays an alarm. Empty since 2026-10-15: opt2-tealbrick-cli exists (private, C173/C177). */
export const PENDING_REPOS: readonly string[] = [];
/** C154/C173 (2026-10-15): repos that are private or become private (Portal Core, bridge server, CLI). registry-sync and the
 *  template audit read them with TB_PRIVATE_READ_TOKEN (fine-grained, read-only: Contents + Metadata on these repos), never
 *  with the platform GITHUB_TOKEN, which cannot see another private repo. Without that token they are read as before
 *  (GITHUB_TOKEN / anonymous), which works only while the repo is still public; after the flip an unreadable repo is a loud
 *  registry-sync rejection, never a silent skip. Change by platform PR only. */
export const PRIVATE_REPOS: readonly string[] = [
  "opt2-tealbrick-portal-core",
  "opt2-tealbrick-bridge",
  "opt2-tealbrick-cli",
  // C206/C208 (ci-v9.8): every opt2 repo that is private in the Tealbrick org. Public: the 6 shipped apps, platform, dist
  // (C181/C164) and samples (C208: example fixtures Core fetches anonymously). Each one needs the read token (tb-registry-read).
  "opt2-tealbrick-portal-gui",
  "opt2-tealbrick-website",
  "opt2-tealbrick-sdk",
  "opt2-tealbrick-specs",
  "opt2-tealbrick-packages",
  "opt2-tealbrick-tbd",
  "opt2-tealbrick-qa",
  // C249 (ci-v9.12, Martin yes 2026-10-18): opt2-tealbrick-fleet (Governance) is public again and is read without the token.
];
/** ci-v9.6 (C154/C157): public download hosts for the release assets of private repos. A repo opts in with `distBaseUrl` in
 *  tealbrick-ci.json (or TB_DIST_BASE_URL); only these bases are accepted, so a config can never point dependencies at another host.
 *  The asset layout under a base is `<base>/<repo>-<release tag>/<file>` (one path segment, so a GitHub dist repo's release tag and a
 *  plain host path look the same). Change this list by platform PR only. */
export const DIST_BASES: readonly string[] = [
  "https://github.com/Tealbrick/opt2-tealbrick-dist/releases/download", // assets-only public repo (C206: org repo)
  "https://releases.tealbrick.com", // our own download address (prod)
];
export const MIN_TEMPLATE_PATH = "ci/MIN_TEMPLATE";
export type Kind = (typeof KINDS)[number];

/** Image kinds: `app` and `bridge` become release-index entries; `portal` images are published only (ours, not deployed into workspaces);
 *  `service` images (BSA-01) are companion containers of an app: built and published, digest recorded in the parent app's entry. */
export type ImageKind = "app" | "bridge" | "portal" | "service";

export interface ImageSpec {
  name: string; // ghcr image name, must start with the repo name
  context: string; // build context, relative to repo root
  dockerfile: string; // relative to repo root
  product: string; // release-index product id (manifest id for apps)
  kind: ImageKind;
  manifest?: string; // app manifest path (required for kind app), relative to repo root
  upgradeFrom: string; // semver range of versions that may update to this release
  service?: string; // kind service: the manifest runtime.services[].id this image is (product = the parent app's product)
}

export interface CiConfig {
  kind: Kind;
  paths: string[];
  conformance: boolean;
  images: ImageSpec[];
  postgres: boolean; // ci-v9.1: opt-in ephemeral Postgres for the unit step (TB_TEST_DATABASE_URL)
  distBaseUrl: string | null; // ci-v9.6: public dist host base for dependency URLs of this repo's releases (null = GitHub releases of the repo)
  preReleaseChecks: string[]; // ci-v9.6: repo-relative .ts scripts the pipeline runs before a release can be tagged
  packScripts: Record<string, string>; // ci-v9.7: package dir -> repo-relative .ts that builds that package's release tarball
  releaseOn: ReleaseOn; // ci-v9.10 (C222): who publishes releases: GitHub Actions (public repos) or Woodpecker (private repos)
  osvIgnore: OsvIgnore[]; // ci-v9.14 (C262): vulnerabilities accepted for a limited time (reason + expiry <= 90 days), see osv-check
}
/** ci-v9.10 (C222): "actions" = .github/workflows/opt2-release.yml (free only in public repos); "woodpecker" = .woodpecker/release.yaml. */
export type ReleaseOn = "actions" | "woodpecker";

/** PORTAL-API Release (types/routes.ts `Release`) plus provenance fields. */
export type Channel = "stable" | "dev";
/** Kinds of release-index entries. C174: `cli` = the tealbrick CLI tarball the C173 installer and `tealbrick self-update` verify.
 *  Readers skip kinds they do not know (L24); Core indexes app/bridge/desktop only. */
export const INDEX_KINDS = ["app", "bridge", "desktop", "cli", "package"] as const;
export type IndexKind = (typeof INDEX_KINDS)[number];
/** A downloadable release file. `sha256` is `sha256:<hex>`; `integrity` (C174, required for kind cli) is the npm/pnpm lockfile
 *  value `sha512-<base64>` of the same bytes (the `.integrity` asset, ci-v9.5). */
export interface ReleaseArtifact {
  url: string;
  sha256: string;
  integrity?: string;
}
export interface IndexRelease {
  id: string; // rel_<ULID>
  product: string;
  kind: IndexKind;
  version: string;
  channel: Channel;
  manifestDigest: string | null;
  manifestUrl: string | null;
  skillsDigest: string | null;
  image: string | null; // ghcr.io/martin-atrin/<name>@sha256:<hex>
  artifact: ReleaseArtifact | null; // desktop, cli (C174)
  source: { repo: string; ref: string; dockerfile: string; context?: string } | null; // C29 interim: dev-channel source build; dockerfile repo-relative, context repo-relative build root (absent = ".")
  runtime: BridgeRuntime | null; // kind bridge only (the bridge has no app manifest); apps take runtime from their manifest
  services?: { id: string; image: string }[] | null; // app image releases: one published image per manifest service with `build` (BSA-01)
  minOs: string | null; // desktop
  notarized: boolean | null; // desktop
  upgradeFrom: string;
  repo: string;
  commit: string | null;
  tag: string | null;
  publishedAt: string;
  devOnly?: true; // C113: DEV_ONLY_PRODUCTS (always channel dev); Core never offers or deploys it in a stable workspace
  promotedFrom?: string; // C207 E4: a stable record made by a recorded promotion of this dev record (same image + manifest digest)
}

/** Deploy recipe facts for the bridge service (apps carry these in their manifest `runtime`). */
export interface BridgeRuntime {
  port: number; // public (MCP, launch, key page)
  internalPort: number; // private network only (apps, companions)
  healthPath: string; // liveness
  readyPath: string; // ready after enrolment
  volumes: { mountPath: string; backup: boolean }[]; // backup = Railway volume backups on (C28, S7)
  env: { name: string; source: "portal" | "provider-secret" | "public-url" | "public-url-keys" | "fixed"; value?: string }[];
}

export function validateBridgeRuntime(raw: unknown): BridgeRuntime {
  const r = raw as Record<string, unknown>;
  const port = (v: unknown) => Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536;
  const path = (v: unknown) => typeof v === "string" && v.startsWith("/");
  if (!r || !port(r.port) || !port(r.internalPort) || r.port === r.internalPort) throw new Error("runtime: port and internalPort must be distinct ports");
  if (!path(r.healthPath) || !path(r.readyPath)) throw new Error("runtime: healthPath and readyPath must be absolute paths");
  if (
    !Array.isArray(r.volumes) ||
    !r.volumes.every((v) => path((v as Record<string, unknown>).mountPath) && typeof (v as Record<string, unknown>).backup === "boolean")
  )
    throw new Error("runtime: volumes [{mountPath, backup}]");
  if (!Array.isArray(r.env)) throw new Error("runtime: env list required");
  for (const e of r.env as Record<string, unknown>[]) {
    if (typeof e.name !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/.test(e.name)) throw new Error(`runtime: bad env name ${String(e.name)}`);
    if (!["portal", "provider-secret", "public-url", "public-url-keys", "fixed"].includes(e.source as string)) throw new Error(`runtime: env ${e.name} source`);
    if (e.source === "fixed" ? typeof e.value !== "string" : e.value !== undefined) throw new Error(`runtime: env ${e.name}: value only for source fixed`);
  }
  return r as unknown as BridgeRuntime;
}

export interface Offer {
  id: string; // off_<ULID>
  kind: "single" | "bundle";
  name: string;
  products: string[];
  major: number;
  amount: number; // minor units
  currency: string;
  taxNote: string;
  stripePrice: { test: string | null; live: string | null };
}

/** C40/C40a: harness options as data, exactly the frozen PORTAL-API `HarnessOption` (types/routes.ts). Core syncs them. */
export interface Harness {
  id: string;
  kind: "desktop" | "agentic_system" | "other";
  label: string;
  /** Asset URL served from the release of the harness, or null. */
  icon: string | null;
  authorise: "device_approval" | "instruction_set" | "url";
  /** true = the "I do not have an agent" path (download the desktop app). */
  noAgentPath: boolean;
  /** C43: InstructionSet-shaped step template. Placeholders: {{mcpUrl}}, {{agentId}} (Core), {{pairingCode}} (GUI). */
  instructions: HarnessStep[];
}
export interface HarnessStep {
  title: string;
  detail: string;
  copy?: { kind: "command" | "json" | "url" | "text"; value: string };
}

export interface ReleaseIndex {
  schema: typeof INDEX_SCHEMA;
  generatedAt: string;
  releases: IndexRelease[];
  offers: Offer[];
  harnesses: Harness[];
}

/** Claims of the signed envelope (the JWS stays far below MAX_JWS_BYTES; the body is index.json). */
export interface IndexEnvelopeClaims {
  iss: typeof INDEX_ISS;
  aud: typeof INDEX_AUD;
  iat: number;
  exp: number;
  schema: typeof INDEX_SCHEMA;
  indexDigest: string; // manifest-package digest(index body)
  releases: number;
  offers: number;
}

/** The subset of @opt2-tealbrick/manifest the registry uses (SDK-API §2). */
export interface ManifestPkg {
  digest(value: unknown): string;
  manifestDigest(manifest: unknown): string;
  validateManifest(json: unknown): { ok: true; manifest: unknown } | { ok: false; errors: unknown[] };
  thumbprint(jwk: JsonWebKey): string;
  signReleaseIndex(
    body: ReleaseIndex,
    input: { iat: number; exp?: number },
    key: { publicJwk: JsonWebKey; privateKey: CryptoKey; kid: string },
  ): Promise<string>;
  verifyReleaseIndex(
    token: string,
    body: ReleaseIndex,
    ctx: { now: number; keys: unknown },
  ): { ok: true; claims: IndexEnvelopeClaims } | { ok: false; reason?: string };
  keySetFrom(jwks: { keys: JsonWebKey[] }, issuer: string): unknown;
}

const REQUIRED_SCRIPTS = ["typecheck", "lint", "test"] as const;

/** `ci-vN` -> N, `ci-vN.M` -> N (the major); anything else -> NaN. */
export function templateNumber(ref: string): number {
  return templateVersion(ref)?.[0] ?? Number.NaN;
}

/** `ci-vN` -> [N, 0], `ci-vN.M` -> [N, M] (ci-v9.1: point releases of a template); anything else -> null. */
export function templateVersion(ref: string): [number, number] | null {
  const m = /^ci-v(\d+)(?:\.(\d+))?$/.exec(ref.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
}

/** D1/C56: a template ref below the minimum (or unparseable) is refused. */
export function belowMinimum(ref: string, min: string): boolean {
  const a = templateVersion(ref);
  const b = templateVersion(min);
  if (!b) throw new Error(`bad minimum template ref ${min}`);
  return !a || a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

/** ci-v9.15: template tags that are broken and must never be (re)adopted, whatever MIN_TEMPLATE says. Tags are never moved, so a
 *  broken tag stays and is refused here. ci-v9.14: the osv-scan printf line is not a YAML string (Woodpecker compiler error). */
export const DENIED_TEMPLATES: Readonly<Record<string, string>> = {
  "ci-v9.14": "does not parse in Woodpecker (osv-scan printf line is a YAML map); adopt ci-v9.15 or later",
};

function fail(msg: string): never {
  console.error(`tb-ci: FAIL: ${msg}`);
  process.exit(1);
}

function log(msg: string): void {
  console.log(`tb-ci: ${msg}`);
}

// ---------- pure helpers (unit tested) ----------

export function channelForVersion(version: string): Channel {
  return version.includes("-") ? "dev" : "stable";
}

/** ci-v9.4: products the signer indexes ONLY on channel "dev" (test fixtures; never offered to stable workspaces).
 *  The one list: releaseChannel() and mergeIndex() both read it. */
/** C208 made fleet dev-only; C278 (Martin, 2026-10-19) makes Governance (fleet) a stable app again (its repo is public, C249), so
 *  it leaves this list. Its dev records indexed meanwhile keep their devOnly flag (signed records are never rewritten,
 *  PROMOTE-STABLE §5); promotion reads THIS list, not the record flag (promotionReleases). */
export const DEV_ONLY_PRODUCTS: readonly string[] = ["sample-gate", "sample-caller", "sample-pay", "sample-mismatch"];

export function isDevOnlyProduct(product: string): boolean {
  return DEV_ONLY_PRODUCTS.includes(product);
}

/** C113: every release of a DEV_ONLY product carries devOnly: true and channel dev. A stable record a pre-ci-v9.4
 *  signer published is RE-CLASSIFIED to dev (same id, digests, image; nothing deleted). If that leaves two records with
 *  the same (product, version, dev) and identical content, the earlier one (the original) is kept and the later copy is
 *  folded into it; different content for the same key is refused. Other products are returned unchanged. Idempotent. */
export function normalizeDevOnly(releases: IndexRelease[]): { releases: IndexRelease[]; notes: string[] } {
  const notes: string[] = [];
  const marked = releases.map((r) => {
    if (!isDevOnlyProduct(r.product)) return r;
    if (r.channel === "stable") notes.push(`${r.product}@${r.version} ${r.id} re-classified stable -> dev`);
    else if (r.devOnly !== true) notes.push(`${r.product}@${r.version} ${r.id} marked devOnly`);
    return { ...r, channel: "dev" as Channel, devOnly: true as const };
  });
  const same = (a: IndexRelease, b: IndexRelease) =>
    a.image === b.image &&
    a.manifestDigest === b.manifestDigest &&
    a.skillsDigest === b.skillsDigest &&
    a.commit === b.commit &&
    a.source?.ref === b.source?.ref &&
    JSON.stringify(a.services ?? null) === JSON.stringify(b.services ?? null);
  const kept = new Map<string, IndexRelease>();
  const out: IndexRelease[] = [];
  for (const r of [...marked].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))) {
    if (r.devOnly !== true) {
      out.push(r);
      continue;
    }
    const key = `${r.product}@${r.version}@${r.channel}`;
    const first = kept.get(key);
    if (!first) {
      kept.set(key, r);
      out.push(r);
    } else if (same(first, r)) notes.push(`${r.product}@${r.version} ${r.id} folded into ${first.id} (identical record)`);
    else throw new Error(`${r.product}@${r.version}: two dev records with different content (releases are immutable)`);
  }
  const keep = new Set(out);
  return { releases: marked.filter((r) => keep.has(r)), notes }; // original order
}

// ---------- C207 E1: release guard; C207 E4: recorded promotions ----------

/** C207 E1: from this date a tag commit must also come from a merged PR (before it: a warning). */
export const PR_REQUIRED_FROM = "2026-10-25T00:00:00Z";
/** Woodpecker contexts that prove a green pipeline on the commit (push on main/hotfix, or the tag pipeline). */
export const GREEN_CONTEXTS: readonly string[] = ["ci/woodpecker/push/ci", "ci/woodpecker/tag/ci"];

export interface GuardResult {
  problem: string | null;
  warnings: string[];
}

/** C207 E1 release guard (ENFORCEMENT E1): a tag is indexed only if (1) its commit is on `main` or a `hotfix/*` branch head's
 *  history, (2) the commit has a green Woodpecker push or tag status, (3) from PR_REQUIRED_FROM: the commit came from a merged
 *  PR into main or hotfix/* (before: a warning). `api` reads the repo (read token for private repos: Contents, Metadata,
 *  Commit statuses and Pull requests read). Pure apart from `api`. */
export async function releaseGuard(
  api: (path: string) => Promise<{ status: number; json: any }>,
  fullRepo: string,
  sha: string,
  now: number = Date.now(),
): Promise<GuardResult> {
  const warnings: string[] = [];
  const onBranch = async (branch: string): Promise<boolean> => {
    const c = await api(`/repos/${fullRepo}/compare/${encodeURIComponent(branch)}...${sha}`);
    // base...head: head (the tag commit) is in base's history when it is "behind" or "identical"
    return c.status === 200 && (c.json?.status === "behind" || c.json?.status === "identical");
  };
  let branchOk = await onBranch("main");
  let branchName = "main";
  if (!branchOk) {
    const br = await api(`/repos/${fullRepo}/branches?per_page=100`);
    const hotfix = br.status === 200 && Array.isArray(br.json) ? (br.json as { name: string }[]).map((b) => b.name).filter((n) => n.startsWith("hotfix/")) : [];
    for (const h of hotfix) {
      if (await onBranch(h)) {
        branchOk = true;
        branchName = h;
        break;
      }
    }
  }
  if (!branchOk) return { problem: `commit ${sha.slice(0, 8)} is not on main or a hotfix/* branch (E1)`, warnings };
  const st = await api(`/repos/${fullRepo}/commits/${sha}/status`);
  if (st.status !== 200)
    return { problem: `commit status of ${sha.slice(0, 8)} not readable: HTTP ${st.status} (read token needs Commit statuses: read)`, warnings };
  const statuses = ((st.json?.statuses ?? []) as { context: string; state: string }[]).filter((x) => GREEN_CONTEXTS.includes(x.context));
  // the API lists the newest status first per context
  const latest = new Map<string, string>();
  for (const x of statuses) if (!latest.has(x.context)) latest.set(x.context, x.state);
  if (![...latest.values()].includes("success")) return { problem: `commit ${sha.slice(0, 8)} has no green Woodpecker push/tag pipeline (E1)`, warnings };
  const pr = await api(`/repos/${fullRepo}/commits/${sha}/pulls`);
  const merged =
    pr.status === 200 &&
    Array.isArray(pr.json) &&
    (pr.json as { merged_at: string | null; base?: { ref?: string } }[]).some(
      (p) => p.merged_at && (p.base?.ref === "main" || p.base?.ref?.startsWith("hotfix/")),
    );
  if (!merged) {
    const msg = `commit ${sha.slice(0, 8)} (${branchName}) has no merged PR${pr.status === 200 ? "" : ` (HTTP ${pr.status}: read token needs Pull requests: read)`}`;
    if (now >= Date.parse(PR_REQUIRED_FROM)) return { problem: `${msg} (E1, required since ${PR_REQUIRED_FROM.slice(0, 10)})`, warnings };
    warnings.push(`${msg}; required from ${PR_REQUIRED_FROM.slice(0, 10)} (E1)`);
  }
  return { problem: null, warnings };
}

export interface IgnoredTag {
  repo: string; // opt2-tealbrick-<name>
  tag: string;
  reason: string;
  decision: string; // C<nnn>
}
export function validateIgnoredTags(raw: unknown): IgnoredTag[] {
  if (!Array.isArray(raw)) throw new Error("ignored-tags.json must be an array");
  return raw.map((x, i) => {
    const t = x as Record<string, unknown>;
    if (!t || typeof t !== "object" || Object.keys(t).sort().join(",") !== "decision,reason,repo,tag")
      throw new Error(`ignored-tags[${i}]: fields must be repo, tag, reason, decision`);
    if (typeof t.repo !== "string" || !/^opt2-tealbrick-[a-z0-9-]+$/.test(t.repo)) throw new Error(`ignored-tags[${i}].repo`);
    if (typeof t.tag !== "string" || !t.tag) throw new Error(`ignored-tags[${i}].tag`);
    if (typeof t.reason !== "string" || t.reason.length < 10) throw new Error(`ignored-tags[${i}].reason (say why)`);
    if (typeof t.decision !== "string" || !/^C\d{2,4}[a-z]?$/.test(t.decision)) throw new Error(`ignored-tags[${i}].decision must be a decision id (C<nnn>)`);
    return t as unknown as IgnoredTag;
  });
}

/** C207 E4: one recorded promotion dev → stable (registry/promotions.json, PR only). */
export interface Promotion {
  product: string;
  version: string;
  devReleaseId: string;
  promotedAt: string;
  by: string;
  decision: string;
  evidence: {
    soakStart: string; // qa1 roll time (the dev release running on qa1)
    soakEnd: string;
    workspace: string; // qa1 (or another QA workspace on the dev channel)
    qaRun: string; // regression run reference (qa report path or pipeline URL)
    platform: { core: string; bridge: string }; // Core SHA + bridge version the soak ran against
    upgradeTest?: string; // E14 Layer B result (release asset URL) once it exists
  };
  expedited?: true;
  incident?: string;
}
/** Minimum soak on qa1 before a promotion (M9; bridge M11: 48 h). */
export const SOAK_HOURS: Readonly<Record<"app" | "bridge", number>> = { app: 24, bridge: 48 };

export function validatePromotions(raw: unknown): Promotion[] {
  if (!Array.isArray(raw)) throw new Error("promotions.json must be an array");
  const iso = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v)) && /T.*Z$/.test(v);
  const seen = new Set<string>();
  return raw.map((x, i) => {
    const p = x as Record<string, unknown>;
    const bad = (m: string): never => {
      throw new Error(`promotions[${i}]: ${m}`);
    };
    if (!p || typeof p !== "object") bad("must be an object");
    const allowed = ["product", "version", "devReleaseId", "promotedAt", "by", "decision", "evidence", "expedited", "incident"];
    const extra = Object.keys(p).filter((k) => !allowed.includes(k));
    if (extra.length) bad(`unknown field(s) ${extra.join(", ")}`);
    if (typeof p.product !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(p.product)) bad("product");
    if (typeof p.version !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(p.version)) bad("version");
    if (/-/.test(p.version as string)) bad("a pre-release version is never promoted to stable");
    if (typeof p.devReleaseId !== "string" || !/^rel_[0-9A-HJKMNP-TV-Z]{26}$/.test(p.devReleaseId)) bad("devReleaseId (rel_<ULID> of the dev record)");
    if (!iso(p.promotedAt)) bad("promotedAt (ISO UTC)");
    if (typeof p.by !== "string" || !p.by) bad("by");
    if (typeof p.decision !== "string" || !/^C\d{2,4}[a-z]?$/.test(p.decision)) bad("decision (C<nnn>)");
    const e = p.evidence as Record<string, unknown> | undefined;
    if (!e || typeof e !== "object") bad("evidence");
    const ev = e as Record<string, unknown>;
    for (const k of ["soakStart", "soakEnd"]) if (!iso(ev[k])) bad(`evidence.${k} (ISO UTC)`);
    if (Date.parse(ev.soakEnd as string) <= Date.parse(ev.soakStart as string)) bad("evidence.soakEnd must be after soakStart");
    if (typeof ev.workspace !== "string" || !ev.workspace) bad("evidence.workspace (qa1)");
    if (typeof ev.qaRun !== "string" || ev.qaRun.length < 5) bad("evidence.qaRun (regression run reference)");
    const pl = ev.platform as Record<string, unknown> | undefined;
    if (!pl || typeof pl.core !== "string" || !/^[0-9a-f]{7,40}$/.test(pl.core) || typeof pl.bridge !== "string" || !/^\d+\.\d+\.\d+/.test(pl.bridge))
      bad("evidence.platform {core: <sha>, bridge: <version>}");
    if (ev.upgradeTest !== undefined && (typeof ev.upgradeTest !== "string" || !/^https:\/\//.test(ev.upgradeTest))) bad("evidence.upgradeTest (https URL)");
    const extraEv = Object.keys(ev).filter((k) => !["soakStart", "soakEnd", "workspace", "qaRun", "platform", "upgradeTest"].includes(k));
    if (extraEv.length) bad(`unknown evidence field(s) ${extraEv.join(", ")}`);
    if (p.expedited !== undefined && p.expedited !== true) bad("expedited must be true or absent");
    if (p.expedited === true && (typeof p.incident !== "string" || !/^INC-/.test(p.incident))) bad("an expedited promotion needs incident INC-…");
    if (p.incident !== undefined && p.expedited !== true) bad("incident only with expedited");
    const key = `${p.product}@${p.version}`;
    if (seen.has(key)) bad(`${key} is promoted twice`);
    seen.add(key);
    return p as unknown as Promotion;
  });
}

/** C207 E4: the stable records the recorded promotions add to `index` (pure). A promotion that is already applied (a stable
 *  record with promotedFrom = devReleaseId) is skipped. Problems (missing dev record, too short a soak, a stable record of
 *  that version already present, …) are returned and nothing is added for that promotion. */
export function promotionReleases(
  index: { releases: IndexRelease[] },
  promotions: Promotion[],
  opts: { now: string; newId?: () => string },
): { add: IndexRelease[]; problems: string[] } {
  const add: IndexRelease[] = [];
  const problems: string[] = [];
  for (const p of promotions) {
    const where = `promotion ${p.product}@${p.version}`;
    if (index.releases.some((r) => r.promotedFrom === p.devReleaseId)) continue; // applied
    const dev = index.releases.find((r) => r.id === p.devReleaseId);
    if (!dev) {
      problems.push(`${where}: dev record ${p.devReleaseId} is not in the index`);
      continue;
    }
    if (dev.product !== p.product || dev.version !== p.version) {
      problems.push(`${where}: ${p.devReleaseId} is ${dev.product}@${dev.version}`);
      continue;
    }
    if (dev.kind !== "app" && dev.kind !== "bridge") {
      problems.push(`${where}: only app and bridge releases are promoted (got ${dev.kind})`);
      continue;
    }
    if (dev.channel !== "dev" || !dev.image) {
      problems.push(`${where}: ${p.devReleaseId} must be a dev record with an image`);
      continue;
    }
    // C278: the CURRENT product list decides, not the record flag: a product that left DEV_ONLY_PRODUCTS keeps devOnly on its
    // older signed dev records (never rewritten), and the stable copy below drops the flag
    if (isDevOnlyProduct(dev.product)) {
      problems.push(`${where}: ${dev.product} is dev-only (C113)`);
      continue;
    }
    if (index.releases.some((r) => r.product === p.product && r.version === p.version && r.channel === "stable")) {
      problems.push(`${where}: a stable ${p.product}@${p.version} record already exists`);
      continue;
    }
    const hours = (Date.parse(p.evidence.soakEnd) - Date.parse(p.evidence.soakStart)) / 3_600_000;
    const need = SOAK_HOURS[dev.kind];
    if (hours < need && p.expedited !== true) {
      problems.push(`${where}: soak ${hours.toFixed(1)} h < ${need} h on ${p.evidence.workspace} (expedited needs an incident)`);
      continue;
    }
    if (Date.parse(p.evidence.soakStart) < Date.parse(dev.publishedAt)) {
      problems.push(`${where}: soak started before the dev release was published (${dev.publishedAt})`);
      continue;
    }
    const { devOnly: _d, ...rest } = dev;
    add.push({ ...rest, id: (opts.newId ?? (() => newId("rel")))(), channel: "stable", promotedFrom: dev.id, publishedAt: opts.now });
  }
  return { add, problems };
}

/** C206 R2-1: one legacy-owner location in a signed record moved to OWNER (same repo name; GitHub transfer). */
export interface OwnerRewrite {
  id: string;
  product: string;
  version: string;
  field: "manifestUrl" | "source.repo" | "artifact.url";
  from: string;
  to: string;
}

const LEGACY_OWNER_ALT = LEGACY_OWNERS.join("|");
/** C206 R2-1: signed records published before the org move point manifestUrl (raw), source.repo and desktop artifact.url at
 *  the legacy owner, which resolve only through GitHub's transfer redirect. They are rewritten to OWNER (same repo, same
 *  commit/tag, so the bytes are the same; publishIndex verifies every rewritten location against the record's digests before
 *  it signs). `repo` (provenance, GTP-01 formerRepos) and image refs (packages never moved) are NOT touched. Idempotent. */
export function normalizeLegacyOwners(releases: IndexRelease[]): { releases: IndexRelease[]; rewrites: OwnerRewrite[] } {
  const rewrites: OwnerRewrite[] = [];
  const rawRe = new RegExp(`^https://raw\\.githubusercontent\\.com/(?:${LEGACY_OWNER_ALT})/(opt2-tealbrick-[a-z0-9-]+)/`);
  const relRe = new RegExp(`^https://github\\.com/(?:${LEGACY_OWNER_ALT})/(opt2-tealbrick-[a-z0-9-]+)/releases/download/`);
  const repoRe = new RegExp(`^(?:${LEGACY_OWNER_ALT})/(opt2-tealbrick-[a-z0-9-]+)$`);
  const out = releases.map((r) => {
    let next = r;
    const note = (field: OwnerRewrite["field"], from: string, to: string) =>
      rewrites.push({ id: r.id, product: r.product, version: r.version, field, from, to });
    if (typeof r.manifestUrl === "string" && rawRe.test(r.manifestUrl)) {
      const to = r.manifestUrl.replace(rawRe, (_m, repo: string) => `https://raw.githubusercontent.com/${OWNER}/${repo}/`);
      note("manifestUrl", r.manifestUrl, to);
      next = { ...next, manifestUrl: to };
    }
    if (r.source && typeof r.source.repo === "string" && repoRe.test(r.source.repo)) {
      const to = r.source.repo.replace(repoRe, (_m, repo: string) => `${OWNER}/${repo}`);
      note("source.repo", r.source.repo, to);
      next = { ...next, source: { ...r.source, repo: to } };
    }
    if (r.kind === "desktop" && r.artifact && typeof r.artifact.url === "string" && relRe.test(r.artifact.url)) {
      const to = r.artifact.url.replace(relRe, (_m, repo: string) => `https://github.com/${OWNER}/${repo}/releases/download/`);
      note("artifact.url", r.artifact.url, to);
      next = { ...next, artifact: { ...r.artifact, url: to } };
    }
    return next;
  });
  return { releases: out, rewrites };
}

/** C206 R2-1: before signing, every rewritten location must serve what the signed record pins: the manifest at the new raw
 *  URL has the record's manifestDigest (private repos read with the read token), the source commit exists in the org repo,
 *  a desktop artifact has the record's sha256. Returns the problems (empty = all verified). */
export async function verifyOwnerRewrites(
  m: Pick<ManifestPkg, "manifestDigest">,
  releases: IndexRelease[],
  rewrites: OwnerRewrite[],
  reader: (repo: string) => RepoReader = (repo) => repoReader(repo),
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  const problems: string[] = [];
  const byId = new Map(releases.map((r) => [r.id, r]));
  for (const w of rewrites) {
    const r = byId.get(w.id);
    const where = `${w.product}@${w.version} ${w.field}`;
    try {
      if (!r) throw new Error("record not found");
      if (w.field === "manifestUrl") {
        const mm = /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/(opt2-tealbrick-[a-z0-9-]+)\/([^/]+)\/(.+)$/.exec(w.to);
        if (!mm) throw new Error(`unexpected URL ${w.to}`);
        const f = await reader(mm[1] as string).file(mm[3] as string, mm[2] as string);
        if (f.text === null) throw new Error(`HTTP ${f.status} at ${w.to}`);
        const d = m.manifestDigest(JSON.parse(f.text));
        if (d !== r.manifestDigest) throw new Error(`digest ${d} != signed ${r.manifestDigest}`);
      } else if (w.field === "source.repo") {
        const ref = r.source?.ref;
        const res = await reader(w.to.split("/")[1] as string).api(`/repos/${w.to}/commits/${ref}`);
        if (res.status !== 200 || res.json?.sha !== ref) throw new Error(`commit ${ref} not readable in ${w.to} (HTTP ${res.status})`);
      } else {
        const res = await fetcher(w.to, { redirect: "follow" });
        if (!res.ok) throw new Error(`HTTP ${res.status} at ${w.to}`);
        const got = `sha256:${createHash("sha256")
          .update(Buffer.from(await res.arrayBuffer()))
          .digest("hex")}`;
        if (got !== r.artifact?.sha256) throw new Error(`sha256 ${got} != signed ${r.artifact?.sha256}`);
      }
    } catch (e) {
      problems.push(`${where}: ${(e as Error).message}`);
    }
  }
  return problems;
}

/** C207 E4: the channel a NEW tag of `kind` is indexed on. App and bridge tags always land on `dev`; `stable` comes only from a
 *  recorded promotion (registry/promotions.json). Other kinds keep releaseChannel (cli/package by version; desktop by hand). */
export function tagChannel(product: string, version: string, kind: IndexKind): Channel {
  if (kind === "app" || kind === "bridge") return "dev";
  return releaseChannel(product, version);
}

/** The channel the signer indexes a release on: a dev-only product is always "dev", whatever its version says. */
export function releaseChannel(product: string, version: string): Channel {
  return isDevOnlyProduct(product) ? "dev" : channelForVersion(version);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** `<prefix>_<ULID>` (CORE §1). */
export function newId(prefix: string, now = Date.now(), rand: Uint8Array = randomBytes(10)): string {
  let t = "";
  let ms = now;
  for (let i = 0; i < 10; i++) {
    t = CROCKFORD[ms % 32] + t;
    ms = Math.floor(ms / 32);
  }
  let bits = 0n;
  for (const b of rand) bits = (bits << 8n) | BigInt(b);
  let r = "";
  for (let i = 0; i < 16; i++) {
    r = CROCKFORD[Number(bits & 31n)] + r;
    bits >>= 5n;
  }
  return `${prefix}_${t}${r}`;
}

export function versionFromTag(tag: string): string {
  const m = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
  if (!m) throw new Error(`tag ${JSON.stringify(tag)} is not v<semver> without build metadata`);
  return m[1];
}

export function validateConfig(raw: unknown, repoName: string): CiConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("tealbrick-ci.json must be an object");
  const o = raw as Record<string, unknown>;
  const allowed = new Set([
    "$schema",
    "kind",
    "paths",
    "conformance",
    "images",
    "postgres",
    "distBaseUrl",
    "preReleaseChecks",
    "packScripts",
    "releaseOn",
    "osvIgnore",
  ]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new Error(`unknown field ${k}`);
  if (!KINDS.includes(o.kind as Kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  const kind = o.kind as Kind;
  const paths = o.paths === undefined ? ["."] : o.paths;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string" && safeRel(p)))
    throw new Error("paths must be a non-empty list of relative paths");
  const conformance = o.conformance === undefined ? kind === "miniapp" || kind === "bridge" : o.conformance;
  if (typeof conformance !== "boolean") throw new Error("conformance must be boolean");
  const postgres = o.postgres === undefined ? false : o.postgres;
  if (typeof postgres !== "boolean") throw new Error("postgres must be boolean");
  const distBaseUrl = o.distBaseUrl === undefined ? null : normalizeDistBase(o.distBaseUrl, "distBaseUrl");
  const preReleaseChecks = parsePreReleaseChecks(o.preReleaseChecks);
  const packScripts = parsePackScripts(o.packScripts);
  const osvIgnore = parseOsvIgnore(o.osvIgnore);
  const releaseOn = o.releaseOn === undefined ? "actions" : o.releaseOn;
  if (releaseOn !== "actions" && releaseOn !== "woodpecker") throw new Error('releaseOn must be "actions" or "woodpecker"');
  const imagesRaw = o.images === undefined ? [] : o.images;
  if (!Array.isArray(imagesRaw)) throw new Error("images must be a list");
  const names = new Set<string>();
  const images = imagesRaw.map((im, i): ImageSpec => {
    if (typeof im !== "object" || im === null) throw new Error(`images[${i}] must be an object`);
    const r = im as Record<string, unknown>;
    const name = r.name;
    if (typeof name !== "string" || !(name === repoName || name.startsWith(`${repoName}-`)) || !/^[a-z0-9][a-z0-9-]*$/.test(name))
      throw new Error(`images[${i}].name must be ${repoName} or ${repoName}-<component> (lowercase)`);
    if (names.has(name)) throw new Error(`duplicate image ${name}`);
    names.add(name);
    const context = r.context ?? ".";
    const dockerfile = r.dockerfile ?? "Dockerfile";
    if (typeof context !== "string" || !safeRel(context)) throw new Error(`images[${i}].context must be a relative path`);
    if (typeof dockerfile !== "string" || !safeRel(dockerfile)) throw new Error(`images[${i}].dockerfile must be a relative path`);
    const product = r.product;
    if (typeof product !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(product)) throw new Error(`images[${i}].product required (lowercase id)`);
    const kind = r.kind;
    if (!["app", "bridge", "portal", "service"].includes(kind as string)) throw new Error(`images[${i}].kind must be app|bridge|portal|service`);
    const service = r.service;
    if (kind === "service" && (typeof service !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(service)))
      throw new Error(`images[${i}]: a service image needs service (the manifest runtime.services[].id)`);
    if (kind !== "service" && service !== undefined) throw new Error(`images[${i}].service is only allowed for kind service`);
    const manifest = r.manifest;
    if (manifest !== undefined && (typeof manifest !== "string" || !safeRel(manifest))) throw new Error(`images[${i}].manifest must be a relative path`);
    if (kind === "app" && manifest === undefined) throw new Error(`images[${i}]: an app image needs manifest (${MANIFEST_FILE})`);
    const upgradeFrom = r.upgradeFrom ?? "*";
    if (typeof upgradeFrom !== "string" || upgradeFrom.length === 0) throw new Error(`images[${i}].upgradeFrom must be a semver range`);
    return {
      name,
      context,
      dockerfile,
      product,
      kind: kind as ImageKind,
      upgradeFrom,
      ...(manifest ? { manifest } : {}),
      ...(kind === "service" ? { service: service as string } : {}),
    };
  });
  for (const im of images.filter((x) => x.kind === "service")) {
    if (!images.some((a) => a.kind === "app" && a.product === im.product))
      throw new Error(`service image ${im.name}: no app image with product ${im.product} (its parent)`);
    if (images.filter((x) => x.kind === "service" && x.product === im.product && x.service === im.service).length > 1)
      throw new Error(`service ${im.product}/${im.service} declared twice`);
  }
  // ci-v9.11 (C232): images are allowed with releaseOn "woodpecker" (kaniko --no-push + crane push, secret tb_ghcr_token)
  return { kind, paths, conformance, images, postgres, distBaseUrl, preReleaseChecks, packScripts, releaseOn, osvIgnore };
}

function safeRel(p: string): boolean {
  return p.length > 0 && !p.startsWith("/") && !p.split("/").includes("..");
}

/** ci-v9.6: a dist base must be one of DIST_BASES (exact, trailing slash dropped). Returns the normalised base. */
export function normalizeDistBase(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Error(`${what} must be a string`);
  const base = v.replace(/\/+$/, "");
  if (!DIST_BASES.includes(base)) throw new Error(`${what} must be one of the platform dist hosts (${DIST_BASES.join(", ")}), got ${JSON.stringify(v)}`);
  return base;
}

/** ci-v9.6: the dist base in force for a repo: env TB_DIST_BASE_URL wins over tealbrick-ci.json `distBaseUrl`; null = GitHub releases (unchanged). */
export function resolveDistBase(cfg: { distBaseUrl: string | null }, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.TB_DIST_BASE_URL;
  if (fromEnv !== undefined && fromEnv !== "") return normalizeDistBase(fromEnv, "TB_DIST_BASE_URL");
  return cfg.distBaseUrl;
}

/** ci-v9.6: the one path segment of a release on a dist host: `<repo>-<release tag>` (e.g. opt2-tealbrick-cli-relay-v0.1.0). */
export function distTag(repo: string, releaseTag: string): string {
  return `${repo}-${releaseTag}`;
}

const DIST_TAIL_RE = /^opt2-tealbrick-[a-z0-9-]+-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\/[a-z0-9-]+-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/;

/** ci-v9.6: a package tarball on one of the platform dist hosts (`<base>/<repo>-<dir>-v<ver>/<scope-name>-<ver>.tgz`). */
export function isDistTarballUrl(v: string): boolean {
  return DIST_BASES.some((b) => v.startsWith(`${b}/`) && DIST_TAIL_RE.test(v.slice(b.length + 1)));
}

/** The only accepted forms of an @opt2-tealbrick/* dependency URL: a GitHub release tarball of an opt2 repo, or a tarball on a dist host. */
export function isReleaseTarballUrl(v: string): boolean {
  return RELEASE_URL_RE.test(v) || isDistTarballUrl(v);
}

/** ci-v9.6: where a desktop artifact URL comes from. GitHub release URL: repo and tag are in the path (as before). Dist URL:
 *  `<base>/<repo>-<tag>/<file>`; the caller names the repo, and the segment must start with it. */
export function artifactSource(url: string, repoArg?: string): { repo: string; tag: string } {
  // the dist base on GitHub is itself a github.com release URL, so the dist hosts are matched FIRST
  const base = DIST_BASES.find((b) => url.startsWith(`${b}/`));
  if (base) {
    if (!repoArg || !/^opt2-tealbrick-[a-z0-9-]+$/.test(repoArg)) throw new Error("--repo opt2-tealbrick-<name> is required with a dist host URL");
    const m = /^([^/]+)\/[^/]+$/.exec(url.slice(base.length + 1));
    if (!m || !(m[1] as string).startsWith(`${repoArg}-`)) throw new Error(`a dist URL must look like ${base}/${repoArg}-<release tag>/<file>`);
    return { repo: repoArg, tag: (m[1] as string).slice(repoArg.length + 1) };
  }
  const gh = new RegExp(`^https://github\\.com/(?:${OWNERS_RE})/(opt2-tealbrick-[a-z0-9-]+)/releases/download/([^/]+)/[^/]+$`).exec(url); // C206: old owner URLs redirect
  if (gh) return { repo: gh[1] as string, tag: gh[2] as string };
  throw new Error("--url must be a GitHub release asset URL of an opt2 repo or a file on a platform dist host");
}

/** ci-v9.6: `preReleaseChecks` in tealbrick-ci.json: repo-relative TypeScript files (run as `node <file>` from the repo root). */
export function parsePreReleaseChecks(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw new Error("preReleaseChecks must be a list of at most 20 script paths");
  const seen = new Set<string>();
  for (const [i, p] of raw.entries()) {
    if (typeof p !== "string" || !safeRel(p) || !/^[A-Za-z0-9._/-]+\.ts$/.test(p))
      throw new Error(`preReleaseChecks[${i}] must be a repo-relative .ts file path (TypeScript only), got ${JSON.stringify(p)}`);
    if (seen.has(p)) throw new Error(`preReleaseChecks lists ${p} twice`);
    seen.add(p);
  }
  return [...seen];
}

/** ci-v9.7 (C173/C175): `packScripts` in tealbrick-ci.json: `{ "<package dir>": "<repo-relative .ts>" }`. On a `<dir>-v<ver>` tag the
 *  release Action runs `node <script> --out <empty dir>` (repo root, after install + build + preReleaseChecks, no tokens) INSTEAD of
 *  the template's `npm pack`; the script must write exactly `<scope-name>-<ver>.tgz` of the tagged package there. The template then
 *  applies the same guards as to its own pack (name/version, pack guard) and computes .sha256/.integrity itself in the publish job. */
export function parsePackScripts(raw: unknown): Record<string, string> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error('packScripts must be an object { "<package dir>": "<script>.ts" }');
  const out: Record<string, string> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 20) throw new Error("packScripts: at most 20 entries");
  for (const [dir, p] of entries) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(dir))
      throw new Error(`packScripts: ${JSON.stringify(dir)} is not a package directory name (the <dir> of a <dir>-v<semver> tag)`);
    if (typeof p !== "string" || !safeRel(p) || !/^[A-Za-z0-9._/-]+\.ts$/.test(p))
      throw new Error(`packScripts.${dir} must be a repo-relative .ts file path (TypeScript only), got ${JSON.stringify(p)}`);
    out[dir] = p;
  }
  return out;
}

/** ci-v9.7: what is wrong with a pack script's output directory (`files` = name -> bytes) for package `name@version`. Pure.
 *  Exactly one .tgz, named as npm would name it, containing that package at that version, passing the pack guard. Side files
 *  the script writes (e.g. its own .sha256) are ignored: the publish job derives the checksum files from the bytes. */
export function packScriptOutputProblems(files: Map<string, Uint8Array>, name: string, version: string): string[] {
  const want = tarballName(name, version);
  const tgzs = [...files.keys()].filter((f) => f.endsWith(".tgz"));
  if (tgzs.length !== 1 || tgzs[0] !== want) return [`the pack script must write exactly ${want}; it wrote ${tgzs.length ? tgzs.join(", ") : "no .tgz"}`];
  const data = files.get(want) as Uint8Array;
  let pkg: { name?: unknown; version?: unknown };
  try {
    const pj = tarEntries(data).get("package.json");
    if (!pj) return [`${want} has no package/package.json`];
    pkg = JSON.parse(pj.toString("utf8"));
  } catch (e) {
    return [`${want} is not a readable npm tarball: ${(e as Error).message}`];
  }
  if (pkg.name !== name || pkg.version !== version) return [`${want} contains ${String(pkg.name)}@${String(pkg.version)}, not ${name}@${version}`];
  return checkPackedTarball(data);
}

export function requiredScripts(cfg: CiConfig, multiPackage = false): string[] {
  return [...REQUIRED_SCRIPTS, ...(cfg.conformance ? ["conformance"] : []), ...(multiPackage ? ["build"] : []), ...(cfg.kind === "miniapp" ? ["gen"] : [])];
}

/** BSA-03: the generated kinds `tb-gen all` must produce for a miniapp (relative to gen/). */
export function expectedGenFiles(product: string): string[] {
  return ["openapi/openapi.json", `kit/${product}-kit/package.json`, `docs/${product}.md`, "railway/railway.json"];
}

/** BSA-01: every manifest service built from source needs exactly one service image; returns problems. */
export function checkServiceImages(cfg: CiConfig, appProduct: string, manifestServices: { id: string; build?: unknown; image?: unknown }[]): string[] {
  const declared = cfg.images.filter((im) => im.kind === "service" && im.product === appProduct).map((im) => im.service as string);
  const built = manifestServices.filter((s) => s.build).map((s) => s.id);
  const errs: string[] = [];
  for (const id of built) if (!declared.includes(id)) errs.push(`manifest service ${id} has build but no images[] entry of kind service (service: "${id}")`);
  for (const id of declared) if (!built.includes(id)) errs.push(`images[] service ${id} is not a manifest service with build`);
  return errs;
}

export function checkPackageJson(pkg: Record<string, unknown>, cfg: CiConfig, where: string, multiPackage = false): string[] {
  const errors: string[] = [];
  if (pkg.private !== true) errors.push(`${where}: "private": true is required (no npm publishing in opt2; packages ship as GitHub release tarballs)`);
  if (pkg.publishConfig !== undefined) errors.push(`${where}: publishConfig is not allowed`);
  const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
  for (const s of requiredScripts(cfg, multiPackage)) if (typeof scripts[s] !== "string") errors.push(`${where}: script "${s}" is required`);
  return errors;
}

/** C206 (ci-v9.8): either owner; pins made before the move keep the old owner (GitHub redirects the download, integrity is unchanged). */
export const RELEASE_URL_RE = new RegExp(
  `^https://github\\.com/(?:${OWNERS_RE})/opt2-tealbrick-[a-z0-9-]+/releases/download/[a-z0-9-]+-v\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?/[a-z0-9-]+-\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?\\.tgz$`,
);
/** ci-v9.3: the exact spec tarball the manifest package is loaded with (pinned by sha512 next to it). */
const SPEC_URL_RE = new RegExp(
  `^https://github\\.com/(?:${OWNERS_RE})/opt2-tealbrick-specs/releases/download/spec-v\\d+\\.\\d+\\.\\d+/opt2-tealbrick-spec-\\d+\\.\\d+\\.\\d+\\.tgz$`,
);
/** ci-v9.8 (C206 B6): the same spec tarball on a platform dist host (`<base>/opt2-tealbrick-specs-spec-v<ver>/…`). */
const DIST_SPEC_TAIL_RE = /^opt2-tealbrick-specs-spec-v(\d+\.\d+\.\d+)\/opt2-tealbrick-spec-\1\.tgz$/;
export function isSpecTarballUrl(v: string): boolean {
  return SPEC_URL_RE.test(v) || DIST_BASES.some((b) => v.startsWith(`${b}/`) && DIST_SPEC_TAIL_RE.test(v.slice(b.length + 1)));
}
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/** Dependency rules: no v1 names; @opt2-tealbrick/* only as workspace (same repo) or GitHub release tarball URL. Returns [errors, urls]. */
export function checkDependencies(pkg: Record<string, unknown>, where: string, localNames: Set<string>): [string[], string[]] {
  const errors: string[] = [];
  const urls: string[] = [];
  for (const field of DEP_FIELDS) {
    const deps = (pkg[field] ?? {}) as Record<string, unknown>;
    for (const [name, spec] of Object.entries(deps)) {
      const v = String(spec);
      if (name === "tealbrick" || name.startsWith("@tealbrick/")) errors.push(`${where}: ${field}.${name}: v1 package names are not allowed in opt2`);
      if (!name.startsWith("@opt2-tealbrick/")) continue;
      if (v.startsWith("workspace:")) {
        if (!localNames.has(name)) errors.push(`${where}: ${field}.${name}: workspace: is only allowed for packages in this repo`);
      } else if (isReleaseTarballUrl(v)) {
        urls.push(v);
      } else {
        errors.push(
          `${where}: ${field}.${name}: must be a GitHub release tarball URL (https://github.com/${OWNER}/opt2-tealbrick-<repo>/releases/download/<pkg>-v<ver>/<file>.tgz) or a tarball on a platform dist host (${DIST_BASES.join(" | ")}/<repo>-<pkg>-v<ver>/<file>.tgz), got ${JSON.stringify(v)}`,
        );
      }
    }
  }
  return [errors, urls];
}

/** Minimal pnpm-workspace.yaml reader: supports `- dir/*` and `- dir` entries only. */
export function workspaceGlobs(yamlText: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const line of yamlText.split("\n")) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) inPackages = false;
    const m = inPackages ? /^\s+-\s+["']?([^"'#]+?)["']?\s*(#.*)?$/.exec(line) : null;
    if (m) {
      const g = m[1].trim();
      if (!/^[A-Za-z0-9._/-]+(\/\*)?$/.test(g) || g.split("/").includes("..")) throw new Error(`unsupported workspace pattern ${g} (use dir/* or dir)`);
      out.push(g);
    }
  }
  return out;
}

export function parsePackageTag(tag: string): { dir: string; version: string } {
  const m = /^([a-z0-9][a-z0-9-]*)-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
  if (!m) throw new Error(`tag ${JSON.stringify(tag)} is not <package>-v<semver>`);
  return { dir: m[1], version: m[2] };
}

/** npm pack file name for a package name + version. */
export function tarballName(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

/** URL of a released package tarball. Default: the GitHub release of the source repo. With a dist base (ci-v9.6): the dist host. */
export function releaseUrl(repo: string, dir: string, name: string, version: string, distBase: string | null = null): string {
  const file = tarballName(name, version);
  if (distBase) return `${normalizeDistBase(distBase, "distBase")}/${distTag(repo, `${dir}-v${version}`)}/${file}`;
  return `https://github.com/${OWNER}/${repo}/releases/download/${dir}-v${version}/${file}`;
}

/** ci-v9.1 (C75): the build that runs before `npm pack` on a package tag. The repo's root `build` script (the same one the
 *  Woodpecker build stage runs), else the tagged package and its workspace dependencies. Args for `corepack`. */
export function packageBuildArgs(rootScripts: Record<string, unknown>, target: string): string[] {
  return typeof rootScripts.build === "string" ? ["pnpm", "run", "build"] : ["pnpm", "--filter", `${target}...`, "run", "--if-present", "build"];
}

/** ci-v9.1 (C75): the commands gh-build runs on a package tag before `package-pack`: frozen, script-free installs per pnpm path,
 *  then the build. Before ci-v9.1 there was no build, so tarballs shipped without dist/. */
export function packageReleaseCommands(
  dirs: { dir: string; pm: "pnpm" | "npm" | null }[],
  projectDir: string,
  rootScripts: Record<string, unknown>,
  target: string,
): { cwd: string; cmd: string; args: string[] }[] {
  const out = dirs
    .filter((d) => d.pm === "pnpm")
    .map((d) => ({ cwd: d.dir, cmd: "corepack", args: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"] }));
  out.push({ cwd: projectDir, cmd: "corepack", args: packageBuildArgs(rootScripts, target) });
  return out;
}

/** ci-v9.1 pack guard: every file a package.json entry field points at (main, module, types, typings, bin, exports), relative to
 *  the package root. Export wildcard patterns (`./schemas/*`) are returned as patterns. */
export function packEntryTargets(pkg: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === "string" && v.length > 0) out.add(v.replace(/^\.\//, ""));
  };
  for (const f of ["main", "module", "types", "typings"]) add(pkg[f]);
  const bin = pkg.bin;
  if (typeof bin === "string") add(bin);
  else if (bin && typeof bin === "object") for (const v of Object.values(bin)) add(v);
  const walk = (e: unknown): void => {
    if (typeof e === "string") add(e);
    else if (Array.isArray(e)) for (const x of e) walk(x);
    else if (e && typeof e === "object") for (const v of Object.values(e)) walk(v);
  };
  walk(pkg.exports);
  return [...out].sort();
}

/** Entry targets of `pkg` that are not in `files` (paths relative to the package root). A wildcard pattern needs one match;
 *  an extension-less `main` resolves like Node (`x`, `x.js`, `x.json`, `x/index.js`). */
export function missingPackTargets(pkg: Record<string, unknown>, files: Iterable<string>): string[] {
  const have = new Set(files);
  const list = [...have];
  return packEntryTargets(pkg).filter((t) => {
    if (t.includes("*")) {
      const parts = t.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
      const re = new RegExp(`^${parts.join(".+")}$`);
      return !list.some((f) => re.test(f));
    }
    return ![t, `${t}.js`, `${t}.json`, `${t}/index.js`].some((c) => have.has(c));
  });
}

/** Files of an npm-pack .tgz (ustar + pax/GNU long names), keyed by path relative to the package root (`package/` stripped). */
export function tarEntries(tgz: Uint8Array): Map<string, Buffer> {
  const buf = gunzipSync(tgz);
  const out = new Map<string, Buffer>();
  const str = (b: Buffer): string => b.toString("utf8").replace(/\0.*$/s, "");
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = Number.parseInt(str(h.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      if (m) longName = m[1];
      continue;
    }
    if (type === "L") {
      longName = str(body);
      continue;
    }
    if (type === "g") continue;
    const prefix = str(h.subarray(257, 263)).startsWith("ustar") ? str(h.subarray(345, 500)) : "";
    const name = longName ?? (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)));
    longName = null;
    if (type !== "0" && type !== "\0") continue; // regular files only
    out.set(name.replace(/^[^/]+\//, ""), Buffer.from(body));
  }
  return out;
}

/** Problems of a packed package: no package.json, or entry targets (main/exports/types/bin) missing from the tarball (e.g. no dist/). */
export function checkPackedTarball(tgz: Uint8Array): string[] {
  const entries = tarEntries(tgz);
  const pj = entries.get("package.json");
  if (!pj) return ["the tarball has no package.json"];
  const pkg = JSON.parse(pj.toString("utf8")) as Record<string, unknown>;
  return missingPackTargets(pkg, entries.keys()).map((t) => `${String(pkg.name)}: ${t} is referenced by package.json but missing from the tarball`);
}

/** ci-v9.1: the unit step talks to the opt-in Postgres step (Woodpecker step `postgres`) only when tealbrick-ci.json asks. */
export const PG_TEST_URL = "postgres://tb:tb-ci-only@postgres:5432/tb";
export const PG_MARKER = ".tb-ci/postgres";
/** ci-v9.2: written when the unit step ends (pass or fail); the template's postgres step then stops itself and exits 0. ci-v9.3: the step is a normal parallel step (a detached one ends red). */
export const PG_DONE_MARKER = ".tb-ci/postgres-done";
export function testEnv(cfg: CiConfig, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  if (cfg.postgres) out.TB_TEST_DATABASE_URL = PG_TEST_URL;
  else delete out.TB_TEST_DATABASE_URL;
  return out;
}

export interface ProductBinding {
  repo: string; // "Tealbrick/opt2-tealbrick-<name>"
  kind: IndexRelease["kind"];
  /** C206: the same repo under a LEGACY owner ("Martin-Atrin/opt2-tealbrick-<name>"). Only earlier, already signed releases may
   *  carry it; a new release always carries `repo`. */
  formerRepos?: string[];
}
export type ProductBindings = Record<string, ProductBinding>;

/** GTP-01: registry/products.json = { "<product>": { "repo": "Tealbrick/opt2-tealbrick-<name>", "kind": "app"|"bridge"|"desktop"|"cli"|"package",
 *  "formerRepos"?: ["Martin-Atrin/opt2-tealbrick-<same name>"] } }. */
export function validateProducts(raw: unknown): ProductBindings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("products.json must be an object { product: { repo, kind } }");
  const out: ProductBindings = {};
  for (const [product, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(product)) throw new Error(`products.json: bad product id ${product}`);
    const b = v as Record<string, unknown>;
    const keys = b && typeof b === "object" ? Object.keys(b).sort().join(",") : "";
    if (keys !== "kind,repo" && keys !== "formerRepos,kind,repo")
      throw new Error(`products.json ${product}: fields must be exactly repo, kind (and optional formerRepos)`);
    if (typeof b.repo !== "string" || !new RegExp(`^${OWNER}/opt2-tealbrick-[a-z0-9-]+$`).test(b.repo))
      throw new Error(`products.json ${product}: repo must be ${OWNER}/opt2-tealbrick-<name>`);
    if (!(INDEX_KINDS as readonly string[]).includes(b.kind as string)) throw new Error(`products.json ${product}: kind must be ${INDEX_KINDS.join(", ")}`);
    const binding: ProductBinding = { repo: b.repo, kind: b.kind as ProductBinding["kind"] };
    if (b.formerRepos !== undefined) {
      // C206: only the same repo name under a legacy owner, so the alias can never bind another repo's history
      const name = b.repo.slice(OWNER.length + 1);
      const allowed = LEGACY_OWNERS.map((o) => `${o}/${name}`);
      const f = b.formerRepos;
      if (!Array.isArray(f) || f.length === 0 || f.some((x) => typeof x !== "string" || !allowed.includes(x)) || new Set(f).size !== f.length)
        throw new Error(`products.json ${product}: formerRepos must be a non-empty list of ${allowed.join(" | ")} (same repo name, legacy owner)`);
      binding.formerRepos = [...(f as string[])];
    }
    out[product] = binding;
  }
  return out;
}

/** GTP-01: a release may come only from the repo (and as the kind) its product is bound to; unknown products are refused. */
export function productBindingProblem(bindings: ProductBindings, r: { product: string; kind: string; repo: string | null }): string | null {
  const b = Object.hasOwn(bindings, r.product) ? bindings[r.product] : undefined;
  if (!b) return `${r.product} is not bound to a repo in ${PRODUCTS_PATH} (a new product is added there by a platform PR)`;
  if (r.repo !== b.repo) return `${r.product} is bound to ${b.repo}; a release from ${r.repo ?? "no repo"} is refused (GTP-01)`;
  if (r.kind !== b.kind) return `${r.product} is bound as kind ${b.kind}; a ${r.kind} release is refused (GTP-01)`;
  return null;
}

// ---------- C174: the `cli` release-index kind (C173 one-line installer + `tealbrick self-update`) ----------

/** The private CLI repo (C173). Its releases are read ONLY by the signer's cli source, with a read-only token (C164). */
export const CLI_REPO = "opt2-tealbrick-cli";
export const CLI_PRODUCT = "cli";
export const CLI_PACKAGE = "@opt2-tealbrick/cli";
/** Release tags of the CLI package: `cli-v<semver>` (template package tags, `<package dir>-v<semver>`). */
export const CLI_TAG_DIR = "cli";
/** Where the index points a cli tarball: a platform dist host, never the private GitHub repo (C164 pull mirror). The platform
 *  picks the host, not the product repo (SEC-03); change by platform PR (releases.tealbrick.com at cutover). */
export const CLI_DIST_BASE: string = DIST_BASES[0] as string;
/** Env name of the fine-grained READ-only token (contents + releases of the private repos) Martin creates (C164). Absent = the
 *  cli source is pending: registry-sync stays green and the index has no cli entry. */
export const PRIVATE_READ_TOKEN_ENV = "TB_PRIVATE_READ_TOKEN";

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const SHA512_INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** The only accepted URL of a cli tarball: `<dist base>/opt2-tealbrick-cli-cli-v<ver>/opt2-tealbrick-cli-<ver>.tgz`. */
export function cliTarballUrl(version: string, distBase: string = CLI_DIST_BASE): string {
  return releaseUrl(CLI_REPO, CLI_TAG_DIR, CLI_PACKAGE, version, distBase);
}

/** C174 + C181: the npm tarballs the private CLI repo releases onto the dist host, per index product. kind `cli` = the CLI the
 *  installer and `tealbrick self-update` install; kind `package` = a library other repos depend on by dist URL (relay for the
 *  private bridge and TBD; the harnesses). Release tag `<tagDir>-v<semver>`; the packed package.json must be `packageName` at that
 *  version (and carry `bin` when set). Change by platform PR only; products.json binds each product to the CLI repo + kind. */
export interface DistProduct {
  kind: "cli" | "package";
  packageName: string;
  tagDir: string;
  bin?: string;
  /** C206 B6: the repo that releases it (default CLI_REPO). */
  repo?: string;
  /** C206 B6: releases from this version on are indexed (and mirrored); older tags are ignored unless listed in `legacy`.
   *  Absent (and no `legacy`): every tag of the product (the CLI-repo products, C174/C181). */
  since?: string;
  /** C206 B6: older versions that consumers still pin (lockfiles before the dist host). Released before ci-v9.5 some have no
   *  `.integrity` asset; the signer then computes it from the bytes it downloaded (the `.sha256` asset must still match). */
  legacy?: readonly string[];
}
export const DIST_PRODUCTS: Readonly<Record<string, DistProduct>> = {
  cli: { kind: "cli", packageName: CLI_PACKAGE, tagDir: CLI_TAG_DIR, bin: "tealbrick" },
  relay: { kind: "package", packageName: "@opt2-tealbrick/relay", tagDir: "relay" },
  "harness-claude": { kind: "package", packageName: "@opt2-tealbrick/harness-claude", tagDir: "harness-claude" },
  "harness-eve": { kind: "package", packageName: "@opt2-tealbrick/harness-eve", tagDir: "harness-eve" },
  // C206 B6: the libraries of the repos that go private (sdk, specs, packages) and the pre-split bridge-repo tarballs that
  // TBD and an older CLI install still pin. Every consumer pins them by dist URL; the dist mirror copies the bytes (C164).
  spec: {
    kind: "package",
    packageName: "@opt2-tealbrick/spec",
    tagDir: "spec",
    repo: "opt2-tealbrick-specs",
    since: "0.1.38",
    legacy: ["0.1.2", "0.1.7", "0.1.12", "0.1.18", "0.1.20", "0.1.22", "0.1.25", "0.1.26", "0.1.27", "0.1.28", "0.1.31", "0.1.35"],
  },
  manifest: {
    kind: "package",
    packageName: "@opt2-tealbrick/manifest",
    tagDir: "manifest",
    repo: "opt2-tealbrick-sdk",
    since: "0.1.18",
    legacy: ["0.1.1", "0.1.7", "0.1.12", "0.1.16"],
  },
  "miniapp-sdk": {
    kind: "package",
    packageName: "@opt2-tealbrick/miniapp-sdk",
    tagDir: "miniapp-sdk",
    repo: "opt2-tealbrick-sdk",
    since: "0.1.24",
    legacy: ["0.1.12", "0.1.16", "0.1.19", "0.1.20", "0.1.22"],
  },
  conformance: {
    kind: "package",
    packageName: "@opt2-tealbrick/conformance",
    tagDir: "conformance",
    repo: "opt2-tealbrick-sdk",
    since: "0.1.18",
    legacy: ["0.1.12", "0.1.16", "0.1.17"],
  },
  "create-tealbrick-miniapp": {
    kind: "package",
    packageName: "create-tealbrick-miniapp",
    tagDir: "create-tealbrick-miniapp",
    repo: "opt2-tealbrick-sdk",
    since: "0.1.14",
  },
  ui: {
    kind: "package",
    packageName: "@opt2-tealbrick/ui",
    tagDir: "ui",
    repo: "opt2-tealbrick-packages",
    since: "0.2.4",
    legacy: ["0.2.0", "0.2.1", "0.2.3"],
  },
  "bridge-package-legacy": { kind: "package", packageName: "@opt2-tealbrick/bridge", tagDir: "bridge", repo: "opt2-tealbrick-bridge", legacy: ["0.1.1"] },
  "harness-claude-legacy": {
    kind: "package",
    packageName: "@opt2-tealbrick/harness-claude",
    tagDir: "harness-claude",
    repo: "opt2-tealbrick-bridge",
    legacy: ["0.1.0"],
  },
  "cli-legacy": { kind: "package", packageName: CLI_PACKAGE, tagDir: CLI_TAG_DIR, repo: "opt2-tealbrick-bridge", legacy: ["0.1.22"] },
};

/** C206 B6: the repo of a dist product. */
export function distRepo(d: DistProduct): string {
  return d.repo ?? CLI_REPO;
}

function semverCore(v: string): number[] {
  return (/^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1) ?? ["0", "0", "0"]).map(Number);
}
/** C206 B6: whether the signer indexes this version of a dist product (see DistProduct since/legacy). */
export function distVersionWanted(d: DistProduct, version: string): boolean {
  if (d.legacy?.includes(version)) return true;
  if (d.since === undefined) return d.legacy === undefined;
  const [a, b] = [semverCore(version), semverCore(d.since)];
  for (let i = 0; i < 3; i++) if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) > (b[i] as number);
  return true;
}
/** C206 B6: a legacy version may lack the `.integrity` asset (released before ci-v9.5). */
function distIntegrityOptional(d: DistProduct, version: string): boolean {
  return d.legacy?.includes(version) ?? false;
}

/** The only accepted URL of a DIST_PRODUCTS tarball: `<dist base>/opt2-tealbrick-cli-<tagDir>-v<ver>/<npm pack name>`. */
export function distTarballUrl(product: string, version: string, distBase: string = CLI_DIST_BASE): string {
  const d = DIST_PRODUCTS[product];
  if (!d) throw new Error(`${product} is not a dist product (DIST_PRODUCTS)`);
  return releaseUrl(distRepo(d), d.tagDir, d.packageName, version, distBase);
}

/** C174: what is wrong with a cli index entry (null = fine). Writers stay strict (L24): a dist-host URL that matches the version,
 *  `sha256:<hex>` + `sha512-<base64>` integrity, and nothing that belongs to other kinds. */
export function cliEntryProblem(r: IndexRelease): string | null {
  if (r.kind !== "cli") return "not a cli entry";
  return distEntryProblem(r);
}

/** C174/C181: what is wrong with a `cli` or `package` index entry (null = fine). */
export function distEntryProblem(r: IndexRelease): string | null {
  const d = DIST_PRODUCTS[r.product];
  if (!d) return `${r.product} is not a dist product (DIST_PRODUCTS: ${Object.keys(DIST_PRODUCTS).join(", ")})`;
  if (r.kind !== d.kind) return `${r.product} must be kind ${d.kind}, got ${r.kind}`;
  const a = r.artifact;
  if (!a || typeof a !== "object") return `a ${r.kind} release needs artifact {url, sha256, integrity}`;
  const extra = Object.keys(a).filter((k) => !["url", "sha256", "integrity"].includes(k));
  if (extra.length) return `artifact has unknown field(s) ${extra.join(", ")}`;
  if (typeof a.url !== "string" || !DIST_BASES.some((b) => a.url.startsWith(`${b}/`)))
    return `artifact.url must be on a platform dist host (${DIST_BASES.join(", ")}), never a private GitHub URL; got ${JSON.stringify(a.url)}`;
  if (!DIST_BASES.some((b) => a.url === distTarballUrl(r.product, r.version, b)))
    return `artifact.url must be <dist base>/${distRepo(d)}-${d.tagDir}-v${r.version}/${tarballName(d.packageName, r.version)}; got ${a.url}`;
  if (typeof a.sha256 !== "string" || !SHA256_RE.test(a.sha256)) return "artifact.sha256 must be sha256:<64 hex>";
  if (a.integrity === undefined) return `artifact.integrity (sha512-<base64>) is required for kind ${r.kind}`;
  if (typeof a.integrity !== "string" || !SHA512_INTEGRITY_RE.test(a.integrity)) return "artifact.integrity must be sha512-<88 base64 chars>";
  if (r.image || r.source || r.runtime || r.services?.length || r.manifestDigest || r.manifestUrl || r.skillsDigest)
    return `a ${r.kind} release carries only the artifact (no image, source, runtime, services or manifest)`;
  if (r.minOs !== null || r.notarized !== null) return "minOs/notarized are desktop fields";
  return null;
}

/** C174: builds the cli entry from the release assets of tag `cli-v<version>` the signer downloaded itself. It trusts no
 *  product-written digest: it hashes the tarball, requires the `.sha256` and `.integrity` assets to agree, and requires the
 *  packed package.json to be @opt2-tealbrick/cli at this version with a `tealbrick` bin. Pure; returns the entry or a rejection. */
export function cliReleaseFromAssets(input: Omit<Parameters<typeof distReleaseFromAssets>[0], "product">): IndexRelease | string {
  return distReleaseFromAssets({ ...input, product: CLI_PRODUCT });
}

/** C174/C181: the same rules for every DIST_PRODUCTS product (bin only where the product declares one). */
export function distReleaseFromAssets(input: {
  product: string;
  version: string;
  commit: string;
  tgz: Uint8Array;
  sha256File: string;
  integrityFile: string | null;
  distBase?: string;
  publishedAt: string;
  id?: string;
}): IndexRelease | string {
  const { version, commit, tgz, product } = input;
  const d = DIST_PRODUCTS[product];
  if (!d) return `${product} is not a dist product (DIST_PRODUCTS)`;
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) return `bad version ${JSON.stringify(version)}`;
  if (!/^[0-9a-f]{40}$/.test(commit)) return "commit must be a full sha";
  const name = tarballName(d.packageName, version);
  const sums = assetChecksums(name, tgz);
  const listed = input.sha256File.trim().split(/\s+/);
  if (listed[0] !== sums.sha256 || (listed[1] !== undefined && listed[1].replace(/^\*/, "") !== name))
    return `${name}.sha256 does not match the tarball (tarball sha256 ${sums.sha256})`;
  if (input.integrityFile === null) {
    if (!distIntegrityOptional(d, version)) return `${name} has no .integrity asset (template ci-v9.5+)`;
  } else if (input.integrityFile.trim() !== sums.integrity) return `${name}.integrity does not match the tarball`;
  let pkg: { name?: unknown; version?: unknown; bin?: unknown };
  try {
    const raw = tarEntries(tgz).get("package.json");
    if (!raw) return `${name} has no package/package.json`;
    pkg = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    return `${name} is not a readable npm tarball: ${(e as Error).message}`;
  }
  if (pkg.name !== d.packageName || pkg.version !== version)
    return `${name} contains ${String(pkg.name)}@${String(pkg.version)}, not ${d.packageName}@${version}`;
  if (d.bin) {
    const bin = pkg.bin as Record<string, unknown> | undefined;
    if (!bin || typeof bin !== "object" || typeof bin[d.bin] !== "string") return `${name} has no "${d.bin}" bin`;
  }
  const entry: IndexRelease = {
    id: input.id ?? newId("rel"),
    product,
    kind: d.kind,
    version,
    channel: releaseChannel(product, version),
    manifestDigest: null,
    manifestUrl: null,
    skillsDigest: null,
    image: null,
    artifact: { url: distTarballUrl(product, version, input.distBase ?? CLI_DIST_BASE), sha256: `sha256:${sums.sha256}`, integrity: sums.integrity },
    source: null,
    runtime: null,
    services: null,
    minOs: null,
    notarized: null,
    upgradeFrom: "*",
    repo: `${OWNER}/${distRepo(d)}`,
    commit,
    tag: `${d.tagDir}-v${version}`,
    publishedAt: input.publishedAt,
  };
  return distEntryProblem(entry) ?? entry;
}

export interface CliSourceResult {
  add: IndexRelease[];
  rejected: string[];
  /** C207 E1: release-guard warnings (PR missing before the cut-over date) */
  warnings: string[];
  /** why the source was skipped as a whole (null = it ran) */
  pending: string | null;
}

/** C174 signer source: cli-v* releases of the private CLI repo (C206 B6: and every DIST_PRODUCTS repo: specs, sdk, packages, bridge), read with the read-only token (C164). Without the token, or
 *  while the repo is in PENDING_REPOS and not visible, it is PENDING (no entry, no failure). A release without the tarball
 *  asset yet is pending too. Any other answer is a rejection (registry-sync fails loudly, as for other sources). The token
 *  goes to api.github.com only; asset downloads follow GitHub's redirect, and fetch drops the authorization header on the
 *  cross-origin hop. */
export async function cliSourceReleases(opts: {
  token: string | undefined;
  known: Set<string>;
  fetcher?: typeof fetch;
  now?: () => string;
  distBase?: string;
  /** C207 E1: release guard per new tag (default releaseGuard over the same read-token API). */
  guard?: (fullRepo: string, sha: string) => Promise<GuardResult>;
}): Promise<CliSourceResult> {
  const out: CliSourceResult = { add: [], rejected: [], warnings: [], pending: null };
  if (!opts.token) {
    out.pending = `no ${PRIVATE_READ_TOKEN_ENV} (C164: Martin's read-only token for the private repos)`;
    return out;
  }
  const fetcher = opts.fetcher ?? fetch;
  const api = (path: string, accept = "application/vnd.github+json") =>
    fetcher(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${opts.token}`, accept, "x-github-api-version": "2022-11-28" },
      redirect: "follow",
    });
  const apiJson = async (path: string): Promise<{ status: number; json: any }> => {
    const r = await api(path);
    const text = await r.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: r.status, json };
  };
  const tagRe = /^([a-z0-9][a-z0-9-]*)-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
  // C206 B6: every repo that releases a DIST_PRODUCTS product (CLI repo first, as before)
  const repos = [...new Set([CLI_REPO, ...Object.values(DIST_PRODUCTS).map(distRepo)])];
  for (const repo of repos) {
    const base = `/repos/${OWNER}/${repo}`;
    const tags: { name: string; commit: { sha: string } }[] = [];
    let listed = true;
    for (let page = 1; page <= 10; page++) {
      const tagsRes = await api(`${base}/tags?per_page=100&page=${page}`);
      if (tagsRes.status === 404 && PENDING_REPOS.includes(repo)) {
        if (repo === CLI_REPO) {
          out.pending = `${CLI_REPO} is not visible to the read token (PENDING_REPOS)`;
          return out;
        }
        listed = false;
        break;
      }
      if (tagsRes.status !== 200) {
        out.rejected.push(`${repo}: list tags with the read token: HTTP ${tagsRes.status}`);
        listed = false;
        break;
      }
      const pageTags = (await tagsRes.json()) as { name: string; commit: { sha: string } }[];
      tags.push(...pageTags);
      if (pageTags.length < 100) break;
    }
    if (!listed) continue;
    // C181: every DIST_PRODUCTS tag of this repo (cli-v*, relay-v*, harness-*-v*, spec-v*, …); tag dirs are unique per repo
    const byDir = new Map(
      Object.entries(DIST_PRODUCTS)
        .filter(([, d]) => distRepo(d) === repo)
        .map(([product, d]) => [d.tagDir, product]),
    );
    for (const t of tags) {
      const m = tagRe.exec(t.name);
      const product = m ? byDir.get(m[1] as string) : undefined;
      if (!m || !product) continue;
      const version = m[2] as string;
      const d = DIST_PRODUCTS[product] as DistProduct;
      if (!distVersionWanted(d, version)) continue; // C206 B6: older library versions nobody pins
      const key = `${product}@${version}@${releaseChannel(product, version)}`;
      if (opts.known.has(key)) continue;
      const where = `${repo} ${t.name}`;
      try {
        const relRes = await api(`${base}/releases/tags/${encodeURIComponent(t.name)}`);
        if (relRes.status === 404) continue; // tag pushed, release Action not done yet: pending
        if (relRes.status !== 200) {
          out.rejected.push(`${where}: read release: HTTP ${relRes.status}`);
          continue;
        }
        const assets = ((await relRes.json()) as { assets?: { id: number; name: string }[] }).assets ?? [];
        const name = tarballName(d.packageName, version);
        const find = (n: string) => assets.find((a) => a.name === n);
        const tgzAsset = find(name);
        if (!tgzAsset) continue; // not uploaded yet: pending
        // C207 E1: release guard (main/hotfix, green Woodpecker, merged PR from the cut-over date); only once the release has
        // its tarball, so a tag whose release Action has not run (or could not run) stays pending, not red
        const g = await (opts.guard ?? ((full: string, sha: string) => releaseGuard(apiJson, full, sha)))(`${OWNER}/${repo}`, t.commit.sha);
        for (const w of g.warnings) out.warnings.push(`${where}: ${w}`);
        if (g.problem) {
          out.rejected.push(`${where}: ${g.problem}`);
          continue;
        }
        const shaAsset = find(`${name}.sha256`);
        const intAsset = find(`${name}.integrity`);
        if (!shaAsset || (!intAsset && !distIntegrityOptional(d, version))) {
          out.rejected.push(`${where}: ${name} has no .sha256/.integrity asset (template ci-v9.5+)`);
          continue;
        }
        const get = async (id: number): Promise<Uint8Array> => {
          const r = await api(`${base}/releases/assets/${id}`, "application/octet-stream");
          if (!r.ok) throw new Error(`download asset ${id}: HTTP ${r.status}`);
          return new Uint8Array(await r.arrayBuffer());
        };
        const text = (b: Uint8Array) => Buffer.from(b).toString("utf8");
        const r = distReleaseFromAssets({
          product,
          version,
          commit: t.commit.sha,
          tgz: await get(tgzAsset.id),
          sha256File: text(await get(shaAsset.id)),
          integrityFile: intAsset ? text(await get(intAsset.id)) : null,
          distBase: opts.distBase,
          publishedAt: (opts.now ?? (() => new Date().toISOString()))(),
        });
        if (typeof r === "string") out.rejected.push(`${where}: ${r}`);
        else {
          out.add.push(r);
          opts.known.add(key);
        }
      } catch (e) {
        out.rejected.push(`${where}: ${(e as Error).message}`);
      }
    }
  }
  return out;
}

/** Merge new releases into the index. Releases are immutable: (product, version, channel) never changes content.
 *  A dev source build (C29) and the later stable image of the same version are two releases.
 *  GTP-01: with `bindings`, every added release must match its product's repo/kind binding; always, a product never
 *  changes repo (an added release from another repo than the product's earlier releases is refused). */
export function mergeIndex(
  prev: ReleaseIndex | null,
  add: IndexRelease[],
  offers: Offer[],
  now: string,
  harnesses: Harness[] = [],
  bindings?: ProductBindings,
): ReleaseIndex {
  const releases: IndexRelease[] = (prev?.releases ?? []).map((r) => ({ ...r, runtime: r.runtime ?? null, services: r.services ?? null }));
  for (const r of add) {
    if (r.channel === "stable" && isDevOnlyProduct(r.product))
      throw new Error(`${r.product}@${r.version}: ${r.product} is dev-only (DEV_ONLY_PRODUCTS); the signer refuses a stable release`);
    // C207 E4: a NEW stable app/bridge record exists only as a promotion of an indexed dev record (same image + manifest)
    if (r.channel === "stable" && (r.kind === "app" || r.kind === "bridge")) {
      const from = r.promotedFrom ? releases.find((x) => x.id === r.promotedFrom) : undefined;
      if (!from) throw new Error(`${r.product}@${r.version}: a new stable ${r.kind} record needs promotedFrom = an indexed dev record (C207 E4)`);
      if (
        from.channel !== "dev" ||
        from.product !== r.product ||
        from.version !== r.version ||
        from.image !== r.image ||
        from.manifestDigest !== r.manifestDigest
      )
        throw new Error(`${r.product}@${r.version}: promotion must copy dev record ${from.id} (same product, version, image, manifest digest)`);
    }
    if (!(INDEX_KINDS as readonly string[]).includes(r.kind)) throw new Error(`${r.product}@${r.version}: unknown kind ${JSON.stringify(r.kind)}`);
    const fileKind = r.kind === "desktop" || r.kind === "cli" || r.kind === "package"; // released as a downloadable file, not an image
    if (!fileKind && r.channel === "stable" && !r.image)
      throw new Error(`${r.product}@${r.version}: a stable release needs an image digest (source builds are dev only, C29)`);
    if (!fileKind && !r.image && !r.source) throw new Error(`${r.product}@${r.version}: needs image or source`);
    if (r.kind === "cli" || r.kind === "package") {
      const problem = distEntryProblem(r);
      if (problem) throw new Error(`${r.product}@${r.version}: ${problem}`);
    }
    if ((r.kind === "bridge") !== (r.runtime !== null && r.runtime !== undefined))
      throw new Error(`${r.product}@${r.version}: runtime is required for kind bridge and only allowed there`);
    if (bindings) {
      const problem = productBindingProblem(bindings, r);
      if (problem) throw new Error(`${r.product}@${r.version}: ${problem}`);
    }
    // C206: with a binding, the bound repo and its formerRepos are ONE repo (renamed by the org move)
    const same = bindings && Object.hasOwn(bindings, r.product) ? repoAliases(bindings[r.product] as ProductBinding) : [r.repo];
    const earlier = releases.find((x) => x.product === r.product && x.repo !== r.repo && !(same.includes(x.repo) && same.includes(r.repo)));
    if (earlier)
      throw new Error(`${r.product}@${r.version}: earlier releases of ${r.product} come from ${earlier.repo}; a release from ${r.repo} is refused (GTP-01)`);
    // C207 E4: a dev SOURCE record (C29) and the dev IMAGE record of the same version are two releases (both land on dev now)
    const old = releases.find((x) => x.product === r.product && x.version === r.version && x.channel === r.channel && Boolean(x.image) === Boolean(r.image));
    if (old) {
      if (
        old.image !== r.image ||
        old.artifact?.sha256 !== r.artifact?.sha256 ||
        old.artifact?.integrity !== r.artifact?.integrity ||
        ((r.kind === "cli" || r.kind === "package") && old.artifact?.url !== r.artifact?.url) ||
        old.manifestDigest !== r.manifestDigest ||
        old.source?.ref !== r.source?.ref ||
        (old.source?.context ?? ".") !== (r.source?.context ?? ".")
      )
        throw new Error(`${r.product}@${r.version} is already released with other content (releases are immutable; ship a new version)`);
      continue;
    }
    releases.push(r);
  }
  const normalized = normalizeLegacyOwners(normalizeDevOnly(releases).releases).releases; // C113, C206 R2-1
  releases.length = 0;
  releases.push(...normalized);
  releases.sort((x, y) => (x.product === y.product ? x.publishedAt.localeCompare(y.publishedAt) : x.product.localeCompare(y.product)));
  return { schema: INDEX_SCHEMA, generatedAt: now, releases, offers, harnesses };
}

export function validateHarnesses(raw: unknown): Harness[] {
  if (!Array.isArray(raw)) throw new Error("harnesses.json must be an array");
  const ids = new Set<string>();
  const keys = ["authorise", "icon", "id", "instructions", "kind", "label", "noAgentPath"];
  const PLACEHOLDERS = new Set(["mcpUrl", "agentId", "pairingCode"]);
  const checkText = (v: unknown, where: string, bad: (m: string) => never) => {
    if (typeof v !== "string" || !v) bad(`${where} must be a non-empty string`);
    for (const m of (v as string).matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) if (!PLACEHOLDERS.has(m[1])) bad(`${where}: unknown placeholder {{${m[1]}}}`);
  };
  const out = raw.map((h, i) => {
    const r = h as Record<string, unknown>;
    const bad = (m: string): never => {
      throw new Error(`harnesses[${i}]: ${m}`);
    };
    if (Object.keys(r).sort().join(",") !== keys.join(",")) bad(`fields must be exactly ${keys.join(", ")} (HarnessOption + instructions)`);
    if (!Array.isArray(r.instructions) || r.instructions.length === 0) bad("instructions: at least one step");
    (r.instructions as Record<string, unknown>[]).forEach((st, j) => {
      const extra = Object.keys(st).filter((k) => !["title", "detail", "copy"].includes(k));
      if (extra.length) bad(`instructions[${j}]: unknown field ${extra.join(",")}`);
      checkText(st.title, `instructions[${j}].title`, bad);
      checkText(st.detail, `instructions[${j}].detail`, bad);
      if (st.copy !== undefined) {
        const c = st.copy as Record<string, unknown>;
        if (!["command", "json", "url", "text"].includes(c.kind as string) || Object.keys(c).sort().join(",") !== "kind,value")
          bad(`instructions[${j}].copy must be {kind: command|json|url|text, value}`);
        checkText(c.value, `instructions[${j}].copy.value`, bad);
      }
    });
    if (typeof r.id !== "string" || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(r.id)) bad("id (lowercase slug)");
    if (ids.has(r.id as string)) bad("duplicate id");
    ids.add(r.id as string);
    if (typeof r.label !== "string" || !r.label) bad("label");
    if (!["desktop", "agentic_system", "other"].includes(r.kind as string)) bad("kind desktop|agentic_system|other");
    if (!["device_approval", "instruction_set", "url"].includes(r.authorise as string)) bad("authorise device_approval|instruction_set|url");
    if (typeof r.noAgentPath !== "boolean") bad("noAgentPath boolean");
    if (
      r.icon !== null &&
      !(typeof r.icon === "string" && new RegExp(`^https://(github\\.com|raw\\.githubusercontent\\.com)/(?:${OWNERS_RE})/opt2-tealbrick-`).test(r.icon))
    )
      bad("icon: opt2 GitHub URL or null");
    return r as unknown as Harness;
  });
  if (out.filter((h) => h.noAgentPath).length > 1) throw new Error("at most one harness may be the no-agent path");
  return out;
}

export function validateOffers(raw: unknown): Offer[] {
  if (!Array.isArray(raw)) throw new Error("offers.json must be an array");
  const ids = new Set<string>();
  return raw.map((o, i) => {
    const r = o as Record<string, unknown>;
    const fail = (m: string): never => {
      throw new Error(`offers[${i}]: ${m}`);
    };
    if (typeof r.id !== "string" || !/^off_[0-9A-HJKMNP-TV-Z]{26}$/.test(r.id)) fail("id must be off_<ULID>");
    if (ids.has(r.id as string)) fail("duplicate id");
    ids.add(r.id as string);
    if (r.kind !== "single" && r.kind !== "bundle") fail("kind single|bundle");
    if (!Array.isArray(r.products) || r.products.length === 0) fail("products required");
    if (r.kind === "single" && (r.products as unknown[]).length !== 1) fail("a single offer has exactly one product");
    if (!Number.isInteger(r.major) || (r.major as number) < 0) fail("major");
    if (!Number.isInteger(r.amount) || (r.amount as number) < 0) fail("amount (minor units)");
    // Free fixture offer: amount 0 only for DEV_ONLY_PRODUCTS, single, no Stripe price (Core grants the licence with no
    // checkout, only in dev-channel workspaces).
    const free = r.amount === 0;
    if (free && (r.kind !== "single" || !(r.products as unknown[]).every((p) => typeof p === "string" && isDevOnlyProduct(p))))
      fail("amount 0 (free) is only for a single offer of a DEV_ONLY_PRODUCTS product");
    if (typeof r.currency !== "string" || !/^[a-z]{3}$/.test(r.currency)) fail("currency (ISO lower case)");
    for (const k of ["name", "taxNote"]) if (typeof r[k] !== "string" || !(r[k] as string)) fail(k);
    const sp = r.stripePrice as Record<string, unknown> | undefined;
    if (!sp || !("test" in sp) || !("live" in sp)) fail("stripePrice {test, live}");
    for (const m of ["test", "live"] as const) {
      const v = (sp as Record<string, unknown>)[m];
      if (v !== null && (typeof v !== "string" || !/^price_[A-Za-z0-9]+$/.test(v))) fail(`stripePrice.${m} must be price_… or null`);
      if (free && v !== null) fail(`a free offer has no Stripe price (stripePrice.${m} must be null)`);
    }
    return r as unknown as Offer;
  });
}

export const INTEGRITY_FILE = "tealbrick-integrity.json";

/** A lockfile entry that needs `integrity`: a GitHub release tarball or (ci-v9.6) a tarball on a dist host. */
function isLockedReleaseTarball(url: string): boolean {
  return /\/releases\/download\/.+\.tgz$/.test(url) || (url.endsWith(".tgz") && DIST_BASES.some((b) => url.startsWith(`${b}/`)));
}

/** S3 (C59): GitHub-release tarballs in a lockfile and whether the lockfile itself carries integrity for them. */
export function lockfileTarballs(lockText: string, kind: "pnpm" | "npm"): { url: string; integrity: string | null }[] {
  const out = new Map<string, string | null>();
  if (kind === "npm") {
    const lock = JSON.parse(lockText) as { packages?: Record<string, { resolved?: string; integrity?: string }> };
    for (const v of Object.values(lock.packages ?? {})) {
      if (v.resolved && isLockedReleaseTarball(v.resolved)) out.set(v.resolved, v.integrity ?? out.get(v.resolved) ?? null);
    }
  } else {
    for (const line of lockText.split("\n")) {
      const m = /resolution:\s*\{([^}]*)\}/.exec(line);
      if (!m) continue;
      const tarball = /tarball:\s*([^,\s}]+)/.exec(m[1])?.[1];
      if (!tarball || !isLockedReleaseTarball(tarball)) continue;
      out.set(tarball, /integrity:\s*([^,\s}]+)/.exec(m[1])?.[1] ?? null);
    }
  }
  return [...out].map(([url, integrity]) => ({ url, integrity }));
}

export function sha512Integrity(data: Uint8Array): string {
  return `sha512-${createHash("sha512").update(data).digest("base64")}`;
}

/** ci-v9.5 (F27): the checksum files published next to each release tarball: `<name>.sha256` (sha256sum format, as
 *  before) and `<name>.integrity` (the npm/pnpm lockfile `integrity` value, sha512, one line). Pure. */
export function assetChecksums(name: string, data: Uint8Array): { sha256: string; integrity: string; files: { name: string; body: string }[] } {
  const sha256 = createHash("sha256").update(data).digest("hex");
  const integrity = sha512Integrity(data);
  return {
    sha256,
    integrity,
    files: [
      { name: `${name}.sha256`, body: `${sha256}  ${name}\n` },
      { name: `${name}.integrity`, body: `${integrity}\n` },
    ],
  };
}

/** C62/BSD-10: write `integrity` into every pnpm `resolution: {tarball: …}` for a GitHub-release tarball. Pure. */
export function addPnpmIntegrity(lockText: string, integrityOf: (url: string) => string): { text: string; changed: number } {
  let changed = 0;
  const text = lockText.replace(/resolution:\s*\{tarball:\s*(https:\/\/[^\s,}]+\.tgz)\s*\}/g, (m, url: string) => {
    if (!/^https:\/\/github\.com\/[^\s,}]+\/releases\/download\//.test(url) && !isLockedReleaseTarball(url)) return m;
    changed++;
    return `resolution: {integrity: ${integrityOf(url)}, tarball: ${url}}`;
  });
  return { text, changed };
}

/** Returns problems: every GitHub-release tarball needs `integrity` IN THE LOCKFILE (pnpm and npm verify it on every install,
 *  also inside Docker builds) and that integrity must equal the published tarball. */
async function checkTarballIntegrity(dir: string, where: string): Promise<string[]> {
  const pm = packageManager(dir);
  if (!pm) return [];
  const lockName = pm === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
  const entries = lockfileTarballs(readFileSync(join(dir, lockName), "utf8"), pm);
  const errs: string[] = [];
  if (existsSync(join(dir, INTEGRITY_FILE)))
    errs.push(`${where}: ${INTEGRITY_FILE} is retired (C62): run node ci/tb-ci.ts pin-tarballs, which writes integrity into ${lockName}, then delete it`);
  for (const e of entries) {
    if (!e.integrity) {
      errs.push(`${where}: ${e.url} has no integrity in ${lockName} (run: node ci/tb-ci.ts pin-tarballs ../<repo>)`);
      continue;
    }
    const res = await fetch(e.url, { redirect: "follow" });
    if (!res.ok) {
      errs.push(`${where}: ${e.url} HTTP ${res.status}`);
      continue;
    }
    if (sha512Integrity(new Uint8Array(await res.arrayBuffer())) !== e.integrity) errs.push(`${where}: ${e.url} does not match the integrity in ${lockName}`);
  }
  return errs;
}

/** (local) C62: write sha512 integrity into pnpm-lock.yaml for every GitHub-release tarball (npm lockfiles already carry it). */
async function cmdPinTarballs(args: string[]): Promise<void> {
  const dir = resolve(args[0] ?? ".");
  const pm = packageManager(dir);
  if (!pm) fail(`${dir}: no lockfile`);
  rmSync(join(dir, INTEGRITY_FILE), { force: true });
  if (pm === "npm") {
    const missing = lockfileTarballs(readFileSync(join(dir, "package-lock.json"), "utf8"), "npm").filter((e) => !e.integrity);
    if (missing.length) fail(`package-lock.json lacks integrity for ${missing.map((e) => e.url).join(", ")}; run npm install to refresh it`);
    log("package-lock.json carries integrity for every release tarball");
    return;
  }
  const lockPath = join(dir, "pnpm-lock.yaml");
  const lock = readFileSync(lockPath, "utf8");
  const urls = [
    ...new Set(
      lockfileTarballs(lock, "pnpm")
        .filter((e) => !e.integrity)
        .map((e) => e.url),
    ),
  ];
  const sums = new Map<string, string>();
  for (const url of urls) {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) fail(`${url}: HTTP ${res.status}`);
    sums.set(url, sha512Integrity(new Uint8Array(await res.arrayBuffer())));
  }
  const { text, changed } = addPnpmIntegrity(lock, (u) => sums.get(u) as string);
  writeFileSync(lockPath, text);
  log(`wrote integrity for ${changed} tarball resolution(s) into pnpm-lock.yaml; run pnpm install --frozen-lockfile to confirm, then commit`);
}

/** C62: `packageManager` must pin pnpm by hash (corepack verifies it): pnpm@<semver>+sha512.<128 hex>. */
export function packageManagerPinned(value: unknown): boolean {
  return typeof value === "string" && /^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/.test(value);
}

/** C62: every install in a Dockerfile is frozen and runs no install scripts. Returns problems (line numbers are 1-based). */
export function dockerfileInstallProblems(text: string): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let instr = lines[i];
    while (instr.trimEnd().endsWith("\\") && i + 1 < lines.length) instr = `${instr.trimEnd().slice(0, -1)} ${lines[++i]}`;
    const t = instr.trim();
    if (!/^RUN\s/i.test(t)) continue;
    for (const cmd of t.slice(3).split(/&&|;|\|\|/)) {
      const c = cmd.trim();
      if (/(^|\s)(corepack\s+)?pnpm\s+(install|i|add)(\s|$)/.test(c)) {
        if (!/--frozen-lockfile/.test(c)) out.push(`line ${start + 1}: pnpm install without --frozen-lockfile`);
        if (!/--ignore-scripts/.test(c)) out.push(`line ${start + 1}: pnpm install without --ignore-scripts`);
      } else if (/(^|\s)npm\s+(ci|install|i)(\s|$)/.test(c)) {
        if (/npm\s+(install|i)(\s|$)/.test(c) && !/npm\s+(install|i)\s+-g\s/.test(c))
          out.push(`line ${start + 1}: npm install in an image build (use npm ci --ignore-scripts)`);
        if (!/--ignore-scripts/.test(c)) out.push(`line ${start + 1}: npm ${/npm\s+ci/.test(c) ? "ci" : "install"} without --ignore-scripts`);
      }
    }
  }
  return out;
}

/** C42: Railway refuses images with a `VOLUME` instruction (it mounts volumes itself). Returns offending line numbers. */
export function dockerfileVolumeLines(text: string): number[] {
  const out: number[] = [];
  let continued = false;
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    const isInstructionStart = !continued && t !== "" && !t.startsWith("#");
    if (isInstructionStart && /^VOLUME(\s|\[|$)/i.test(t)) out.push(i + 1);
    if (t.startsWith("#") && !continued) return;
    continued = t.endsWith("\\");
  });
  return out;
}

function findDockerfiles(root: string, dir = "", acc: string[] = []): string[] {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (["node_modules", ".git", ".tb-ci", "dist"].includes(e.name)) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) findDockerfiles(root, rel, acc);
    else if (/^Dockerfile(\..+)?$|\.Dockerfile$/i.test(e.name)) acc.push(rel);
  }
  return acc;
}

export function serializeIndex(index: ReleaseIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

/** Skills archive (C17): one JSON document with every manifest skill file; skillsDigest = digest(archive). */
export function skillsArchive(manifest: { skills?: { id: string; file: string }[] }, readFile: (rel: string) => string) {
  const files = (manifest.skills ?? []).map((sk) => ({ id: sk.id, file: sk.file, content: readFile(sk.file) })).sort((a, b) => a.id.localeCompare(b.id));
  return { schema: "opt2.skills-archive/v1", files };
}

/** Kaniko image-check script (push/PR events): builds every declared image, never pushes, holds no credentials. */
export function renderImagesScript(cfg: CiConfig, _repoName: string): string {
  const lines = ["#!/bin/sh", "# generated by tb-ci plan-images; runs in the kaniko debug image (busybox sh); holds no credentials", "set -eu"];
  if (cfg.images.length === 0) {
    lines.push('echo "tb-ci: no images declared in tealbrick-ci.json; nothing to build"', "exit 0");
    return `${lines.join("\n")}\n`;
  }
  for (const im of cfg.images) {
    lines.push(
      `echo "tb-ci: image ${im.name} (check)"`,
      `/kaniko/executor --no-push --context "$CI_WORKSPACE/${im.context}" --dockerfile "$CI_WORKSPACE/${im.dockerfile}" --cleanup --verbosity info`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// ---------- environment helpers ----------

function repoRoot(): string {
  return process.env.CI_WORKSPACE ?? process.cwd();
}

function repoName(root: string): string {
  const fromCi = process.env.CI_REPO_NAME;
  if (fromCi) return fromCi;
  try {
    const url = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    const m = /\/([^/]+?)(\.git)?$/.exec(url);
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  return root.split("/").pop() ?? "repo";
}

function loadConfig(root: string): CiConfig {
  const p = join(root, "tealbrick-ci.json");
  if (!existsSync(p)) fail("tealbrick-ci.json is missing (run: node ci/tb-ci.ts adopt <repo> --kind <kind> from the platform repo)");
  try {
    return validateConfig(JSON.parse(readFileSync(p, "utf8")), repoName(root));
  } catch (e) {
    fail(`tealbrick-ci.json: ${(e as Error).message}`);
  }
}

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
}

function packageManager(dir: string): "pnpm" | "npm" | null {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "package-lock.json"))) return "npm";
  return null;
}

function sh(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  log(`$ (${cwd}) ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } });
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.text();
}

// ---------- commands ----------

async function cmdSetup(): Promise<void> {
  const root = repoRoot();
  const ref = process.env.TB_CI_REF;
  if (!ref) fail("TB_CI_REF is not set (the pipeline must come from the template)");
  const local = readFileSync(join(root, ".woodpecker/ci.yaml"), "utf8");
  const upstream = await fetchText(`https://raw.githubusercontent.com/${OWNER}/${PLATFORM_REPO}/${ref}/ci/woodpecker/ci.yaml`);
  if (local !== upstream) fail(`.woodpecker/ci.yaml differs from the platform template ${ref}; re-run adopt, do not edit it by hand`);
  log(`template ${ref}: identical`);
  const min = (await fetchText(`https://raw.githubusercontent.com/${OWNER}/${PLATFORM_REPO}/main/${MIN_TEMPLATE_PATH}`)).trim();
  if (belowMinimum(ref, min)) fail(`template ${ref} is below the enforced minimum ${min} (C56 D1): run adopt from the platform repo`);
  if (DENIED_TEMPLATES[ref]) fail(`template ${ref} is denied: ${DENIED_TEMPLATES[ref]}`);
  log(`template ${ref} >= minimum ${min}`);
  if (existsSync(join(root, ".woodpecker/secret-scan.yaml"))) fail(".woodpecker/secret-scan.yaml duplicates the template's secret-scan step; delete it");
  {
    const cfgEarly = loadConfig(root);
    const wfPath = join(root, GH_WORKFLOW_PATH);
    const wpPath = join(root, WP_RELEASE_PATH);
    const problems = releaseFileProblems(cfgEarly.releaseOn, repoReleases(cfgEarly, root), existsSync(wfPath), existsSync(wpPath));
    if (problems.length) fail(problems.join("; "));
    if (existsSync(wfPath)) {
      const wfUp = await fetchText(`https://raw.githubusercontent.com/${OWNER}/${PLATFORM_REPO}/${ref}/ci/github/opt2-release.yml`);
      if (readFileSync(wfPath, "utf8") !== wfUp) fail(`${GH_WORKFLOW_PATH} differs from the platform template ${ref}; re-run adopt`);
      log(`release workflow ${ref}: identical`);
    }
    if (existsSync(wpPath)) {
      const wpUp = await fetchText(`https://raw.githubusercontent.com/${OWNER}/${PLATFORM_REPO}/${ref}/ci/woodpecker/release.yaml`);
      if (readFileSync(wpPath, "utf8") !== wpUp) fail(`${WP_RELEASE_PATH} differs from the platform template ${ref}; re-run adopt`);
      log(`Woodpecker release workflow ${ref}: identical (C222)`);
    }
  }
  const cfg = loadConfig(root);
  log(
    `kind=${cfg.kind} paths=${cfg.paths.join(",")} conformance=${cfg.conformance} postgres=${cfg.postgres} dist=${resolveDistBase(cfg) ?? "-"} preReleaseChecks=${cfg.preReleaseChecks.length} images=${cfg.images.map((i) => i.name).join(",") || "-"}`,
  );
  // ci-v9.1: the template's `postgres` step starts the database only when this marker exists (opt-in)
  mkdirSync(join(root, ".tb-ci"), { recursive: true });
  if (cfg.postgres) writeFileSync(join(root, PG_MARKER), "requested by tealbrick-ci.json\n");
  else rmSync(join(root, PG_MARKER), { force: true });
  rmSync(join(root, PG_DONE_MARKER), { force: true }); // ci-v9.2: never inherit a stale "unit finished" marker
  // ci-v9.14 (C262): the osv-scan step (osv-scanner image, no node) scans exactly the lockfiles listed here; osv-check judges the report
  writeFileSync(
    join(root, OSV_LOCKFILES_FILE),
    osvLockfiles(
      cfg,
      (rel) => existsSync(join(root, rel)),
      (rel) => readFileSync(join(root, rel), "utf8"),
    )
      .map((l) => `${l}\n`)
      .join(""),
  );
  rmSync(join(root, OSV_REPORT_FILE), { force: true });
  const errors: string[] = [];
  const urls: string[] = [];
  for (const p of cfg.paths) {
    const pj = join(root, p, "package.json");
    if (!existsSync(pj)) {
      log(`WARNING: ${p}/package.json does not exist yet; node stages skip this path`);
      continue;
    }
    const pkg = readJson(pj);
    const ws = workspacePackages(join(root, p));
    const localNames = new Set(ws.map((w) => w.name));
    errors.push(...checkPackageJson(pkg, cfg, `${p}/package.json`, ws.length > 0));
    for (const pkgJson of [{ rel: `${p}/package.json`, pkg }, ...ws.map((w) => ({ rel: `${p}/${w.rel}/package.json`, pkg: w.pkg }))]) {
      const [depErrors, depUrls] = checkDependencies(pkgJson.pkg, pkgJson.rel, localNames);
      errors.push(...depErrors);
      urls.push(...depUrls);
    }
    for (const w of ws) {
      if (w.pkg.private !== true) errors.push(`${p}/${w.rel}/package.json: "private": true is required`);
      if (w.pkg.publishConfig !== undefined) errors.push(`${p}/${w.rel}/package.json: publishConfig is not allowed`);
    }
    const pm = packageManager(join(root, p));
    if (!pm) errors.push(`${p}: a committed lockfile (pnpm-lock.yaml or package-lock.json) is required`);
    if (pm === "pnpm" && !packageManagerPinned(pkg.packageManager))
      errors.push(`${p}/package.json: "packageManager" must be "pnpm@<version>+sha512.<hex>" (C62; e.g. corepack use pnpm@9.15.4)`);
  }
  for (const im of cfg.images) {
    if (!existsSync(join(root, im.dockerfile))) errors.push(`image ${im.name}: ${im.dockerfile} not found`);
    if (im.manifest && !existsSync(join(root, im.manifest))) errors.push(`image ${im.name}: manifest ${im.manifest} not found`);
    if (im.kind === "app" && im.manifest && existsSync(join(root, im.manifest))) {
      const man = JSON.parse(readFileSync(join(root, im.manifest), "utf8")) as { runtime?: { services?: { id: string; build?: unknown }[] } };
      errors.push(...checkServiceImages(cfg, im.product, man.runtime?.services ?? []).map((e) => `image ${im.name}: ${e}`));
    }
  }
  for (const rel of missingPreReleaseChecks(cfg.preReleaseChecks, (r) => existsSync(join(root, r)))) errors.push(`preReleaseChecks: ${rel} not found`);
  for (const rel of missingPreReleaseChecks(Object.values(cfg.packScripts), (r) => existsSync(join(root, r)))) errors.push(`packScripts: ${rel} not found`);
  for (const df of findDockerfiles(root)) {
    const lines = dockerfileVolumeLines(readFileSync(join(root, df), "utf8"));
    if (lines.length)
      errors.push(`${df}: VOLUME instruction on line ${lines.join(", ")} (C42: Railway mounts volumes itself; declare volumes in the manifest runtime)`);
  }
  for (const u of new Set(urls)) {
    const res = await fetch(u, { method: "HEAD", redirect: "follow" });
    if (!res.ok) errors.push(`dependency tarball not found (HTTP ${res.status}): ${u}`);
  }
  for (const p of cfg.paths) if (existsSync(join(root, p, "package.json"))) errors.push(...(await checkTarballIntegrity(join(root, p), p)));
  if (errors.length) fail(`\n  - ${errors.join("\n  - ")}`);
  log("setup OK");
}

function nodePaths(cfg: CiConfig, root: string): string[] {
  return cfg.paths.filter((p) => existsSync(join(root, p, "package.json")));
}

function cmdInstall(): void {
  const root = repoRoot();
  const cfg = loadConfig(root);
  const paths = nodePaths(cfg, root);
  if (paths.length === 0) {
    log("SKIP install: no package.json yet");
    return;
  }
  for (const p of paths) {
    const dir = join(root, p);
    const pm = packageManager(dir);
    if (pm === "pnpm") sh("corepack", ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"], dir);
    else if (pm === "npm") sh("npm", ["ci", "--ignore-scripts"], dir);
    else fail(`${p}: no lockfile`);
  }
}

/** Waits until host:port accepts TCP connections (the opt-in Postgres step boots while install/typecheck/lint run). */
async function waitForTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((done) => {
      const s = createConnection({ host, port });
      s.setTimeout(2000);
      s.once("connect", () => {
        s.destroy();
        done(true);
      });
      s.once("timeout", () => {
        s.destroy();
        done(false);
      });
      s.once("error", () => done(false));
    });
    if (ok) return;
    if (Date.now() > until) fail(`postgres: ${host}:${port} not reachable after ${timeoutMs / 1000}s (tealbrick-ci.json postgres=true)`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function cmdRun(script: string | undefined): Promise<void> {
  if (!script || !["typecheck", "lint", "test", "conformance", "build"].includes(script)) fail("usage: run typecheck|lint|test|conformance|build");
  const root = repoRoot();
  const cfg = loadConfig(root);
  if (script === "conformance" && !cfg.conformance) {
    log("SKIP conformance: not required for this repo (tealbrick-ci.json conformance=false)");
    return;
  }
  if (script === "test" && cfg.postgres) {
    // ci-v9.2: tell the postgres step to stop itself, however this process ends (pass, fail, process.exit, throw)
    process.on("exit", () => {
      try {
        writeFileSync(join(root, PG_DONE_MARKER), "unit step finished\n");
      } catch {
        /* the step's 1 h cap still stops it */
      }
    });
  }
  const paths = nodePaths(cfg, root);
  if (paths.length === 0) {
    log(`SKIP ${script}: no package.json yet`);
    return;
  }
  const env = script === "test" ? testEnv(cfg, process.env) : process.env;
  if (script === "test" && cfg.postgres) {
    await waitForTcp("postgres", 5432, 90_000);
    log("postgres reachable; TB_TEST_DATABASE_URL is set");
  }
  for (const p of paths) {
    const dir = join(root, p);
    const scripts = (readJson(join(dir, "package.json")).scripts ?? {}) as Record<string, string>;
    if (!scripts[script]) {
      if (script === "build") {
        log(`SKIP build in ${p}: no build script`);
        continue;
      }
      fail(`${p}: script "${script}" is missing`);
    }
    if (packageManager(dir) === "pnpm") sh("corepack", ["pnpm", "run", script], dir, env);
    else sh("npm", ["run", script], dir, env);
  }
}

function pmExec(dir: string, bin: string, args: string[]): void {
  if (packageManager(dir) === "pnpm") sh("corepack", ["pnpm", "exec", bin, ...args], dir);
  else sh("npm", ["exec", "--no", "--", bin, ...args], dir);
}

/** BSA-03 gen stage: (1) a committed gen/ must not be stale, (2) the repo's `gen` script must really run `tb-gen all`, (3) the result passes `tb-gen check`. */
function cmdGen(): void {
  const root = repoRoot();
  const cfg = loadConfig(root);
  for (const p of nodePaths(cfg, root)) {
    const dir = join(root, p);
    const scripts = (readJson(join(dir, "package.json")).scripts ?? {}) as Record<string, string>;
    const manifestPath = join(dir, MANIFEST_FILE);
    if (!scripts.gen) {
      if (cfg.kind === "miniapp") fail(`${p}: script "gen" is required for kind miniapp ("gen": "tb-gen all")`);
      log(`SKIP gen in ${p}: no gen script`);
      continue;
    }
    if (!existsSync(manifestPath)) fail(`${p}: ${MANIFEST_FILE} is required for the gen stage`);
    const product = String((JSON.parse(readFileSync(manifestPath, "utf8")) as { id?: string }).id);
    if (existsSync(join(dir, "gen"))) pmExec(dir, "tb-gen", ["check"]); // committed gen/ must equal the manifest
    sh(packageManager(dir) === "pnpm" ? "corepack" : "npm", packageManager(dir) === "pnpm" ? ["pnpm", "run", "gen"] : ["run", "gen"], dir);
    const missing = expectedGenFiles(product).filter((f) => !existsSync(join(dir, "gen", f)));
    if (missing.length) fail(`${p}: the gen script did not produce ${missing.map((f) => `gen/${f}`).join(", ")} (it must run tb-gen all)`);
    pmExec(dir, "tb-gen", ["check"]);
    log(`gen OK in ${p} (${product})`);
  }
}

/** ci-v9.6: environment for a pre-release check: the effective dist base and the release tag (empty outside a tag run). Pure. */
export function preReleaseEnv(cfg: { distBaseUrl: string | null }, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, TB_PRE_RELEASE: "1", TB_RELEASE_TAG: env.CI_COMMIT_TAG ?? "" };
  const base = resolveDistBase(cfg, env);
  if (base) out.TB_DIST_BASE_URL = base;
  else delete out.TB_DIST_BASE_URL;
  return out;
}

/** ci-v9.6: `preReleaseChecks` entries that are not files in the repo. Pure over `exists`. */
export function missingPreReleaseChecks(checks: readonly string[], exists: (rel: string) => boolean): string[] {
  return checks.filter((rel) => !exists(rel));
}

/** ci-v9.6 pre-release gate: run every `preReleaseChecks` script (`node <file>`, repo root, no tokens). The first failure stops the run.
 *  The Woodpecker `pre-release` step runs this on every pipeline (so a green pipeline means the gate passed before anyone tags), and
 *  gh-build runs it again on the tag, before images or tarballs are built. */
function runPreReleaseChecks(cfg: CiConfig, root: string): void {
  for (const k of ["GITHUB_TOKEN", "GH_TOKEN", "GHCR_TOKEN"]) if (process.env[k]) fail(`pre-release checks must run without ${k}`);
  if (cfg.preReleaseChecks.length === 0) {
    log("pre-release: no preReleaseChecks in tealbrick-ci.json; nothing to run");
    return;
  }
  const missing = missingPreReleaseChecks(cfg.preReleaseChecks, (rel) => existsSync(join(root, rel)));
  if (missing.length) fail(`preReleaseChecks: ${missing.join(", ")} not found`);
  const env = preReleaseEnv(cfg, process.env);
  for (const rel of cfg.preReleaseChecks) {
    log(`pre-release: node ${rel}`);
    try {
      execFileSync(process.execPath, [rel], { cwd: root, stdio: "inherit", env, timeout: 600_000 });
    } catch {
      fail(`pre-release check ${rel} failed; no release may be tagged until it passes`);
    }
  }
  log(`pre-release: ${cfg.preReleaseChecks.length} check(s) passed`);
}

function cmdPreRelease(): void {
  const root = repoRoot();
  runPreReleaseChecks(loadConfig(root), root);
}

// ---------- ci-v9.14 (C262): OSV vulnerability scan ----------
// Two template steps, both without a secret: `osv-scan` (osv-scanner image, pinned by digest) scans the lockfiles that `setup` listed
// in OSV_LOCKFILES_FILE and writes OSV_REPORT_FILE; `osv-check` (node image, this runner) judges the report. osv-scanner asks
// osv.dev (no credentials). Fail closed: an unreachable osv.dev, a missing or unreadable report, a vulnerability with unknown
// severity and an out-of-policy ignore entry all fail the pipeline.

/** Written by `setup`: one repo-relative lockfile per line (empty file = nothing to scan). Read by the osv-scan step's shell. */
export const OSV_LOCKFILES_FILE = ".tb-ci/osv-lockfiles";
/** Written by the osv-scan step itself (never by the repo) and passed as `--config`: osv-scanner then reads NO repo-owned
 *  osv-scanner.toml (its default looks next to each lockfile and in parent folders), so an exception exists only as a policy-checked
 *  tealbrick-ci.json osvIgnore entry. */
export const OSV_CONFIG_FILE = ".tb-ci/osv-scanner.toml";
/** Written by the osv-scan step (osv-scanner `--format json`), read by `osv-check`. */
export const OSV_REPORT_FILE = ".tb-ci/osv.json";
/** CVSS base score thresholds (FIRST): HIGH 7.0-8.9, CRITICAL 9.0-10.0. A finding at or above OSV_HIGH fails the check. */
export const OSV_HIGH = 7.0;
export const OSV_CRITICAL = 9.0;
/** An osvIgnore entry may run at most this many days from the day the check runs (it must be renewed, with a new reason review). */
export const OSV_IGNORE_MAX_DAYS = 90;

/** `osvIgnore` in tealbrick-ci.json: a vulnerability a repo accepts for a limited time. `expires` is the first day the entry no longer applies. */
export interface OsvIgnore {
  id: string; // GHSA-, CVE- or OSV id; matches the finding's id or any of its aliases (case-insensitive)
  reason: string; // why the repo accepts it (>= 10 characters)
  expires: string; // YYYY-MM-DD (UTC): after the run date, and at most OSV_IGNORE_MAX_DAYS days after it
}

/** Shape check only (the date window depends on the run date and is judged by `osv-check`, see osvIgnoreProblems). */
export function parseOsvIgnore(raw: unknown): OsvIgnore[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('osvIgnore must be a list of { "id", "reason", "expires" }');
  if (raw.length > 50) throw new Error("osvIgnore: at most 50 entries");
  const seen = new Set<string>();
  return raw.map((e, i): OsvIgnore => {
    if (typeof e !== "object" || e === null || Array.isArray(e)) throw new Error(`osvIgnore[${i}] must be an object`);
    const r = e as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!["id", "reason", "expires"].includes(k)) throw new Error(`osvIgnore[${i}]: unknown field ${k}`);
    const { id, reason, expires } = r;
    if (typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9._:-]{1,80}$/.test(id))
      throw new Error(`osvIgnore[${i}].id must be a vulnerability id such as GHSA-xxxx-xxxx-xxxx or CVE-2026-12345, got ${JSON.stringify(id)}`);
    if (typeof reason !== "string" || reason.trim().length < 10) throw new Error(`osvIgnore[${i}].reason must say why in at least 10 characters`);
    if (typeof expires !== "string" || osvDay(expires) === null)
      throw new Error(`osvIgnore[${i}].expires must be a calendar date YYYY-MM-DD, got ${JSON.stringify(expires)}`);
    if (seen.has(id.toUpperCase())) throw new Error(`osvIgnore lists ${id} twice`);
    seen.add(id.toUpperCase());
    return { id, reason: reason.trim(), expires };
  });
}

/** Whole days since 1970-01-01 (UTC) of a YYYY-MM-DD calendar date; null when it is not a real date. */
function osvDay(s: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== s) return null;
  return t / 86_400_000;
}

/** Entries that are out of policy on the run date `today` (YYYY-MM-DD, UTC): expired, or expiring more than OSV_IGNORE_MAX_DAYS ahead. */
export function osvIgnoreProblems(ignores: OsvIgnore[], today: string): string[] {
  const t = osvDay(today);
  if (t === null) throw new Error(`osvIgnoreProblems: bad run date ${today}`);
  const out: string[] = [];
  for (const ig of ignores) {
    const e = osvDay(ig.expires) as number;
    if (e <= t)
      out.push(`osvIgnore ${ig.id}: expired on ${ig.expires} (today ${today}); fix the dependency, or renew the entry with a new date and a current reason`);
    else if (e - t > OSV_IGNORE_MAX_DAYS)
      out.push(
        `osvIgnore ${ig.id}: expires ${ig.expires}, more than ${OSV_IGNORE_MAX_DAYS} days after today (${today}); the latest allowed date is ${osvDayString(t + OSV_IGNORE_MAX_DAYS)}`,
      );
  }
  return out;
}
function osvDayString(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** The lockfiles osv-scan must scan: the pnpm or npm lockfile of every project path that has a package.json. Pure over `exists`
 *  and `read`. A lockfile that CLEARLY lists no package (osvLockfileEmpty) is left out: it has nothing to scan and osv-scanner
 *  exits 128 ("no packages found") on it, which the scan step treats as a failure. */
export function osvLockfiles(cfg: { paths: string[] }, exists: (rel: string) => boolean, read?: (rel: string) => string): string[] {
  const out: string[] = [];
  for (const p of cfg.paths) {
    const dir = posix.normalize(p);
    const at = (f: string): string => (dir === "." ? f : `${dir}/${f}`);
    if (!exists(at("package.json"))) continue;
    const lock = ["pnpm-lock.yaml", "package-lock.json"].find((f) => exists(at(f)));
    if (!lock || out.includes(at(lock))) continue;
    if (read && osvLockfileEmpty(lock, read(at(lock)))) continue;
    out.push(at(lock));
  }
  return out;
}

/** True only on POSITIVE evidence that the lockfile lists no package (fail closed: anything unclear is scanned). pnpm: the word
 *  `packages` does not occur at all, or its ONLY occurrence is a top-level line `packages: {}` (any other layout — indented,
 *  quoted, flow style — is scanned). npm (lockfileVersion >= 2): no `packages` entry other than the root "" and no
 *  `dependencies`. An unreadable or unparsable lockfile is NOT empty (osv-scanner then fails on it). */
export function osvLockfileEmpty(name: string, text: string): boolean {
  if (name === "pnpm-lock.yaml") {
    const n = text.match(/packages/g)?.length ?? 0;
    if (n === 0) return true;
    return n === 1 && /^packages:[ \t]*\{\}[ \t]*(#[^\r\n]*)?\r?$/m.test(text);
  }
  if (name === "package-lock.json") {
    try {
      const j = JSON.parse(text) as { lockfileVersion?: unknown; packages?: unknown; dependencies?: unknown };
      if (typeof j.lockfileVersion !== "number" || j.lockfileVersion < 2) return false;
      if (j.packages === null || typeof j.packages !== "object" || Array.isArray(j.packages)) return false;
      const deps = j.dependencies;
      if (deps !== undefined && (deps === null || typeof deps !== "object" || Object.keys(deps).length > 0)) return false;
      return Object.keys(j.packages).every((k) => k === "");
    } catch {
      return false;
    }
  }
  return false;
}

export type OsvSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
export interface OsvFinding {
  id: string;
  ids: string[]; // the id, its aliases and the ids of its osv-scanner group (what an osvIgnore entry may name), upper-case
  name: string;
  version: string;
  ecosystem: string;
  source: string; // lockfile path as osv-scanner saw it
  score: number | null; // CVSS base score, null when neither the report nor the advisory label gives one
  severity: OsvSeverity; // UNKNOWN counts as HIGH (fail closed)
  fixed: string[]; // fixed versions above the installed one, ascending
}

/** Score floor of an advisory's own severity label (GitHub: CRITICAL, HIGH, MODERATE, LOW; others: MEDIUM). */
function osvLabelScore(label: unknown): number | null {
  switch (typeof label === "string" ? label.trim().toUpperCase() : "") {
    case "CRITICAL":
      return OSV_CRITICAL;
    case "HIGH":
      return OSV_HIGH;
    case "MODERATE":
    case "MEDIUM":
      return 4.0;
    case "LOW":
      return 0.1;
    default:
      return null;
  }
}
export function osvSeverityOf(score: number | null): OsvSeverity {
  if (score === null) return "UNKNOWN";
  if (score >= OSV_CRITICAL) return "CRITICAL";
  if (score >= OSV_HIGH) return "HIGH";
  if (score >= 4.0) return "MEDIUM";
  return "LOW";
}
/** Does this finding fail the check (before ignores)? HIGH, CRITICAL and UNKNOWN. */
export function osvBlocks(sev: OsvSeverity): boolean {
  return sev === "CRITICAL" || sev === "HIGH" || sev === "UNKNOWN";
}

function osvStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function osvObj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`osv report: ${what} must be an object`);
  return v as Record<string, unknown>;
}

/** Reads an osv-scanner v2 `--format json` report: results[].packages[].vulnerabilities[] plus groups[] (ids, aliases, max_severity).
 *  Severity per vulnerability = the larger of the group's `max_severity` (CVSS base score, highest over the aliases) and the floor
 *  of the advisory's `database_specific.severity` label; neither present (or 0.0 and no label) = UNKNOWN. Throws on a report that is
 *  not in this shape (fail closed: a format change must not read as "no vulnerabilities"). */
export function parseOsvReport(raw: unknown): OsvFinding[] {
  const root = osvObj(raw, "the report");
  if (!Array.isArray(root.results)) throw new Error('osv report: "results" is missing (not an osv-scanner JSON report)');
  const out = new Map<string, OsvFinding>();
  for (const res of root.results) {
    const r = osvObj(res, "results[]");
    const source = typeof (r.source as { path?: unknown } | undefined)?.path === "string" ? (r.source as { path: string }).path : "?";
    if (!Array.isArray(r.packages)) throw new Error("osv report: results[].packages is missing");
    for (const pk of r.packages) {
      const p = osvObj(pk, "packages[]");
      const pkg = osvObj(p.package, "packages[].package");
      if (typeof pkg.name !== "string" || typeof pkg.version !== "string") throw new Error("osv report: packages[].package needs name and version");
      const ecosystem = typeof pkg.ecosystem === "string" ? pkg.ecosystem : "";
      const groups = (Array.isArray(p.groups) ? p.groups : []).map((g) => osvObj(g, "groups[]"));
      for (const vv of Array.isArray(p.vulnerabilities) ? p.vulnerabilities : []) {
        const v = osvObj(vv, "vulnerabilities[]");
        if (typeof v.id !== "string" || v.id === "") throw new Error(`osv report: a vulnerability of ${pkg.name}@${pkg.version} has no id`);
        const group = groups.find((g) => osvStrings(g.ids).includes(v.id as string) || osvStrings(g.aliases).includes(v.id as string));
        const groupScore = group && typeof group.max_severity === "string" ? Number.parseFloat(group.max_severity) : Number.NaN;
        const parts: number[] = [];
        if (Number.isFinite(groupScore) && groupScore > 0) parts.push(groupScore);
        const label = osvLabelScore((v.database_specific as { severity?: unknown } | undefined)?.severity);
        if (label !== null) parts.push(label);
        const score = parts.length ? Math.max(...parts) : null;
        const ids = [...new Set([v.id, ...osvStrings(v.aliases), ...osvStrings(group?.ids), ...osvStrings(group?.aliases)].map((x) => x.toUpperCase()))];
        const key = `${v.id}|${pkg.name}|${pkg.version}|${ecosystem}`;
        if (out.has(key)) continue; // the same package in two lockfiles is one finding
        out.set(key, {
          id: v.id,
          ids,
          name: pkg.name,
          version: pkg.version,
          ecosystem,
          source,
          score,
          severity: osvSeverityOf(score),
          fixed: osvFixedVersions(v.affected, pkg.name, ecosystem, pkg.version),
        });
      }
    }
  }
  return [...out.values()];
}

/** Fixed versions (above the installed one) that the advisory names for this package, ascending. */
function osvFixedVersions(affected: unknown, name: string, ecosystem: string, installed: string): string[] {
  const fixed = new Set<string>();
  for (const a of Array.isArray(affected) ? affected : []) {
    const pk = (a as { package?: { name?: unknown; ecosystem?: unknown } }).package;
    if (!pk || pk.name !== name || (ecosystem !== "" && pk.ecosystem !== ecosystem)) continue;
    for (const rg of ((a as { ranges?: unknown }).ranges as unknown[] | undefined) ?? []) {
      for (const ev of ((rg as { events?: unknown }).events as unknown[] | undefined) ?? []) {
        const f = (ev as { fixed?: unknown }).fixed;
        if (typeof f === "string" && (!/^\d+\.\d+\.\d+/.test(f) || osvCmp(f, installed) > 0)) fixed.add(f);
      }
    }
  }
  return [...fixed].sort(osvCmp);
}
function osvCmp(a: string, b: string): number {
  const [x, y] = [semverCore(a), semverCore(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return 0;
}

export interface OsvVerdict {
  blocking: OsvFinding[]; // HIGH / CRITICAL / UNKNOWN with no valid ignore
  ignored: { finding: OsvFinding; ignore: OsvIgnore }[];
  info: OsvFinding[]; // LOW / MEDIUM, printed only
  stale: OsvIgnore[]; // entries that match no finding
  problems: string[]; // ignore entries out of policy (expired, > 90 days): these fail the check and do not apply
}

/** The decision of osv-check, pure. `today` is the run date (YYYY-MM-DD, UTC). */
export function osvVerdict(findings: OsvFinding[], ignores: OsvIgnore[], today: string): OsvVerdict {
  const problems = osvIgnoreProblems(ignores, today);
  const badIds = new Set(ignores.filter((ig) => osvIgnoreProblems([ig], today).length > 0).map((ig) => ig.id));
  const valid = ignores.filter((ig) => !badIds.has(ig.id));
  const blocking: OsvFinding[] = [];
  const ignored: OsvVerdict["ignored"] = [];
  const info: OsvFinding[] = [];
  const used = new Set<string>();
  for (const f of findings) {
    const hit = valid.find((ig) => f.ids.includes(ig.id.toUpperCase()));
    if (osvBlocks(f.severity)) {
      if (hit) {
        ignored.push({ finding: f, ignore: hit });
        used.add(hit.id);
      } else blocking.push(f);
    } else info.push(f);
  }
  // an entry is also in use when it names a LOW/MEDIUM finding, or one that an expired entry would have covered
  for (const ig of ignores) if (findings.some((f) => f.ids.includes(ig.id.toUpperCase()))) used.add(ig.id);
  return { blocking, ignored, info, stale: ignores.filter((ig) => !used.has(ig.id)), problems };
}

const OSV_RANK: Record<OsvSeverity, number> = { CRITICAL: 4, UNKNOWN: 3, HIGH: 3, MEDIUM: 2, LOW: 1 };
/** The table osv-check prints: id, package@version, severity (with score), fixed version, status. */
export function osvTable(v: OsvVerdict): string {
  const rows: string[][] = [["ID", "PACKAGE@VERSION", "SEVERITY", "FIXED IN", "STATUS"]];
  const sorted = (xs: OsvFinding[]): OsvFinding[] =>
    [...xs].sort((a, b) => OSV_RANK[b.severity] - OSV_RANK[a.severity] || (b.score ?? 10) - (a.score ?? 10) || a.id.localeCompare(b.id));
  const row = (f: OsvFinding, status: string): string[] => [
    f.id,
    `${f.name}@${f.version}`,
    f.score === null ? "UNKNOWN (counts as HIGH)" : `${f.severity} ${f.score.toFixed(1)}`,
    f.fixed.length ? f.fixed.join(", ") : "-",
    status,
  ];
  for (const f of sorted(v.blocking)) rows.push(row(f, "FAIL"));
  for (const { finding, ignore } of v.ignored) rows.push(row(finding, `ignored until ${ignore.expires}: ${ignore.reason}`));
  for (const f of sorted(v.info)) rows.push(row(f, "info"));
  const w = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] as string).length))) ?? [];
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i] as number))).join("  ")).join("\n");
}

function cmdOsvCheck(args: string[]): void {
  const file = args[0];
  if (!file) fail("usage: osv-check <osv-scanner report.json>");
  const root = repoRoot();
  const cfg = loadConfig(root);
  const today = new Date().toISOString().slice(0, 10);
  const expected = osvLockfiles(
    cfg,
    (rel) => existsSync(join(root, rel)),
    (rel) => readFileSync(join(root, rel), "utf8"),
  );
  let findings: OsvFinding[] = [];
  if (expected.length === 0) log("osv-check: no node lockfile in this repo (no package.json under tealbrick-ci.json paths); nothing was scanned");
  else {
    if (!existsSync(resolve(root, file)))
      fail(`osv-check: ${file} does not exist: the osv-scan step did not write its report (osv.dev unreachable?). Failing closed.`);
    try {
      findings = parseOsvReport(JSON.parse(readFileSync(resolve(root, file), "utf8")));
    } catch (e) {
      fail(`osv-check: cannot read ${file}: ${(e as Error).message}. Failing closed.`);
    }
    log(`osv-check: report ${file} for ${expected.join(", ")}: ${findings.length} vulnerability finding(s)`);
  }
  const v = osvVerdict(findings, cfg.osvIgnore, today);
  if (findings.length) console.log(osvTable(v));
  for (const ig of v.stale) log(`WARNING: osvIgnore ${ig.id} matches no vulnerability in this scan (stale); remove it`);
  const problems = [...v.problems];
  if (v.blocking.length)
    problems.push(
      `${v.blocking.length} HIGH/CRITICAL/unknown-severity vulnerabilit${v.blocking.length === 1 ? "y" : "ies"} (CVSS >= ${OSV_HIGH.toFixed(1)}; unknown counts as HIGH): update the dependency to the FIXED IN version, or accept it for a limited time with an osvIgnore entry in tealbrick-ci.json`,
    );
  if (problems.length) fail(`\n  - ${problems.join("\n  - ")}`);
  log(`osv-check OK (${v.info.length} LOW/MEDIUM printed only, ${v.ignored.length} ignored)`);
}

/** gh-build: frozen, script-free install of every node path (checks may import the repo's dependencies). */
function installAllPaths(cfg: CiConfig, root: string): void {
  for (const p of nodePaths(cfg, root)) {
    const dir = join(root, p);
    if (packageManager(dir) === "pnpm") sh("corepack", ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"], dir);
    else sh("npm", ["ci", "--ignore-scripts"], dir);
  }
}

/** Collects `<dir>/*.tgz` built by an earlier tokenless step: [file name, bytes]. Names are checked, content is the repo's own. */
function builtTarballs(dir: string, nameRe: RegExp): [string, Buffer][] {
  if (!existsSync(dir)) return [];
  const out: [string, Buffer][] = [];
  for (const sub of readdirSync(dir, { withFileTypes: true })) {
    const files = sub.isDirectory() ? readdirSync(join(dir, sub.name)).map((f) => join(sub.name, f)) : [sub.name];
    for (const rel of files) {
      const name = rel.split("/").pop() as string;
      if (!name.endsWith(".tgz")) continue;
      if (!nameRe.test(name)) fail(`unexpected tarball name ${name}`);
      out.push([name, readFileSync(join(dir, rel))]);
    }
  }
  return out;
}

/** D1/C56: report every opt2 repo's template ref on main; fails if any is missing or below the minimum. */
async function cmdAuditTemplates(): Promise<void> {
  const min = (await fetchText(`https://raw.githubusercontent.com/${OWNER}/${PLATFORM_REPO}/main/${MIN_TEMPLATE_PATH}`)).trim();
  const bad: string[] = [];
  for (const repo of OPT2_REPOS) {
    const rd = repoReader(repo); // C154: private repos with TB_PRIVATE_READ_TOKEN when this runner has it
    const res = await rd.file(".woodpecker/ci.yaml", "main");
    const ref = res.text !== null ? (/TB_CI_REF: (\S+)/.exec(res.text)?.[1] ?? "none") : "none";
    const verdict = auditVerdict(repo, res.status, rd.via, ref, min);
    if (verdict === "PEND") log(`PEND ${repo}: no GitHub repo yet (PENDING_REPOS); skipped`);
    else if (verdict === "SKIP")
      log(`SKIP ${repo}: private and no ${PRIVATE_READ_TOKEN_ENV} on this runner; its own pipeline setup step enforces ${MIN_TEMPLATE_PATH}`);
    else log(`${verdict === "OK" ? "OK  " : "FAIL"} ${repo}: ${res.status === 200 ? ref : `HTTP ${res.status}`}`);
    if (verdict === "FAIL") bad.push(`${repo} (${res.status === 200 ? ref : `HTTP ${res.status}`})`);
  }
  if (bad.length) fail(`below minimum ${min} or denied (${Object.keys(DENIED_TEMPLATES).join(", ")}): ${bad.join(", ")}`);
  log(`all ${OPT2_REPOS.length} repos at or above ${min}`);
}

// ---------- GitHub Actions release publishing (C72): no personal token ----------

export const GH_WORKFLOW_PATH = ".github/workflows/opt2-release.yml";
/** ci-v9.10 (C222): the Woodpecker release workflow of repos with "releaseOn": "woodpecker" (byte copy of ci/woodpecker/release.yaml). */
export const WP_RELEASE_PATH = ".woodpecker/release.yaml";
/** ci-v9.10 (C222): the Woodpecker repo secret the release-publish step (and only that step) reads. Created by Martin by hand. */
export const WP_RELEASE_SECRET = "tb_release_token";
/** ci-v9.11 (C232): the Woodpecker repo secret the release-image-push step (and only that step) reads: a classic PAT with
 *  write:packages ONLY, of a machine user that can write one package (design: coordination/leads/platform/contracts/GHCR-FROM-WOODPECKER.md). */
export const WP_GHCR_SECRET = "tb_ghcr_token";

/** ci-v9.10 (C222): exactly one publisher per tag. Pure. */
export function releaseFileProblems(releaseOn: ReleaseOn, releases: boolean, hasGhWorkflow: boolean, hasWpRelease: boolean): string[] {
  const out: string[] = [];
  if (releaseOn === "woodpecker") {
    if (hasGhWorkflow)
      out.push(
        `${GH_WORKFLOW_PATH} must not exist with "releaseOn": "woodpecker" (C222: one publisher per tag; Actions do not start in private repos): re-run adopt`,
      );
    if (!hasWpRelease) out.push(`${WP_RELEASE_PATH} is required with "releaseOn": "woodpecker" (C222): re-run adopt`);
  } else {
    if (hasWpRelease) out.push(`${WP_RELEASE_PATH} needs "releaseOn": "woodpecker" in tealbrick-ci.json (one publisher per tag)`);
    if ((releases || hasGhWorkflow) && !hasGhWorkflow) out.push(`${GH_WORKFLOW_PATH} is required for a releasing repo (C72): re-run adopt`);
  }
  return out;
}
const KIT_NAME_RE = /^opt2-tealbrick-[a-z0-9-]+-kit-\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?\.tgz$/;
const PKG_NAME_RE = /^[a-z0-9-]+-\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?\.tgz$/;

/** A repo publishes releases when it declares images, is a miniapp (kit) or is a pnpm workspace (package tarballs). */
export function repoReleases(cfg: CiConfig, root: string): boolean {
  return cfg.images.length > 0 || cfg.kind === "miniapp" || cfg.paths.some((p) => existsSync(join(root, p, "pnpm-workspace.yaml")));
}

export interface GhPlan {
  schema: "opt2.gh-release-plan/v1";
  repo: string;
  tag: string;
  commit: string;
  images: { name: string; tar: string; version: string }[];
  assets: string[]; // file names in assets/
}

/** Build job (read-only token): docker build each image to a tarball with OCI labels, build the kit, pack the package. */
async function cmdGhBuild(): Promise<void> {
  const root = repoRoot();
  const cfg = loadConfig(root);
  if (cfg.releaseOn === "woodpecker" && !wpBuildActive)
    fail('C222: this repo releases on Woodpecker ("releaseOn": "woodpecker"); the GitHub Actions release must not publish it too');
  const repo = repoName(root);
  const tag = process.env.CI_COMMIT_TAG;
  const commit = process.env.CI_COMMIT_SHA;
  if (!tag || !commit || !/^[0-9a-f]{40}$/.test(commit)) fail("gh-build needs CI_COMMIT_TAG and CI_COMMIT_SHA");
  for (const k of ["GITHUB_TOKEN", "GH_TOKEN", "GHCR_TOKEN"]) if (process.env[k]) fail(`C72: gh-build must run without ${k}`);
  const out = join(root, ".tb-ci/out");
  mkdirSync(join(out, "images"), { recursive: true });
  mkdirSync(join(out, "assets"), { recursive: true });
  const plan: GhPlan = { schema: "opt2.gh-release-plan/v1", repo, tag, commit, images: [], assets: [] };
  const appTag = /^v(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/.exec(tag);
  if (appTag) {
    const version = appTag[1];
    if (cfg.preReleaseChecks.length > 0) {
      installAllPaths(cfg, root);
      runPreReleaseChecks(cfg, root);
    }
    const full = repoFullName(repo); // C206: the repo this Action runs in; its owner's ghcr namespace is the only one it can push to
    const ns = imageNamespace(full.split("/")[0]);
    for (const im of cfg.images) {
      if (wpBuildActive) {
        // ci-v9.11 (C232): Woodpecker has no docker daemon: the release-image step (kaniko --no-push --tar-path) builds the tarball
        // from the script wp-build writes at the end; the plan only names it
        plan.images.push({ name: im.name, tar: `${im.name}.tar`, version });
        continue;
      }
      const ref = `${ns}/${im.name}:${version}`;
      sh(
        "docker",
        [
          "build",
          "-f",
          im.dockerfile,
          "-t",
          ref,
          "--label",
          `org.opencontainers.image.source=https://github.com/${full}`,
          "--label",
          `org.opencontainers.image.revision=${commit}`,
          "--label",
          `org.opencontainers.image.version=${version}`,
          im.context,
        ],
        root,
      );
      sh("docker", ["save", "-o", join(out, "images", `${im.name}.tar`), ref], root);
      plan.images.push({ name: im.name, tar: `images/${im.name}.tar`, version });
    }
    if (cfg.kind === "miniapp") {
      for (const p of nodePaths(cfg, root)) {
        const dir = join(root, p);
        if (packageManager(dir) === "pnpm") sh("corepack", ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"], dir);
        else sh("npm", ["ci", "--ignore-scripts"], dir);
        pmExec(dir, "tb-gen", ["kit", "--build", "--out", join(out, "assets")]);
      }
    }
  } else {
    let parsed: { dir: string; version: string } | null = null;
    try {
      parsed = parsePackageTag(tag);
    } catch {
      parsed = null;
    }
    if (parsed && !(repo === PLATFORM_REPO && tag.startsWith("ci-v"))) {
      const target = packTarget(cfg, root, tag);
      const rootScripts = (readJson(join(target.projectDir, "package.json")).scripts ?? {}) as Record<string, unknown>;
      const dirs = nodePaths(cfg, root).map((p) => ({ dir: join(root, p), pm: packageManager(join(root, p)) }));
      // ci-v9.1 (C75): install, then BUILD, then pack (still read-only token); the pack guard checks dist/ is in the tarball
      for (const c of packageReleaseCommands(dirs, target.projectDir, rootScripts, target.name)) sh(c.cmd, c.args, c.cwd);
      runPreReleaseChecks(cfg, root); // ci-v9.6: after install + build, before the tarball is packed
      const packScript = Object.hasOwn(cfg.packScripts, parsed.dir) ? cfg.packScripts[parsed.dir] : undefined;
      if (packScript) {
        // ci-v9.7: the repo's own pack script replaces `npm pack` for this package (e.g. the bundled CLI tarball, C173)
        const dir = join(root, ".tb-ci/pack-script");
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        log(`gh-build: node ${packScript} --out ${dir} (packScripts.${parsed.dir})`);
        try {
          execFileSync(process.execPath, [packScript, "--out", dir], { cwd: root, stdio: "inherit", env: preReleaseEnv(cfg, process.env), timeout: 1_200_000 });
        } catch {
          fail(`pack script ${packScript} failed`);
        }
        const files = new Map(readdirSync(dir).map((f) => [f, new Uint8Array(readFileSync(join(dir, f)))] as const));
        const problems = packScriptOutputProblems(files, target.name, target.version);
        if (problems.length) fail(`packScripts.${parsed.dir} (ci-v9.7):\n  - ${problems.join("\n  - ")}`);
        const file = tarballName(target.name, target.version);
        writeFileSync(join(out, "assets", file), files.get(file) as Uint8Array);
        log(`packed ${file} with ${packScript}; name/version + pack guard OK`);
      } else {
        await cmdPackagePack();
        for (const [name, data] of builtTarballs(join(root, ".tb-ci/pack"), PKG_NAME_RE)) writeFileSync(join(out, "assets", name), data);
      }
    }
  }
  plan.assets = readdirSync(join(out, "assets")).filter((f) => f.endsWith(".tgz"));
  writeFileSync(join(out, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  log(`gh-build: ${plan.images.length} image(s), ${plan.assets.length} asset(s)`);
}

/** Publish job (packages: write, contents: write): runs no repo code. Pushes images, prints digests, attaches assets. */
async function cmdGhPublish(): Promise<void> {
  const out = resolve(process.env.TB_OUT ?? "out");
  const repo = process.env.CI_REPO_NAME;
  const tag = process.env.CI_COMMIT_TAG;
  const commit = process.env.CI_COMMIT_SHA;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !tag || !commit || !token) fail("gh-publish needs CI_REPO_NAME, CI_COMMIT_TAG, CI_COMMIT_SHA, GITHUB_TOKEN");
  const plan = JSON.parse(readFileSync(join(out, "plan.json"), "utf8")) as GhPlan;
  if (plan.schema !== "opt2.gh-release-plan/v1" || plan.repo !== repo || plan.tag !== tag || plan.commit !== commit) fail("plan does not match this run");
  if (plan.images.length) {
    execFileSync("docker", ["login", REGISTRY_HOST, "-u", process.env.GH_ACTOR ?? OWNER, "--password-stdin"], {
      input: token,
      stdio: ["pipe", "inherit", "inherit"],
    });
    const ns = imageNamespace(repoFullName(repo).split("/")[0]); // C206: same namespace gh-build tagged the images with
    for (const im of plan.images) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(im.name) || !(im.name === repo || im.name.startsWith(`${repo}-`))) fail(`image ${im.name} does not belong to ${repo}`);
      if (im.tar !== `images/${im.name}.tar`) fail(`unexpected tar path ${im.tar}`);
      const ref = `${ns}/${im.name}:${im.version}`;
      execFileSync("docker", ["load", "-i", join(out, im.tar)], { stdio: "inherit" });
      execFileSync("docker", ["tag", ref, `${ns}/${im.name}:sha-${commit}`], { stdio: "inherit" });
      execFileSync("docker", ["push", ref], { stdio: "inherit" });
      execFileSync("docker", ["push", `${ns}/${im.name}:sha-${commit}`], { stdio: "inherit" });
      const digest = execFileSync("docker", ["inspect", "--format", "{{index .RepoDigests 0}}", ref], { encoding: "utf8" }).trim();
      log(`pushed ${digest} (the platform signer re-resolves digests in ghcr; this line is information only)`);
    }
    execFileSync("docker", ["logout", REGISTRY_HOST], { stdio: "inherit" });
  }
  if (plan.assets.length) {
    const prerelease = /-v?\d+\.\d+\.\d+-/.test(tag) || /^v\d+\.\d+\.\d+-/.test(tag);
    const rel = await ensureRelease(repo, tag, prerelease);
    for (const name of plan.assets) {
      if (!KIT_NAME_RE.test(name) && !PKG_NAME_RE.test(name)) fail(`unexpected asset name ${name}`);
      const data = readFileSync(join(out, "assets", name));
      const sums = assetChecksums(name, data);
      await uploadFile(repo, rel, name, data, "application/gzip");
      for (const f of sums.files) await uploadFile(repo, rel, f.name, Buffer.from(f.body), "text/plain");
      log(`attached ${name} (sha256 ${sums.sha256}, integrity ${sums.integrity})`);
    }
  }
  log(`gh-publish: done (${plan.images.length} image(s), ${plan.assets.length} asset(s))`);
}

// ---------- Woodpecker release publishing (C222): private repos, no GitHub Actions ----------

/** Set by wp-build only: cmdGhBuild then builds a repo whose config says releaseOn "woodpecker" (or an older tag of it). */
let wpBuildActive = false;
const RELEASE_TAG_RE = /^(v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?|[a-z0-9][a-z0-9-]*-v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/;

export interface WpReleaseEnv {
  event: string; // CI_PIPELINE_EVENT
  branch: string; // CI_COMMIT_BRANCH (manual pipelines)
  commitTag: string; // CI_COMMIT_TAG (tag pipelines)
  commitSha: string; // CI_COMMIT_SHA
  releaseTag: string; // TB_RELEASE_TAG (manual pipelines: re-release an existing tag)
}

export function wpReleaseEnv(env: NodeJS.ProcessEnv): WpReleaseEnv {
  return {
    event: env.CI_PIPELINE_EVENT ?? "",
    branch: env.CI_COMMIT_BRANCH ?? "",
    commitTag: env.CI_COMMIT_TAG ?? "",
    commitSha: env.CI_COMMIT_SHA ?? "",
    releaseTag: env.TB_RELEASE_TAG ?? "",
  };
}

/** ci-v9.10 (C222): the tag + commit a Woodpecker release builds and publishes. A tag pipeline releases its own tag; a manual
 *  pipeline on main re-releases an EXISTING tag named by TB_RELEASE_TAG (the tag was cut before the repo adopted this template).
 *  `tagCommit` answers the commit a tag points at (null = no such tag). A tag is never created or moved. Pure. */
export function wpReleaseTarget(e: WpReleaseEnv, tagCommit: (tag: string) => string | null): { tag: string; commit: string } | string {
  let tag: string;
  if (e.event === "tag") {
    tag = e.commitTag;
    if (e.releaseTag && e.releaseTag !== tag) return `TB_RELEASE_TAG ${e.releaseTag} != the pipeline tag ${tag}`;
  } else if (e.event === "manual") {
    if (e.branch !== "main") return `a manual release runs on main only (got branch ${JSON.stringify(e.branch)})`;
    tag = e.releaseTag;
    if (!tag) return "a manual release needs the variable TB_RELEASE_TAG=<existing tag>";
  } else return `the Woodpecker release runs on tag and manual events only (got ${JSON.stringify(e.event)})`;
  if (!RELEASE_TAG_RE.test(tag)) return `tag ${JSON.stringify(tag)} is not v<semver> or <package>-v<semver>`;
  const commit = tagCommit(tag);
  if (!commit) return `tag ${tag} does not exist (the release never creates a tag)`;
  if (!/^[0-9a-f]{40}$/.test(commit)) return `tag ${tag}: unexpected commit ${JSON.stringify(commit)}`;
  if (e.event === "tag" && commit !== e.commitSha) return `tag ${tag} points at ${commit}, the pipeline ran for ${e.commitSha}`;
  return { tag, commit };
}

/** ci-v9.10 (C222): a published asset is never replaced. Same bytes = skip, other bytes = alarm, none = upload. Pure. */
export function assetDecision(existing: Uint8Array | null, data: Uint8Array): "upload" | "same" | "conflict" {
  if (existing === null) return "upload";
  const h = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  return h(existing) === h(data) ? "same" : "conflict";
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-c", "safe.directory=*", "-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitTagCommit(root: string, tag: string): string | null {
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]) || null;
  } catch {
    return null;
  }
}

/** Woodpecker release-build step (NO token): check out the tagged commit, then the same build as gh-build. */
async function cmdWpBuild(): Promise<void> {
  for (const k of ["GITHUB_TOKEN", "GH_TOKEN", "GHCR_TOKEN"]) if (process.env[k]) fail(`C222: wp-build must run without ${k}`);
  const root = repoRoot();
  const target = wpReleaseTarget(wpReleaseEnv(process.env), (tag) => gitTagCommit(root, tag));
  if (typeof target === "string") fail(target);
  if (git(root, ["rev-parse", "HEAD"]) !== target.commit) {
    const dirty = git(root, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty) fail(`the workspace has tracked changes; refusing to check out ${target.tag}:\n${dirty}`);
    git(root, ["-c", "advice.detachedHead=false", "checkout", "--detach", "--quiet", target.commit]);
    log(`wp-build: checked out ${target.tag} = ${target.commit} (manual re-release)`);
  }
  process.env.CI_COMMIT_TAG = target.tag;
  process.env.CI_COMMIT_SHA = target.commit;
  wpBuildActive = true;
  await cmdGhBuild();
  // ci-v9.11 (C232): the kaniko step's script, written LAST (after every repo script ran). It holds no secret and names the tag's images.
  const cfg = loadConfig(root);
  const full = `${OWNER}/${repoName(root)}`;
  const appVersion = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(target.tag)?.[1] ?? null;
  writeFileSync(join(root, WP_IMAGE_SCRIPT), renderReleaseImagesScript(appVersion ? cfg.images : [], full, appVersion ?? "", target.commit), { mode: 0o755 });
  log(`wp-build: wrote ${WP_IMAGE_SCRIPT} (${appVersion ? cfg.images.length : 0} image(s) for ${target.tag})`);
}

async function ghBytes(path: string): Promise<{ status: number; data: Uint8Array }> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) fail("GITHUB_TOKEN is missing");
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/octet-stream", "x-github-api-version": "2022-11-28" },
    redirect: "follow", // the asset host is another origin: fetch drops the authorization header on that hop
  });
  return { status: res.status, data: new Uint8Array(await res.arrayBuffer()) };
}

/** The commit a tag points at on GitHub (annotated tags followed), or null if the tag does not exist. */
async function githubTagCommit(full: string, tag: string): Promise<string | null> {
  const ref = await gh("GET", `/repos/${full}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (ref.status === 404) return null;
  if (ref.status !== 200) fail(`read tag ${tag}: HTTP ${ref.status}`);
  let obj = ref.json?.object as { type?: string; sha?: string } | undefined;
  for (let i = 0; i < 3 && obj?.type === "tag"; i++) {
    const t = await gh("GET", `/repos/${full}/git/tags/${obj.sha}`);
    if (t.status !== 200) fail(`read annotated tag ${tag}: HTTP ${t.status}`);
    obj = t.json?.object;
  }
  return obj?.type === "commit" && typeof obj.sha === "string" ? obj.sha : null;
}

/** Upload `name` once: never delete or replace a published asset (C222; the dist mirror alarms on changed bytes). */
async function publishAssetOnce(full: string, rel: GhRelease, name: string, data: Buffer, contentType: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const list = await gh("GET", `/repos/${full}/releases/${rel.id}/assets?per_page=100`);
    if (list.status !== 200 || !Array.isArray(list.json)) fail(`list assets of release ${rel.id}: HTTP ${list.status}`);
    const found = (list.json as Array<{ id: number; name: string }>).find((a) => a.name === name);
    let existing: Uint8Array | null = null;
    if (found) {
      const got = await ghBytes(`/repos/${full}/releases/assets/${found.id}`);
      if (got.status !== 200) fail(`download asset ${name}: HTTP ${got.status}`);
      existing = got.data;
    }
    const d = assetDecision(existing, data);
    if (d === "same") {
      log(`asset ${name}: already published with the same bytes; skipped`);
      return;
    }
    if (d === "conflict") fail(`ALARM: asset ${name} is already published with OTHER bytes; a release asset is never replaced (cut the next version)`);
    let target: { host: string; path: string };
    try {
      target = uploadTarget(rel.uploadUrl, name);
    } catch (e) {
      fail((e as Error).message);
    }
    const up = await gh("POST", target.path, undefined, { host: target.host, contentType, raw: data });
    if (up.status === 201) return;
    log(`upload asset ${name}: HTTP ${up.status} (attempt ${attempt}/3)`);
    if (up.status !== 422) break; // 422 = a concurrent upload landed: re-read and compare
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  fail(`upload asset ${name}: failed`);
}

/** Woodpecker release-publish step (repo secret tb_release_token; runs NO repo code): attach the planned tarballs. */
async function cmdWpPublish(): Promise<void> {
  const outEnv = process.env.TB_OUT;
  const ws = process.env.CI_WORKSPACE;
  if (!outEnv || !ws) fail("wp-publish needs TB_OUT and CI_WORKSPACE");
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
  const cwd = real(process.cwd());
  const wsReal = real(ws);
  if (cwd === wsReal || cwd.startsWith(`${wsReal}/`)) fail("wp-publish must run outside the workspace (it runs no repo code)");
  const out = resolve(outEnv);
  const repo = process.env.CI_REPO_NAME;
  if (process.env.GHCR_TOKEN) fail(`C232: wp-publish must run without GHCR_TOKEN (the secret ${WP_GHCR_SECRET} belongs to release-image-push only)`);
  if (!repo || !process.env.GITHUB_TOKEN) fail(`wp-publish needs CI_REPO_NAME and the secret ${WP_RELEASE_SECRET} (as GITHUB_TOKEN)`);
  const full = `${OWNER}/${repo}`;
  if (process.env.CI_REPO && process.env.CI_REPO !== full) fail(`CI_REPO ${process.env.CI_REPO} != ${full}`);
  const env = wpReleaseEnv(process.env);
  const wanted = env.event === "manual" ? env.releaseTag : env.commitTag;
  const onGitHub = RELEASE_TAG_RE.test(wanted) ? await githubTagCommit(full, wanted) : null;
  const target = wpReleaseTarget(env, (t) => (t === wanted ? onGitHub : null));
  if (typeof target === "string") fail(target);
  const plan = JSON.parse(readFileSync(join(out, "plan.json"), "utf8")) as GhPlan;
  if (plan.schema !== "opt2.gh-release-plan/v1" || plan.repo !== repo || plan.tag !== target.tag || plan.commit !== target.commit)
    fail(`plan (${plan.repo} ${plan.tag} ${plan.commit}) does not match the tag on GitHub (${repo} ${target.tag} ${target.commit})`);
  if (!plan.assets.length && !plan.images.length) {
    log(`wp-publish: nothing to publish for ${target.tag}`);
    return;
  }
  const prerelease = /-v?\d+\.\d+\.\d+-/.test(target.tag) || /^v\d+\.\d+\.\d+-/.test(target.tag);
  const rel = await ensureRelease(repo, target.tag, prerelease);
  if (plan.images.length) {
    // ci-v9.11 (C232): the images were pushed by release-image-push; the digests it wrote are data. The declared images come from the
    // config AT THE TAG COMMIT on GitHub, never from the workspace.
    const cfgRes = await gh("GET", `/repos/${full}/contents/tealbrick-ci.json?ref=${target.commit}`);
    if (cfgRes.status !== 200 || typeof cfgRes.json?.content !== "string") fail(`read tealbrick-ci.json at ${target.commit}: HTTP ${cfgRes.status}`);
    let cfg: CiConfig;
    try {
      cfg = validateConfig(JSON.parse(Buffer.from(cfgRes.json.content, "base64").toString("utf8")), repo);
    } catch (e) {
      fail(`tealbrick-ci.json at ${target.commit}: ${(e as Error).message}`);
    }
    const doc = await wpCandidateDoc(cfg, repo, target.tag, target.commit, plan, out);
    if (doc === null) log("wp-publish: no app/bridge image in this release; no release-candidate.json");
    else await publishAssetOnce(full, rel, CANDIDATE_ASSET, Buffer.from(`${JSON.stringify(doc, null, 2)}\n`), "application/json");
  }
  for (const name of plan.assets) {
    if (!KIT_NAME_RE.test(name) && !PKG_NAME_RE.test(name)) fail(`unexpected asset name ${name}`);
    const data = readFileSync(join(out, "assets", name));
    const sums = assetChecksums(name, data);
    // checksum files first: the signer treats a release without the tarball as pending, never as a red run
    for (const f of sums.files) await publishAssetOnce(full, rel, f.name, Buffer.from(f.body), "text/plain");
    await publishAssetOnce(full, rel, name, data, "application/gzip");
    log(`attached ${name} to ${full} ${target.tag} (sha256 ${sums.sha256}, integrity ${sums.integrity})`);
  }
  log(`wp-publish: done (${plan.assets.length} asset(s)); registry-sync indexes it, the dist mirror copies it`);
}

// ---------- Woodpecker image releases (C232, ci-v9.11): kaniko --no-push builds, crane pushes ----------
// Design: coordination/leads/platform/contracts/GHCR-FROM-WOODPECKER.md. GHCR takes a push from outside Actions only with a classic
// PAT (write:packages) of a machine user that can write ONE package. The steps (release.yaml):
//   release-build       repo code, no secret   wp-build records the images in the plan and writes WP_IMAGE_SCRIPT (last)
//   release-image       kaniko, no secret      builds each image from the tagged commit, linux/amd64, to .tb-ci/out/<image>.tar (no push)
//   release-image-push  NO repo code, the ONLY step with tb_ghcr_token   wp-push (this runner, hash-checked, in /tmp)
//   release-publish     NO repo code, the ONLY step with tb_release_token   wp-publish attaches release-candidate.json (image@digest)

/** The script release-build leaves for the kaniko step (generated after all repo code ran; the step runs it with busybox sh). */
export const WP_IMAGE_SCRIPT = ".tb-ci/release-images.sh";
/** The release asset that names the pushed images (schema opt2.release-candidate/v1, the signer's own document). */
export const CANDIDATE_ASSET = "release-candidate.json";
export const KANIKO_PLATFORM = "linux/amd64";
/** crane (go-containerregistry) release tarball for the Woodpecker agent (linux/amd64). The sha256 is the one in the release's own
 *  checksums.txt, checked again by hand when the version changed. The runner (itself hash-checked) refuses any other bytes. */
export const CRANE_VERSION = "v0.22.1";
export const CRANE_URL = `https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_Linux_x86_64.tar.gz`;
export const CRANE_SHA256 = "0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0";
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const IMAGE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Escapes a value for the inside of a double-quoted sh string. */
function dq(v: string): string {
  return v.replace(/[\\"$`]/g, "\\$&");
}

/** The kaniko step's script for one tag: builds every declared image from the checked-out TAGGED commit without pushing, with the
 *  labels the Actions path sets (source, revision, version; registry-sync's verifyImageProvenance needs source + revision). Pure. */
export function renderReleaseImagesScript(images: readonly ImageSpec[], full: string, version: string, commit: string): string {
  const lines = [
    "#!/bin/sh",
    "# generated by tb-ci wp-build (C232); runs in the kaniko debug image (busybox sh); holds no credentials; never pushes",
    "set -eu",
  ];
  if (images.length === 0) {
    lines.push('echo "tb-ci: no images for this tag; nothing to build"', "exit 0");
    return `${lines.join("\n")}\n`;
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`bad commit ${JSON.stringify(commit)}`);
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`bad version ${JSON.stringify(version)}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(full)) throw new Error(`bad repo ${JSON.stringify(full)}`);
  const ns = imageNamespace(full.split("/")[0] as string);
  lines.push('mkdir -p "$CI_WORKSPACE/.tb-ci/out"');
  for (const im of images) {
    if (!IMAGE_NAME_RE.test(im.name)) throw new Error(`bad image name ${JSON.stringify(im.name)}`);
    lines.push(
      `echo "tb-ci: release image ${im.name} ${version} (kaniko --no-push, ${KANIKO_PLATFORM})"`,
      [
        "/kaniko/executor --no-push",
        `--context "$CI_WORKSPACE/${dq(im.context)}"`,
        `--dockerfile "$CI_WORKSPACE/${dq(im.dockerfile)}"`,
        `--destination ${ns}/${im.name}:${version}`,
        `--custom-platform ${KANIKO_PLATFORM}`,
        `--label org.opencontainers.image.source=https://github.com/${full}`,
        `--label org.opencontainers.image.revision=${commit}`,
        `--label org.opencontainers.image.version=${version}`,
        `--tar-path "$CI_WORKSPACE/.tb-ci/out/${im.name}.tar"`,
        "--cleanup --verbosity info",
      ].join(" "),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The OCI labels of the single image in a `docker save` / kaniko tarball. `readEntry` returns one member of the tarball. Pure. */
export function labelsFromImageTar(readEntry: (member: string) => Buffer): Record<string, string> {
  const manifest = JSON.parse(readEntry("manifest.json").toString("utf8")) as unknown;
  const config = Array.isArray(manifest) && manifest.length === 1 ? (manifest[0] as { Config?: unknown }).Config : undefined;
  if (typeof config !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/.test(config) || config.includes(".."))
    throw new Error("image tarball: manifest.json must name exactly one image with a plain config entry");
  const labels = (JSON.parse(readEntry(config).toString("utf8")) as { config?: { Labels?: Record<string, string> | null } }).config?.Labels;
  return labels ?? {};
}

/** What is wrong with the provenance labels of an image tarball (registry-sync checks the same two on the pushed digest). Pure. */
export function imageLabelProblems(labels: Record<string, string>, full: string, commit: string): string[] {
  const out: string[] = [];
  if (labels["org.opencontainers.image.revision"] !== commit) out.push(`revision label ${labels["org.opencontainers.image.revision"]} != ${commit}`);
  if (labels["org.opencontainers.image.source"] !== `https://github.com/${full}`)
    out.push(`source label ${labels["org.opencontainers.image.source"]} != https://github.com/${full}`);
  return out;
}

/** A tag is never overwritten with another image: none = push, same digest = skip (retry), other digest = alarm. Pure. */
export function ghcrPushDecision(existing: string | null, local: string): "push" | "same" | "conflict" {
  if (existing === null) return "push";
  return existing === local ? "same" : "conflict";
}

/** True when crane's error says "this tag does not exist" (anything else, e.g. 401/403/5xx, is NOT proof of absence). Pure. */
export function craneAbsent(stderr: string): boolean {
  return /MANIFEST_UNKNOWN|NAME_UNKNOWN|Error: [^\n]*unexpected status code 404/.test(stderr);
}

export interface CraneResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs the crane binary (no shell). `input` goes to stdin. */
export type CraneRun = (args: string[], input?: string) => CraneResult;

/** Pushes every image tarball to `<ns>/<name>:<version>` and writes `<out>/<name>.digest`. Refuses to overwrite a tag that points to
 *  another digest. The tarballs are DATA (crane reads them; nothing from the workspace is executed). Returns one log line per image. */
export function pushImages(o: { out: string; images: readonly { name: string; tar: string }[]; ns: string; version: string; crane: CraneRun }): string[] {
  const lines: string[] = [];
  for (const im of o.images) {
    const ref = `${o.ns}/${im.name}:${o.version}`;
    const tarPath = join(o.out, im.tar);
    const digestFile = join(o.out, `${im.name}.digest`);
    rmSync(digestFile, { force: true });
    const loc = o.crane(["digest", "--tarball", tarPath]);
    const local = loc.stdout.trim();
    if (loc.code !== 0 || !DIGEST_RE.test(local)) throw new Error(`${im.name}: cannot read the digest of ${im.tar}: ${loc.stderr.trim().split("\n").at(-1)}`);
    const ex = o.crane(["digest", ref]);
    let existing: string | null = null;
    if (ex.code === 0) {
      existing = ex.stdout.trim();
      if (!DIGEST_RE.test(existing)) throw new Error(`${ref}: unexpected digest answer ${JSON.stringify(existing.slice(0, 80))}`);
    } else if (!craneAbsent(ex.stderr)) {
      throw new Error(`${ref}: cannot tell whether the tag exists (refusing to push): ${ex.stderr.trim().split("\n").at(-1)}`);
    }
    const decision = ghcrPushDecision(existing, local);
    if (decision === "conflict")
      throw new Error(`ALARM: ${ref} already points to ${existing}, this build is ${local}; a published tag is never overwritten (cut the next version)`);
    if (decision === "same") {
      lines.push(`${ref}: already published with the same digest ${local}; skipped`);
    } else {
      const push = o.crane(["push", tarPath, ref]);
      if (push.code !== 0) throw new Error(`${ref}: push failed: ${push.stderr.trim().split("\n").at(-1)}`);
      const after = o.crane(["digest", ref]);
      if (after.code !== 0 || after.stdout.trim() !== local)
        throw new Error(`ALARM: ${ref} reads back as ${after.stdout.trim() || "(nothing)"}, expected ${local}`);
      lines.push(`${ref}: pushed ${local}`);
    }
    writeFileSync(digestFile, `${local}\n`);
  }
  return lines;
}

/** The release-candidate document of a Woodpecker image release: the signer's own document, with the digests release-image-push wrote
 *  next to the tarballs. The images the plan names must be exactly the images tealbrick-ci.json declares at the tag commit. */
export async function wpCandidateDoc(
  cfg: CiConfig,
  repo: string,
  tag: string,
  commit: string,
  plan: Pick<GhPlan, "images">,
  out: string,
): Promise<ReleaseCandidateDoc | null> {
  const declared = cfg.images.map((i) => i.name).sort();
  const planned = plan.images.map((i) => i.name).sort();
  if (declared.join() !== planned.join())
    throw new Error(`plan images [${planned.join(",")}] != tealbrick-ci.json images [${declared.join(",")}] at ${commit}`);
  const ns = imageNamespace(OWNER);
  return buildCandidateDoc(cfg, repo, tag, commit, async (name) => {
    const file = join(out, `${name}.digest`);
    if (!existsSync(file)) throw new Error(`no digest for image ${name} (${file}): release-image-push did not run`);
    const digest = readFileSync(file, "utf8").trim();
    if (!DIGEST_RE.test(digest)) throw new Error(`${file}: not a sha256 digest`);
    return `${ns}/${name}@${digest}`;
  });
}

function tarMember(tarPath: string): (member: string) => Buffer {
  return (member) => execFileSync("tar", ["-xOf", tarPath, member], { maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** release-image-push (secret tb_ghcr_token as GHCR_TOKEN; runs NO repo code): push the kaniko tarballs with crane. */
async function cmdWpPush(): Promise<void> {
  for (const k of ["GITHUB_TOKEN", "GH_TOKEN"]) if (process.env[k]) fail(`C232: wp-push must run without ${k} (the release-publish secret)`);
  const outEnv = process.env.TB_OUT;
  const ws = process.env.CI_WORKSPACE;
  const repo = process.env.CI_REPO_NAME;
  if (!outEnv || !ws || !repo) fail("wp-push needs TB_OUT, CI_WORKSPACE and CI_REPO_NAME");
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
  const cwd = real(process.cwd());
  const wsReal = real(ws);
  if (cwd === wsReal || cwd.startsWith(`${wsReal}/`)) fail("wp-push must run outside the workspace (it runs no repo code)");
  const out = resolve(outEnv);
  const full = `${OWNER}/${repo}`;
  if (process.env.CI_REPO && process.env.CI_REPO !== full) fail(`CI_REPO ${process.env.CI_REPO} != ${full}`);
  const env = wpReleaseEnv(process.env);
  const plan = JSON.parse(readFileSync(join(out, "plan.json"), "utf8")) as GhPlan;
  // The plan comes from a repo-code step, so it is only data: the tag and commit must agree with the pipeline (tag event: its own
  // commit; manual: the plan names the commit and release-publish compares it with the tag on GitHub before it attaches anything).
  const wanted = env.event === "manual" ? env.releaseTag : env.commitTag;
  const target = wpReleaseTarget(env, (t) => (t === wanted ? (env.event === "tag" ? env.commitSha : plan.commit) : null));
  if (typeof target === "string") fail(target);
  if (plan.schema !== "opt2.gh-release-plan/v1" || plan.repo !== repo || plan.tag !== target.tag || plan.commit !== target.commit)
    fail(`plan (${plan.repo} ${plan.tag} ${plan.commit}) does not match this run (${repo} ${target.tag} ${target.commit})`);
  if (plan.images.length === 0) {
    log(`wp-push: no images for ${target.tag}; nothing to push`);
    return;
  }
  const token = process.env.GHCR_TOKEN;
  if (!token) fail(`wp-push needs the secret ${WP_GHCR_SECRET} (as GHCR_TOKEN)`);
  const version = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(target.tag)?.[1];
  if (!version) fail(`images are released on v<semver> tags only (got ${target.tag})`);
  const seen = new Set<string>();
  for (const im of plan.images) {
    if (!IMAGE_NAME_RE.test(im.name) || !(im.name === repo || im.name.startsWith(`${repo}-`))) fail(`image ${im.name} does not belong to ${repo}`);
    if (seen.has(im.name)) fail(`image ${im.name} listed twice`);
    seen.add(im.name);
    if (im.tar !== `${im.name}.tar` || im.version !== version) fail(`unexpected plan entry for ${im.name}: ${JSON.stringify(im)}`);
    const st = lstatSync(join(out, im.tar), { throwIfNoEntry: false });
    if (!st?.isFile()) fail(`${im.tar}: the kaniko step did not write a regular file`);
    const problems = imageLabelProblems(labelsFromImageTar(tarMember(join(out, im.tar))), full, target.commit);
    if (problems.length) fail(`${im.name}: ${problems.join("; ")} (nothing was pushed)`);
  }
  const tmp = mkdtempSync(join(tmpdir(), "tb-crane-")); // 0700, outside the workspace; holds the crane binary and the login, removed below
  let problem: string | null = null;
  try {
    const res = await fetch(CRANE_URL);
    if (!res.ok) throw new Error(`GET ${CRANE_URL}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== CRANE_SHA256) throw new Error(`crane ${CRANE_VERSION}: sha256 ${got} != pinned ${CRANE_SHA256}`);
    writeFileSync(join(tmp, "crane.tgz"), bytes);
    execFileSync("tar", ["-xzf", join(tmp, "crane.tgz"), "-C", tmp, "crane"], { stdio: "pipe" });
    chmodSync(join(tmp, "crane"), 0o755);
    const cfgDir = join(tmp, "docker");
    mkdirSync(cfgDir, { mode: 0o700 });
    const childEnv = { PATH: process.env.PATH ?? "", HOME: tmp, DOCKER_CONFIG: cfgDir };
    const crane: CraneRun = (args, input) => {
      const r = spawnSync(join(tmp, "crane"), args, { input, encoding: "utf8", env: childEnv, maxBuffer: 16 * 1024 * 1024 });
      return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    // the token goes to crane's stdin only: never argv, never the log, never the workspace
    const login = crane(["auth", "login", REGISTRY_HOST, "-u", process.env.GH_ACTOR ?? OWNER, "--password-stdin"], token);
    if (login.code !== 0) throw new Error(`crane login ${REGISTRY_HOST} failed`);
    for (const line of pushImages({ out, images: plan.images, ns: imageNamespace(OWNER), version, crane })) log(line);
  } catch (e) {
    problem = (e as Error).message;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (problem) fail(problem);
  log(`wp-push: done (${plan.images.length} image(s)); registry-sync verifies the labels and signs the digest`);
}

function cmdPlanImages(): void {
  const root = repoRoot();
  const cfg = loadConfig(root);
  mkdirSync(join(root, ".tb-ci"), { recursive: true });
  writeFileSync(join(root, ".tb-ci/images.sh"), renderImagesScript(cfg, repoName(root)), { mode: 0o755 });
  log(`wrote .tb-ci/images.sh for ${cfg.images.length} image(s)`);
}

async function gh(
  method: string,
  path: string,
  body?: unknown,
  extra: { host?: string; contentType?: string; raw?: string | Buffer } = {},
): Promise<{ status: number; json: any }> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) fail("GITHUB_TOKEN (Woodpecker secret ghcr_token) is missing");
  const res = await fetch(`https://${extra.host ?? "api.github.com"}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body !== undefined || extra.raw ? { "content-type": extra.contentType ?? "application/json" } : {}),
    },
    body: (extra.raw ?? (body !== undefined ? JSON.stringify(body) : undefined)) as BodyInit | undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/** A GitHub release this runner attaches assets to. */
export interface GhRelease {
  id: number;
  uploadUrl: string;
}

function ghRelease(json: { id?: unknown; upload_url?: unknown }): GhRelease {
  if (typeof json?.id !== "number" || typeof json.upload_url !== "string") fail("GitHub release answer has no id/upload_url");
  return { id: json.id, uploadUrl: json.upload_url };
}

/** ci-v9.8 (C206): writes go to repoFullName(repo) (GITHUB_REPOSITORY in Actions). */
async function ensureRelease(repo: string, tag: string, prerelease: boolean, target?: string): Promise<GhRelease> {
  const full = repoFullName(repo);
  const got = await gh("GET", `/repos/${full}/releases/tags/${tag}`);
  if (got.status === 200) return ghRelease(got.json);
  const made = await gh("POST", `/repos/${full}/releases`, { tag_name: tag, name: tag, prerelease, ...(target ? { target_commitish: target } : {}) });
  if (made.status !== 201) fail(`create release ${tag}: HTTP ${made.status}`);
  return ghRelease(made.json);
}

/** ci-v9.8 (C206 B0 probe): uploads.github.com does NOT follow a repo transfer (an old-owner path answers 307 without a
 *  Location), so the upload goes to the release's own `upload_url`, which always names the current owner. */
export function uploadTarget(uploadUrl: string, name: string): { host: string; path: string } {
  let u: URL;
  try {
    u = new URL(uploadUrl.replace(/\{[^}]*\}$/, ""));
  } catch {
    throw new Error(`unexpected release upload_url ${JSON.stringify(uploadUrl)}`);
  }
  if (u.protocol !== "https:" || u.host !== "uploads.github.com" || u.search || !/^\/repos\/[^/]+\/[^/]+\/releases\/\d+\/assets$/.test(u.pathname))
    throw new Error(`unexpected release upload_url ${JSON.stringify(uploadUrl)}`);
  return { host: u.host, path: `${u.pathname}?name=${encodeURIComponent(name)}` };
}

/** Replaces asset `name` on the release (delete the old one, then upload). */
async function putAsset(repo: string, rel: GhRelease, name: string, data: string | Buffer, contentType: string): Promise<void> {
  const full = repoFullName(repo);
  let target: { host: string; path: string };
  try {
    target = uploadTarget(rel.uploadUrl, name);
  } catch (e) {
    fail((e as Error).message);
  }
  // C206: a delete that did not land (transient API error) made the upload answer 422 already_exists and left the committed
  // index ahead of the published asset. Delete is checked, and a 422 is retried after a fresh delete.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const list = await gh("GET", `/repos/${full}/releases/${rel.id}/assets?per_page=100`);
    if (list.status !== 200 || !Array.isArray(list.json)) fail(`list assets of release ${rel.id}: HTTP ${list.status}`);
    for (const a of list.json as Array<{ id: number; name: string }>) {
      if (a.name !== name) continue;
      const d = await gh("DELETE", `/repos/${full}/releases/assets/${a.id}`);
      if (d.status !== 204 && d.status !== 404) log(`delete asset ${name} (${a.id}): HTTP ${d.status}`);
    }
    const up = await gh("POST", target.path, undefined, { host: target.host, contentType, raw: data });
    if (up.status === 201) return;
    log(`upload asset ${name}: HTTP ${up.status} ${JSON.stringify(up.json).slice(0, 300)} (attempt ${attempt}/3)`);
    if (up.status !== 422) break;
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  fail(`upload asset ${name}: failed`);
}

async function uploadAsset(repo: string, rel: GhRelease, name: string, data: string): Promise<void> {
  await putAsset(repo, rel, name, data, "application/json");
}

/** ci-v9.3: the lockfile npm wrote for the release-record packages must hold exactly the pinned integrity of both tarballs. */
export function lockPinProblems(lock: { packages?: Record<string, { integrity?: string }> }, pins: { manifest: string; spec: string }): string[] {
  const out: string[] = [];
  if (lock.packages?.["node_modules/@opt2-tealbrick/manifest"]?.integrity !== pins.manifest)
    out.push("installed @opt2-tealbrick/manifest differs from TB_MANIFEST_INTEGRITY (C62)");
  if (lock.packages?.["node_modules/@opt2-tealbrick/spec"]?.integrity !== pins.spec)
    out.push("installed @opt2-tealbrick/spec differs from TB_SPEC_INTEGRITY (ci-v9.3)");
  return out;
}

export async function loadManifestPkg(root: string): Promise<ManifestPkg> {
  const override = process.env.TB_MANIFEST_MODULE; // local path to a built package (development)
  let entry: string;
  if (override) {
    entry = resolve(override);
  } else {
    const url = process.env.TB_MANIFEST_PKG;
    const want = process.env.TB_MANIFEST_INTEGRITY;
    if (!url || !isReleaseTarballUrl(url))
      fail("TB_MANIFEST_PKG must be the @opt2-tealbrick/manifest release tarball URL (GitHub release or a platform dist host)");
    if (!want || !/^sha512-[A-Za-z0-9+/]+=*$/.test(want)) fail("TB_MANIFEST_INTEGRITY (sha512-…) is required with TB_MANIFEST_PKG (C62)");
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) fail(`TB_MANIFEST_PKG: HTTP ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (sha512Integrity(data) !== want) fail("TB_MANIFEST_PKG does not match TB_MANIFEST_INTEGRITY (C62): refusing to load it");
    // ci-v9.3: the manifest package depends on @opt2-tealbrick/spec by a GitHub URL, which npm would fetch WITHOUT integrity.
    // The spec tarball is pinned here the same way (sha512 checked before install) and an npm override makes the manifest
    // package use exactly that file. The lockfile npm writes is read back, so a different spec or manifest can never load.
    const specUrl = process.env.TB_SPEC_PKG;
    const specWant = process.env.TB_SPEC_INTEGRITY;
    if (!specUrl || !isSpecTarballUrl(specUrl))
      fail("TB_SPEC_PKG must be the @opt2-tealbrick/spec release tarball URL (GitHub release or a platform dist host; ci-v9.3)");
    if (!specWant || !/^sha512-[A-Za-z0-9+/]+=*$/.test(specWant)) fail("TB_SPEC_INTEGRITY (sha512-…) is required with TB_SPEC_PKG (ci-v9.3)");
    const specRes = await fetch(specUrl, { redirect: "follow" });
    if (!specRes.ok) fail(`TB_SPEC_PKG: HTTP ${specRes.status}`);
    const specData = new Uint8Array(await specRes.arrayBuffer());
    if (sha512Integrity(specData) !== specWant) fail("TB_SPEC_PKG does not match TB_SPEC_INTEGRITY (ci-v9.3): refusing to load it");
    const dir = join(root, ".tb-ci/pkgs");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, overrides: { "@opt2-tealbrick/spec": "file:./spec.tgz" } }) + "\n");
    writeFileSync(join(dir, "manifest.tgz"), data);
    writeFileSync(join(dir, "spec.tgz"), specData);
    sh("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", "./manifest.tgz"], dir);
    const lock = readJson(join(dir, "package-lock.json")) as { packages?: Record<string, { integrity?: string }> };
    const problems = lockPinProblems(lock, { manifest: want, spec: specWant });
    if (problems.length > 0) fail(`${problems.join("; ")}: refusing to load it`);
    const pkgDir = join(dir, "node_modules/@opt2-tealbrick/manifest");
    const pj = readJson(join(pkgDir, "package.json")) as { exports?: unknown; main?: string };
    const ex = pj.exports as Record<string, unknown> | string | undefined;
    const dot = typeof ex === "string" ? ex : ((ex?.["."] ?? ex) as Record<string, string> | string | undefined);
    const rel = typeof dot === "string" ? dot : (dot?.import ?? dot?.default ?? pj.main);
    if (!rel) fail("cannot find the entry point of @opt2-tealbrick/manifest");
    entry = join(pkgDir, rel);
  }
  const mod = (await import(pathToFileURL(entry).href)) as Partial<ManifestPkg>;
  for (const f of ["digest", "manifestDigest", "validateManifest", "thumbprint", "signReleaseIndex", "verifyReleaseIndex", "keySetFrom"] as const)
    if (typeof mod[f] !== "function") fail(`@opt2-tealbrick/manifest does not export ${f}`);
  return mod as ManifestPkg;
}

async function loadSigningKey(m: ManifestPkg): Promise<{ publicJwk: JsonWebKey; privateKey: CryptoKey; kid: string }> {
  const pem = process.env.RELEASE_SIGNING_KEY ?? (process.env.RELEASE_SIGNING_KEY_FILE ? readFileSync(process.env.RELEASE_SIGNING_KEY_FILE, "utf8") : "");
  if (!pem) fail("RELEASE_SIGNING_KEY (Woodpecker secret release_signing_key) or RELEASE_SIGNING_KEY_FILE is missing");
  const priv = createPrivateKey(pem);
  const publicJwk = createPublicKey(priv).export({ format: "jwk" }) as JsonWebKey;
  const der = priv.export({ type: "pkcs8", format: "der" });
  const privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
  return { publicJwk, privateKey, kid: m.thumbprint(publicJwk) };
}

async function ghFile(path: string, ref: string): Promise<string | null> {
  const r = await gh("GET", `/repos/${repoFullName(PLATFORM_REPO)}/contents/${path}?ref=${ref}`);
  if (r.status === 404) return null;
  if (r.status !== 200) fail(`read ${path}: HTTP ${r.status}`);
  return Buffer.from(r.json.content as string, "base64").toString("utf8");
}

/** Read index + offers at main, merge, re-sign with the manifest package, commit to main (fast-forward), publish release assets. */
/** GTP-01: the binding map from the signer's own checkout (the platform repo; same file as on main). */
export function loadProductBindings(): ProductBindings {
  return validateProducts(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", PRODUCTS_PATH), "utf8")));
}

async function publishIndex(m: ManifestPkg | null, add: IndexRelease[]): Promise<void> {
  // Unsigned mode exists only until the spec defines the release-index typ (REQUESTS "platform: release index typ").
  const signed = process.env.TB_REGISTRY_UNSIGNED !== "1";
  if (signed && !m) fail("signing needs @opt2-tealbrick/manifest");
  const key = signed && m ? await loadSigningKey(m) : null;
  if (key && m) {
    const pubKeys = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../registry/keys.json"), "utf8")) as { keys: JsonWebKey[] };
    if (!pubKeys.keys.some((k) => m.thumbprint(k) === key.kid)) fail(`signing key ${key.kid} is not in registry/keys.json`);
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    const ref = await gh("GET", `/repos/${repoFullName(PLATFORM_REPO)}/git/ref/heads/main`);
    if (ref.status !== 200) fail(`registry: read main: HTTP ${ref.status}`);
    const headSha = ref.json.object.sha as string;
    const prevText = await ghFile(INDEX_PATH, headSha);
    const prev = prevText ? (JSON.parse(prevText) as ReleaseIndex) : null;
    if (prev && prev.schema !== INDEX_SCHEMA) fail(`registry: unexpected schema ${prev.schema}`);
    const offersText = await ghFile(OFFERS_PATH, headSha);
    const offers = validateOffers(offersText ? JSON.parse(offersText) : []);
    const harnessesText = await ghFile(HARNESSES_PATH, headSha);
    const harnesses = validateHarnesses(harnessesText ? JSON.parse(harnessesText) : []);
    const devOnlyNotes = normalizeDevOnly(prev?.releases ?? []).notes; // C113: what this publish changes in existing records
    const index = mergeIndex(prev, add, offers, new Date().toISOString(), harnesses, loadProductBindings());
    // C206 R2-1: legacy-owner locations rewritten in this publish are verified before anything is signed
    const ownerRewrites = normalizeLegacyOwners(prev?.releases ?? []).rewrites;
    if (ownerRewrites.length) {
      if (!m) fail("registry: legacy-owner rewrites need the manifest package to verify digests");
      const problems = await verifyOwnerRewrites(m, prev?.releases ?? [], ownerRewrites);
      if (problems.length) fail(`registry: legacy-owner rewrite not verified, nothing published:\n  - ${problems.join("\n  - ")}`);
      log(`registry: ${ownerRewrites.length} legacy-owner location(s) rewritten to ${OWNER} and verified (C206 R2-1)`);
    }
    const body = serializeIndex(index);
    let jws: string | null = null;
    if (key && m) {
      const nowS = Math.floor(Date.now() / 1000);
      const token = await m.signReleaseIndex(index, { iat: nowS }, key);
      const keys = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../registry/keys.json"), "utf8")) as { keys: JsonWebKey[] };
      const check = m.verifyReleaseIndex(token, JSON.parse(body) as ReleaseIndex, { now: nowS, keys: m.keySetFrom(keys, INDEX_ISS) });
      if (!check.ok) fail(`registry: self-verification of the signed index failed: ${check.reason ?? "refused"}`);
      jws = `${token}\n`;
    }
    const commit = await gh("GET", `/repos/${repoFullName(PLATFORM_REPO)}/git/commits/${headSha}`);
    const hasEnvelope = (await ghFile(ENVELOPE_PATH, headSha)) !== null;
    const tree = await gh("POST", `/repos/${repoFullName(PLATFORM_REPO)}/git/trees`, {
      base_tree: commit.json.tree.sha,
      tree: [
        { path: INDEX_PATH, mode: "100644", type: "blob", content: body },
        ...(jws
          ? [{ path: ENVELOPE_PATH, mode: "100644", type: "blob", content: jws }]
          : hasEnvelope
            ? [{ path: ENVELOPE_PATH, mode: "100644", type: "blob", sha: null }]
            : []),
      ],
    });
    if (tree.status !== 201) fail(`registry: create tree: HTTP ${tree.status}`);
    const msg = `${add.length ? `registry: ${add.map((r) => `${r.product}@${r.version}`).join(", ")}` : ownerRewrites.length ? `registry: ${ownerRewrites.length} legacy-owner locations -> ${OWNER} (C206 R2-1)` : "registry: re-publish"}${jws ? "" : " (UNSIGNED interim)"}${
      devOnlyNotes.length ? `\n\nC113 (DEV_ONLY_PRODUCTS, digests unchanged):\n${devOnlyNotes.map((n) => `- ${n}`).join("\n")}` : ""
    }`;
    const nc = await gh("POST", `/repos/${repoFullName(PLATFORM_REPO)}/git/commits`, { message: msg, tree: tree.json.sha, parents: [headSha] });
    if (nc.status !== 201) fail(`registry: create commit: HTTP ${nc.status}`);
    const upd = await gh("PATCH", `/repos/${repoFullName(PLATFORM_REPO)}/git/refs/heads/main`, { sha: nc.json.sha, force: false });
    if (upd.status === 200) {
      const rel = await ensureRelease(PLATFORM_REPO, REGISTRY_RELEASE_TAG, false, nc.json.sha as string);
      await uploadAsset(PLATFORM_REPO, rel, "index.json", body);
      if (jws) await uploadAsset(PLATFORM_REPO, rel, "index.jws", jws);
      // D12/C30 + BSD-08: the public key files travel with the index.
      for (const [path, name] of REGISTRY_EXTRA_ASSETS) {
        const text = await ghFile(path, nc.json.sha as string);
        if (text) await uploadAsset(PLATFORM_REPO, rel, name, text);
      }
      log(`${msg}; published https://github.com/${OWNER}/${PLATFORM_REPO}/releases/download/${REGISTRY_RELEASE_TAG}/${jws ? "index.jws" : "index.json"}`);
      return;
    }
    log(`registry: main moved (HTTP ${upd.status}), retry ${attempt}/5`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  fail("registry: could not fast-forward main after 5 attempts");
}

/** SEC-03 (C59): what a product tag pipeline may claim. It holds NO signature and no derived digests the signer trusts:
 *  the platform signer re-derives manifest/skills/runtime from the repo at `commit` and checks every image in the registry. */
export interface ReleaseCandidate {
  product: string;
  kind: "app" | "bridge";
  version: string;
  image: string; // ghcr.io/martin-atrin/<name>@sha256:<hex>
  services: { id: string; image: string }[];
  manifest: string | null; // repo-relative manifest path (apps)
  runtimeFile: string | null; // repo-relative bridge-runtime.json (bridge)
  upgradeFrom: string;
}
export interface ReleaseCandidateDoc {
  schema: "opt2.release-candidate/v1";
  repo: string; // owner/name
  tag: string;
  commit: string;
  candidates: ReleaseCandidate[];
}

/** Product tag pipeline (C62): validate the release locally and print it. No token, no signing key, no network writes.
 *  The platform signer discovers the tag itself, resolves image digests from ghcr and re-derives everything. */
async function cmdReleaseRecord(): Promise<void> {
  const root = repoRoot();
  const cfg = loadConfig(root);
  const tag = process.env.CI_COMMIT_TAG;
  if (!tag) fail("release-record runs on tag events only");
  for (const k of ["RELEASE_SIGNING_KEY", "RELEASE_SIGNING_KEY_FILE", "GITHUB_TOKEN", "GHCR_TOKEN"])
    if (process.env[k]) fail(`C62/SEC-03: release-record must run without ${k}`);
  let version: string;
  try {
    version = versionFromTag(tag);
  } catch (e) {
    fail((e as Error).message);
  }
  const entries = cfg.images.filter((im) => im.kind === "app" || im.kind === "bridge");
  if (entries.length === 0) {
    log("no app/bridge images declared: nothing for the release index");
    return;
  }
  const m = await loadManifestPkg(root);
  for (const im of entries) {
    if (im.manifest) {
      const v = m.validateManifest(JSON.parse(readFileSync(join(root, im.manifest), "utf8")));
      if (!v.ok) fail(`${im.manifest} is invalid: ${JSON.stringify(v.errors).slice(0, 2000)}`);
      const man = v.manifest as { id?: string; version?: string; runtime?: { services?: { id: string; build?: unknown }[] } };
      if (man.id !== im.product || man.version !== version) fail(`manifest ${man.id}@${man.version} != ${im.product}@${version}`);
      const svcErrs = checkServiceImages(cfg, im.product, man.runtime?.services ?? []);
      if (svcErrs.length) fail(svcErrs.join("; "));
      log(`candidate ${im.product}@${version}: manifestDigest ${m.manifestDigest(v.manifest)}`);
    }
    if (im.kind === "bridge") validateBridgeRuntime(JSON.parse(readFileSync(join(root, dirname(im.dockerfile), "bridge-runtime.json"), "utf8")));
    const digest = existsSync(join(root, ".tb-ci/digests", `${im.name}.digest`))
      ? readFileSync(join(root, ".tb-ci/digests", `${im.name}.digest`), "utf8").trim()
      : "(see image-push)";
    log(`candidate ${im.product}@${version} (${im.kind}) ${IMAGE_NAMESPACE}/${im.name}@${digest}; the platform signer verifies and indexes it`);
  }
}

/** What the signer derives for one tag (SEC-03, C62): no product-written document is trusted. */
export interface ReleaseCandidate {
  product: string;
  kind: "app" | "bridge";
  version: string;
  image: string; // ghcr.io/martin-atrin/<name>@sha256:<hex>
  services: { id: string; image: string }[];
  manifest: string | null;
  runtimeFile: string | null;
  upgradeFrom: string;
}
export interface ReleaseCandidateDoc {
  schema: "opt2.release-candidate/v1";
  repo: string;
  tag: string;
  commit: string;
  candidates: ReleaseCandidate[];
}

// ---------- platform signer (SEC-03): runs only platform code, never product repo or dependency code ----------

const GHCR_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** Checks a public ghcr image by digest: it exists and its OCI labels bind it to this repo + commit. */
export async function verifyImageProvenance(ref: string, repo: string, commit: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  // C206: ghcr.io/tealbrick (org releases) or a legacy namespace (tags pushed before the move); both are ours
  const nsRe = KNOWN_OWNERS.map((o) => o.toLowerCase()).join("|");
  const m = new RegExp(`^ghcr\\.io\\/((?:${nsRe})\\/([a-z0-9-]+))@(sha256:[0-9a-f]{64})$`).exec(ref);
  if (!m) return `bad image ref ${ref}`;
  const [, name, image, digest] = m as unknown as [string, string, string, string];
  const repoName = repo.split("/")[1] as string;
  if (image !== repoName && !image.startsWith(`${repoName}-`)) return `${ref}: image name does not belong to ${repo}`;
  const tokRes = await fetcher(`https://ghcr.io/token?scope=repository:${name}:pull`);
  if (!tokRes.ok) return `${ref}: no pull token (package private?) HTTP ${tokRes.status}`;
  const token = ((await tokRes.json()) as { token: string }).token;
  const get = (path: string, accept = GHCR_ACCEPT) => fetcher(`https://ghcr.io/v2/${name}/${path}`, { headers: { authorization: `Bearer ${token}`, accept } });
  let res = await get(`manifests/${digest}`);
  if (!res.ok) return `${ref}: manifest not found HTTP ${res.status}`;
  let man = (await res.json()) as {
    mediaType?: string;
    manifests?: { digest: string; platform?: { os: string; architecture: string } }[];
    config?: { digest: string };
  };
  if (man.manifests) {
    const amd = man.manifests.find((x) => x.platform?.os === "linux" && x.platform?.architecture === "amd64");
    if (!amd) return `${ref}: no linux/amd64 image in the index`;
    res = await get(`manifests/${amd.digest}`);
    if (!res.ok) return `${ref}: platform manifest HTTP ${res.status}`;
    man = await res.json();
  }
  if (!man.config?.digest) return `${ref}: manifest has no config`;
  const cfgRes = await get(`blobs/${man.config.digest}`, "*/*");
  if (!cfgRes.ok) return `${ref}: config blob HTTP ${cfgRes.status}`;
  const labels = ((await cfgRes.json()) as { config?: { Labels?: Record<string, string> } }).config?.Labels ?? {};
  if (labels["org.opencontainers.image.revision"] !== commit) return `${ref}: revision label ${labels["org.opencontainers.image.revision"]} != ${commit}`;
  // C206: an image built before the move carries the legacy owner in its source label; same repo name only
  const sources = [repo, ...LEGACY_OWNERS.map((o) => `${o}/${repoName}`)].map((r) => `https://github.com/${r}`);
  if (!sources.includes(labels["org.opencontainers.image.source"] as string))
    return `${ref}: source label ${labels["org.opencontainers.image.source"]} != https://github.com/${repo}`;
  return null;
}

/** C154 private-repo reads: how registry-sync and the template audit read one opt2 repo. */
export interface RepoReader {
  /** read-token = TB_PRIVATE_READ_TOKEN (PRIVATE_REPOS only), github-token = the platform GITHUB_TOKEN, anonymous = no token */
  via: "read-token" | "github-token" | "anonymous";
  api(path: string): Promise<{ status: number; json: any }>;
  /** one file of this repo at a ref; text null when the status is not 200 */
  file(path: string, ref: string): Promise<{ status: number; text: string | null }>;
}

/** The reader for one repo. A repo in PRIVATE_REPOS uses TB_PRIVATE_READ_TOKEN when it is set (api.github.com only: REST +
 *  contents API with the raw media type); every other repo, or a private one without that token, is read as before (REST with
 *  GITHUB_TOKEN, files from the anonymous raw host, so public repos cost no API quota). The read token never goes to another repo. */
export function repoReader(repo: string, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): RepoReader {
  const readToken = PRIVATE_REPOS.includes(repo) ? env[PRIVATE_READ_TOKEN_ENV] || undefined : undefined;
  const token = readToken ?? (env.GITHUB_TOKEN || undefined);
  const via: RepoReader["via"] = readToken ? "read-token" : token ? "github-token" : "anonymous";
  const headers = (accept: string): Record<string, string> => ({
    accept,
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });
  return {
    via,
    async api(path) {
      const res = await fetcher(`https://api.github.com${path}`, { headers: headers("application/vnd.github+json") });
      const text = await res.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      return { status: res.status, json };
    },
    async file(path, ref) {
      const res = readToken
        ? await fetcher(
            `https://api.github.com/repos/${OWNER}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
            { headers: headers("application/vnd.github.raw+json") },
          )
        : await fetcher(`https://raw.githubusercontent.com/${OWNER}/${repo}/${ref}/${path}`);
      return { status: res.status, text: res.ok ? await res.text() : null };
    },
  };
}

/** One line for a repo that could not be read; names the missing or too narrow read token for PRIVATE_REPOS. */
export function repoReadProblem(repo: string, what: string, status: number, via: RepoReader["via"]): string {
  const hint = !PRIVATE_REPOS.includes(repo)
    ? ""
    : via === "read-token"
      ? ` (${PRIVATE_READ_TOKEN_ENV} cannot read ${repo}: it needs Contents + Metadata: read on it)`
      : ` (${repo} is a private repo: set ${PRIVATE_READ_TOKEN_ENV} with Contents + Metadata: read on it)`;
  return `${repo}: ${what}: HTTP ${status}${hint}`;
}

/** D1/C56 audit verdict for one repo. SKIP only for a PRIVATE repo that answers 404 to a reader without the read token (its own
 *  pipeline `setup` step still enforces ci/MIN_TEMPLATE); PEND only for PENDING_REPOS; any other unreadable repo FAILs. */
export function auditVerdict(repo: string, status: number, via: RepoReader["via"], ref: string, min: string): "OK" | "FAIL" | "PEND" | "SKIP" {
  if (status === 404 && PENDING_REPOS.includes(repo)) return "PEND";
  if (status === 404 && PRIVATE_REPOS.includes(repo) && via !== "read-token") return "SKIP";
  if (status !== 200) return "FAIL";
  return belowMinimum(ref, min) || DENIED_TEMPLATES[ref] !== undefined ? "FAIL" : "OK";
}

async function fileAt(rd: RepoReader, repo: string, commit: string, path: string): Promise<string> {
  const r = await rd.file(path, commit);
  if (r.text === null) throw new Error(`${path} not found at ${repo}@${commit} (HTTP ${r.status})`);
  return r.text;
}

/** Re-derives one index entry from the repo at the tag commit + the registry; returns the entry or a rejection. */
async function verifyCandidate(m: ManifestPkg, doc: ReleaseCandidateDoc, c: ReleaseCandidate, rd: RepoReader): Promise<IndexRelease | string> {
  try {
    const ref = await rd.api(`/repos/${doc.repo}/git/ref/tags/${encodeURIComponent(doc.tag)}`);
    if (ref.status !== 200) return `tag ${doc.tag} not found`;
    let sha = ref.json.object.sha as string;
    if (ref.json.object.type === "tag") sha = (await rd.api(`/repos/${doc.repo}/git/tags/${sha}`)).json.object.sha;
    if (sha !== doc.commit) return `tag ${doc.tag} points to ${sha}, candidate says ${doc.commit}`;
    if (versionFromTag(doc.tag) !== c.version) return `version ${c.version} != tag ${doc.tag}`;
    let manifestDigest: string | null = null;
    let skillsDigest: string | null = null;
    let manifestUrl: string | null = null;
    let declaredServices: string[] = [];
    if (c.kind === "app") {
      if (!c.manifest || !safeRel(c.manifest)) return "app candidate without a safe manifest path";
      const v = m.validateManifest(JSON.parse(await fileAt(rd, doc.repo, doc.commit, c.manifest)));
      if (!v.ok) return `manifest invalid at ${doc.commit}`;
      const man = v.manifest as {
        id?: string;
        version?: string;
        skills?: { id: string; file: string }[];
        runtime?: { services?: { id: string; build?: unknown }[] };
      };
      if (man.id !== c.product || man.version !== c.version) return `manifest ${man.id}@${man.version} != ${c.product}@${c.version}`;
      manifestDigest = m.manifestDigest(v.manifest);
      manifestUrl = `https://raw.githubusercontent.com/${doc.repo}/${doc.commit}/${c.manifest}`;
      const base = c.manifest.includes("/") ? c.manifest.slice(0, c.manifest.lastIndexOf("/") + 1) : "";
      const files = new Map<string, string>();
      for (const sk of man.skills ?? []) files.set(sk.file, await fileAt(rd, doc.repo, doc.commit, base + sk.file));
      skillsDigest = m.digest(skillsArchive(man, (f) => files.get(f) ?? ""));
      declaredServices = (man.runtime?.services ?? [])
        .filter((x) => x.build)
        .map((x) => x.id)
        .sort();
    }
    const got = c.services.map((x) => x.id).sort();
    if (JSON.stringify(got) !== JSON.stringify(declaredServices)) return `service images [${got}] != manifest services with build [${declaredServices}]`;
    let runtime: BridgeRuntime | null = null;
    if (c.kind === "bridge") {
      if (!c.runtimeFile || !safeRel(c.runtimeFile)) return "bridge candidate without a safe runtime file path";
      runtime = validateBridgeRuntime(JSON.parse(await fileAt(rd, doc.repo, doc.commit, c.runtimeFile)));
    }
    for (const img of [c.image, ...c.services.map((x) => x.image)]) {
      const problem = await verifyImageProvenance(img, doc.repo, doc.commit);
      if (problem) return problem;
    }
    return {
      id: newId("rel"),
      product: c.product,
      kind: c.kind,
      version: c.version,
      channel: tagChannel(c.product, c.version, c.kind), // C207 E4: new app/bridge tags → dev
      manifestDigest,
      manifestUrl,
      skillsDigest,
      image: c.image,
      artifact: null,
      source: null,
      runtime,
      services: c.kind === "app" ? c.services : null,
      minOs: null,
      notarized: null,
      upgradeFrom: c.upgradeFrom,
      repo: doc.repo,
      commit: doc.commit,
      tag: doc.tag,
      publishedAt: new Date().toISOString(),
    };
  } catch (e) {
    return (e as Error).message;
  }
}

/** Resolves a public ghcr tag to its manifest digest (null = not published yet). `namespace` = ghcr.io/<owner>. */
export async function ghcrDigest(name: string, tag: string, fetcher: typeof fetch = fetch, namespace: string = IMAGE_NAMESPACE): Promise<string | null> {
  const ns = namespace.slice(`${REGISTRY_HOST}/`.length);
  const tok = await fetcher(`https://ghcr.io/token?scope=repository:${ns}/${name}:pull`);
  if (!tok.ok) return null;
  const token = ((await tok.json()) as { token: string }).token;
  const res = await fetcher(`https://ghcr.io/v2/${ns}/${name}/manifests/${tag}`, {
    method: "HEAD",
    headers: { authorization: `Bearer ${token}`, accept: GHCR_ACCEPT },
  });
  if (!res.ok) return null;
  const d = res.headers.get("docker-content-digest");
  return d && /^sha256:[0-9a-f]{64}$/.test(d) ? d : null;
}

/** C206: the image of a tag in the first namespace that has it: ghcr.io/tealbrick (releases from the org), then the legacy
 *  namespaces (tags pushed before the move). Releases are never re-tagged (C76), so one tag lives in one namespace. */
export async function ghcrFind(name: string, tag: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  for (const ns of IMAGE_NAMESPACES) {
    const d = await ghcrDigest(name, tag, fetcher, ns);
    if (d) return `${ns}/${name}@${d}`;
  }
  return null;
}

/** The release candidate of one product tag, from the repo's config at the tag commit. `imageOf` answers the `ghcr.io/<ns>/<name>@sha256:…`
 *  of a declared image (null = not published yet -> the whole document is null = pending). Shared by the signer (ghcr lookup) and,
 *  since ci-v9.11 (C232), the Woodpecker release-publish step (digests the push step wrote), so both write the same document. */
export async function buildCandidateDoc(
  cfg: CiConfig,
  repo: string,
  tag: string,
  commit: string,
  imageOf: (imageName: string) => Promise<string | null>,
): Promise<ReleaseCandidateDoc | null> {
  const version = versionFromTag(tag);
  const candidates: ReleaseCandidate[] = [];
  for (const im of cfg.images.filter((x) => x.kind === "app" || x.kind === "bridge")) {
    const image = await imageOf(im.name);
    if (!image) return null;
    const services: { id: string; image: string }[] = [];
    for (const sv of cfg.images.filter((x) => x.kind === "service" && x.product === im.product)) {
      const svImage = await imageOf(sv.name);
      if (!svImage) return null;
      services.push({ id: sv.service as string, image: svImage });
    }
    candidates.push({
      product: im.product,
      kind: im.kind === "bridge" ? "bridge" : "app",
      version,
      image,
      services: services.sort((a, b) => a.id.localeCompare(b.id)),
      manifest: im.manifest ?? null,
      runtimeFile: im.kind === "bridge" ? `${dirname(im.dockerfile)}/bridge-runtime.json` : null,
      upgradeFrom: im.upgradeFrom,
    });
  }
  return candidates.length ? { schema: "opt2.release-candidate/v1", repo: `${OWNER}/${repo}`, tag, commit, candidates } : null;
}

/** Builds the candidate for one product tag from the repo at that commit + ghcr; null = images not published (pending). */
async function candidateFromTag(repo: string, tag: string, commit: string, rd: RepoReader): Promise<ReleaseCandidateDoc | null> {
  const version = versionFromTag(tag);
  const cfgText = await fileAt(rd, `${OWNER}/${repo}`, commit, "tealbrick-ci.json").catch(() => null);
  if (!cfgText) return null;
  let cfg: CiConfig;
  try {
    cfg = validateConfig(JSON.parse(cfgText), repo);
  } catch {
    return null; // tag predates the current tealbrick-ci.json schema: it cannot carry Actions-built images
  }
  return buildCandidateDoc(cfg, repo, tag, commit, (name) => ghcrFind(name, version));
}

/** Platform signer pipeline (cron/manual, platform repo only, holds release_signing_key):
 *  discover v* tags in the opt2 repos, derive and verify each release independently, add them, re-sign when anything changed. */
async function cmdRegistrySync(): Promise<void> {
  const m = await loadManifestPkg(repoRoot());
  const cur = await ghFile(INDEX_PATH, "main");
  const index = cur ? (JSON.parse(cur) as ReleaseIndex) : null;
  const known = new Set((index?.releases ?? []).map((r) => `${r.product}@${r.version}@${r.channel}`));
  const add: IndexRelease[] = [];
  const rejected: string[] = [];
  const bindings = loadProductBindings();
  // C207 E1/E4: reviewed inputs from main
  const ignoredText = await ghFile(IGNORED_TAGS_PATH, "main");
  const ignored = new Set(validateIgnoredTags(ignoredText ? JSON.parse(ignoredText) : []).map((t) => `${t.repo}@${t.tag}`));
  const promotionsText = await ghFile(PROMOTIONS_PATH, "main");
  const promotions = validatePromotions(promotionsText ? JSON.parse(promotionsText) : []);
  // C207 E4: an app/bridge version that already has an image record (stable from before E4, dev, or promoted) is indexed
  const imaged = new Set((index?.releases ?? []).filter((r) => (r.kind === "app" || r.kind === "bridge") && r.image).map((r) => `${r.product}@${r.version}`));
  for (const repo of OPT2_REPOS) {
    if (repo === CLI_REPO) continue; // C174: private; read below by the cli source with the read-only token, never with GITHUB_TOKEN
    const rd = repoReader(repo); // C154: PRIVATE_REPOS are read with TB_PRIVATE_READ_TOKEN, never with GITHUB_TOKEN
    const tags = await rd.api(`/repos/${OWNER}/${repo}/tags?per_page=50`);
    if (tags.status === 404 && PENDING_REPOS.includes(repo)) {
      log(`registry-sync: ${repo} has no GitHub repo yet (PENDING_REPOS); skipped`);
      continue;
    }
    if (tags.status !== 200 || !Array.isArray(tags.json)) {
      rejected.push(repoReadProblem(repo, "list tags", tags.status, rd.via)); // loud, and the other repos are still synced
      continue;
    }
    for (const t of tags.json as { name: string; commit: { sha: string } }[]) {
      if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(t.name)) continue;
      const version = t.name.slice(1);
      let doc: ReleaseCandidateDoc | null;
      try {
        doc = await candidateFromTag(repo, t.name, t.commit.sha, rd);
      } catch (e) {
        rejected.push(`${repo} ${t.name}: ${(e as Error).message}`);
        continue;
      }
      if (!doc) continue; // no images for this tag (yet): pending, not an error
      const fresh = doc.candidates.filter(
        (c) => !imaged.has(`${c.product}@${version}`) && !known.has(`${c.product}@${version}@${tagChannel(c.product, version, c.kind)}`),
      );
      if (!fresh.length) continue;
      if (ignored.has(`${repo}@${t.name}`)) {
        log(`registry-sync: ${repo} ${t.name} is in ${IGNORED_TAGS_PATH}; not indexed`);
        continue;
      }
      // C207 E1: release guard (main/hotfix, green Woodpecker, merged PR from the cut-over date)
      const guard = await releaseGuard((path) => rd.api(path), doc.repo, doc.commit);
      for (const w of guard.warnings) log(`registry-sync: WARN ${repo} ${t.name}: ${w}`);
      if (guard.problem) {
        rejected.push(`${repo} ${t.name}: ${guard.problem}`);
        continue;
      }
      for (const c of fresh) {
        // GTP-01: a tag in one repo can never sign another repo's product (e.g. samples declaring product "bridge").
        const bound = productBindingProblem(bindings, { product: c.product, kind: c.kind, repo: doc.repo });
        if (bound) {
          rejected.push(`${repo} ${doc.tag} ${c.product}: ${bound}`);
          continue;
        }
        const r = await verifyCandidate(m, doc, c, rd);
        if (typeof r === "string") rejected.push(`${repo} ${doc.tag} ${c.product}: ${r}`);
        else {
          add.push(r);
          known.add(`${r.product}@${r.version}@${r.channel}`);
          imaged.add(`${r.product}@${r.version}`);
          log(`verified ${r.product}@${r.version} (${r.channel}) from ${repo}@${doc.commit.slice(0, 8)}`);
        }
      }
    }
  }
  // C174: the cli tarball (C173 installer). Pending (green, no entry) until Martin's read token exists.
  const cli = await cliSourceReleases({ token: process.env[PRIVATE_READ_TOKEN_ENV] || undefined, known });
  if (cli.pending) log(`registry-sync: PEND cli source: ${cli.pending}; no cli entry this run`);
  for (const w of cli.warnings) log(`registry-sync: WARN ${w}`);
  for (const r of cli.add) {
    const bound = productBindingProblem(bindings, r);
    if (bound) rejected.push(`${r.repo} ${r.tag} ${r.product}: ${bound}`);
    else {
      add.push(r);
      log(`verified ${r.product}@${r.version} from ${r.repo}@${(r.commit ?? "").slice(0, 8)} (${r.artifact?.url})`);
    }
  }
  rejected.push(...cli.rejected);
  // C207 E4: recorded promotions dev → stable (same image + manifest digest; soak evidence validated)
  const promoted = promotionReleases(index ?? { releases: [] }, promotions, { now: new Date().toISOString() });
  for (const r of promoted.add) {
    add.push(r);
    log(`promoted ${r.product}@${r.version} to stable from ${r.promotedFrom}`);
  }
  rejected.push(...promoted.problems);
  const offersText = await ghFile(OFFERS_PATH, "main");
  const harnessesText = await ghFile(HARNESSES_PATH, "main");
  const offersChanged = JSON.stringify(validateOffers(offersText ? JSON.parse(offersText) : [])) !== JSON.stringify(index?.offers ?? []);
  const harnessesChanged = JSON.stringify(validateHarnesses(harnessesText ? JSON.parse(harnessesText) : [])) !== JSON.stringify(index?.harnesses ?? []);
  const env = await ghFile(ENVELOPE_PATH, "main");
  const exp = env ? (JSON.parse(Buffer.from(env.trim().split(".")[1], "base64url").toString("utf8")) as { exp: number }).exp : 0;
  const expiring = exp - Date.now() / 1000 < 30 * 86400;
  const devOnlyChanged = normalizeDevOnly(index?.releases ?? []).notes.length > 0; // C113: mark/re-classify existing records
  const ownerChanged = normalizeLegacyOwners(index?.releases ?? []).rewrites.length > 0; // C206 R2-1
  if (add.length || offersChanged || harnessesChanged || expiring || devOnlyChanged || ownerChanged) await publishIndex(m, add);
  else {
    log("registry-sync: nothing new");
    await syncRegistryExtraAssets(); // a key file changed on main without an index change (e.g. a new key-set statement)
  }
  if (rejected.length) fail(`rejected candidates:\n  - ${rejected.join("\n  - ")}`);
}

/** Keeps each REGISTRY_EXTRA_ASSETS release asset byte-equal to its file on main (uploads only on a difference). */
async function syncRegistryExtraAssets(): Promise<void> {
  const rel = await gh("GET", `/repos/${repoFullName(PLATFORM_REPO)}/releases/tags/${REGISTRY_RELEASE_TAG}`);
  if (rel.status !== 200) return; // no registry release yet: the first publishIndex creates it with every asset
  // C206: the signed index pair itself too, so a publish that committed main but failed its upload heals on the next run
  // (main holds index.json + index.jws as one signed pair; they are re-uploaded together, envelope last).
  const pair: (readonly [string, string])[] = [
    [INDEX_PATH, "index.json"],
    [ENVELOPE_PATH, "index.jws"],
  ];
  const pairStale = [];
  for (const [path, name] of pair) {
    const want = await ghFile(path, "main");
    const res = await fetch(`https://github.com/${OWNER}/${PLATFORM_REPO}/releases/download/${REGISTRY_RELEASE_TAG}/${name}`, { redirect: "follow" });
    if (want !== null && (!res.ok || (await res.text()) !== want)) pairStale.push(name);
  }
  if (pairStale.length) {
    for (const [path, name] of pair) {
      const want = await ghFile(path, "main");
      if (want !== null) await uploadAsset(PLATFORM_REPO, ghRelease(rel.json), name, want);
    }
    log(`registry-sync: release assets index.json + index.jws re-published from main (stale: ${pairStale.join(", ")})`);
  }
  for (const [path, name] of REGISTRY_EXTRA_ASSETS) {
    const want = await ghFile(path, "main");
    if (want === null) continue;
    const res = await fetch(`https://github.com/${OWNER}/${PLATFORM_REPO}/releases/download/${REGISTRY_RELEASE_TAG}/${name}`, { redirect: "follow" });
    const have = res.ok ? await res.text() : null;
    if (have === want) continue;
    await uploadAsset(PLATFORM_REPO, ghRelease(rel.json), name, want);
    log(`registry-sync: release asset ${name} updated from ${path} on main`);
  }
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** TBD desktop release (C24): run on the release Mac after the notarized artifact is on the GitHub release. */
async function cmdRegistryAddDesktop(args: string[]): Promise<void> {
  const product = argValue(args, "--product") ?? "tbd";
  const version = argValue(args, "--version");
  const url = argValue(args, "--url");
  const sha256 = argValue(args, "--sha256");
  const minOs = argValue(args, "--min-os") ?? "14.0";
  const upgradeFrom = argValue(args, "--upgrade-from") ?? "*";
  const notarized = !args.includes("--not-notarized");
  if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail("--version <semver> required");
  if (!url) fail("--url <asset URL> required");
  let src: { repo: string; tag: string };
  try {
    src = artifactSource(url, argValue(args, "--repo")); // ci-v9.6: a GitHub release asset, or a file on a platform dist host (--repo)
  } catch (e) {
    fail((e as Error).message);
  }
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) fail("--sha256 <hex> required");
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) fail(`artifact not reachable: HTTP ${res.status}`);
  const got = createHash("sha256")
    .update(Buffer.from(await res.arrayBuffer()))
    .digest("hex");
  if (got !== sha256) fail(`artifact sha256 mismatch (downloaded ${got})`);
  const m = await loadManifestPkg(repoRoot());
  const repo = src.repo;
  await publishIndex(m, [
    {
      id: newId("rel"),
      product,
      kind: "desktop",
      version,
      channel: channelForVersion(version),
      manifestDigest: null,
      manifestUrl: null,
      skillsDigest: null,
      image: null,
      artifact: { url, sha256: `sha256:${sha256}` },
      source: null,
      runtime: null,
      minOs,
      notarized,
      upgradeFrom,
      repo: `${OWNER}/${repo}`,
      commit: null,
      tag: src.tag,
      publishedAt: new Date().toISOString(),
    },
  ]);
}

async function cmdRegistrySign(): Promise<void> {
  await publishIndex(process.env.TB_REGISTRY_UNSIGNED === "1" ? null : await loadManifestPkg(repoRoot()), []);
}

/** C29 interim (no ghcr token yet): a dev-channel entry built from source at a pushed commit. */
async function cmdRegistryAddSource(args: string[]): Promise<void> {
  const product = argValue(args, "--product");
  const kind = argValue(args, "--kind") ?? "app";
  const repo = argValue(args, "--repo");
  const ref = argValue(args, "--ref");
  const dockerfile = argValue(args, "--dockerfile") ?? "Dockerfile";
  const context = argValue(args, "--context") ?? ".";
  const version = argValue(args, "--version");
  const manifestPath = argValue(args, "--manifest");
  const upgradeFrom = argValue(args, "--upgrade-from") ?? "*";
  const runtimeFile = argValue(args, "--runtime");
  if (!product || !/^[a-z0-9][a-z0-9-]*$/.test(product)) fail("--product <id> required");
  if ((kind === "bridge") !== Boolean(runtimeFile)) fail("--runtime <json file> is required for kind bridge and only allowed there");
  let runtime: BridgeRuntime | null = null;
  try {
    runtime = runtimeFile ? validateBridgeRuntime(JSON.parse(readFileSync(runtimeFile, "utf8"))) : null;
  } catch (e) {
    fail((e as Error).message);
  }
  if (kind !== "app" && kind !== "bridge") fail("--kind app|bridge");
  if (!repo || !/^opt2-tealbrick-[a-z0-9-]+$/.test(repo)) fail("--repo opt2-tealbrick-<name> required");
  if (!ref || !/^[0-9a-f]{40}$/.test(ref)) fail("--ref <full commit sha> required");
  if (!safeRel(context) || !safeRel(dockerfile)) fail("--context and --dockerfile must be repo-relative paths without ..");
  if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail("--version <semver> required (source builds always go to channel dev)");
  if (kind === "app" && !manifestPath) fail(`--manifest <path to ${MANIFEST_FILE}> required for apps`);
  const raw = (path: string) => `https://raw.githubusercontent.com/${OWNER}/${repo}/${ref}/${path}`;
  const df = await fetch(raw(dockerfile));
  if (!df.ok) fail(`${dockerfile} not found at ${repo}@${ref} (HTTP ${df.status}); push it first`);
  const volumeLines = dockerfileVolumeLines(await df.text());
  if (volumeLines.length) fail(`${dockerfile} at ${repo}@${ref} has a VOLUME instruction on line ${volumeLines.join(", ")} (C42); remove it and push`);
  let manifestDigest: string | null = null;
  let skillsDigest: string | null = null;
  let m: ManifestPkg | null = null;
  if (manifestPath) {
    m = await loadManifestPkg(repoRoot());
    const res = await fetch(raw(manifestPath));
    if (!res.ok) fail(`${manifestPath} not found at ${repo}@${ref}`);
    const v = m.validateManifest(JSON.parse(await res.text()));
    if (!v.ok) fail(`manifest invalid: ${JSON.stringify(v.errors).slice(0, 2000)}`);
    const man = v.manifest as { id?: string; version?: string; skills?: { id: string; file: string }[] };
    if (man.id !== product || man.version !== version) fail(`manifest id/version ${man.id}@${man.version} != ${product}@${version}`);
    // SPINE-GAPS #15: manifest runtime.build paths are repo-relative and must equal the record's.
    const mb = (v.manifest as { runtime?: { build?: { context?: string; dockerfile?: string } } }).runtime?.build;
    if (mb && ((mb.context ?? ".") !== context || (mb.dockerfile ?? "Dockerfile") !== dockerfile))
      fail(`manifest runtime.build {context: ${mb.context}, dockerfile: ${mb.dockerfile}} != --context ${context} --dockerfile ${dockerfile}`);
    manifestDigest = m.manifestDigest(v.manifest);
    const base = manifestPath.includes("/") ? manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1) : "";
    const files = new Map<string, string>();
    for (const sk of man.skills ?? []) {
      const r = await fetch(raw(base + sk.file));
      if (!r.ok) fail(`skill file ${sk.file} missing`);
      files.set(sk.file, await r.text());
    }
    skillsDigest = m.digest(skillsArchive(man, (f) => files.get(f) ?? ""));
  } else if (process.env.TB_REGISTRY_UNSIGNED !== "1") {
    m = await loadManifestPkg(repoRoot());
  }
  await publishIndex(m, [
    {
      id: newId("rel"),
      product,
      kind,
      version,
      channel: "dev",
      manifestDigest,
      manifestUrl: manifestPath ? raw(manifestPath) : null,
      skillsDigest,
      image: null,
      artifact: null,
      source: { repo: `${OWNER}/${repo}`, ref, dockerfile, ...(context !== "." ? { context } : {}) },
      runtime,
      services: null,
      minOs: null,
      notarized: null,
      upgradeFrom,
      repo: `${OWNER}/${repo}`,
      commit: ref,
      tag: null,
      publishedAt: new Date().toISOString(),
    },
  ]);
}

interface WsPackage {
  rel: string; // relative to the project path
  dir: string; // basename = release tag prefix
  name: string;
  version: string;
  pkg: Record<string, unknown>;
}

function workspacePackages(projectDir: string): WsPackage[] {
  const wsFile = join(projectDir, "pnpm-workspace.yaml");
  if (!existsSync(wsFile)) return [];
  const out: WsPackage[] = [];
  for (const g of workspaceGlobs(readFileSync(wsFile, "utf8"))) {
    const rels = g.endsWith("/*")
      ? (existsSync(join(projectDir, g.slice(0, -2))) ? readdirSync(join(projectDir, g.slice(0, -2)), { withFileTypes: true }) : [])
          .filter((d) => d.isDirectory())
          .map((d) => `${g.slice(0, -2)}/${d.name}`)
      : [g];
    for (const rel of rels) {
      const pj = join(projectDir, rel, "package.json");
      if (!existsSync(pj)) continue;
      const pkg = readJson(pj);
      out.push({ rel, dir: rel.split("/").pop() ?? rel, name: String(pkg.name), version: String(pkg.version), pkg });
    }
  }
  return out;
}

async function uploadFile(repo: string, rel: GhRelease, name: string, data: Buffer, contentType: string): Promise<void> {
  await putAsset(repo, rel, name, data, contentType);
}

/** Package tags, step 1 (NO token): npm pack --ignore-scripts the tagged workspace package into .tb-ci/pack. */
async function cmdPackagePack(): Promise<void> {
  if (process.env.GITHUB_TOKEN || process.env.GHCR_TOKEN) fail("C62: package-pack must run without tokens");
  const root = repoRoot();
  const cfg = loadConfig(root);
  const repo = repoName(root);
  const tag = process.env.CI_COMMIT_TAG;
  if (!tag) fail("package-release runs on tag events only");
  if (repo === PLATFORM_REPO && tag.startsWith("ci-v")) {
    log(`SKIP: ${tag} is a CI template tag, not a package release`);
    return;
  }
  const target = packTarget(cfg, root, tag);
  const all = target.all;
  const distBase = resolveDistBase(cfg);
  // Rewrite in-repo workspace deps to their released tarball URLs; the release must exist.
  const pjPath = join(target.abs, "package.json");
  const original = readFileSync(pjPath, "utf8");
  const pkg = JSON.parse(original) as Record<string, Record<string, string> | unknown>;
  for (const field of DEP_FIELDS) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (!spec.startsWith("workspace:")) continue;
      const dep = all.find((w) => w.name === name);
      if (!dep || !name.startsWith("@opt2-tealbrick/")) fail(`${field}.${name}: only @opt2-tealbrick/* workspace dependencies can be released`);
      // ci-v9.6: with a dist base (tealbrick-ci.json distBaseUrl / TB_DIST_BASE_URL) the dependency URL points at the dist host
      // (the signed lockfile integrity of the consumer still pins the bytes); default stays the GitHub release of this repo.
      const url = releaseUrl(repo, dep.dir, dep.name, dep.version, distBase);
      const res = await fetch(url, { method: "HEAD", redirect: "follow" });
      if (!res.ok)
        fail(
          `${name}@${dep.version} is not released yet (${url}); tag ${dep.dir}-v${dep.version} first${distBase ? " and publish its assets to the dist host" : ""}`,
        );
      deps[name] = url;
    }
  }
  const outDir = join(root, ".tb-ci/pack");
  mkdirSync(outDir, { recursive: true });
  try {
    writeFileSync(pjPath, `${JSON.stringify(pkg, null, 2)}\n`);
    sh("npm", ["pack", "--ignore-scripts", "--pack-destination", outDir], target.abs);
  } finally {
    writeFileSync(pjPath, original);
  }
  const file = tarballName(target.name, target.version);
  const problems = checkPackedTarball(readFileSync(join(outDir, file)));
  if (problems.length) fail(`pack guard (ci-v9.1): ${file}\n  - ${problems.join("\n  - ")}\n  (was the package built before packing?)`);
  log(`packed ${file}; pack guard OK (every main/exports/types/bin target is in the tarball); upload runs in the next step`);
}

interface PackTarget extends WsPackage {
  abs: string; // package directory
  projectDir: string; // the tealbrick-ci.json path (workspace root) that contains it
  all: (WsPackage & { abs: string })[]; // every workspace package of every path
}

/** The workspace package a `<dir>-v<semver>` tag releases; its version must equal the tag version. */
function packTarget(cfg: CiConfig, root: string, tag: string): PackTarget {
  let parsed: { dir: string; version: string };
  try {
    parsed = parsePackageTag(tag);
  } catch (e) {
    fail((e as Error).message);
  }
  const all = cfg.paths.flatMap((p) => workspacePackages(join(root, p)).map((w) => ({ ...w, abs: join(root, p, w.rel), projectDir: join(root, p) })));
  const target = all.find((w) => w.dir === parsed.dir);
  if (!target) fail(`no workspace package directory named ${parsed.dir} (tag ${tag})`);
  if (target.version !== parsed.version) fail(`${target.rel}/package.json version ${target.version} != tag version ${parsed.version}`);
  return { ...target, all };
}

function cmdAdopt(args: string[]): void {
  const dir = args[0];
  const kindIdx = args.indexOf("--kind");
  const kind = kindIdx >= 0 ? args[kindIdx + 1] : undefined;
  if (!dir || !kind || !KINDS.includes(kind as Kind)) fail(`usage: adopt <repoDir> --kind ${KINDS.join("|")}`);
  const here = dirname(fileURLToPath(import.meta.url));
  const target = resolve(dir);
  mkdirSync(join(target, ".woodpecker"), { recursive: true });
  const tpl = readFileSync(join(here, "woodpecker/ci.yaml"), "utf8");
  writeFileSync(join(target, ".woodpecker/ci.yaml"), tpl);
  // ci-v9.10 (C222): a repo whose tealbrick-ci.json says "releaseOn": "woodpecker" gets .woodpecker/release.yaml and loses the
  // Actions release workflow (one publisher per tag); every other releasing kind keeps the Actions template (C72)
  const cfgPathEarly = join(target, "tealbrick-ci.json");
  const onWoodpecker = existsSync(cfgPathEarly) && (JSON.parse(readFileSync(cfgPathEarly, "utf8")) as { releaseOn?: unknown }).releaseOn === "woodpecker";
  if (onWoodpecker) {
    writeFileSync(join(target, WP_RELEASE_PATH), readFileSync(join(here, "woodpecker/release.yaml"), "utf8"));
    rmSync(join(target, GH_WORKFLOW_PATH), { force: true });
    log(`releaseOn woodpecker: wrote ${WP_RELEASE_PATH}, removed ${GH_WORKFLOW_PATH} (C222)`);
  } else {
    rmSync(join(target, WP_RELEASE_PATH), { force: true });
    if (["miniapp", "bridge", "portal", "library", "specs"].includes(kind)) {
      // C72: releasing kinds publish through the GitHub Actions template (setup decides if it is required)
      mkdirSync(join(target, ".github/workflows"), { recursive: true });
      writeFileSync(join(target, GH_WORKFLOW_PATH), readFileSync(join(here, "github/opt2-release.yml"), "utf8"));
    }
  }
  const ref = /TB_CI_REF: (\S+)/.exec(tpl)?.[1] ?? "main";
  const schemaUrl = `https://raw.githubusercontent.com/${OWNER}/${PLATFORM_REPO}/${ref}/ci/tealbrick-ci.schema.json`;
  rmSync(join(target, ".woodpecker/secret-scan.yaml"), { force: true });
  const cfgPath = join(target, "tealbrick-ci.json");
  if (!existsSync(cfgPath)) {
    const cfg = { $schema: schemaUrl, kind, paths: ["."], images: [] };
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  } else {
    // keep the repo's settings AND its formatting; only pin the $schema URL to the template version
    const text = readFileSync(cfgPath, "utf8");
    const pinned = /"\$schema"\s*:\s*"[^"]*"/.test(text)
      ? text.replace(/("\$schema"\s*:\s*)"[^"]*"/, `$1"${schemaUrl}"`)
      : text.replace(/^\s*\{/, `{\n  "$schema": "${schemaUrl}",`);
    JSON.parse(pinned); // still valid JSON
    writeFileSync(cfgPath, pinned);
  }
  const gi = join(target, ".gitignore");
  const giText = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!giText.split("\n").includes(".tb-ci/")) appendFileSync(gi, `${giText.endsWith("\n") || giText === "" ? "" : "\n"}\n# opt2 CI runner scratch\n.tb-ci/\n`);
  log(`adopted ${target} (kind ${kind}); review tealbrick-ci.json, then commit`);
}

function cmdStamp(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const sha = createHash("sha256")
    .update(readFileSync(join(here, "tb-ci.ts")))
    .digest("hex");
  const tplPath = join(here, "woodpecker/ci.yaml");
  const tpl = readFileSync(tplPath, "utf8").replaceAll(/TB_CI_SHA256: "[^"]*"/g, `TB_CI_SHA256: "${sha}"`);
  writeFileSync(tplPath, tpl);
  writeFileSync(join(here, "../.woodpecker/ci.yaml"), tpl);
  for (const rel of ["github/opt2-release.yml", "woodpecker/release.yaml"]) {
    const p = join(here, rel);
    writeFileSync(p, readFileSync(p, "utf8").replaceAll(/TB_CI_SHA256: "[^"]*"/g, `TB_CI_SHA256: "${sha}"`));
  }
  log(`stamped runner sha256 ${sha}`);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "setup":
      return cmdSetup();
    case "install":
      return cmdInstall();
    case "run":
      return cmdRun(rest[0]);
    case "gen":
      return cmdGen();
    case "pre-release":
      return cmdPreRelease();
    case "osv-check":
      return cmdOsvCheck(rest);
    case "gh-build":
      return cmdGhBuild();
    case "gh-publish":
      return cmdGhPublish();
    case "wp-build":
      return cmdWpBuild();
    case "wp-publish":
      return cmdWpPublish();
    case "wp-push":
      return cmdWpPush();
    case "audit-templates":
      return cmdAuditTemplates();
    case "plan-images":
      return cmdPlanImages();
    case "release-record":
      return cmdReleaseRecord();
    case "package-pack":
      return cmdPackagePack();
    case "adopt":
      return cmdAdopt(rest);
    case "stamp":
      return cmdStamp();
    case "registry-add-desktop":
      return cmdRegistryAddDesktop(rest);
    case "registry-sign":
      return cmdRegistrySign();
    case "registry-sync":
      return cmdRegistrySync();
    case "pin-tarballs":
      return cmdPinTarballs(rest);
    case "registry-add-source":
      return cmdRegistryAddSource(rest);
    default:
      fail(
        "usage: tb-ci setup|install|run <script>|gen|pre-release|osv-check <report.json>|audit-templates|gh-build|gh-publish|wp-build|wp-push|wp-publish|plan-images|release-record|package-pack|registry-add-desktop|registry-add-source|registry-sign|registry-sync|pin-tarballs|adopt|stamp",
      );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e: unknown) => fail((e as Error).stack ?? String(e)));
}
