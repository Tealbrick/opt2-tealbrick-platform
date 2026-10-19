import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  addPnpmIntegrity,
  artifactSource,
  assetChecksums,
  assetDecision,
  auditVerdict,
  belowMinimum,
  buildCandidateDoc,
  CANDIDATE_ASSET,
  CLI_DIST_BASE,
  CLI_REPO,
  CRANE_SHA256,
  CRANE_URL,
  CRANE_VERSION,
  type CraneRun,
  channelForVersion,
  checkDependencies,
  checkPackageJson,
  checkPackedTarball,
  checkServiceImages,
  cliEntryProblem,
  cliReleaseFromAssets,
  cliSourceReleases,
  cliTarballUrl,
  craneAbsent,
  DENIED_TEMPLATES,
  DEV_ONLY_PRODUCTS,
  DIST_BASES,
  DIST_PRODUCTS,
  distEntryProblem,
  distReleaseFromAssets,
  distRepo,
  distTag,
  distTarballUrl,
  distVersionWanted,
  dockerfileInstallProblems,
  dockerfileVolumeLines,
  expectedGenFiles,
  GH_WORKFLOW_PATH,
  ghcrFind,
  ghcrPushDecision,
  IMAGE_NAMESPACE,
  IMAGE_NAMESPACES,
  INDEX_KINDS,
  type IndexRelease,
  imageLabelProblems,
  imageNamespace,
  isDistTarballUrl,
  isReleaseTarballUrl,
  isSpecTarballUrl,
  KANIKO_PLATFORM,
  KNOWN_OWNERS,
  LEGACY_OWNERS,
  labelsFromImageTar,
  loadManifestPkg,
  loadProductBindings,
  lockfileTarballs,
  lockPinProblems,
  mergeIndex,
  missingPackTargets,
  missingPreReleaseChecks,
  newId,
  normalizeDevOnly,
  normalizeDistBase,
  normalizeLegacyOwners,
  OPT2_REPOS,
  OSV_CONFIG_FILE,
  OSV_IGNORE_MAX_DAYS,
  OSV_LOCKFILES_FILE,
  OSV_REPORT_FILE,
  OWNER,
  osvIgnoreProblems,
  osvLockfileEmpty,
  osvLockfiles,
  osvSeverityOf,
  osvTable,
  osvVerdict,
  PENDING_REPOS,
  PG_DONE_MARKER,
  PG_MARKER,
  PG_TEST_URL,
  PR_REQUIRED_FROM,
  PRIVATE_REPOS,
  packageBuildArgs,
  packageManagerPinned,
  packageReleaseCommands,
  packEntryTargets,
  packScriptOutputProblems,
  parseOsvIgnore,
  parseOsvReport,
  parsePackageTag,
  parsePackScripts,
  parsePreReleaseChecks,
  preReleaseEnv,
  productBindingProblem,
  promotionReleases,
  pushImages,
  REGISTRY_EXTRA_ASSETS,
  releaseChannel,
  releaseFileProblems,
  releaseGuard,
  releaseUrl,
  renderImagesScript,
  renderReleaseImagesScript,
  repoAliases,
  repoFullName,
  repoReader,
  repoReadProblem,
  resolveDistBase,
  sha512Integrity,
  skillsArchive,
  tagChannel,
  tarballName,
  tarEntries,
  templateVersion,
  testEnv,
  uploadTarget,
  validateBridgeRuntime,
  validateConfig,
  validateHarnesses,
  validateIgnoredTags,
  validateOffers,
  validateProducts,
  validatePromotions,
  verifyImageProvenance,
  verifyOwnerRewrites,
  versionFromTag,
  WP_GHCR_SECRET,
  WP_IMAGE_SCRIPT,
  WP_RELEASE_PATH,
  WP_RELEASE_SECRET,
  workspaceGlobs,
  wpCandidateDoc,
  wpReleaseTarget,
} from "./tb-ci.ts";

const repo = "opt2-tealbrick-knowledge";

test("channel from version", () => {
  assert.equal(channelForVersion("1.2.3"), "stable");
  assert.equal(channelForVersion("1.2.3-rc.1"), "dev");
  assert.equal(channelForVersion("1.2.3-beta.4"), "dev");
  assert.equal(channelForVersion("1.2.3-dev.7"), "dev");
  assert.equal(channelForVersion("1.2.3-alpha.1"), "dev");
});

test("version from tag rejects non-semver and build metadata", () => {
  assert.equal(versionFromTag("v0.1.0-dev.3"), "0.1.0-dev.3");
  assert.throws(() => versionFromTag("0.1.0"));
  assert.throws(() => versionFromTag("v1.0"));
  assert.throws(() => versionFromTag("v1.0.0+build.1"));
});

test("config defaults and validation", () => {
  const c = validateConfig({ kind: "miniapp", images: [{ name: repo, product: "knowledge", kind: "app", manifest: "tealbrick.manifest.json" }] }, repo);
  assert.equal(c.conformance, true);
  assert.deepEqual(c.paths, ["."]);
  assert.equal(c.images[0].dockerfile, "Dockerfile");
  assert.equal(validateConfig({ kind: "library" }, repo).conformance, false);
  assert.throws(() => validateConfig({ kind: "nope" }, repo), /kind/);
  assert.throws(() => validateConfig({ kind: "library", extra: 1 }, repo), /unknown field/);
  assert.throws(() => validateConfig({ kind: "library", paths: ["../x"] }, repo), /paths/);
  assert.throws(() => validateConfig({ kind: "miniapp", images: [{ name: "other-image", product: "x", kind: "app" }] }, repo), /name/);
  assert.throws(() => validateConfig({ kind: "miniapp", images: [{ name: repo, product: "knowledge", kind: "app" }] }, repo), /manifest/);
  assert.throws(() => validateConfig({ kind: "miniapp", images: [{ name: repo, product: "k", kind: "worker" }] }, repo), /app\|bridge\|portal\|service/);
});

test("package.json rules: private, no publishConfig, required scripts", () => {
  const cfg = validateConfig({ kind: "miniapp" }, repo);
  const errs = checkPackageJson({ scripts: { typecheck: "tsc", lint: "biome check", test: "node --test" }, publishConfig: {} }, cfg, "pkg");
  assert.ok(errs.some((e) => e.includes("private")));
  assert.ok(errs.some((e) => e.includes("publishConfig")));
  assert.ok(errs.some((e) => e.includes('"conformance"')));
  assert.deepEqual(checkPackageJson({ private: true, scripts: { typecheck: "a", lint: "b", test: "c", conformance: "d", gen: "tb-gen all" } }, cfg, "pkg"), []);
  assert.ok(
    checkPackageJson({ private: true, scripts: { typecheck: "a", lint: "b", test: "c", conformance: "d" } }, cfg, "pkg").some((e) => e.includes('"gen"')),
    "miniapp needs a gen script (BSA-03)",
  );
});

const rel = (over: Partial<IndexRelease>): IndexRelease => ({
  id: "rel_01JA0000000000000000000000",
  product: "knowledge",
  kind: "app",
  version: "0.1.0",
  channel: "dev", // C207 E4: new app/bridge records land on dev; stable only by promotion
  manifestDigest: `sha256:${"c".repeat(64)}`,
  manifestUrl: null,
  skillsDigest: null,
  image: `ghcr.io/tealbrick/${repo}@sha256:${"a".repeat(64)}`,
  artifact: null,
  source: null,
  runtime: null,
  minOs: null,
  notarized: null,
  upgradeFrom: "*",
  repo: `Tealbrick/${repo}`,
  commit: "abc",
  tag: "v0.1.0",
  publishedAt: "2026-10-11T00:00:00.000Z",
  ...over,
});

test("ids are <prefix>_<ULID>", () => {
  const id = newId("rel", 1760000000000, new Uint8Array(10));
  assert.match(id, /^rel_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(id.endsWith("0000000000000000"));
  assert.notEqual(newId("rel"), newId("rel"));
});

const brt = {
  port: 8080,
  internalPort: 8788,
  healthPath: "/healthz",
  readyPath: "/readyz",
  volumes: [{ mountPath: "/data", backup: true }],
  env: [{ name: "TB_KEK", source: "provider-secret" as const }],
};

test("bridge runtime validation", () => {
  assert.deepEqual(validateBridgeRuntime(brt), brt);
  assert.throws(() => validateBridgeRuntime({ ...brt, internalPort: 8080 }), /distinct/);
  assert.throws(() => validateBridgeRuntime({ ...brt, env: [{ name: "X1", source: "fixed" }] }), /value only/);
  assert.throws(() => mergeIndex(null, [rel({ product: "bridge", kind: "bridge", manifestDigest: null })], [], "t"), /runtime is required/);
  assert.throws(() => mergeIndex(null, [rel({ runtime: brt })], [], "t"), /only allowed/);
});

test("index merge: add, idempotent re-add, immutable content, desktop kind, offers carried", () => {
  const i1 = mergeIndex(null, [rel({})], [], "t1");
  assert.equal(i1.schema, "opt2.release-index/v2");
  assert.equal(mergeIndex(i1, [rel({ id: "rel_other" })], [], "t2").releases.length, 1);
  assert.throws(() => mergeIndex(i1, [rel({ image: `ghcr.io/tealbrick/${repo}@sha256:${"b".repeat(64)}` })], [], "t"), /immutable/);
  const desk = rel({ product: "tbd", kind: "desktop", image: null, manifestDigest: null, artifact: { url: "https://x", sha256: `sha256:${"d".repeat(64)}` } });
  const i2 = mergeIndex(i1, [desk, rel({ product: "bridge", kind: "bridge", manifestDigest: null, runtime: brt })], [], "t3");
  assert.deepEqual(
    i2.releases.map((r) => r.product),
    ["bridge", "knowledge", "tbd"],
  );
  const src = { repo: "Tealbrick/opt2-tealbrick-bridge", ref: "f".repeat(40), dockerfile: "Dockerfile" };
  assert.throws(
    () => mergeIndex(null, [rel({ channel: "stable", image: null, source: src })], [], "t"),
    /promotedFrom/,
    "C207 E4: no new stable without a promotion",
  );
  assert.equal(mergeIndex(null, [rel({ version: "0.1.0-dev.1", channel: "dev", image: null, source: src })], [], "t").releases.length, 1);
  assert.throws(() => mergeIndex(null, [rel({ version: "0.1.0-dev.1", channel: "dev", image: null })], [], "t"), /image or source/);
  const devSrc = mergeIndex(null, [rel({ channel: "dev", image: null, source: src })], [], "t");
  assert.equal(
    mergeIndex(devSrc, [rel({ id: "rel_01JA0000000000000000000002" })], [], "t2").releases.length,
    2,
    "dev source 0.1.0 and dev image 0.1.0 coexist (C207 E4)",
  );
});

test("offers validation", () => {
  const ok = {
    id: "off_01JA0000000000000000000000",
    kind: "single",
    name: "Knowledge",
    products: ["knowledge"],
    major: 0,
    amount: 9900,
    currency: "usd",
    taxNote: "Tax added at checkout",
    stripePrice: { test: "price_123", live: null },
  };
  assert.equal(validateOffers([ok]).length, 1);
  assert.throws(() => validateOffers([{ ...ok, id: "knowledge-v1" }]), /off_/);
  assert.throws(() => validateOffers([{ ...ok, products: ["a", "b"] }]), /exactly one/);
  assert.throws(() => validateOffers([{ ...ok, stripePrice: { test: "sk_test_x", live: null } }]), /price_/);
  assert.throws(() => validateOffers([ok, ok]), /duplicate/);
  // free fixture offers: DEV_ONLY_PRODUCTS only, no Stripe price
  const free = { ...ok, products: ["sample-pay"], amount: 0, stripePrice: { test: null, live: null } };
  assert.equal(validateOffers([free]).length, 1);
  assert.throws(() => validateOffers([{ ...free, products: ["knowledge"] }]), /DEV_ONLY_PRODUCTS/);
  assert.throws(() => validateOffers([{ ...free, stripePrice: { test: "price_123", live: null } }]), /no Stripe price/);
  assert.throws(() => validateOffers([{ ...ok, amount: -1 }]), /amount/);
  // the reviewed registry input passes
  const offers = validateOffers(JSON.parse(readFileSync(new URL("../registry/offers.json", import.meta.url), "utf8")));
  assert.deepEqual(
    offers.filter((o) => o.amount === 0).map((o) => o.products[0]),
    ["sample-pay", "sample-mismatch"],
  );
});

test("skills archive is sorted and complete", () => {
  const a = skillsArchive(
    {
      skills: [
        { id: "b", file: "skills/b/SKILL.md" },
        { id: "a", file: "skills/a/SKILL.md" },
      ],
    },
    (f) => `content of ${f}`,
  );
  assert.deepEqual(
    a.files.map((f) => f.id),
    ["a", "b"],
  );
  assert.equal(a.files[0].content, "content of skills/a/SKILL.md");
  assert.equal(skillsArchive({}, () => "").files.length, 0);
});

test("images script: check builds every image, never pushes, no credentials", () => {
  assert.match(renderImagesScript(validateConfig({ kind: "library" }, repo), repo), /nothing to build/);
  const cfg = validateConfig({ kind: "miniapp", images: [{ name: repo, product: "knowledge", kind: "app", manifest: "m.json" }] }, repo);
  const s = renderImagesScript(cfg, repo);
  assert.match(s, /--no-push/);
  assert.ok(!/GHCR_TOKEN|config\.json|--destination|--tar-path/.test(s));
});

test("dependency rules: v1 names rejected, @opt2-tealbrick only via workspace or release URL", () => {
  const url = "https://github.com/Tealbrick/opt2-tealbrick-sdk/releases/download/manifest-v0.1.0/opt2-tealbrick-manifest-0.1.0.tgz";
  const [errs, urls] = checkDependencies(
    {
      dependencies: { "@opt2-tealbrick/manifest": url, "@opt2-tealbrick/spec": "0.1.0", tealbrick: "1.0.0", zod: "^4" },
      devDependencies: { "@tealbrick/contract": "1", "@opt2-tealbrick/miniapp-sdk": "workspace:*", "@opt2-tealbrick/other": "workspace:*" },
    },
    "pkg",
    new Set(["@opt2-tealbrick/miniapp-sdk"]),
  );
  assert.deepEqual(urls, [url]);
  assert.equal(errs.length, 4, errs.join("\n"));
  assert.ok(errs.some((e) => e.includes("@opt2-tealbrick/spec") && e.includes("release tarball URL")));
  assert.ok(errs.some((e) => e.includes("dependencies.tealbrick")));
  assert.ok(errs.some((e) => e.includes("@tealbrick/contract")));
  assert.ok(errs.some((e) => e.includes("@opt2-tealbrick/other") && e.includes("workspace")));
  assert.equal(checkDependencies({ dependencies: { "@opt2-tealbrick/x": "https://evil.example/x.tgz" } }, "p", new Set())[0].length, 1);
});

test("workspace globs and package tags", () => {
  assert.deepEqual(workspaceGlobs("packages:\n  - 'packages/*'\n  - tools\nother: 1\n"), ["packages/*", "tools"]);
  assert.throws(() => workspaceGlobs("packages:\n  - 'packages/**'\n"), /unsupported/);
  assert.deepEqual(parsePackageTag("manifest-v0.1.0"), { dir: "manifest", version: "0.1.0" });
  assert.deepEqual(parsePackageTag("create-tealbrick-miniapp-v1.2.3-rc.1"), { dir: "create-tealbrick-miniapp", version: "1.2.3-rc.1" });
  assert.throws(() => parsePackageTag("v0.1.0"));
  assert.equal(tarballName("@opt2-tealbrick/manifest", "0.1.0"), "opt2-tealbrick-manifest-0.1.0.tgz");
  assert.equal(tarballName("create-tealbrick-miniapp", "0.1.0"), "create-tealbrick-miniapp-0.1.0.tgz");
  assert.equal(
    releaseUrl("opt2-tealbrick-sdk", "manifest", "@opt2-tealbrick/manifest", "0.1.0"),
    "https://github.com/Tealbrick/opt2-tealbrick-sdk/releases/download/manifest-v0.1.0/opt2-tealbrick-manifest-0.1.0.tgz",
  );
});

test("harnesses validation (frozen HarnessOption, C40a)", () => {
  const h = {
    id: "claude-desktop",
    kind: "desktop",
    label: "Claude Desktop",
    icon: null,
    authorise: "instruction_set",
    noAgentPath: false,
    instructions: [{ title: "Add connector", detail: "Paste the URL.", copy: { kind: "url", value: "{{mcpUrl}}" } }],
  };
  assert.equal(validateHarnesses([h]).length, 1);
  assert.throws(() => validateHarnesses([h, h]), /duplicate/);
  assert.throws(() => validateHarnesses([{ ...h, authorise: "pairing" }]), /authorise/);
  assert.throws(() => validateHarnesses([{ ...h, kind: "agentic" }]), /kind/);
  assert.throws(() => validateHarnesses([{ ...h, assets: {} }]), /exactly/);
  assert.throws(() => validateHarnesses([{ ...h, instructions: [] }]), /at least one/);
  assert.throws(() => validateHarnesses([{ ...h, instructions: [{ title: "t", detail: "use {{ownerToken}}" }] }]), /unknown placeholder/);
  assert.throws(() => validateHarnesses([{ ...h, instructions: [{ title: "t", detail: "d", copy: { kind: "html", value: "x" } }] }]), /copy/);
  assert.throws(() => validateHarnesses([{ ...h, icon: "https://evil.example/x.svg" }]), /icon/);
  assert.throws(
    () =>
      validateHarnesses([
        { ...h, noAgentPath: true },
        { ...h, id: "tbd-default", noAgentPath: true },
      ]),
    /no-agent/,
  );
  assert.deepEqual(
    mergeIndex(null, [], [], "t", validateHarnesses([h])).harnesses.map((x) => x.id),
    ["claude-desktop"],
  );
});

test("the committed registry/harnesses.json is valid and has a claude-code row (F75)", () => {
  const rows = validateHarnesses(JSON.parse(readFileSync(new URL("../registry/harnesses.json", import.meta.url), "utf8")));
  const cc = rows.find((r) => r.id === "claude-code");
  assert.ok(cc, "claude-code row");
  assert.equal(cc.authorise, "device_approval");
  assert.ok(cc.instructions.some((st) => st.copy?.value.includes("--harness claude-code")));
  // F77/F78 (CLI 0.1.20): connect writes the project scope .mcp.json with absolute node + tealbrick paths
  const wire = cc.instructions.find((st) => st.copy?.value.startsWith("tealbrick connect claude-code"));
  assert.ok(
    wire && /project scope/.test(wire.detail) && /\.mcp\.json/.test(wire.detail) && /full paths/.test(wire.detail),
    "row says project scope + absolute paths",
  );
});

test("GTP-01: a product is signed only from its bound repo and kind (fires on a foreign repo, quiet on its own)", () => {
  const b = validateProducts({
    bridge: { repo: "Tealbrick/opt2-tealbrick-bridge", kind: "bridge" },
    knowledge: { repo: `Tealbrick/${repo}`, kind: "app" },
  });
  // quiet on good
  assert.equal(productBindingProblem(b, { product: "bridge", kind: "bridge", repo: "Tealbrick/opt2-tealbrick-bridge" }), null);
  assert.equal(mergeIndex(null, [rel({})], [], "t", [], b).releases.length, 1, "knowledge from its own repo is signed");
  // fire on bad: a samples tag declaring product "bridge" (the review's attack), a kind change, an unknown product
  assert.match(
    productBindingProblem(b, { product: "bridge", kind: "bridge", repo: "Tealbrick/opt2-tealbrick-samples" }) ?? "",
    /bound to Tealbrick\/opt2-tealbrick-bridge/,
  );
  assert.match(productBindingProblem(b, { product: "knowledge", kind: "bridge", repo: `Tealbrick/${repo}` }) ?? "", /bound as kind app/);
  assert.match(productBindingProblem(b, { product: "newapp", kind: "app", repo: `Tealbrick/${repo}` }) ?? "", /not bound/);
  assert.match(productBindingProblem(b, { product: "constructor", kind: "app", repo: `Tealbrick/${repo}` }) ?? "", /not bound/, "no prototype keys");
  const evil = rel({ product: "bridge", kind: "bridge", version: "99.0.0", manifestDigest: null, runtime: brt, repo: "Tealbrick/opt2-tealbrick-samples" });
  assert.throws(() => mergeIndex(null, [evil], [], "t", [], b), /GTP-01/);
  // without the map, the index still refuses a repo change for a product that already has releases
  const i1 = mergeIndex(
    null,
    [rel({ product: "bridge", kind: "bridge", manifestDigest: null, runtime: brt, repo: "Tealbrick/opt2-tealbrick-bridge" })],
    [],
    "t",
  );
  assert.throws(() => mergeIndex(i1, [evil], [], "t2"), /earlier releases of bridge come from Tealbrick\/opt2-tealbrick-bridge/);
  assert.throws(() => validateProducts({ bridge: { repo: "evil/opt2-tealbrick-bridge", kind: "bridge" } }), /repo must be/);
  assert.throws(() => validateProducts({ bridge: { repo: "Tealbrick/opt2-tealbrick-bridge", kind: "lib" } }), /kind must be/);
});

test("GTP-01: the committed registry/products.json binds every product of the committed index to the repo it came from", () => {
  const b = loadProductBindings();
  const index = JSON.parse(readFileSync(new URL("../registry/index.json", import.meta.url), "utf8")) as { releases: IndexRelease[] };
  // C206: entries signed before the org move carry the legacy repo string; the binding's formerRepos covers exactly that
  for (const r of index.releases) {
    const bound = b[r.product];
    assert.ok(bound, `${r.product} is bound`);
    assert.equal(bound.kind, r.kind, `${r.product}@${r.version} kind`);
    assert.ok(repoAliases(bound).includes(r.repo), `${r.product}@${r.version}: ${r.repo} is ${bound.repo} or one of its formerRepos`);
  }
  assert.equal(b.bridge?.repo, "Tealbrick/opt2-tealbrick-bridge");
  assert.deepEqual(b.bridge?.formerRepos, ["Martin-Atrin/opt2-tealbrick-bridge"]);
});

test("C42: VOLUME instruction detection", () => {
  assert.deepEqual(dockerfileVolumeLines('FROM node\nVOLUME ["/data"]\nCMD x'), [2]);
  assert.deepEqual(dockerfileVolumeLines("FROM node\n  volume /data\n"), [2]);
  assert.deepEqual(dockerfileVolumeLines("FROM node\n# VOLUME /data\nRUN mkdir -p /data && \\\n  echo VOLUME\nENV TB_DATA_DIR=/data"), []);
  assert.deepEqual(dockerfileVolumeLines("FROM node\nRUN echo a \\\n VOLUME /x\n"), [], "continuation lines are not instructions");
  assert.deepEqual(dockerfileVolumeLines("FROM node\nENV VOLUME_DIR=/data\n"), []);
});

test("BSA-01: service images belong to an app and match the manifest services", () => {
  const app = { name: repo, product: "knowledge", kind: "app", manifest: "tealbrick.manifest.json" };
  const svc = (id: string) => ({ name: `${repo}-${id}`, product: "knowledge", kind: "service", service: id, dockerfile: `services/${id}/Dockerfile` });
  const cfg = validateConfig({ kind: "miniapp", images: [app, svc("gbrain"), svc("gbrain-db")] }, repo);
  assert.equal(cfg.images.filter((i) => i.kind === "service").length, 2);
  assert.throws(() => validateConfig({ kind: "miniapp", images: [svc("gbrain")] }, repo), /parent/);
  assert.throws(() => validateConfig({ kind: "miniapp", images: [app, { ...svc("x"), service: undefined }] }, repo), /needs service/);
  assert.throws(() => validateConfig({ kind: "miniapp", images: [app, svc("x"), { ...svc("x"), name: `${repo}-x2` }] }, repo), /twice/);
  assert.throws(() => validateConfig({ kind: "miniapp", images: [{ ...app, service: "x" }] }, repo), /only allowed/);
  const services = [
    { id: "gbrain", build: {} },
    { id: "gbrain-db", build: {} },
    { id: "upstream", image: "x@sha256:1" },
  ];
  assert.deepEqual(checkServiceImages(cfg, "knowledge", services), []);
  assert.match(checkServiceImages(cfg, "knowledge", [...services, { id: "notebook", build: {} }]).join(), /notebook has build but no images/);
  assert.match(checkServiceImages(cfg, "knowledge", [{ id: "gbrain", build: {} }]).join(), /gbrain-db is not a manifest service/);
});

test("BSA-03: expected generated files", () => {
  assert.deepEqual(expectedGenFiles("connect"), ["openapi/openapi.json", "kit/connect-kit/package.json", "docs/connect.md", "railway/railway.json"]);
});

test("D1: minimum template ref", () => {
  assert.equal(belowMinimum("ci-v5", "ci-v6"), true);
  assert.equal(belowMinimum("ci-v6", "ci-v6"), false);
  assert.equal(belowMinimum("ci-v10", "ci-v6"), false);
  assert.equal(belowMinimum("none", "ci-v6"), true);
  assert.equal(belowMinimum("main", "ci-v6"), true);
  assert.throws(() => belowMinimum("ci-v6", "v6"), /bad minimum/);
});

test("ci-v9.1: point-release template refs compare as major.minor", () => {
  assert.deepEqual(templateVersion("ci-v9.1"), [9, 1]);
  assert.deepEqual(templateVersion("ci-v9"), [9, 0]);
  assert.equal(templateVersion("ci-v9.x"), null);
  assert.equal(belowMinimum("ci-v9.1", "ci-v8"), false);
  assert.equal(belowMinimum("ci-v9.1", "ci-v9"), false);
  assert.equal(belowMinimum("ci-v9", "ci-v9.1"), true);
  assert.equal(belowMinimum("ci-v9.1", "ci-v9.2"), true);
  assert.equal(belowMinimum("ci-v9.2", "ci-v9.1"), false);
  assert.equal(belowMinimum("ci-v9.2", "ci-v10"), true);
  assert.equal(belowMinimum("ci-v10", "ci-v9.1"), false);
});

test("S3: lockfile tarball integrity detection", () => {
  const url = "https://github.com/Tealbrick/opt2-tealbrick-sdk/releases/download/manifest-v0.1.3/opt2-tealbrick-manifest-0.1.3.tgz";
  const pnpm = `packages:\n  '@opt2-tealbrick/manifest@${url}':\n    resolution: {tarball: ${url}}\n    version: 0.1.3\n  ajv@8.17.1:\n    resolution: {integrity: sha512-abc}\n`;
  assert.deepEqual(lockfileTarballs(pnpm, "pnpm"), [{ url, integrity: null }]);
  const pnpmInt = pnpm.replace(`{tarball: ${url}}`, `{integrity: sha512-xyz, tarball: ${url}}`);
  assert.deepEqual(lockfileTarballs(pnpmInt, "pnpm"), [{ url, integrity: "sha512-xyz" }]);
  const npm = JSON.stringify({
    packages: {
      "node_modules/@opt2-tealbrick/manifest": { resolved: url, integrity: "sha512-q" },
      "node_modules/ajv": { resolved: "https://registry.npmjs.org/ajv/-/ajv-8.17.1.tgz", integrity: "sha512-r" },
    },
  });
  assert.deepEqual(lockfileTarballs(npm, "npm"), [{ url, integrity: "sha512-q" }]);
  assert.match(sha512Integrity(new TextEncoder().encode("x")), /^sha512-[A-Za-z0-9+/]+=*$/);
});

test("SEC-03: image provenance check binds image to repo + commit", async () => {
  const commit = "c".repeat(40);
  const fake = (labels: Record<string, string>): typeof fetch =>
    (async (u: string | URL | Request) => {
      const s = String(u);
      if (s.includes("/token?")) return new Response(JSON.stringify({ token: "t" }));
      if (s.includes("/manifests/")) return new Response(JSON.stringify({ config: { digest: `sha256:${"e".repeat(64)}` } }));
      if (s.includes("/blobs/")) return new Response(JSON.stringify({ config: { Labels: labels } }));
      return new Response("", { status: 404 });
    }) as typeof fetch;
  const ref = `ghcr.io/tealbrick/${repo}-gbrain@sha256:${"a".repeat(64)}`;
  const good = { "org.opencontainers.image.revision": commit, "org.opencontainers.image.source": `https://github.com/Tealbrick/${repo}` };
  assert.equal(await verifyImageProvenance(ref, `Tealbrick/${repo}`, commit, fake(good)), null);
  assert.match(
    String(await verifyImageProvenance(ref, `Tealbrick/${repo}`, commit, fake({ ...good, "org.opencontainers.image.revision": "d".repeat(40) }))),
    /revision label/,
  );
  assert.match(String(await verifyImageProvenance(ref, "Tealbrick/opt2-tealbrick-connect", commit, fake(good))), /does not belong/);
  assert.match(String(await verifyImageProvenance("ghcr.io/evil/x@sha256:1", `Tealbrick/${repo}`, commit, fake(good))), /bad image ref/);
});

test("C62: pnpm lockfile integrity is written into tarball resolutions", () => {
  const url = "https://github.com/Tealbrick/opt2-tealbrick-sdk/releases/download/manifest-v0.1.3/opt2-tealbrick-manifest-0.1.3.tgz";
  const lock = `  '@opt2-tealbrick/manifest@${url}':\n    resolution: {tarball: ${url}}\n  ajv@8.17.1:\n    resolution: {integrity: sha512-abc}\n`;
  const { text, changed } = addPnpmIntegrity(lock, () => "sha512-XYZ=");
  assert.equal(changed, 1);
  assert.match(text, new RegExp(`resolution: \\{integrity: sha512-XYZ=, tarball: ${url.replaceAll(".", "\\.")}\\}`));
  assert.deepEqual(lockfileTarballs(text, "pnpm"), [{ url, integrity: "sha512-XYZ=" }]);
  assert.equal(addPnpmIntegrity(text, () => "x").changed, 0, "idempotent");
});

test("C62: packageManager must be hash-pinned", () => {
  assert.equal(packageManagerPinned(`pnpm@9.15.4+sha512.${"a".repeat(128)}`), true);
  assert.equal(packageManagerPinned("pnpm@9.15.4"), false);
  assert.equal(packageManagerPinned(`pnpm@9.15.4+sha256.${"a".repeat(64)}`), false);
});

test("C62: Dockerfile installs must be frozen and script-free", () => {
  assert.deepEqual(dockerfileInstallProblems("FROM node\nRUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts\n"), []);
  assert.deepEqual(dockerfileInstallProblems("FROM node\nRUN npm ci --ignore-scripts --omit=dev\n"), []);
  assert.match(dockerfileInstallProblems("FROM node\nRUN pnpm install --frozen-lockfile\n").join(), /line 2: pnpm install without --ignore-scripts/);
  assert.match(dockerfileInstallProblems("FROM node\nRUN pnpm install \\\n  --ignore-scripts\n").join(), /line 2: pnpm install without --frozen-lockfile/);
  assert.match(dockerfileInstallProblems("FROM node\nRUN npm install express\n").join(), /npm install in an image build/);
  assert.match(dockerfileInstallProblems("FROM node\nRUN npm ci\n").join(), /npm ci without --ignore-scripts/);
  assert.deepEqual(dockerfileInstallProblems("FROM node\n# RUN npm install x\nRUN echo pnpm\n"), []);
});

// ---------- ci-v9.1 (C75) ----------

/** Minimal ustar writer for tests (pax `path` header for names over 100 bytes, as npm pack writes them). */
function makeTgz(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: string): Buffer => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 99), 0);
    h.write("0000644\0", 100);
    h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
    h.write(type, 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    h.fill(32, 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    return h;
  };
  const pad = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  for (const [rel, text] of Object.entries(files)) {
    const name = `package/${rel}`;
    const data = Buffer.from(text);
    if (name.length > 99) {
      const rec = ` path=${name}\n`;
      let len = rec.length + 2;
      if (`${len}${rec}`.length !== len) len += 1;
      const pax = Buffer.from(`${len}${rec}`);
      blocks.push(header("PaxHeader", pax.length, "x"), pad(pax));
    }
    blocks.push(header(name, data.length, "0"), pad(data));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const specPkg = {
  name: "@opt2-tealbrick/spec",
  version: "0.1.11",
  exports: {
    ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    "./schemas/*": "./schemas/*",
  },
  bin: { "tb-x": "./dist/cli.js" },
};

test("C75 build step: gh-build installs (frozen, no scripts), then builds, before packing", () => {
  const cmds = packageReleaseCommands([{ dir: "/w", pm: "pnpm" }], "/w", { build: "pnpm -r run build" }, "@opt2-tealbrick/spec");
  assert.deepEqual(
    cmds.map((c) => [c.cwd, c.cmd, ...c.args].join(" ")),
    ["/w corepack pnpm install --frozen-lockfile --ignore-scripts", "/w corepack pnpm run build"],
  );
  assert.equal(cmds.at(-1)?.args.includes("build"), true, "the last command before pack is the build");
  assert.deepEqual(packageBuildArgs({ build: "tsc -b" }, "@x/y"), ["pnpm", "run", "build"]);
  assert.deepEqual(packageBuildArgs({}, "@x/y"), ["pnpm", "--filter", "@x/y...", "run", "--if-present", "build"]);
});

test("C75 pack guard: entry targets of main/exports/types/bin", () => {
  assert.deepEqual(packEntryTargets(specPkg), ["dist/cli.js", "dist/index.d.ts", "dist/index.js", "schemas/*"]);
  assert.deepEqual(packEntryTargets({ main: "./lib/a.js", types: "lib/a.d.ts", bin: "./bin/x.js", exports: ["./lib/a.js", null] }), [
    "bin/x.js",
    "lib/a.d.ts",
    "lib/a.js",
  ]);
  assert.deepEqual(missingPackTargets(specPkg, ["package.json", "dist/index.js", "dist/index.d.ts", "dist/cli.js", "schemas/a.json"]), []);
  assert.deepEqual(missingPackTargets(specPkg, ["package.json", "dist/index.js", "dist/index.d.ts", "dist/cli.js"]), ["schemas/*"]);
  assert.deepEqual(missingPackTargets({ main: "index" }, ["index.js"]), [], "extension-less main resolves like Node");
});

test("C75 pack guard: passes a built tarball, fails one without dist/", () => {
  const pj = JSON.stringify(specPkg);
  const long = `schemas/${"deep/".repeat(20)}x.json`;
  const built = makeTgz({ "package.json": pj, "dist/index.js": "", "dist/index.d.ts": "", "dist/cli.js": "", [long]: "{}" });
  assert.ok(tarEntries(built).has(long), "pax long names are read");
  assert.deepEqual(checkPackedTarball(built), []);
  const unbuilt = makeTgz({ "package.json": pj, "schemas/a.json": "{}" });
  const problems = checkPackedTarball(unbuilt);
  assert.equal(problems.length, 3);
  assert.ok(problems.every((p) => p.startsWith("@opt2-tealbrick/spec: dist/")));
  assert.deepEqual(checkPackedTarball(makeTgz({ "README.md": "" })), ["the tarball has no package.json"]);
});

test("ci-v9.1 postgres is opt-in: config, unit env and template", () => {
  assert.equal(validateConfig({ kind: "library" }, repo).postgres, false);
  assert.equal(validateConfig({ kind: "library", postgres: true }, repo).postgres, true);
  assert.throws(() => validateConfig({ kind: "library", postgres: "yes" }, repo), /postgres must be boolean/);
  const off = testEnv(validateConfig({ kind: "library" }, repo), { TB_TEST_DATABASE_URL: "x", PATH: "/bin" });
  assert.equal(off.TB_TEST_DATABASE_URL, undefined);
  assert.equal(off.PATH, "/bin");
  assert.equal(testEnv(validateConfig({ kind: "library", postgres: true }, repo), {}).TB_TEST_DATABASE_URL, PG_TEST_URL);
  const tpl = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  assert.doesNotMatch(tpl, /^services:/m, "no always-on service (it showed a red step on green pipelines)");
  assert.doesNotMatch(tpl, /TB_TEST_DATABASE_URL:/, "the runner sets the URL only when opted in");
  const step = /- name: postgres\n([\s\S]*?)\n\n/.exec(tpl)?.[1] ?? "";
  assert.doesNotMatch(step, /detach:/, "ci-v9.3: a detached step ends red on this Woodpecker");
  assert.ok(step.includes(`if [ ! -f ${PG_MARKER} ]; then`) && step.includes("exit 0"), "skips (green) unless setup wrote the marker");
  assert.ok(tpl.indexOf("- name: setup") < tpl.indexOf("- name: postgres"), "postgres starts after setup decided");
});

// ---------- ci-v9.2 ----------

/** The `commands` of one template step, as the shell script Woodpecker would run (set -e). */
function stepScript(tpl: string, name: string): string {
  const step = new RegExp(`- name: ${name}\\n([\\s\\S]*?)\\n\\n`).exec(tpl)?.[1] ?? "";
  const cmds = step.slice(step.indexOf("commands:")).split("\n").slice(1);
  return cmds.map((l) => l.replace(/^ {6}- /, "")).join("\n");
}

test("ci-v9.2: release-record and the signer pin the SAME manifest package, with integrity", () => {
  const tpl = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  const url = /TB_MANIFEST_PKG: (\S+)/.exec(tpl)?.[1] ?? "";
  const integrity = /TB_MANIFEST_INTEGRITY: (\S+)/.exec(tpl)?.[1] ?? "";
  assert.match(url, /manifest-v(\d+\.\d+\.\d+)\/opt2-tealbrick-manifest-\1\.tgz$/);
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  const version = /manifest-v(\S+?)\//.exec(url)?.[1] ?? "";
  assert.deepEqual(version.split(".").map(Number).slice(0, 2), [0, 1]);
  assert.ok(Number(version.split(".")[2]) >= 8, "wildcard companions (spec 0.1.13, M-CP-3) need manifest >= 0.1.8");
  const signerPkg = JSON.parse(readFileSync(new URL("../ops/signer/package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
  assert.equal(signerPkg.dependencies["@opt2-tealbrick/manifest"], url, "signer dependency == template pin");
  const lock = JSON.parse(readFileSync(new URL("../ops/signer/package-lock.json", import.meta.url), "utf8")) as {
    packages: Record<string, { version?: string; resolved?: string; integrity?: string }>;
  };
  const locked = lock.packages["node_modules/@opt2-tealbrick/manifest"];
  assert.equal(locked.version, version);
  assert.equal(locked.resolved, url);
  assert.equal(locked.integrity, integrity, "signer lockfile integrity == template integrity");
  assert.ok(lock.packages["node_modules/@opt2-tealbrick/spec"]?.integrity?.startsWith("sha512-"), "the spec dependency is integrity-pinned in the lockfile");
  const wf = readFileSync(new URL("../.github/workflows/registry-sync.yml", import.meta.url), "utf8");
  assert.match(wf, /npm ci --prefix ops\/signer --ignore-scripts/);
});

test("ci-v9.2: the template and the release workflow carry the same ref", () => {
  const tpl = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  const gh = readFileSync(new URL("./github/opt2-release.yml", import.meta.url), "utf8");
  const ref = /TB_CI_REF: (\S+)/.exec(tpl)?.[1];
  assert.equal(/TB_CI_REF: (\S+)/.exec(gh)?.[1], ref);
  assert.equal(new RegExp(`template ${ref}`).test(tpl.split("\n")[0]), true);
});

test("ci-v9.2 postgres step stops itself: marker, TERM then KILL, exit 0", async () => {
  const tpl = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  const script = stepScript(tpl, "postgres");
  assert.ok(script.includes(PG_DONE_MARKER.replace(".tb-ci/", "")), "waits for the marker the runner writes");
  assert.doesNotMatch(script, /exec docker-entrypoint/, "no exec: the shell must survive to clean up");
  assert.match(script, /kill -TERM/);
  assert.match(script, /kill -KILL/);

  const work = mkdtempSync(join(tmpdir(), "tb-pg-step-"));
  try {
    const bin = join(work, "bin");
    mkdirSync(bin);
    mkdirSync(join(work, ".tb-ci"));
    // fake postgres entrypoint (the real one is the postgres image's)
    const fake = (body: string) => {
      writeFileSync(join(bin, "docker-entrypoint.sh"), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, "docker-entrypoint.sh"), 0o755);
    };
    const run = (markerAfterMs: number | null) =>
      new Promise<{ status: number | null; out: string }>((done) => {
        const child = spawn("sh", ["-e", "-c", script], { cwd: work, env: { PATH: `${bin}:${process.env.PATH}` } });
        let out = "";
        child.stdout.on("data", (d: Buffer) => {
          out += d.toString();
        });
        child.stderr.on("data", (d: Buffer) => {
          out += d.toString();
        });
        const guard = setTimeout(() => child.kill("SIGKILL"), 40_000);
        if (markerAfterMs !== null) setTimeout(() => writeFileSync(join(work, PG_DONE_MARKER), "done\n"), markerAfterMs);
        child.on("close", (status) => {
          clearTimeout(guard);
          done({ status, out });
        });
      });

    // 1. not requested: exits 0 at once, never starts postgres
    fake(`echo started >> "${work}/started"; sleep 30`);
    const skipped = await run(null);
    assert.equal(skipped.status, 0, skipped.out);
    assert.equal(existsSync(join(work, "started")), false);

    // 2. requested; the runner writes the marker later -> TERM -> exit 0 although the server exits 143
    writeFileSync(join(work, PG_MARKER), "x\n");
    fake(`trap 'echo term >> "${work}/signals"; exit 143' TERM\nwhile :; do sleep 0.1; done`);
    const t0 = Date.now();
    const stopped = await run(1500);
    assert.equal(stopped.status, 0, stopped.out);
    assert.ok(Date.now() - t0 >= 1400, "it kept running until the marker appeared");
    assert.match(readFileSync(join(work, "signals"), "utf8"), /term/);
    assert.match(stopped.out, /ignored, cleanup only/);

    // 3. a server that ignores TERM is killed after the grace period; still exit 0
    fake("trap '' TERM\nwhile :; do sleep 0.1; done");
    rmSync(join(work, PG_DONE_MARKER), { force: true });
    const t1 = Date.now();
    const hung = await run(500);
    assert.equal(hung.status, 0, hung.out);
    assert.ok(Date.now() - t1 >= 9000, "waited the grace period before KILL");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ---------- ci-v9.3 ----------

/** Steps of the template with their depends_on, read from the YAML text (the template is flat on purpose). */
function templateGraph(tpl: string): Map<string, { deps: string[]; detach: boolean; when: string }> {
  const out = new Map<string, { deps: string[]; detach: boolean; when: string }>();
  for (const block of tpl.split(/\n {2}- name: /).slice(1)) {
    const name = /^([a-z-]+)/.exec(block)?.[1] ?? "";
    const deps = /\n {4}depends_on: \[([^\]]*)\]/.exec(block)?.[1];
    assert.notEqual(deps, undefined, `step ${name} has depends_on (DAG mode needs it on every step)`);
    out.set(name, {
      deps: (deps ?? "")
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean),
      detach: /\n {4}detach:/.test(block),
      when: /\n {4}when:\n([\s\S]*)$/.exec(block)?.[1] ?? "",
    });
  }
  return out;
}

test("ci-v9.3 template: every step has depends_on, the graph is acyclic and keeps the old order", () => {
  const tpl = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  const g = templateGraph(tpl);
  assert.deepEqual(
    [...g.keys()],
    [
      "secret-scan",
      "setup",
      "install",
      "osv-scan",
      "osv-check",
      "typecheck",
      "lint",
      "postgres",
      "unit",
      "conformance",
      "build",
      "gen",
      "pre-release",
      "image-check",
      "release-record",
    ],
  );
  for (const [name, s] of g) {
    assert.equal(s.detach, false, `${name}: no detached steps (they end red on this Woodpecker)`);
    for (const d of s.deps) assert.ok(g.has(d), `${name} depends on unknown step ${d}`);
  }
  // acyclic: repeatedly remove steps whose dependencies are gone
  const left = new Map([...g].map(([n, s]) => [n, new Set(s.deps)]));
  for (let progressed = true; progressed && left.size > 0; ) {
    progressed = false;
    for (const [n, deps] of left) {
      if ([...deps].every((d) => !left.has(d))) {
        left.delete(n);
        progressed = true;
      }
    }
  }
  assert.equal(left.size, 0, "the step graph has a cycle");
  // Woodpecker runs stages: level = 1 + the deepest dependency; a stage ends when ALL its steps end.
  const level = (n: string): number => 1 + Math.max(0, ...(g.get(n)?.deps ?? []).map(level));
  assert.equal(level("postgres"), level("unit"), "postgres ends after unit, so it must share unit's stage (an earlier stage deadlocks)");
  // the node chain is the old sequential order
  const chain = ["secret-scan", "setup", "install", "typecheck", "lint", "unit", "conformance", "build", "gen"];
  for (let i = 1; i < chain.length; i++) assert.deepEqual(g.get(chain[i] as string)?.deps, [chain[i - 1]], `${chain[i]} follows ${chain[i - 1]}`);
  // ci-v9.14 (C262): pre-release also waits for the OSV check
  assert.deepEqual(g.get("pre-release")?.deps, ["gen", "osv-check"]);
  assert.deepEqual(g.get("secret-scan")?.deps, []);
  // postgres runs BESIDE unit (Woodpecker runs a graph in stages: a stage ends when all its steps end, so postgres, which
  // ends after unit, must be in unit's stage), never in front of it; nothing may depend on it except through that stage.
  for (const [n, s2] of g) assert.ok(!s2.deps.includes("postgres"), `${n} must not wait for the postgres step by name`);
  assert.deepEqual(g.get("postgres")?.deps, g.get("unit")?.deps, "same stage as unit");
  assert.deepEqual(g.get("postgres")?.deps, ["lint"]);
  // the last two steps end the chain on tags / other events (ci-v9.6: both wait for the pre-release gate)
  assert.deepEqual(g.get("image-check")?.deps, ["pre-release"]);
  assert.deepEqual(g.get("release-record")?.deps, ["pre-release"]);
});

test("ci-v9.3: release-record pins the spec tarball with sha512 and the lockfile check fails closed", () => {
  const tpl = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  const url = /TB_SPEC_PKG: (\S+)/.exec(tpl)?.[1] ?? "";
  const integrity = /TB_SPEC_INTEGRITY: (\S+)/.exec(tpl)?.[1] ?? "";
  // C206 B6 (ci-v9.9): from the dist host
  assert.match(url, /\/opt2-tealbrick-dist\/releases\/download\/opt2-tealbrick-specs-spec-v(\d+\.\d+\.\d+)\/opt2-tealbrick-spec-\1\.tgz$/);
  assert.match(integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  // the same spec the signer's lockfile holds (and the one the pinned manifest package asks for)
  const lock = JSON.parse(readFileSync(new URL("../ops/signer/package-lock.json", import.meta.url), "utf8")) as {
    packages: Record<string, { resolved?: string; integrity?: string }>;
  };
  const spec = lock.packages["node_modules/@opt2-tealbrick/spec"];
  assert.equal(spec?.resolved, url);
  assert.equal(spec?.integrity, integrity);
  const manifest = /TB_MANIFEST_INTEGRITY: (\S+)/.exec(tpl)?.[1] ?? "";
  const ok = { packages: { "node_modules/@opt2-tealbrick/manifest": { integrity: manifest }, "node_modules/@opt2-tealbrick/spec": { integrity } } };
  assert.deepEqual(lockPinProblems(ok, { manifest, spec: integrity }), []);
  const other = `sha512-${"A".repeat(86)}==`;
  assert.equal(
    lockPinProblems({ packages: { ...ok.packages, "node_modules/@opt2-tealbrick/spec": { integrity: other } } }, { manifest, spec: integrity }).length,
    1,
  );
  assert.equal(lockPinProblems({ packages: {} }, { manifest, spec: integrity }).length, 2);
});

// ---------- ci-v9.4 ----------

test("ci-v9.4: DEV_ONLY_PRODUCTS is one list; the signer indexes them on dev only and refuses stable", () => {
  assert.deepEqual([...DEV_ONLY_PRODUCTS].sort(), ["sample-caller", "sample-gate", "sample-mismatch", "sample-pay"]); // C208 + fleet; C278 - fleet
  const src = readFileSync(new URL("./tb-ci.ts", import.meta.url), "utf8");
  for (const p of DEV_ONLY_PRODUCTS) assert.equal(src.split(`"${p}"`).length - 1, 1, `${p} is named once in tb-ci.ts (DEV_ONLY_PRODUCTS)`);
  assert.equal(src.split('"fleet"').length - 1, 1, "C278: fleet is named only in OPT2_REPOS (no longer dev-only)");
  assert.equal(releaseChannel("fleet", "0.2.1"), "stable", "C278: fleet follows the semver rule (app kinds still index on dev first)");
  // channel the signer derives: a plain x.y.z tag of a sample is still dev; other products keep the semver rule
  for (const p of DEV_ONLY_PRODUCTS) {
    assert.equal(releaseChannel(p, "0.1.2"), "dev");
    assert.equal(releaseChannel(p, "0.1.2-rc.1"), "dev");
  }
  assert.equal(releaseChannel("connect", "0.5.0"), "stable");
  assert.equal(releaseChannel("connect", "0.5.0-rc.1"), "dev");
  assert.equal(releaseChannel("sample-gate-pro", "1.0.0"), "stable", "exact ids only");
  // merge: a dev sample release is indexed, a stable one is refused (whatever path built it)
  const sample = (channel: "dev" | "stable") =>
    rel({ product: "sample-pay", version: "0.1.2", channel, tag: "v0.1.2", repo: "Tealbrick/opt2-tealbrick-samples" });
  const merged = mergeIndex(null, [sample("dev")], [], "2026-10-13T00:00:00.000Z");
  assert.deepEqual(
    merged.releases.map((r) => `${r.product}@${r.version}@${r.channel}`),
    ["sample-pay@0.1.2@dev"],
  );
  for (const p of DEV_ONLY_PRODUCTS)
    assert.throws(() => mergeIndex(merged, [rel({ product: p, channel: "stable" })], [], "2026-10-13T00:00:00.000Z"), /dev-only/);
  // other products are unaffected
  assert.equal(mergeIndex(merged, [rel({ product: "connect", version: "0.5.0" })], [], "2026-10-13T00:00:00.000Z").releases.length, 2);
});

/** The spec's own example manifest plus one outward op per new hold family (C107: outward, identity). */
function holdFamilyManifest(specDir: string): unknown {
  const ex = JSON.parse(readFileSync(join(specDir, "examples/notes.manifest.json"), "utf8")) as { operations: Record<string, unknown>[] };
  const write = ex.operations.find((o) => o.effect === "write");
  assert.ok(write, "the spec example has a write op to copy");
  const outward = (family: string) => ({
    ...write,
    id: `note_share_${family}`,
    title: `Share (${family})`,
    crud: ["update"],
    effect: "outward",
    holdFamily: family,
    idempotency: "supported",
    receipt: true,
  });
  return { ...ex, operations: [...ex.operations, outward("outward"), outward("identity")] };
}

function assertHoldFamilies(m: { validateManifest(json: unknown): { ok: boolean; errors?: unknown[] } }, specDir: string, who: string): void {
  const good = holdFamilyManifest(specDir) as { operations: Record<string, unknown>[] };
  const v = m.validateManifest(good);
  assert.equal(v.ok, true, `${who}: holdFamily outward/identity must validate: ${JSON.stringify(v.errors ?? []).slice(0, 500)}`);
  const bad = { ...good, operations: good.operations.map((o) => (o.holdFamily === "identity" ? { ...o, holdFamily: "nonsense" } : o)) };
  assert.equal(m.validateManifest(bad).ok, false, `${who}: an unknown hold family is still refused`);
}

test("ci-v9.4: release-record loads the pinned manifest 0.1.12 + spec 0.1.20 and accepts holdFamily outward/identity", { timeout: 180_000 }, async () => {
  const tpl = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  const pin = (k: string) => new RegExp(`${k}: (\\S+)`).exec(tpl)?.[1] ?? "";
  assert.match(pin("TB_MANIFEST_PKG"), /manifest-v0\.1\.12\/opt2-tealbrick-manifest-0\.1\.12\.tgz$/);
  assert.match(pin("TB_SPEC_PKG"), /spec-v0\.1\.20\/opt2-tealbrick-spec-0\.1\.20\.tgz$/);
  const keys = ["TB_MANIFEST_PKG", "TB_MANIFEST_INTEGRITY", "TB_SPEC_PKG", "TB_SPEC_INTEGRITY", "TB_MANIFEST_MODULE"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const work = mkdtempSync(join(tmpdir(), "tb-release-record-"));
  try {
    delete process.env.TB_MANIFEST_MODULE;
    for (const k of keys.slice(0, 4)) process.env[k] = pin(k);
    const m = await loadManifestPkg(work); // downloads, checks both sha512 pins, installs, reads the lockfile back
    const specDir = join(work, ".tb-ci/pkgs/node_modules/@opt2-tealbrick/spec");
    assert.equal((JSON.parse(readFileSync(join(specDir, "package.json"), "utf8")) as { version: string }).version, "0.1.20");
    assertHoldFamilies(m, specDir, "release-record");
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(work, { recursive: true, force: true });
  }
});

test("ci-v9.4: the registry-sync signer (ops/signer lockfile) validates holdFamily outward/identity", { timeout: 180_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), "tb-signer-"));
  try {
    for (const f of ["package.json", "package-lock.json"]) writeFileSync(join(work, f), readFileSync(new URL(`../ops/signer/${f}`, import.meta.url)));
    // exactly what .github/workflows/registry-sync.yml runs
    execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: work, stdio: "pipe" });
    const nm = join(work, "node_modules/@opt2-tealbrick");
    assert.equal((JSON.parse(readFileSync(join(nm, "manifest/package.json"), "utf8")) as { version: string }).version, "0.1.12");
    assert.equal((JSON.parse(readFileSync(join(nm, "spec/package.json"), "utf8")) as { version: string }).version, "0.1.20");
    const wf = readFileSync(new URL("../.github/workflows/registry-sync.yml", import.meta.url), "utf8");
    const entry = /TB_MANIFEST_MODULE: ops\/signer\/(\S+)/.exec(wf)?.[1] ?? "";
    assert.ok(entry, "the workflow points TB_MANIFEST_MODULE into ops/signer");
    const m = (await import(pathToFileURL(join(work, entry)).href)) as { validateManifest(json: unknown): { ok: boolean; errors?: unknown[] } };
    assertHoldFamilies(m, join(nm, "spec"), "signer");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("C113: devOnly mark + re-classification of an old stable record; identical copies folded, nothing else changes", () => {
  const sample = (over: Partial<IndexRelease>) =>
    rel({
      product: "sample-gate",
      repo: "Tealbrick/opt2-tealbrick-samples",
      image: `ghcr.io/tealbrick/opt2-tealbrick-samples-sample-gate@sha256:${"1".repeat(64)}`,
      ...over,
    });
  const oldStable = sample({ id: "rel_01M4QCJ7T3NP5WQ2WWP5V1G7KY", version: "0.1.1", channel: "stable", publishedAt: "2026-10-11T00:00:00.000Z" });
  const copyDev = sample({ id: "rel_01M4RTJ56HQH0BVWBTEBSSW7AC", version: "0.1.1", channel: "dev", publishedAt: "2026-10-12T19:48:56.000Z" });
  const devOld = sample({
    id: "rel_01M4QA48XR9QC5QRDSC4E1T6DT",
    version: "0.1.0",
    channel: "dev",
    image: null,
    source: { repo: "x/y", ref: "a".repeat(40), dockerfile: "Dockerfile" },
  });
  const other = rel({ id: "rel_01M4QA48XR9QC5QRDSC4E1T6D0", product: "connect", version: "0.5.0", channel: "stable" });
  const { releases, notes } = normalizeDevOnly([devOld, oldStable, other, copyDev]);
  assert.deepEqual(
    releases.map((r) => [r.id, r.channel, r.devOnly ?? null]),
    [
      [devOld.id, "dev", true],
      [oldStable.id, "dev", true], // same id, re-classified
      [other.id, "stable", null], // untouched, no devOnly key
    ],
  );
  assert.equal("devOnly" in (releases[2] as object), false);
  const kept = releases[1] as IndexRelease;
  assert.equal(kept.image, oldStable.image);
  assert.equal(kept.manifestDigest, oldStable.manifestDigest);
  assert.equal(kept.publishedAt, oldStable.publishedAt);
  assert.deepEqual(notes, [
    `sample-gate@0.1.0 ${devOld.id} marked devOnly`,
    `sample-gate@0.1.1 ${oldStable.id} re-classified stable -> dev`,
    `sample-gate@0.1.1 ${copyDev.id} marked devOnly`,
    `sample-gate@0.1.1 ${copyDev.id} folded into ${oldStable.id} (identical record)`,
  ]);
  assert.deepEqual(normalizeDevOnly(releases).notes, [], "idempotent");
  // C278: fleet left the list: its signed dev records are returned unchanged (flag kept, never rewritten, no note);
  // a remaining dev-only product is still flagged
  const fleetRec = rel({ id: "rel_01M5FLEETFLEETFLEETFLEET00", product: "fleet", version: "0.2.1", channel: "dev", devOnly: true });
  const samplePlain = rel({ id: "rel_01M5SAMPLESAMPLESAMPLE000", product: "sample-caller", version: "0.1.0", channel: "dev" });
  const n2 = normalizeDevOnly([fleetRec, samplePlain]);
  assert.deepEqual(n2.releases[0], fleetRec, "fleet record unchanged");
  assert.equal(n2.releases[1]?.devOnly, true, "sample-caller still flagged");
  assert.deepEqual(n2.notes, ["sample-caller@0.1.0 rel_01M5SAMPLESAMPLESAMPLE000 marked devOnly"]);
  // a copy with other content is never folded
  assert.throws(() => normalizeDevOnly([oldStable, { ...copyDev, image: `ghcr.io/x@sha256:${"9".repeat(64)}` }]), /different content/);
  // mergeIndex applies it: the next signed index carries the marks; a new dev sample release is marked too
  const merged = mergeIndex(
    { schema: "opt2.release-index/v2", generatedAt: "x", releases: [oldStable, copyDev, other], offers: [], harnesses: [] },
    [sample({ id: "rel_01M4RV2CZHEB2D52KCSNGSB862", version: "0.2.0-dev.1", channel: "dev" })],
    [],
    "2026-10-13T00:00:00.000Z",
  );
  assert.deepEqual(
    merged.releases.map((r) => `${r.product}@${r.version}@${r.channel}${r.devOnly ? "+devOnly" : ""}`),
    ["connect@0.5.0@stable", "sample-gate@0.1.1@dev+devOnly", "sample-gate@0.2.0-dev.1@dev+devOnly"],
  );
});

test("ci-v9.5 (F27): each release tarball gets a .sha256 and an npm-style .integrity file", () => {
  const data = new TextEncoder().encode("tarball bytes");
  const c = assetChecksums("opt2-tealbrick-spec-0.1.22.tgz", data);
  assert.match(c.sha256, /^[0-9a-f]{64}$/);
  assert.equal(c.integrity, sha512Integrity(data));
  assert.deepEqual(c.files, [
    { name: "opt2-tealbrick-spec-0.1.22.tgz.sha256", body: `${c.sha256}  opt2-tealbrick-spec-0.1.22.tgz\n` },
    { name: "opt2-tealbrick-spec-0.1.22.tgz.integrity", body: `${c.integrity}\n` },
  ]);
  // the value npm writes into package-lock.json for the same bytes
  assert.match(c.files[1]!.body.trim(), /^sha512-[A-Za-z0-9+/]{86}==$/);
});

// ---------- ci-v9.6 (C154/C157/C158): dist host + pre-release gate ----------

const distBase = DIST_BASES[0] as string;
const cliRepo = "opt2-tealbrick-cli";

test("ci-v9.6 distBaseUrl: absent = unchanged GitHub default; only platform dist hosts are accepted", () => {
  assert.equal(validateConfig({ kind: "library" }, cliRepo).distBaseUrl, null);
  assert.equal(resolveDistBase(validateConfig({ kind: "library" }, cliRepo), {}), null);
  assert.equal(validateConfig({ kind: "library", distBaseUrl: `${distBase}/` }, cliRepo).distBaseUrl, distBase, "trailing slash dropped");
  assert.equal(validateConfig({ kind: "library", distBaseUrl: "https://releases.tealbrick.com" }, cliRepo).distBaseUrl, "https://releases.tealbrick.com");
  for (const bad of [
    "https://evil.example",
    "http://releases.tealbrick.com",
    "https://releases.tealbrick.com.evil.example",
    "https://github.com/Other/opt2-tealbrick-dist/releases/download",
    "",
    5,
  ])
    assert.throws(() => validateConfig({ kind: "library", distBaseUrl: bad }, cliRepo), /distBaseUrl/, String(bad));
  // env wins over the file; an env value is held to the same list
  const cfg = validateConfig({ kind: "library", distBaseUrl: distBase }, cliRepo);
  assert.equal(resolveDistBase(cfg, { TB_DIST_BASE_URL: "https://releases.tealbrick.com" }), "https://releases.tealbrick.com");
  assert.equal(resolveDistBase(cfg, { TB_DIST_BASE_URL: "" }), distBase);
  assert.throws(() => resolveDistBase(cfg, { TB_DIST_BASE_URL: "https://evil.example" }), /TB_DIST_BASE_URL/);
  assert.throws(() => normalizeDistBase(undefined, "x"), /must be a string/);
});

test("ci-v9.6 releaseUrl: default unchanged, dist base gives <base>/<repo>-<tag>/<file>", () => {
  const github = "https://github.com/Tealbrick/opt2-tealbrick-cli/releases/download/relay-v0.1.0/opt2-tealbrick-relay-0.1.0.tgz";
  assert.equal(releaseUrl(cliRepo, "relay", "@opt2-tealbrick/relay", "0.1.0"), github);
  assert.equal(releaseUrl(cliRepo, "relay", "@opt2-tealbrick/relay", "0.1.0", null), github);
  const dist = releaseUrl(cliRepo, "relay", "@opt2-tealbrick/relay", "0.1.0", distBase);
  assert.equal(dist, `${distBase}/opt2-tealbrick-cli-relay-v0.1.0/opt2-tealbrick-relay-0.1.0.tgz`);
  assert.equal(distTag(cliRepo, "relay-v0.1.0"), "opt2-tealbrick-cli-relay-v0.1.0");
  assert.equal(
    releaseUrl(cliRepo, "relay", "@opt2-tealbrick/relay", "0.1.0", "https://releases.tealbrick.com/"),
    "https://releases.tealbrick.com/opt2-tealbrick-cli-relay-v0.1.0/opt2-tealbrick-relay-0.1.0.tgz",
  );
  assert.throws(() => releaseUrl(cliRepo, "relay", "@opt2-tealbrick/relay", "0.1.0", "https://evil.example"), /distBase/);
  assert.equal(isDistTarballUrl(dist), true);
  assert.equal(isDistTarballUrl(github), false);
});

test("ci-v9.6 dependency rules accept a dist URL, still refuse look-alikes (L34 both ways)", () => {
  const dist = releaseUrl(cliRepo, "relay", "@opt2-tealbrick/relay", "0.1.0", distBase);
  const rel = releaseUrl(cliRepo, "relay", "@opt2-tealbrick/relay", "0.1.0", "https://releases.tealbrick.com");
  const [errs, urls] = checkDependencies({ dependencies: { "@opt2-tealbrick/relay": dist }, devDependencies: { "@opt2-tealbrick/x": rel } }, "pkg", new Set());
  assert.deepEqual(errs, []);
  assert.deepEqual(urls, [dist, rel]);
  const bad = [
    "https://releases.tealbrick.com.evil.example/opt2-tealbrick-cli-relay-v0.1.0/opt2-tealbrick-relay-0.1.0.tgz",
    "https://releases.tealbrick.com/evil/opt2-tealbrick-cli-relay-v0.1.0/opt2-tealbrick-relay-0.1.0.tgz",
    "https://releases.tealbrick.com/opt2-tealbrick-cli-relay-v0.1.0/../x/opt2-tealbrick-relay-0.1.0.tgz",
    "https://releases.tealbrick.com/cli-relay-v0.1.0/opt2-tealbrick-relay-0.1.0.tgz",
    "https://releases.tealbrick.com/opt2-tealbrick-cli-relay-v0.1.0/opt2-tealbrick-relay-0.1.0.zip",
    "https://github.com/Other/opt2-tealbrick-dist/releases/download/opt2-tealbrick-cli-relay-v0.1.0/opt2-tealbrick-relay-0.1.0.tgz",
  ];
  for (const url of bad) assert.equal(checkDependencies({ dependencies: { "@opt2-tealbrick/relay": url } }, "p", new Set())[0].length, 1, url);
});

test("ci-v9.6 lockfile integrity covers dist tarballs (pnpm pin and npm read)", () => {
  const url = releaseUrl(cliRepo, "relay", "@opt2-tealbrick/relay", "0.1.0", distBase);
  const lock = `packages:\n  '@opt2-tealbrick/relay@${url}':\n    resolution: {tarball: ${url}}\n    version: 0.1.0\n  other@1.0.0:\n    resolution: {tarball: https://example.com/a.tgz}\n`;
  assert.deepEqual(lockfileTarballs(lock, "pnpm"), [{ url, integrity: null }]);
  const { text, changed } = addPnpmIntegrity(lock, () => "sha512-ABC=");
  assert.equal(changed, 1, "the dist tarball is pinned, the foreign host is left alone");
  assert.match(text, /resolution: \{tarball: https:\/\/example\.com\/a\.tgz\}/);
  assert.deepEqual(lockfileTarballs(text, "pnpm"), [{ url, integrity: "sha512-ABC=" }]);
  const npm = JSON.stringify({
    packages: { "node_modules/x": { resolved: url, integrity: "sha512-q" }, "node_modules/y": { resolved: "https://example.com/a.tgz" } },
  });
  assert.deepEqual(lockfileTarballs(npm, "npm"), [{ url, integrity: "sha512-q" }]);
});

test("ci-v9.6 registry-add-desktop: GitHub asset URL as before, or a dist file with --repo", () => {
  assert.deepEqual(artifactSource("https://github.com/Tealbrick/opt2-tealbrick-tbd/releases/download/v1.2.3/TBD-1.2.3.dmg"), {
    repo: "opt2-tealbrick-tbd",
    tag: "v1.2.3",
  });
  assert.deepEqual(artifactSource(`${distBase}/opt2-tealbrick-tbd-v1.2.3/TBD-1.2.3.dmg`, "opt2-tealbrick-tbd"), { repo: "opt2-tealbrick-tbd", tag: "v1.2.3" });
  assert.throws(() => artifactSource(`${distBase}/opt2-tealbrick-tbd-v1.2.3/TBD-1.2.3.dmg`), /--repo/);
  assert.throws(() => artifactSource(`${distBase}/opt2-tealbrick-tbd-v1.2.3/TBD-1.2.3.dmg`, "opt2-tealbrick-cli"), /must look like/);
  assert.throws(() => artifactSource(`${distBase}/opt2-tealbrick-tbd-v1.2.3/a/b.dmg`, "opt2-tealbrick-tbd"), /must look like/);
  assert.throws(() => artifactSource("https://evil.example/TBD.dmg", "opt2-tealbrick-tbd"), /GitHub release asset URL/);
  assert.throws(() => artifactSource("https://github.com/Other/opt2-tealbrick-tbd/releases/download/v1/x.dmg"), /GitHub release asset URL/);
});

test("ci-v9.6 preReleaseChecks: TypeScript, repo-relative, unique", () => {
  assert.deepEqual(validateConfig({ kind: "library" }, cliRepo).preReleaseChecks, []);
  assert.deepEqual(validateConfig({ kind: "library", preReleaseChecks: ["scripts/release-gate.ts", "scripts/b.ts"] }, cliRepo).preReleaseChecks, [
    "scripts/release-gate.ts",
    "scripts/b.ts",
  ]);
  for (const bad of [
    ["scripts/gate.js"],
    ["scripts/gate.mjs"],
    ["../gate.ts"],
    ["/etc/gate.ts"],
    ["a.ts", "a.ts"],
    [5],
    "scripts/gate.ts",
    ["a b.ts"],
    ["x; rm -rf y.ts"],
  ])
    assert.throws(() => parsePreReleaseChecks(bad), /preReleaseChecks/, JSON.stringify(bad));
  assert.throws(() => parsePreReleaseChecks(Array.from({ length: 21 }, (_v, i) => `s/${i}.ts`)), /at most 20/);
  assert.deepEqual(
    missingPreReleaseChecks(["a.ts", "b.ts"], (r) => r === "a.ts"),
    ["b.ts"],
  );
  const env = preReleaseEnv(validateConfig({ kind: "library", distBaseUrl: distBase }, cliRepo), { CI_COMMIT_TAG: "relay-v0.1.0", PATH: "/bin" });
  assert.equal(env.TB_PRE_RELEASE, "1");
  assert.equal(env.TB_RELEASE_TAG, "relay-v0.1.0");
  assert.equal(env.TB_DIST_BASE_URL, distBase);
  const plain = preReleaseEnv(validateConfig({ kind: "library" }, cliRepo), { PATH: "/bin" });
  assert.equal(plain.TB_RELEASE_TAG, "");
  assert.equal(plain.TB_DIST_BASE_URL, undefined);
});

/** Runs `tb-ci pre-release` in a throw-away repo directory (no network: the command only reads the config and runs the scripts). */
function runPreRelease(files: Record<string, string>, config: Record<string, unknown>, extraEnv: Record<string, string> = {}): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "tb-prerelease-"));
  try {
    writeFileSync(join(dir, "tealbrick-ci.json"), JSON.stringify(config));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), body);
    }
    const env: NodeJS.ProcessEnv = { ...process.env, CI_WORKSPACE: dir, CI_REPO_NAME: cliRepo, GITHUB_TOKEN: "", GH_TOKEN: "", GHCR_TOKEN: "", ...extraEnv };
    for (const k of ["GITHUB_TOKEN", "GH_TOKEN", "GHCR_TOKEN"]) if (!extraEnv[k]) delete env[k];
    try {
      const out = execFileSync(process.execPath, [new URL("./tb-ci.ts", import.meta.url).pathname, "pre-release"], { env, encoding: "utf8", stdio: "pipe" });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("ci-v9.6 pre-release step: no-op without checks, passes a good gate, fails a bad or missing one, refuses tokens (L34)", () => {
  const none = runPreRelease({}, { kind: "library" });
  assert.equal(none.code, 0, none.out);
  assert.match(none.out, /nothing to run/);
  const good = runPreRelease(
    {
      "scripts/ok.ts": `if (process.env.TB_PRE_RELEASE !== "1" || process.env.TB_DIST_BASE_URL !== ${JSON.stringify(distBase)}) process.exit(3);\nconsole.log("gate-ok", process.env.TB_RELEASE_TAG);\n`,
    },
    { kind: "library", distBaseUrl: distBase, preReleaseChecks: ["scripts/ok.ts"] },
    { CI_COMMIT_TAG: "relay-v0.1.0" },
  );
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /gate-ok relay-v0\.1\.0/);
  assert.match(good.out, /1 check\(s\) passed/);
  const bad = runPreRelease(
    { "scripts/ok.ts": "", "scripts/bad.ts": "process.exit(7);\n", "scripts/never.ts": 'console.log("RAN-AFTER-FAILURE");\n' },
    { kind: "library", preReleaseChecks: ["scripts/ok.ts", "scripts/bad.ts", "scripts/never.ts"] },
  );
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /scripts\/bad\.ts failed/);
  assert.doesNotMatch(bad.out, /RAN-AFTER-FAILURE/, "the first failure stops the run");
  const missing = runPreRelease({}, { kind: "library", preReleaseChecks: ["scripts/nope.ts"] });
  assert.notEqual(missing.code, 0);
  assert.match(missing.out, /scripts\/nope\.ts not found/);
  const tokened = runPreRelease({ "scripts/ok.ts": "" }, { kind: "library", preReleaseChecks: ["scripts/ok.ts"] }, { GITHUB_TOKEN: "x" });
  assert.notEqual(tokened.code, 0);
  assert.match(tokened.out, /without GITHUB_TOKEN/);
});

test("ci-v9.6 template: pre-release step after gen; image-check and release-record wait for it; workflow runs the checks on the tag", () => {
  const tpl = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  assert.equal(stepScript(tpl, "pre-release"), "node .tb-ci/tb-ci.ts pre-release");
  assert.match(tpl.split("\n")[0] as string, /ci-v9\.16/, "current template (ci-v9.16 keeps the ci-v9.6 pre-release step)");
  const wf = readFileSync(new URL("./github/opt2-release.yml", import.meta.url), "utf8");
  assert.match(wf, /TB_CI_REF: ci-v9\.16/);
  const runner = readFileSync(new URL("./tb-ci.ts", import.meta.url), "utf8");
  const build = runner.slice(runner.indexOf("async function cmdGhBuild"), runner.indexOf("async function cmdGhPublish"));
  assert.ok(build.indexOf("runPreReleaseChecks(cfg, root)") > 0, "gh-build runs the checks on the tag");
  assert.ok(
    build.indexOf("runPreReleaseChecks(cfg, root); //") < build.indexOf("await cmdPackagePack()"),
    "package tags: checks run before the tarball is packed",
  );
  assert.ok(build.indexOf("runPreReleaseChecks(cfg, root);") < build.indexOf('"docker",'), "app tags: checks run before the image build");
});

test("ci-v9.6 opt2-tealbrick-cli: in OPT2_REPOS and the activation list; no repo pending since the CLI repo exists (C177); registry products = cli (C174) + packages relay/harness-* (C181)", () => {
  assert.ok(OPT2_REPOS.includes(cliRepo));
  for (const r of PENDING_REPOS) assert.ok(OPT2_REPOS.includes(r), `${r} is pending but not an opt2 repo`);
  assert.deepEqual([...PENDING_REPOS], [], "every opt2 repo exists; any 404 is an alarm (private repos: see PRIVATE_REPOS)");
  for (const r of PRIVATE_REPOS) assert.ok(OPT2_REPOS.includes(r), `${r} is private but not an opt2 repo`);
  assert.deepEqual(
    [...PRIVATE_REPOS].sort(),
    ["bridge", "cli", "packages", "portal-core", "portal-gui", "qa", "sdk", "specs", "tbd", "website"].map((n) => `opt2-tealbrick-${n}`),
    "C154/C173 + C206/C208 (private in the org; samples stays public); C249: fleet (Governance) is public again",
  );
  assert.ok(!PRIVATE_REPOS.includes("opt2-tealbrick-fleet"), "C249: the Governance repo is public: registry-sync reads it without the token");
  assert.ok(OPT2_REPOS.includes("opt2-tealbrick-fleet"), "C249: the Governance repo stays an opt2 release repo");
  const activate = readFileSync(new URL("../ops/woodpecker-activate.ts", import.meta.url), "utf8");
  const listed = /const REPOS = \[([\s\S]*?)\]\.map/.exec(activate)?.[1] ?? "";
  const names = [...listed.matchAll(/"([a-z-]+)"/g)].map((m) => `opt2-tealbrick-${m[1]}`);
  assert.deepEqual(names, OPT2_REPOS, "ops/woodpecker-activate.ts lists the same repos as OPT2_REPOS, in the same order");
  // the CLI ships package tarballs (kind library, no images); release-index products: `cli` (C174) + kind package relay/harness-* (C181)
  const products = JSON.parse(readFileSync(new URL("../registry/products.json", import.meta.url), "utf8")) as Record<string, { repo: string; kind: string }>;
  const former = [`Martin-Atrin/${cliRepo}`];
  assert.deepEqual(
    Object.entries(products).filter(([, p]) => p.repo.endsWith(`/${cliRepo}`)),
    [
      ["cli", { repo: `Tealbrick/${cliRepo}`, kind: "cli", formerRepos: former }],
      ["harness-claude", { repo: `Tealbrick/${cliRepo}`, kind: "package", formerRepos: former }],
      ["harness-eve", { repo: `Tealbrick/${cliRepo}`, kind: "package", formerRepos: former }],
      ["relay", { repo: `Tealbrick/${cliRepo}`, kind: "package", formerRepos: former }],
    ],
  );
  // C206 B6: the sdk repo is bound only for its library tarballs (kind package), never for an app or the bridge
  assert.ok(
    Object.values(products)
      .filter((p) => p.repo.endsWith("/opt2-tealbrick-sdk"))
      .every((p) => p.kind === "package"),
  );
});

// ---------- C174: `cli` release-index kind (C173 installer + self-update) ----------

const CLI_SHA = "e".repeat(40);
const cliPkg = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "@opt2-tealbrick/cli", version: "0.2.0", bin: { tealbrick: "dist/main.js" }, ...over });
const cliFixture = (pkgJson = cliPkg()) => {
  const tgz = makeTgz({ "package.json": pkgJson, "dist/main.js": "#!/usr/bin/env node\n" });
  const sums = assetChecksums("opt2-tealbrick-cli-0.2.0.tgz", tgz);
  return { tgz, sha256File: sums.files[0]?.body ?? "", integrityFile: sums.files[1]?.body ?? "", sums };
};
const relayFixture = (pkgJson = JSON.stringify({ name: "@opt2-tealbrick/relay", version: "0.1.0" })) => {
  const tgz = makeTgz({ "package.json": pkgJson, "dist/index.js": "export {};\n" });
  const sums = assetChecksums("opt2-tealbrick-relay-0.1.0.tgz", tgz);
  return { tgz, sha256File: sums.files[0]?.body ?? "", integrityFile: sums.files[1]?.body ?? "", sums };
};
const cliEntry = (over: Partial<IndexRelease> = {}): IndexRelease => {
  const f = cliFixture();
  const r = cliReleaseFromAssets({ version: "0.2.0", commit: CLI_SHA, ...f, publishedAt: "2026-10-14T00:00:00.000Z", id: "rel_01JA0000000000000000000009" });
  if (typeof r === "string") throw new Error(r);
  return { ...r, ...over };
};

test("C174: cli entry shape from a fixture release (dist URL, sha256 + sha512 integrity, nothing else)", () => {
  const f = cliFixture();
  const r = cliEntry();
  assert.deepEqual(INDEX_KINDS, ["app", "bridge", "desktop", "cli", "package"]);
  assert.equal(r.kind, "cli");
  assert.equal(r.product, "cli");
  assert.equal(r.channel, "stable");
  assert.equal(r.tag, "cli-v0.2.0");
  assert.equal(r.repo, `Tealbrick/${CLI_REPO}`);
  assert.deepEqual(r.artifact, {
    url: "https://github.com/Tealbrick/opt2-tealbrick-dist/releases/download/opt2-tealbrick-cli-cli-v0.2.0/opt2-tealbrick-cli-0.2.0.tgz",
    sha256: `sha256:${f.sums.sha256}`,
    integrity: f.sums.integrity,
  });
  assert.equal(r.artifact?.url, cliTarballUrl("0.2.0", CLI_DIST_BASE));
  assert.equal(cliEntryProblem(r), null);
  assert.equal(r.image ?? r.source ?? r.runtime ?? r.manifestDigest ?? r.minOs ?? r.notarized, null);
  const dev = cliReleaseFromAssets({
    version: "0.3.0-dev.1",
    commit: CLI_SHA,
    ...cliFixture(cliPkg({ version: "0.3.0-dev.1" })),
    sha256File: "",
    integrityFile: "",
    publishedAt: "t",
  });
  assert.match(String(dev), /\.sha256 does not match/, "checksum files are required to agree");
  // the prod download host is accepted too
  assert.equal(
    cliEntryProblem({ ...r, artifact: { ...(r.artifact as { url: string; sha256: string }), url: cliTarballUrl("0.2.0", "https://releases.tealbrick.com") } }),
    null,
  );
});

test("C174: cli entries are refused for a private URL, bad digest formats, missing integrity, extra fields", () => {
  const r = cliEntry();
  const art = r.artifact as { url: string; sha256: string; integrity?: string };
  const bad = (artifact: unknown, re: RegExp, extra: Partial<IndexRelease> = {}) =>
    assert.match(cliEntryProblem({ ...r, artifact: artifact as IndexRelease["artifact"], ...extra }) ?? "OK", re);
  bad(
    { ...art, url: "https://github.com/Tealbrick/opt2-tealbrick-cli/releases/download/cli-v0.2.0/opt2-tealbrick-cli-0.2.0.tgz" },
    /never a private GitHub URL/,
  );
  bad({ ...art, url: "https://evil.example/opt2-tealbrick-cli-0.2.0.tgz" }, /dist host/);
  bad({ ...art, url: cliTarballUrl("0.1.9") }, /must be <dist base>\/opt2-tealbrick-cli-cli-v0\.2\.0\//);
  bad({ ...art, sha256: art.sha256.slice(7) }, /sha256:<64 hex>/);
  bad({ ...art, sha256: `sha256:${"A".repeat(64)}` }, /sha256:<64 hex>/);
  bad({ url: art.url, sha256: art.sha256 }, /integrity .* is required/);
  bad({ ...art, integrity: `sha256-${"a".repeat(43)}=` }, /sha512-/);
  bad({ ...art, integrity: "sha512-short==" }, /sha512-/);
  bad({ ...art, size: 1 }, /unknown field/);
  bad(null, /needs artifact/);
  bad(art, /only the artifact/, { image: `ghcr.io/tealbrick/x@sha256:${"a".repeat(64)}` });
  bad(art, /desktop fields/, { notarized: true });
  // mergeIndex enforces the same rules, keeps the entry immutable, and existing kinds are unchanged
  const i1 = mergeIndex(null, [rel({}), r], [], "t1", [], loadProductBindings());
  assert.deepEqual(
    i1.releases.map((x) => `${x.product}:${x.kind}`),
    ["cli:cli", "knowledge:app"],
  );
  assert.equal(mergeIndex(i1, [{ ...r, id: "rel_other" }], [], "t2").releases.length, 2, "idempotent re-add");
  assert.throws(() => mergeIndex(i1, [{ ...r, artifact: { ...art, integrity: `sha512-${"B".repeat(86)}==` } }], [], "t"), /immutable/);
  assert.throws(() => mergeIndex(i1, [{ ...r, artifact: { ...art, url: cliTarballUrl("0.2.0", "https://releases.tealbrick.com") } }], [], "t"), /immutable/);
  assert.throws(() => mergeIndex(null, [{ ...r, artifact: { url: art.url, sha256: art.sha256 } }], [], "t"), /integrity/);
  assert.throws(() => mergeIndex(null, [{ ...r, kind: "plugin" as IndexRelease["kind"] }], [], "t"), /unknown kind/);
  assert.throws(() => mergeIndex(null, [{ ...r, repo: "Tealbrick/opt2-tealbrick-bridge" }], [], "t", [], loadProductBindings()), /GTP-01/);
  assert.throws(() => mergeIndex(null, [{ ...r, kind: "desktop" }], [], "t", [], loadProductBindings()), /bound as kind cli/);
});

test("C174: the signer refuses a cli tarball whose checksums or package.json do not match", () => {
  const ok = cliFixture();
  const base = { version: "0.2.0", commit: CLI_SHA, publishedAt: "t" };
  assert.equal(typeof cliReleaseFromAssets({ ...base, ...ok }), "object");
  assert.match(String(cliReleaseFromAssets({ ...base, ...ok, sha256File: `${"0".repeat(64)}  opt2-tealbrick-cli-0.2.0.tgz\n` })), /\.sha256 does not match/);
  assert.match(String(cliReleaseFromAssets({ ...base, ...ok, sha256File: `${ok.sums.sha256}  other.tgz\n` })), /\.sha256 does not match/);
  assert.match(String(cliReleaseFromAssets({ ...base, ...ok, integrityFile: `sha512-${"A".repeat(86)}==\n` })), /\.integrity does not match/);
  const wrongVer = cliFixture(cliPkg({ version: "0.1.0" }));
  assert.match(String(cliReleaseFromAssets({ ...base, ...wrongVer })), /contains @opt2-tealbrick\/cli@0\.1\.0/);
  const wrongName = cliFixture(cliPkg({ name: "@opt2-tealbrick/relay" }));
  assert.match(String(cliReleaseFromAssets({ ...base, ...wrongName })), /contains @opt2-tealbrick\/relay/);
  const noBin = cliFixture(cliPkg({ bin: { other: "x.js" } }));
  assert.match(String(cliReleaseFromAssets({ ...base, ...noBin })), /no "tealbrick" bin/);
  assert.match(String(cliReleaseFromAssets({ ...base, ...ok, tgz: Buffer.from("not gzip") })), /does not match|not a readable/);
  assert.match(String(cliReleaseFromAssets({ ...base, ...ok, commit: "abc" })), /full sha/);
});

/** A fake GitHub API for the private CLI repo: records every request (URL + whether it carried the token). */
function fakeCliGitHub(opts: {
  tagsStatus?: number;
  release?: "none" | "no-tgz" | "no-sums" | "ok";
  fixture?: ReturnType<typeof cliFixture>;
  relay?: boolean;
}) {
  const f = opts.fixture ?? cliFixture();
  const rf = relayFixture();
  const calls: { url: string; auth: boolean }[] = [];
  const assets = [
    { id: 1, name: "opt2-tealbrick-cli-0.2.0.tgz", body: f.tgz },
    { id: 2, name: "opt2-tealbrick-cli-0.2.0.tgz.sha256", body: Buffer.from(f.sha256File) },
    { id: 3, name: "opt2-tealbrick-cli-0.2.0.tgz.integrity", body: Buffer.from(f.integrityFile) },
    { id: 4, name: "opt2-tealbrick-relay-0.1.0.tgz", body: Buffer.from("x") },
  ].filter((a) => (opts.release === "no-tgz" ? a.id !== 1 : opts.release === "no-sums" ? a.id !== 3 : true));
  const relayAssets = [
    { id: 11, name: "opt2-tealbrick-relay-0.1.0.tgz", body: rf.tgz },
    { id: 12, name: "opt2-tealbrick-relay-0.1.0.tgz.sha256", body: Buffer.from(rf.sha256File) },
    { id: 13, name: "opt2-tealbrick-relay-0.1.0.tgz.integrity", body: Buffer.from(rf.integrityFile) },
  ];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: Boolean(headers.authorization) });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const base = "https://api.github.com/repos/Tealbrick/opt2-tealbrick-cli";
    // C206 B6: the other dist-product repos have no tags in this fake
    if (/^https:\/\/api\.github\.com\/repos\/Tealbrick\/opt2-tealbrick-(specs|sdk|packages|bridge)\/tags\?per_page=100&page=1$/.test(url)) return json(200, []);
    if (url === `${base}/tags?per_page=100&page=1`)
      return opts.tagsStatus && opts.tagsStatus !== 200
        ? json(opts.tagsStatus, { message: "Not Found" })
        : json(200, [
            { name: "cli-v0.2.0", commit: { sha: CLI_SHA } },
            { name: "relay-v0.1.0", commit: { sha: CLI_SHA } },
            { name: "harness-claude-v0.2.0", commit: { sha: CLI_SHA } },
          ]);
    // C207 E1 release guard: the tag commit is on main, green, from a merged PR
    if (url.startsWith(`${base}/compare/main...`)) return json(200, { status: "behind" });
    if (url === `${base}/commits/${CLI_SHA}/status`) return json(200, { statuses: [{ context: "ci/woodpecker/push/ci", state: "success" }] });
    if (url === `${base}/commits/${CLI_SHA}/pulls`) return json(200, [{ merged_at: "2026-10-15T00:00:00Z", base: { ref: "main" } }]);
    if (url === `${base}/releases/tags/cli-v0.2.0`)
      return opts.release === "none" ? json(404, {}) : json(200, { assets: assets.map(({ id, name }) => ({ id, name })) });
    if (url === `${base}/releases/tags/relay-v0.1.0`)
      return opts.relay ? json(200, { assets: relayAssets.map(({ id, name }) => ({ id, name })) }) : json(404, {});
    if (url === `${base}/releases/tags/harness-claude-v0.2.0`) return json(404, {});
    const m = /\/releases\/assets\/(\d+)$/.exec(url);
    const a = m ? [...assets, ...(opts.relay ? relayAssets : [])].find((x) => x.id === Number(m[1])) : undefined;
    if (a && headers.accept === "application/octet-stream") return new Response(new Uint8Array(a.body), { status: 200 });
    return json(500, { unexpected: url });
  }) as typeof fetch;
  return { fetcher, calls };
}

test("C174: cli source without the read token is PENDING (green, no entry, no network)", async () => {
  const gh = fakeCliGitHub({});
  for (const token of [undefined, ""]) {
    const r = await cliSourceReleases({ token, known: new Set(), fetcher: gh.fetcher });
    assert.deepEqual(r.add, []);
    assert.deepEqual(r.rejected, []);
    assert.match(r.pending ?? "", /TB_PRIVATE_READ_TOKEN/);
  }
  assert.equal(gh.calls.length, 0);
  // token present but it cannot see the (existing, private) repo: an alarm, no longer pending (C177: the repo exists)
  assert.ok(!PENDING_REPOS.includes(CLI_REPO));
  const hidden = await cliSourceReleases({ token: "t", known: new Set(), fetcher: fakeCliGitHub({ tagsStatus: 404 }).fetcher });
  assert.equal(hidden.pending, null);
  assert.match(hidden.rejected.join(), /HTTP 404/);
  // a refused token is an alarm (registry-sync fails loudly)
  const refused = await cliSourceReleases({ token: "t", known: new Set(), fetcher: fakeCliGitHub({ tagsStatus: 401 }).fetcher });
  assert.match(refused.rejected.join(), /HTTP 401/);
});

test("C174: cli source with the token builds the entry from a fixture release; pending and broken releases", async () => {
  const gh = fakeCliGitHub({ release: "ok" });
  const known = new Set<string>();
  const r = await cliSourceReleases({ token: "tok", known, fetcher: gh.fetcher, now: () => "2026-10-14T00:00:00.000Z" });
  assert.equal(r.pending, null);
  assert.deepEqual(r.rejected, []);
  assert.equal(r.add.length, 1, "relay/harness tags without a release yet are pending; only the cli entry is added");
  const e = r.add[0] as IndexRelease;
  assert.equal(cliEntryProblem(e), null);
  assert.equal(e.commit, CLI_SHA);
  assert.ok(known.has("cli@0.2.0@stable"));
  assert.ok(
    gh.calls.every((c) => /^https:\/\/api\.github\.com\/repos\/Tealbrick\/opt2-tealbrick-(cli|specs|sdk|packages|bridge)\//.test(c.url) && c.auth),
    "token only to the CLI repo API",
  );
  assert.equal(new Set(gh.calls.filter((c) => c.url.includes("/releases/assets/")).map((c) => c.url)).size, 3, "tgz + .sha256 + .integrity downloaded");
  // known version: nothing fetched beyond the tag list
  const again = fakeCliGitHub({ release: "ok" });
  assert.equal((await cliSourceReleases({ token: "tok", known, fetcher: again.fetcher })).add.length, 0);
  assert.ok(!again.calls.some((c) => c.url.includes("/releases/assets/") || c.url.endsWith("/releases/tags/cli-v0.2.0")), "known cli version: nothing fetched");
  // release not created yet, or tarball not uploaded yet: pending (no entry, no rejection)
  for (const release of ["none", "no-tgz"] as const) {
    const p = await cliSourceReleases({ token: "tok", known: new Set(), fetcher: fakeCliGitHub({ release }).fetcher });
    assert.deepEqual([p.add.length, p.rejected.length], [0, 0], release);
  }
  // tarball without its checksum assets, or a tampered tarball: rejected
  const noSums = await cliSourceReleases({ token: "tok", known: new Set(), fetcher: fakeCliGitHub({ release: "no-sums" }).fetcher });
  assert.match(noSums.rejected.join(), /\.sha256\/\.integrity/);
  const f = cliFixture();
  const tampered = { ...f, tgz: makeTgz({ "package.json": cliPkg(), "dist/main.js": "evil" }) };
  const bad = await cliSourceReleases({ token: "tok", known: new Set(), fetcher: fakeCliGitHub({ release: "ok", fixture: tampered }).fetcher });
  assert.match(bad.rejected.join(), /\.sha256 does not match/);
});

test("C174: registry-sync reads the read token from the workflow secret and never with GITHUB_TOKEN", () => {
  const wf = readFileSync(new URL("../.github/workflows/registry-sync.yml", import.meta.url), "utf8");
  assert.match(wf, /TB_PRIVATE_READ_TOKEN: \$\{\{ secrets\.TB_PRIVATE_READ_TOKEN \}\}/);
  const src = readFileSync(new URL("./tb-ci.ts", import.meta.url), "utf8");
  assert.match(src, /if \(repo === CLI_REPO\) continue;/, "the generic v* loop does not read the private repo");
  assert.equal(loadProductBindings().cli?.kind, "cli");
});

// ---------- ci-v9.7 (C173/C175): packScripts ----------

test("ci-v9.7 packScripts: config parsing (opt-in, TypeScript only, package dir keys) and the schema lists the field", () => {
  const base = { kind: "library", paths: ["."] };
  assert.deepEqual(validateConfig(base, "opt2-tealbrick-cli").packScripts, {}, "absent = template npm pack (other repos unchanged)");
  assert.deepEqual(validateConfig({ ...base, packScripts: { cli: "scripts/pack-cli.ts" } }, "opt2-tealbrick-cli").packScripts, { cli: "scripts/pack-cli.ts" });
  assert.deepEqual(parsePackScripts(undefined), {});
  assert.throws(() => parsePackScripts(["scripts/pack-cli.ts"]), /must be an object/);
  assert.throws(() => parsePackScripts({ cli: "scripts/pack-cli.js" }), /TypeScript only/);
  assert.throws(() => parsePackScripts({ cli: "../x/pack.ts" }), /repo-relative/);
  assert.throws(() => parsePackScripts({ cli: "/abs/pack.ts" }), /repo-relative/);
  assert.throws(() => parsePackScripts({ "CLI-v1": "scripts/pack.ts" }), /package directory/);
  assert.throws(() => parsePackScripts({ cli: 1 }), /repo-relative/);
  const schema = JSON.parse(readFileSync(new URL("./tealbrick-ci.schema.json", import.meta.url), "utf8")) as { properties: Record<string, unknown> };
  assert.ok(schema.properties.packScripts, "schema has packScripts");
  const src = readFileSync(new URL("./tb-ci.ts", import.meta.url), "utf8");
  const build = src.slice(src.indexOf("async function cmdGhBuild"), src.indexOf("async function cmdGhPublish"));
  assert.ok(
    build.indexOf("runPreReleaseChecks(cfg, root); // ci-v9.6: after install") < build.indexOf('packScript, "--out", dir'),
    "pack script runs after install/build/checks",
  );
  assert.ok(build.includes("await cmdPackagePack();"), "repos without packScripts keep npm pack");
});

test("ci-v9.7 packScripts: the output guard (exactly the named tarball, right package, pack guard; fires and stays quiet)", () => {
  const pj = (o: Record<string, unknown> = {}) => JSON.stringify({ name: "@opt2-tealbrick/cli", version: "0.2.0", bin: { tealbrick: "dist/main.js" }, ...o });
  const good = makeTgz({ "package.json": pj(), "dist/main.js": "x" });
  const files = (m: Record<string, Uint8Array>) => new Map(Object.entries(m));
  assert.deepEqual(
    packScriptOutputProblems(
      files({ "opt2-tealbrick-cli-0.2.0.tgz": good, "opt2-tealbrick-cli-0.2.0.tgz.sha256": Buffer.from("x") }),
      "@opt2-tealbrick/cli",
      "0.2.0",
    ),
    [],
  );
  assert.match(packScriptOutputProblems(files({}), "@opt2-tealbrick/cli", "0.2.0").join(), /no \.tgz/);
  assert.match(packScriptOutputProblems(files({ "cli.tgz": good }), "@opt2-tealbrick/cli", "0.2.0").join(), /exactly opt2-tealbrick-cli-0\.2\.0\.tgz/);
  assert.match(
    packScriptOutputProblems(files({ "opt2-tealbrick-cli-0.2.0.tgz": good, "opt2-tealbrick-relay-0.1.0.tgz": good }), "@opt2-tealbrick/cli", "0.2.0").join(),
    /exactly/,
  );
  const wrong = makeTgz({ "package.json": pj({ version: "0.1.9" }), "dist/main.js": "x" });
  assert.match(
    packScriptOutputProblems(files({ "opt2-tealbrick-cli-0.2.0.tgz": wrong }), "@opt2-tealbrick/cli", "0.2.0").join(),
    /contains @opt2-tealbrick\/cli@0\.1\.9/,
  );
  const noDist = makeTgz({ "package.json": pj() });
  assert.match(packScriptOutputProblems(files({ "opt2-tealbrick-cli-0.2.0.tgz": noDist }), "@opt2-tealbrick/cli", "0.2.0").join(), /missing from the tarball/);
  assert.match(
    packScriptOutputProblems(files({ "opt2-tealbrick-cli-0.2.0.tgz": Buffer.from("nope") }), "@opt2-tealbrick/cli", "0.2.0").join(),
    /not a readable/,
  );
});

test("C154: private repos are read with TB_PRIVATE_READ_TOKEN only; public repos and the platform token unchanged", async () => {
  const calls: { url: string; auth: string | undefined; accept: string | undefined }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(input), auth: h.authorization, accept: h.accept });
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  const env = { GITHUB_TOKEN: "platform", TB_PRIVATE_READ_TOKEN: "readonly" } as NodeJS.ProcessEnv;
  for (const repo of PRIVATE_REPOS) {
    const rd = repoReader(repo, env, fetcher);
    assert.equal(rd.via, "read-token");
    await rd.api(`/repos/Tealbrick/${repo}/tags?per_page=50`);
    await rd.file("packages/bridge-server/bridge-runtime.json", "f".repeat(40));
  }
  for (const c of calls) {
    assert.equal(c.auth, "Bearer readonly", "a private repo never gets the platform GITHUB_TOKEN");
    assert.ok(c.url.startsWith("https://api.github.com/repos/Tealbrick/"), "the read token goes to api.github.com only");
  }
  assert.ok(calls.some((c) => c.url.includes("/contents/packages/bridge-server/bridge-runtime.json?ref=") && c.accept === "application/vnd.github.raw+json"));
  calls.length = 0;
  const pub = repoReader("opt2-tealbrick-knowledge", env, fetcher);
  assert.equal(pub.via, "github-token");
  await pub.api("/repos/Tealbrick/opt2-tealbrick-knowledge/tags?per_page=50");
  await pub.file("tealbrick-ci.json", "main");
  assert.equal(calls[0]?.auth, "Bearer platform", "public repos: REST with GITHUB_TOKEN as before");
  assert.deepEqual(calls[1], {
    url: "https://raw.githubusercontent.com/Tealbrick/opt2-tealbrick-knowledge/main/tealbrick-ci.json",
    auth: undefined,
    accept: undefined,
  });
  assert.ok(!calls.some((c) => c.auth === "Bearer readonly"), "the read token never goes to a public repo");
  // private repo without the read token: read as before (works while it is still public)
  assert.equal(repoReader("opt2-tealbrick-bridge", { GITHUB_TOKEN: "platform" } as NodeJS.ProcessEnv, fetcher).via, "github-token");
  assert.equal(repoReader("opt2-tealbrick-bridge", {} as NodeJS.ProcessEnv, fetcher).via, "anonymous");
});

test("C154: an unreadable private repo is a loud registry-sync rejection naming the token; the audit skips it only without the token", () => {
  assert.match(
    repoReadProblem("opt2-tealbrick-bridge", "list tags", 404, "github-token"),
    /private repo: set TB_PRIVATE_READ_TOKEN with Contents \+ Metadata: read/,
  );
  assert.match(repoReadProblem("opt2-tealbrick-portal-core", "list tags", 404, "read-token"), /cannot read opt2-tealbrick-portal-core/);
  assert.equal(repoReadProblem("opt2-tealbrick-knowledge", "list tags", 500, "github-token"), "opt2-tealbrick-knowledge: list tags: HTTP 500");
  // L34 both ways: SKIP fires only for a private repo + 404 + no read token; everything else that is unreadable FAILs
  assert.equal(auditVerdict("opt2-tealbrick-bridge", 404, "anonymous", "none", "ci-v7"), "SKIP");
  assert.equal(auditVerdict("opt2-tealbrick-bridge", 404, "read-token", "none", "ci-v7"), "FAIL");
  assert.equal(auditVerdict("opt2-tealbrick-knowledge", 404, "anonymous", "none", "ci-v7"), "FAIL");
  assert.equal(auditVerdict("opt2-tealbrick-bridge", 200, "read-token", "ci-v9.5", "ci-v7"), "OK");
  assert.equal(auditVerdict("opt2-tealbrick-bridge", 200, "anonymous", "ci-v6", "ci-v7"), "FAIL");
  // registry-sync source: a non-200 tag list is a rejection, never iterated (a 404 body is an object, not a list)
  const src = readFileSync(new URL("./tb-ci.ts", import.meta.url), "utf8");
  const sync = src.slice(src.indexOf("async function cmdRegistrySync"), src.indexOf("function argValue"));
  assert.ok(sync.includes("const rd = repoReader(repo)"), "registry-sync reads each repo through repoReader");
  assert.ok(sync.includes("!Array.isArray(tags.json)"), "a non-list tag answer is rejected, not iterated");
  assert.ok(!/gh\("GET", `\/repos\/\$\{OWNER\}\/\$\{repo\}\/tags/.test(sync), "no GITHUB_TOKEN tag listing of opt2 repos");
  const activate = readFileSync(new URL("../ops/woodpecker-activate.ts", import.meta.url), "utf8");
  assert.ok(activate.includes('PRIVATE_REPOS.includes(repo) ? "private" : "public"'), "Woodpecker visibility follows PRIVATE_REPOS");
  assert.ok(!activate.includes('visibility: "public"'), "no repo is forced public in Woodpecker");
  // C203: the private Admin GUI repo is activated with private logs, outside OPT2_REPOS (it publishes nothing)
  assert.ok(/const ACTIVATE_PRIVATE[^=]*= \["opt2-tealbrick-admin"[,\]]/.test(activate), "Admin GUI repo activated as private");
  // C258a: Observer is public: an opt2 release repo, no longer activated privately, not in PRIVATE_REPOS
  assert.ok(!/const ACTIVATE_PRIVATE[^=]*= \[[^\]]*"opt2-tealbrick-observer"/.test(activate), "Observer left ACTIVATE_PRIVATE with its public flip");
  assert.ok(OPT2_REPOS.includes("opt2-tealbrick-observer"), "Observer joined OPT2_REPOS with its public flip");
  // C249 (ci-v9.15): Live Artifacts is public: an opt2 release repo, no longer activated privately, not in PRIVATE_REPOS
  assert.ok(
    !/const ACTIVATE_PRIVATE[^=]*= \[[^\]]*"opt2-tealbrick-live-artifacts"/.test(activate),
    "Live Artifacts left ACTIVATE_PRIVATE with its public flip",
  );
  assert.ok(OPT2_REPOS.includes("opt2-tealbrick-live-artifacts"), "Live Artifacts joined OPT2_REPOS with its public flip");
  assert.ok(!PRIVATE_REPOS.includes("opt2-tealbrick-live-artifacts"), "Live Artifacts is public");
  assert.ok(!PRIVATE_REPOS.includes("opt2-tealbrick-observer"), "Observer is public");
  assert.ok(/const ACTIVATE_PRIVATE[^=]*= \[[^\]]*"opt2-tealbrick-creative"/.test(activate), "Creative repo activated as private");
  assert.ok(!OPT2_REPOS.includes("opt2-tealbrick-creative"), "Creative joins OPT2_REPOS only with its public flip");
  assert.ok(!OPT2_REPOS.includes("opt2-tealbrick-admin"), "the Admin GUI repo is not an opt2 release repo");
});

test("BSD-08: the Portal key-set statement is a registry release asset next to the index (Core's default PORTAL_KEYSET_URL)", () => {
  assert.deepEqual(
    REGISTRY_EXTRA_ASSETS.map(([, n]) => n),
    ["keys.json", "portal-keyset.jws"],
  );
  for (const [path] of REGISTRY_EXTRA_ASSETS) assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${path} exists`);
  const src = readFileSync(new URL("./tb-ci.ts", import.meta.url), "utf8");
  const pub = src.slice(src.indexOf("async function publishIndex"), src.indexOf("export interface ReleaseCandidate"));
  assert.ok(pub.includes("for (const [path, name] of REGISTRY_EXTRA_ASSETS)"), "publishIndex uploads every extra asset");
  const sync = src.slice(src.indexOf("async function cmdRegistrySync"), src.indexOf("function argValue"));
  assert.ok(sync.includes("await syncRegistryExtraAssets()"), "a run with nothing new still repairs a missing/stale key file asset");
});

test("C181: kind package (relay, harnesses) from the CLI repo: dist URL only, sha256 + sha512, packed name checked, bound in products.json", async () => {
  const rf = relayFixture();
  const base = { product: "relay", version: "0.1.0", commit: CLI_SHA, publishedAt: "2026-10-15T00:00:00.000Z", id: "rel_01JA0000000000000000000010" };
  const e = distReleaseFromAssets({ ...base, ...rf });
  assert.equal(typeof e, "object", String(e));
  const r = e as IndexRelease;
  assert.equal(r.kind, "package");
  assert.equal(r.tag, "relay-v0.1.0");
  assert.equal(
    r.artifact?.url,
    "https://github.com/Tealbrick/opt2-tealbrick-dist/releases/download/opt2-tealbrick-cli-relay-v0.1.0/opt2-tealbrick-relay-0.1.0.tgz",
  );
  assert.equal(r.artifact?.url, distTarballUrl("relay", "0.1.0"));
  assert.equal(distEntryProblem(r), null);
  // fires: wrong packed name, kind mismatch, unknown product, private repo URL, missing integrity
  const wrong = relayFixture(JSON.stringify({ name: "@opt2-tealbrick/cli", version: "0.1.0" }));
  assert.match(String(distReleaseFromAssets({ ...base, ...wrong })), /not @opt2-tealbrick\/relay@0\.1\.0/);
  assert.match(String(distReleaseFromAssets({ ...base, product: "bridge", ...rf })), /not a dist product/);
  assert.match(distEntryProblem({ ...r, kind: "cli" }) ?? "", /must be kind package/);
  assert.match(distEntryProblem({ ...r, product: "no-such-product" }) ?? "", /not a dist product/);
  const art = r.artifact as { url: string; sha256: string; integrity: string };
  assert.match(
    distEntryProblem({
      ...r,
      artifact: { ...art, url: "https://github.com/Tealbrick/opt2-tealbrick-cli/releases/download/relay-v0.1.0/opt2-tealbrick-relay-0.1.0.tgz" },
    }) ?? "",
    /dist host/,
  );
  assert.match(
    distEntryProblem({ ...r, artifact: { url: art.url, sha256: art.sha256 } as IndexRelease["artifact"] }) ?? "",
    /integrity .* required for kind package/,
  );
  // no bin needed for a package; the cli still needs its bin
  assert.equal(DIST_PRODUCTS.relay?.bin, undefined);
  assert.equal(DIST_PRODUCTS.cli?.bin, "tealbrick");
  // products.json binds every dist product to the CLI repo with its kind; mergeIndex accepts it and keeps it immutable
  const bindings = loadProductBindings();
  for (const [product, d] of Object.entries(DIST_PRODUCTS))
    assert.deepEqual(bindings[product], { repo: `Tealbrick/${distRepo(d)}`, kind: d.kind, formerRepos: [`Martin-Atrin/${distRepo(d)}`] }, product);
  const i1 = mergeIndex(null, [r], [], "t", [], bindings);
  assert.equal(i1.releases.length, 1);
  assert.throws(
    () => mergeIndex(i1, [{ ...r, artifact: { ...art, url: distTarballUrl("relay", "0.1.0", "https://releases.tealbrick.com") } }], [], "t"),
    /immutable/,
  );
  assert.throws(() => mergeIndex(null, [{ ...r, repo: "Tealbrick/opt2-tealbrick-bridge" }], [], "t", [], bindings), /GTP-01/);
  // the source picks relay-v* releases up next to cli-v* (harness-claude without a release yet: pending)
  const gh = fakeCliGitHub({ release: "ok", relay: true });
  const out = await cliSourceReleases({ token: "tok", known: new Set(), fetcher: gh.fetcher, now: () => "2026-10-15T00:00:00.000Z" });
  assert.deepEqual(out.rejected, []);
  assert.deepEqual(out.add.map((x) => `${x.kind}:${x.product}@${x.version}`).sort(), ["cli:cli@0.2.0", "package:relay@0.1.0"]);
});

test("C206 ci-v9.8: owner Tealbrick, legacy Martin-Atrin accepted on read only; writes follow GITHUB_REPOSITORY", () => {
  assert.equal(OWNER, "Tealbrick");
  assert.deepEqual([...LEGACY_OWNERS], ["Martin-Atrin"]);
  assert.deepEqual([...KNOWN_OWNERS], ["Tealbrick", "Martin-Atrin"]);
  assert.equal(IMAGE_NAMESPACE, "ghcr.io/tealbrick");
  assert.equal(imageNamespace("Martin-Atrin"), "ghcr.io/martin-atrin");
  assert.deepEqual([...IMAGE_NAMESPACES], ["ghcr.io/tealbrick", "ghcr.io/martin-atrin"]);
  // writes: the Actions repo wins; elsewhere OWNER; a foreign owner is refused
  assert.equal(repoFullName(repo, {}), `Tealbrick/${repo}`);
  assert.equal(repoFullName(repo, { GITHUB_REPOSITORY: `Tealbrick/${repo}` }), `Tealbrick/${repo}`);
  assert.equal(repoFullName(repo, { GITHUB_REPOSITORY: `Martin-Atrin/${repo}` }), `Martin-Atrin/${repo}`);
  assert.equal(repoFullName(repo, { GITHUB_REPOSITORY: "Tealbrick/opt2-tealbrick-connect" }), `Tealbrick/${repo}`, "another repo's Action: OWNER");
  assert.throws(() => repoFullName(repo, { GITHUB_REPOSITORY: `evil/${repo}` }), /not an opt2 owner/);
  // reads: both owners for pins and desktop artifacts; new URLs carry OWNER
  const pin = (o: string) => `https://github.com/${o}/opt2-tealbrick-sdk/releases/download/manifest-v0.1.12/opt2-tealbrick-manifest-0.1.12.tgz`;
  assert.ok(isReleaseTarballUrl(pin("Martin-Atrin")) && isReleaseTarballUrl(pin("Tealbrick")));
  assert.ok(!isReleaseTarballUrl(pin("evil")));
  assert.ok(checkDependencies({ dependencies: { "@opt2-tealbrick/manifest": pin("Martin-Atrin") } }, "x", new Set())[0].length === 0, "old pins stay valid");
  assert.ok(checkDependencies({ dependencies: { "@opt2-tealbrick/manifest": pin("evil") } }, "x", new Set())[0].length === 1);
  assert.equal(releaseUrl("opt2-tealbrick-sdk", "manifest", "@opt2-tealbrick/manifest", "0.1.12"), pin("Tealbrick"));
  const spec = (o: string) => `https://github.com/${o}/opt2-tealbrick-specs/releases/download/spec-v0.1.20/opt2-tealbrick-spec-0.1.20.tgz`;
  assert.ok(isSpecTarballUrl(spec("Martin-Atrin")) && isSpecTarballUrl(spec("Tealbrick")) && !isSpecTarballUrl(spec("evil")));
  assert.ok(isSpecTarballUrl(`${DIST_BASES[0]}/opt2-tealbrick-specs-spec-v0.1.20/opt2-tealbrick-spec-0.1.20.tgz`), "B6: spec on the dist host");
  assert.ok(!isSpecTarballUrl(`${DIST_BASES[0]}/opt2-tealbrick-specs-spec-v0.1.20/opt2-tealbrick-spec-0.1.21.tgz`), "version must match");
  assert.deepEqual(artifactSource("https://github.com/Martin-Atrin/opt2-tealbrick-tbd/releases/download/v1.2.3/TBD.zip"), {
    repo: "opt2-tealbrick-tbd",
    tag: "v1.2.3",
  });
  assert.throws(() => artifactSource("https://github.com/evil/opt2-tealbrick-tbd/releases/download/v1.2.3/TBD.zip"));
  // dist: the org dist repo is the first base; the old user-account dist base is gone (nothing was ever pinned to it)
  assert.equal(DIST_BASES[0], "https://github.com/Tealbrick/opt2-tealbrick-dist/releases/download");
  assert.equal(CLI_DIST_BASE, DIST_BASES[0]);
  assert.ok(!DIST_BASES.some((b) => b.includes("Martin-Atrin")));
  // harness icons: both owners
  const h = (icon: string) => [
    { id: "test-harness", label: "X", kind: "other", authorise: "url", noAgentPath: false, icon, instructions: [{ title: "Open", detail: "Open it." }] },
  ];
  for (const o of KNOWN_OWNERS) assert.doesNotThrow(() => validateHarnesses(h(`https://raw.githubusercontent.com/${o}/opt2-tealbrick-platform/main/i.svg`)), o);
  assert.throws(() => validateHarnesses(h("https://raw.githubusercontent.com/evil/opt2-tealbrick-platform/main/i.svg")), /icon/);
});

test("C206: products.json formerRepos = same repo name under a legacy owner; GTP-01 treats it as the same repo for EARLIER releases only", () => {
  const ok = { bridge: { repo: "Tealbrick/opt2-tealbrick-bridge", kind: "bridge", formerRepos: ["Martin-Atrin/opt2-tealbrick-bridge"] } };
  const b = validateProducts(ok);
  assert.deepEqual(repoAliases(b.bridge as NonNullable<typeof b.bridge>), ["Tealbrick/opt2-tealbrick-bridge", "Martin-Atrin/opt2-tealbrick-bridge"]);
  assert.throws(
    () => validateProducts({ bridge: { ...ok.bridge, formerRepos: ["Martin-Atrin/opt2-tealbrick-samples"] } }),
    /formerRepos/,
    "never another repo",
  );
  assert.throws(() => validateProducts({ bridge: { ...ok.bridge, formerRepos: ["evil/opt2-tealbrick-bridge"] } }), /formerRepos/);
  assert.throws(() => validateProducts({ bridge: { ...ok.bridge, formerRepos: [] } }), /formerRepos/);
  assert.throws(
    () => validateProducts({ bridge: { ...ok.bridge, formerRepos: ["Martin-Atrin/opt2-tealbrick-bridge", "Martin-Atrin/opt2-tealbrick-bridge"] } }),
    /formerRepos/,
  );
  assert.throws(() => validateProducts({ bridge: { ...ok.bridge, other: 1 } }), /fields must be exactly/);
  assert.throws(
    () => validateProducts({ bridge: { repo: "Martin-Atrin/opt2-tealbrick-bridge", kind: "bridge" } }),
    /repo must be Tealbrick/,
    "the binding names the org repo",
  );
  const old = rel({ product: "bridge", kind: "bridge", version: "0.1.29", manifestDigest: null, runtime: brt, repo: "Martin-Atrin/opt2-tealbrick-bridge" });
  const i0 = mergeIndex(null, [old], [], "t"); // signed before the move (no binding check then)
  const next = rel({ product: "bridge", kind: "bridge", version: "0.1.30", manifestDigest: null, runtime: brt, repo: "Tealbrick/opt2-tealbrick-bridge" });
  assert.equal(mergeIndex(i0, [next], [], "t2", [], b).releases.length, 2, "first org release after the move is accepted");
  assert.throws(() => mergeIndex(i0, [next], [], "t2"), /GTP-01/, "without the binding the repo change is still refused");
  const legacyNew = rel({ ...next, version: "0.1.31", repo: "Martin-Atrin/opt2-tealbrick-bridge" });
  assert.throws(() => mergeIndex(i0, [legacyNew], [], "t2", [], b), /GTP-01/, "a NEW release must carry the bound repo, not the former one");
  const evil = rel({ ...next, version: "0.1.32", repo: "Tealbrick/opt2-tealbrick-samples" });
  assert.throws(() => mergeIndex(i0, [evil], [], "t2", [], b), /GTP-01/);
});

test("C206: image provenance accepts the org namespace and, for tags pushed before the move, the legacy namespace + label (same repo)", async () => {
  const commit = "c".repeat(40);
  const fake = (labels: Record<string, string>): typeof fetch =>
    (async (u: string | URL | Request) => {
      const s = String(u);
      if (s.includes("/token?")) return new Response(JSON.stringify({ token: "t" }));
      if (s.includes("/manifests/")) return new Response(JSON.stringify({ config: { digest: `sha256:${"e".repeat(64)}` } }));
      if (s.includes("/blobs/")) return new Response(JSON.stringify({ config: { Labels: labels } }));
      return new Response("", { status: 404 });
    }) as typeof fetch;
  const label = (o: string) => ({ "org.opencontainers.image.revision": commit, "org.opencontainers.image.source": `https://github.com/${o}/${repo}` });
  const img = (ns: string) => `${ns}/${repo}@sha256:${"a".repeat(64)}`;
  assert.equal(await verifyImageProvenance(img("ghcr.io/tealbrick"), `Tealbrick/${repo}`, commit, fake(label("Tealbrick"))), null);
  assert.equal(await verifyImageProvenance(img("ghcr.io/martin-atrin"), `Tealbrick/${repo}`, commit, fake(label("Martin-Atrin"))), null);
  assert.match(String(await verifyImageProvenance(img("ghcr.io/evil"), `Tealbrick/${repo}`, commit, fake(label("Tealbrick")))), /bad image ref/);
  assert.match(String(await verifyImageProvenance(img("ghcr.io/tealbrick"), `Tealbrick/${repo}`, commit, fake(label("evil")))), /source label/);
  assert.match(
    String(
      await verifyImageProvenance(
        img("ghcr.io/tealbrick"),
        `Tealbrick/${repo}`,
        commit,
        fake({ ...label("Tealbrick"), "org.opencontainers.image.source": "https://github.com/Martin-Atrin/opt2-tealbrick-connect" }),
      ),
    ),
    /source label/,
    "legacy label must name the same repo",
  );
});

test("C206: ghcrFind looks in ghcr.io/tealbrick first, then the legacy namespace", async () => {
  const seen: string[] = [];
  const fetcher = (has: string) =>
    (async (u: string | URL | Request) => {
      const s = String(u);
      seen.push(s);
      if (s.includes("/token?")) return new Response(JSON.stringify({ token: "t" }));
      if (s.includes(`/v2/${has}/`)) return new Response(null, { status: 200, headers: { "docker-content-digest": `sha256:${"f".repeat(64)}` } });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
  assert.equal(await ghcrFind(repo, "0.1.0", fetcher("tealbrick")), `ghcr.io/tealbrick/${repo}@sha256:${"f".repeat(64)}`);
  assert.equal(await ghcrFind(repo, "0.1.0", fetcher("martin-atrin")), `ghcr.io/martin-atrin/${repo}@sha256:${"f".repeat(64)}`);
  assert.equal(await ghcrFind(repo, "0.1.0", fetcher("nobody")), null);
  assert.ok(seen.some((u) => u.includes("scope=repository:tealbrick/")));
});

test("C206 B0 probe: uploads go to the release's upload_url (uploads.github.com does not follow a transfer)", () => {
  assert.deepEqual(uploadTarget("https://uploads.github.com/repos/Tealbrick/opt2-tealbrick-platform/releases/42/assets{?name,label}", "index.json"), {
    host: "uploads.github.com",
    path: "/repos/Tealbrick/opt2-tealbrick-platform/releases/42/assets?name=index.json",
  });
  assert.equal(
    uploadTarget("https://uploads.github.com/repos/T/r/releases/1/assets{?name,label}", "a b.tgz").path,
    "/repos/T/r/releases/1/assets?name=a%20b.tgz",
  );
  for (const bad of [
    "https://evil.example/repos/T/r/releases/1/assets{?name,label}",
    "http://uploads.github.com/repos/T/r/releases/1/assets{?name,label}",
    "https://uploads.github.com/repos/T/r/releases/1/other",
    "https://uploads.github.com/repos/T/r/releases/1/assets?name=x",
    "not a url",
  ])
    assert.throws(() => uploadTarget(bad, "x"), /upload_url/, bad);
  // the runner never builds an uploads.github.com path itself any more
  const runner = readFileSync(new URL("./tb-ci.ts", import.meta.url), "utf8");
  assert.ok(!/host: "uploads\.github\.com"/.test(runner), "no hand-built upload host");
  assert.ok(!/\/repos\/\$\{OWNER\}\/\$\{repo\}\/releases/.test(runner), "release writes go through repoFullName");
});

test("C206 ci-v9.8/9.9 templates: runner + template from Tealbrick; manifest/spec pins on the dist host (B6)", () => {
  const tpl = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  const wf = readFileSync(new URL("./github/opt2-release.yml", import.meta.url), "utf8");
  for (const t of [tpl, wf]) {
    assert.match(t, /GENERATED from Tealbrick\/opt2-tealbrick-platform/);
    assert.match(t, /raw\.githubusercontent\.com\/Tealbrick\/opt2-tealbrick-platform\/\$TB_CI_REF\/ci\/tb-ci\.ts/);
    assert.ok(!/raw\.githubusercontent\.com\/Martin-Atrin/.test(t));
  }
  assert.ok(!wf.includes("ghcr.io/martin-atrin"));
  const schema = JSON.parse(readFileSync(new URL("./tealbrick-ci.schema.json", import.meta.url), "utf8")) as {
    $id: string;
    properties: { distBaseUrl: { enum: string[] } };
  };
  assert.match(schema.$id, /^https:\/\/raw\.githubusercontent\.com\/Tealbrick\//);
  assert.deepEqual(schema.properties.distBaseUrl.enum, [...DIST_BASES], "schema enum == DIST_BASES");
});

test("C206 B6: library dist products (spec, manifest, miniapp-sdk, conformance, ui, create-tealbrick-miniapp, legacy bridge-repo tarballs)", () => {
  assert.equal(distRepo(DIST_PRODUCTS.cli as NonNullable<typeof DIST_PRODUCTS.cli>), CLI_REPO);
  const spec = DIST_PRODUCTS.spec as NonNullable<typeof DIST_PRODUCTS.spec>;
  assert.equal(distRepo(spec), "opt2-tealbrick-specs");
  assert.equal(distTarballUrl("spec", "0.1.20"), `${DIST_BASES[0]}/opt2-tealbrick-specs-spec-v0.1.20/opt2-tealbrick-spec-0.1.20.tgz`);
  assert.ok(isDistTarballUrl(distTarballUrl("spec", "0.1.20")) && isSpecTarballUrl(distTarballUrl("spec", "0.1.20")));
  assert.equal(distTarballUrl("ui", "0.2.4"), `${DIST_BASES[0]}/opt2-tealbrick-packages-ui-v0.2.4/opt2-tealbrick-ui-0.2.4.tgz`);
  assert.equal(
    distTarballUrl("create-tealbrick-miniapp", "0.1.14"),
    `${DIST_BASES[0]}/opt2-tealbrick-sdk-create-tealbrick-miniapp-v0.1.14/create-tealbrick-miniapp-0.1.14.tgz`,
  );
  assert.equal(distTarballUrl("cli-legacy", "0.1.22"), `${DIST_BASES[0]}/opt2-tealbrick-bridge-cli-v0.1.22/opt2-tealbrick-cli-0.1.22.tgz`);
  // since / legacy
  assert.ok(distVersionWanted(spec, "0.1.38") && distVersionWanted(spec, "0.1.39") && distVersionWanted(spec, "0.2.0") && distVersionWanted(spec, "1.0.0"));
  assert.ok(distVersionWanted(spec, "0.1.20"), "pinned legacy");
  assert.ok(!distVersionWanted(spec, "0.1.21") && !distVersionWanted(spec, "0.1.1"), "older versions nobody pins are ignored");
  const legacyOnly = DIST_PRODUCTS["bridge-package-legacy"] as NonNullable<(typeof DIST_PRODUCTS)["cli"]>;
  assert.ok(distVersionWanted(legacyOnly, "0.1.1") && !distVersionWanted(legacyOnly, "0.1.29"), "legacy-only: nothing new");
  assert.ok(distVersionWanted(DIST_PRODUCTS.relay as NonNullable<typeof DIST_PRODUCTS.relay>, "9.9.9"), "CLI-repo products: every version");
  // tag dirs are unique per repo
  const seen = new Set<string>();
  for (const d of Object.values(DIST_PRODUCTS)) {
    const k = `${distRepo(d)}/${d.tagDir}`;
    assert.ok(!seen.has(k), k);
    seen.add(k);
  }
  // products.json binds each of them to its repo as kind package
  const b = loadProductBindings();
  for (const p of [
    "spec",
    "manifest",
    "miniapp-sdk",
    "conformance",
    "ui",
    "create-tealbrick-miniapp",
    "bridge-package-legacy",
    "harness-claude-legacy",
    "cli-legacy",
  ])
    assert.equal(b[p]?.kind, "package", p);
});

test("C206 B6: a legacy version without the .integrity asset is indexed with the integrity computed from the bytes; a new one is refused", () => {
  const rf = relayFixture(JSON.stringify({ name: "@opt2-tealbrick/spec", version: "0.1.20" }));
  // relayFixture names the file after the relay package; rebuild the sums for the spec name
  const name = "opt2-tealbrick-spec-0.1.20.tgz";
  const sums = assetChecksums(name, rf.tgz);
  const base = { product: "spec", commit: CLI_SHA, publishedAt: "2026-10-16T00:00:00.000Z", tgz: rf.tgz, sha256File: `${sums.sha256}  ${name}` };
  const legacy = distReleaseFromAssets({ ...base, version: "0.1.20", integrityFile: null });
  assert.equal(typeof legacy, "object", String(legacy));
  assert.equal((legacy as IndexRelease).artifact?.integrity, sums.integrity);
  assert.equal((legacy as IndexRelease).repo, "Tealbrick/opt2-tealbrick-specs");
  assert.equal((legacy as IndexRelease).tag, "spec-v0.1.20");
  const rf2 = relayFixture(JSON.stringify({ name: "@opt2-tealbrick/spec", version: "0.1.38" }));
  const n2 = "opt2-tealbrick-spec-0.1.38.tgz";
  const s2 = assetChecksums(n2, rf2.tgz);
  assert.match(
    String(distReleaseFromAssets({ ...base, tgz: rf2.tgz, sha256File: `${s2.sha256}  ${n2}`, version: "0.1.38", integrityFile: null })),
    /no \.integrity asset/,
  );
  assert.match(
    String(distReleaseFromAssets({ ...base, version: "0.1.20", sha256File: `${"0".repeat(64)}  ${name}`, integrityFile: null })),
    /\.sha256 does not match/,
  );
});

test("C206 R2-1: legacy-owner manifestUrl / source.repo / desktop artifact.url are rewritten to Tealbrick; repo + images untouched", async () => {
  const sha = "a".repeat(40);
  const app = rel({
    id: "rel_01M4AAAAAAAAAAAAAAAAAAAAAA",
    manifestUrl: `https://raw.githubusercontent.com/Martin-Atrin/${repo}/${sha}/tealbrick.manifest.json`,
    repo: `Martin-Atrin/${repo}`,
    image: `ghcr.io/martin-atrin/${repo}@sha256:${"b".repeat(64)}`,
  });
  const src = rel({
    id: "rel_01M4BBBBBBBBBBBBBBBBBBBBBB",
    channel: "dev",
    image: null,
    source: { repo: "Martin-Atrin/opt2-tealbrick-bridge", ref: sha, dockerfile: "Dockerfile" },
  });
  const desk = rel({
    id: "rel_01M4CCCCCCCCCCCCCCCCCCCCCC",
    product: "tbd",
    kind: "desktop",
    manifestUrl: null,
    manifestDigest: null,
    image: null,
    artifact: { url: "https://github.com/Martin-Atrin/opt2-tealbrick-tbd/releases/download/v0.1.0/TBD.zip", sha256: `sha256:${"c".repeat(64)}` },
  });
  const done = rel({ id: "rel_01M4DDDDDDDDDDDDDDDDDDDDDD", manifestUrl: `https://raw.githubusercontent.com/Tealbrick/${repo}/${sha}/tealbrick.manifest.json` });
  const { releases, rewrites } = normalizeLegacyOwners([app, src, desk, done]);
  assert.deepEqual(
    rewrites.map((w) => w.field),
    ["manifestUrl", "source.repo", "artifact.url"],
  );
  assert.equal(releases[0]?.manifestUrl, `https://raw.githubusercontent.com/Tealbrick/${repo}/${sha}/tealbrick.manifest.json`);
  assert.equal(releases[0]?.repo, `Martin-Atrin/${repo}`, "repo (provenance) stays");
  assert.equal(releases[0]?.image, app.image, "images never move");
  assert.equal(releases[1]?.source?.repo, "Tealbrick/opt2-tealbrick-bridge");
  assert.equal(releases[2]?.artifact?.url, "https://github.com/Tealbrick/opt2-tealbrick-tbd/releases/download/v0.1.0/TBD.zip");
  assert.equal(releases[3], done, "already-org records are returned as is");
  assert.equal(normalizeLegacyOwners(releases).rewrites.length, 0, "idempotent");
  // mergeIndex applies it to every record
  const merged = mergeIndex({ schema: "opt2.release-index/v2", generatedAt: "t", releases: [app, src], offers: [], harnesses: [] } as never, [], [], "t2");
  assert.equal(normalizeLegacyOwners(merged.releases).rewrites.length, 0);
  // verification: digest of the manifest at the new URL, source commit in the org repo, artifact sha256
  const fakeM = { manifestDigest: (j: unknown) => (JSON.stringify(j) === '{"ok":1}' ? app.manifestDigest : "sha256:other") } as never;
  const reader =
    (body: string, commitOk = true) =>
    (_r: string) =>
      ({
        via: "read-token",
        api: async () => (commitOk ? { status: 200, json: { sha } } : { status: 404, json: null }),
        file: async () => ({ status: 200, text: body }),
      }) as never;
  const zip = new TextEncoder().encode("zip");
  const zipSha = `sha256:${createHash("sha256").update(zip).digest("hex")}`;
  const desk2 = { ...desk, artifact: { url: desk.artifact?.url as string, sha256: zipSha } };
  const rw = normalizeLegacyOwners([app, src, desk2]).rewrites;
  const okFetch = (async () => new Response(zip)) as typeof fetch;
  assert.deepEqual(await verifyOwnerRewrites(fakeM, [app, src, desk2], rw, reader('{"ok":1}'), okFetch), []);
  assert.match((await verifyOwnerRewrites(fakeM, [app, src, desk2], rw, reader('{"ok":2}'), okFetch)).join(";"), /manifestUrl: digest/);
  assert.match((await verifyOwnerRewrites(fakeM, [app, src, desk2], rw, reader('{"ok":1}', false), okFetch)).join(";"), /source\.repo: commit/);
  const badFetch = (async () => new Response("other")) as typeof fetch;
  assert.match((await verifyOwnerRewrites(fakeM, [app, src, desk2], rw, reader('{"ok":1}'), badFetch)).join(";"), /artifact\.url: sha256/);
});

test("C206 R2-3: no internal machine / tailnet names in this public repo's tracked files", () => {
  const files = execFileSync("git", ["ls-files"], { cwd: new URL("..", import.meta.url), encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  // built from parts so this test does not trip itself
  const names = ["fo" + "xy", "ne" + "uu", "nuc" + "lab", "fed" + "-main"];
  const re = new RegExp(`\\b(?:${names.join("|")})\\b|tail${"d"}[0-9a-f]{4,}|\\.ts${"."}net\\b`, "i");
  const hits: string[] = [];
  for (const f of files) {
    if (/\.(png|jpg|jws|tgz)$/.test(f)) continue;
    const text = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    text.split("\n").forEach((line, i) => {
      if (re.test(line)) hits.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("C207 E1: release guard — main/hotfix, green Woodpecker, merged PR (warning before the cut-over, refusal after)", async () => {
  const sha = "e".repeat(40);
  const fake = (o: { compare?: string; hotfix?: string; status?: string; context?: string; merged?: boolean; prStatus?: number }) => async (path: string) => {
    if (path.includes("/compare/main...")) return { status: 200, json: { status: o.compare ?? "behind" } };
    if (path.includes("/compare/")) return { status: 200, json: { status: path.includes(encodeURIComponent(o.hotfix ?? "-")) ? "behind" : "diverged" } };
    if (path.endsWith("/branches?per_page=100")) return { status: 200, json: [{ name: "main" }, { name: "hotfix/x" }, { name: "feature" }] };
    if (path.endsWith("/status")) return { status: 200, json: { statuses: [{ context: o.context ?? "ci/woodpecker/push/ci", state: o.status ?? "success" }] } };
    if (path.endsWith("/pulls"))
      return { status: o.prStatus ?? 200, json: o.merged === false ? [] : [{ merged_at: "2026-10-16T00:00:00Z", base: { ref: "main" } }] };
    return { status: 500, json: null };
  };
  const before = Date.parse(PR_REQUIRED_FROM) - 1;
  const after = Date.parse(PR_REQUIRED_FROM) + 1;
  assert.deepEqual(await releaseGuard(fake({}), "Tealbrick/x", sha, after), { problem: null, warnings: [] });
  assert.deepEqual(await releaseGuard(fake({ compare: "identical" }), "Tealbrick/x", sha, after), { problem: null, warnings: [] });
  assert.match((await releaseGuard(fake({ compare: "ahead" }), "Tealbrick/x", sha, after)).problem ?? "", /not on main or a hotfix/);
  assert.equal((await releaseGuard(fake({ compare: "ahead", hotfix: "hotfix/x" }), "Tealbrick/x", sha, after)).problem, null, "hotfix/* accepted");
  assert.match((await releaseGuard(fake({ status: "failure" }), "Tealbrick/x", sha, after)).problem ?? "", /no green Woodpecker/);
  assert.match(
    (await releaseGuard(fake({ context: "ci/woodpecker/pr/ci" }), "Tealbrick/x", sha, after)).problem ?? "",
    /no green Woodpecker/,
    "a PR status is not enough",
  );
  assert.equal((await releaseGuard(fake({ context: "ci/woodpecker/tag/ci" }), "Tealbrick/x", sha, after)).problem, null);
  const warn = await releaseGuard(fake({ merged: false }), "Tealbrick/x", sha, before);
  assert.equal(warn.problem, null);
  assert.match(warn.warnings.join(), /no merged PR.*required from 2026-10-25/);
  assert.match((await releaseGuard(fake({ merged: false }), "Tealbrick/x", sha, after)).problem ?? "", /no merged PR.*required since 2026-10-25/);
  assert.match((await releaseGuard(fake({ prStatus: 403 }), "Tealbrick/x", sha, after)).problem ?? "", /Pull requests: read/);
});

test("C207 E1: ignored-tags.json validation (reviewed list; reason + decision)", () => {
  assert.deepEqual(validateIgnoredTags([]), []);
  const ok = { repo: "opt2-tealbrick-kanban", tag: "v0.2.0", reason: "tagged from a feature branch by mistake", decision: "C210" };
  assert.equal(validateIgnoredTags([ok]).length, 1);
  assert.throws(() => validateIgnoredTags([{ ...ok, decision: "none" }]), /decision/);
  assert.throws(() => validateIgnoredTags([{ ...ok, reason: "x" }]), /reason/);
  assert.throws(() => validateIgnoredTags([{ ...ok, extra: 1 }]), /fields/);
  const committed = JSON.parse(readFileSync(new URL("../registry/ignored-tags.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => validateIgnoredTags(committed));
});

test("C207 E4: new app/bridge tags land on dev; stable only by a recorded promotion with soak evidence (same image + manifest)", () => {
  assert.equal(tagChannel("kanban", "0.2.0", "app"), "dev");
  assert.equal(tagChannel("bridge", "0.1.31", "bridge"), "dev");
  assert.equal(tagChannel("cli", "0.2.1", "cli"), "stable", "cli/package keep the version rule");
  assert.equal(tagChannel("relay", "0.2.0-rc.1", "package"), "dev");
  const dev = rel({ id: "rel_01M5DEVDEVDEVDEVDEVDEVDEV0", product: "kanban", version: "0.2.0", channel: "dev", publishedAt: "2026-10-20T00:00:00.000Z" });
  const ev = {
    soakStart: "2026-10-20T01:00:00Z",
    soakEnd: "2026-10-21T02:00:00Z",
    workspace: "qa1",
    qaRun: "qa/reports/2026-10-21-regression.md",
    platform: { core: "abcdef1", bridge: "0.1.30" },
  };
  const p = {
    product: "kanban",
    version: "0.2.0",
    devReleaseId: dev.id,
    promotedAt: "2026-10-21T03:00:00Z",
    by: "coordinator",
    decision: "C210",
    evidence: ev,
  };
  const [vp] = validatePromotions([p]);
  const idx = { releases: [dev] };
  const out = promotionReleases(idx, [vp as never], { now: "2026-10-21T03:05:00Z", newId: () => "rel_01M5SSSSSSSSSSSSSSSSSSSSS0" });
  assert.deepEqual(out.problems, []);
  const st = out.add[0] as IndexRelease;
  assert.equal(st.channel, "stable");
  assert.equal(st.promotedFrom, dev.id);
  assert.equal(st.image, dev.image);
  assert.equal(st.manifestDigest, dev.manifestDigest);
  assert.equal(st.id, "rel_01M5SSSSSSSSSSSSSSSSSSSSS0");
  // mergeIndex accepts the promotion, refuses a hand-made stable record or a copy that changed the image
  const i1 = mergeIndex({ schema: "opt2.release-index/v2", generatedAt: "t", releases: [dev], offers: [], harnesses: [] } as never, [st], [], "t2");
  assert.equal(i1.releases.length, 2);
  assert.throws(() => mergeIndex(null, [rel({ channel: "stable" })], [], "t"), /promotedFrom/);
  assert.throws(
    () =>
      mergeIndex(
        { schema: "opt2.release-index/v2", generatedAt: "t", releases: [dev], offers: [], harnesses: [] } as never,
        [{ ...st, image: `ghcr.io/tealbrick/x@sha256:${"9".repeat(64)}` }],
        [],
        "t2",
      ),
    /promotion must copy/,
  );
  // idempotent: applied promotions are skipped
  assert.deepEqual(promotionReleases({ releases: [dev, st] }, [vp as never], { now: "t" }), { add: [], problems: [] });
  // soak rules: app 24 h, bridge 48 h, expedited needs an incident
  const short = { ...p, evidence: { ...ev, soakEnd: "2026-10-20T12:00:00Z" } };
  assert.match(promotionReleases(idx, validatePromotions([short]) as never, { now: "t" }).problems.join(), /soak 11\.0 h < 24 h/);
  assert.equal(
    promotionReleases(idx, validatePromotions([{ ...short, expedited: true, incident: "INC-7" }]) as never, {
      now: "t",
      newId: () => "rel_01M5SSSSSSSSSSSSSSSSSSSSS1",
    }).add.length,
    1,
  );
  assert.throws(() => validatePromotions([{ ...short, expedited: true }]), /incident/);
  const bdev = rel({
    id: "rel_01M5BBBBBBBBBBBBBBBBBBBBB0",
    product: "bridge",
    kind: "bridge",
    version: "0.1.31",
    channel: "dev",
    manifestDigest: null,
    publishedAt: "2026-10-20T00:00:00.000Z",
  });
  assert.match(
    promotionReleases({ releases: [bdev] }, validatePromotions([{ ...p, product: "bridge", version: "0.1.31", devReleaseId: bdev.id }]) as never, {
      now: "t",
    }).problems.join(),
    /< 48 h/,
  );
  // refusals
  assert.match(promotionReleases({ releases: [] }, [vp as never], { now: "t" }).problems.join(), /not in the index/);
  assert.match(
    promotionReleases({ releases: [dev, rel({ ...dev, id: "rel_01M5ZZZZZZZZZZZZZZZZZZZZZ0", channel: "stable" })] }, [vp as never], {
      now: "t",
    }).problems.join(),
    /already exists/,
  );
  assert.match(
    promotionReleases({ releases: [{ ...dev, publishedAt: "2026-10-20T05:00:00.000Z" }] }, [vp as never], { now: "t" }).problems.join(),
    /soak started before/,
  );
  const sample = rel({ ...dev, product: "sample-gate", devOnly: true });
  assert.match(
    promotionReleases({ releases: [sample] }, validatePromotions([{ ...p, product: "sample-gate" }]) as never, { now: "t" }).problems.join(),
    /dev-only/,
  );
  // a listed dev-only product is refused even when its record has no flag (the list decides)
  assert.match(
    promotionReleases({ releases: [rel({ ...dev, product: "sample-pay" })] }, validatePromotions([{ ...p, product: "sample-pay" }]) as never, {
      now: "t",
    }).problems.join(),
    /dev-only/,
  );
  // C278: fleet left DEV_ONLY_PRODUCTS; its dev record still carries devOnly:true (signed, never rewritten) and promotes; the
  // stable copy has no devOnly flag
  const fleetDev = rel({ ...dev, product: "fleet", devOnly: true });
  const fleetOut = promotionReleases({ releases: [fleetDev] }, validatePromotions([{ ...p, product: "fleet" }]) as never, {
    now: "t",
    newId: () => "rel_01M5FFFFFFFFFFFFFFFFFFFFF0",
  });
  assert.deepEqual(fleetOut.problems, []);
  assert.equal(fleetOut.add.length, 1);
  assert.equal(fleetOut.add[0]?.channel, "stable");
  assert.equal(fleetOut.add[0]?.promotedFrom, fleetDev.id);
  assert.ok(!("devOnly" in (fleetOut.add[0] as object)), "the stable copy drops devOnly");
  assert.throws(() => validatePromotions([{ ...p, version: "0.2.0-rc.1" }]), /pre-release/);
  assert.throws(() => validatePromotions([{ ...p, evidence: { ...ev, qaRun: "" } }]), /qaRun/);
  assert.throws(() => validatePromotions([p, p]), /twice/);
  const committed = JSON.parse(readFileSync(new URL("../registry/promotions.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => validatePromotions(committed));
});

// ---------- ci-v9.10 (C222): releases of private repos on Woodpecker ----------

const sha40 = (c: string) => c.repeat(40);

test("ci-v9.10 C222 / ci-v9.11 C232: releaseOn config field (default actions; woodpecker allowed with images, every other rule kept)", () => {
  assert.equal(validateConfig({ kind: "library" }, repo).releaseOn, "actions");
  assert.equal(validateConfig({ kind: "library", releaseOn: "woodpecker" }, repo).releaseOn, "woodpecker");
  assert.throws(() => validateConfig({ kind: "library", releaseOn: "github" }, repo), /releaseOn/);
  // ci-v9.11: images are accepted with releaseOn woodpecker (the ci-v9.10 refusal is gone)
  const withImages = validateConfig(
    { kind: "miniapp", releaseOn: "woodpecker", images: [{ name: repo, product: "knowledge", kind: "app", manifest: "tealbrick.manifest.json" }] },
    repo,
  );
  assert.equal(withImages.releaseOn, "woodpecker");
  assert.deepEqual(
    withImages.images.map((i) => i.name),
    [repo],
  );
  // every other config rule still fires with releaseOn woodpecker
  assert.throws(
    () =>
      validateConfig(
        { kind: "miniapp", releaseOn: "woodpecker", images: [{ name: "other-repo", product: "knowledge", kind: "app", manifest: "m.json" }] },
        repo,
      ),
    /images\[0\]\.name/,
  );
  assert.throws(
    () => validateConfig({ kind: "miniapp", releaseOn: "woodpecker", images: [{ name: repo, product: "knowledge", kind: "app" }] }, repo),
    /needs manifest/,
  );
  assert.throws(() => validateConfig({ kind: "miniapp", releaseOn: "woodpecker", images: [], nope: 1 }, repo), /unknown field nope/);
  const schema = JSON.parse(readFileSync(new URL("./tealbrick-ci.schema.json", import.meta.url), "utf8")) as {
    properties: { releaseOn: { enum: string[]; description: string } };
  };
  assert.deepEqual(schema.properties.releaseOn.enum, ["actions", "woodpecker"]);
  assert.ok(!/no images/.test(schema.properties.releaseOn.description), "the schema no longer says package tarballs only");
});

test("ci-v9.10 C222: exactly one release publisher per repo", () => {
  assert.deepEqual(releaseFileProblems("woodpecker", true, false, true), []);
  assert.match(releaseFileProblems("woodpecker", true, true, true).join(), /must not exist/);
  assert.match(releaseFileProblems("woodpecker", true, false, false).join(), /release\.yaml is required/);
  assert.deepEqual(releaseFileProblems("actions", true, true, false), []);
  assert.deepEqual(releaseFileProblems("actions", false, false, false), [], "a repo that releases nothing needs no release file");
  assert.match(releaseFileProblems("actions", true, false, false).join(), /opt2-release\.yml is required/);
  assert.match(releaseFileProblems("actions", false, false, true).join(), /needs "releaseOn": "woodpecker"/);
  assert.equal(GH_WORKFLOW_PATH, ".github/workflows/opt2-release.yml");
  assert.equal(WP_RELEASE_PATH, ".woodpecker/release.yaml");
});

test("ci-v9.10 C222: release target = the pipeline tag, or an EXISTING tag on a manual run from main; never a new tag", () => {
  const tags: Record<string, string> = { "relay-v0.1.0": sha40("b"), "v1.2.3": sha40("c") };
  const look = (t: string) => tags[t] ?? null;
  const base = { event: "tag", branch: "", commitTag: "relay-v0.1.0", commitSha: sha40("b"), releaseTag: "" };
  assert.deepEqual(wpReleaseTarget(base, look), { tag: "relay-v0.1.0", commit: sha40("b") });
  assert.match(String(wpReleaseTarget({ ...base, commitSha: sha40("e") }, look)), /points at/);
  assert.match(String(wpReleaseTarget({ ...base, releaseTag: "v1.2.3" }, look)), /!= the pipeline tag/);
  const manual = { event: "manual", branch: "main", commitTag: "", commitSha: sha40("f"), releaseTag: "relay-v0.1.0" };
  assert.deepEqual(wpReleaseTarget(manual, look), { tag: "relay-v0.1.0", commit: sha40("b") }, "manual: the tag's commit, not main's");
  assert.match(String(wpReleaseTarget({ ...manual, branch: "feature" }, look)), /main only/);
  assert.match(String(wpReleaseTarget({ ...manual, releaseTag: "" }, look)), /TB_RELEASE_TAG/);
  assert.match(String(wpReleaseTarget({ ...manual, releaseTag: "relay-v0.9.9" }, look)), /does not exist/);
  assert.match(String(wpReleaseTarget({ ...manual, releaseTag: "ci-v9.10" }, look)), /not v<semver>/);
  assert.match(String(wpReleaseTarget({ ...manual, releaseTag: "x; rm -rf /" }, look)), /not v<semver>/);
  assert.match(String(wpReleaseTarget({ ...manual, event: "push" }, look)), /tag and manual events only/);
  assert.match(String(wpReleaseTarget({ ...manual, event: "pull_request" }, look)), /tag and manual events only/);
});

test("ci-v9.10 C222: a published asset is never replaced", () => {
  const a = new TextEncoder().encode("a");
  assert.equal(assetDecision(null, a), "upload");
  assert.equal(assetDecision(new TextEncoder().encode("a"), a), "same");
  assert.equal(assetDecision(new TextEncoder().encode("b"), a), "conflict");
  const runner = readFileSync(new URL("./tb-ci.ts", import.meta.url), "utf8");
  const pub = runner.slice(runner.indexOf("async function publishAssetOnce"), runner.indexOf("async function cmdWpPublish"));
  assert.ok(!pub.includes('"DELETE"'), "the Woodpecker publish never deletes an asset");
  const wp = runner.slice(runner.indexOf("async function cmdWpPublish"), runner.indexOf("function cmdPlanImages"));
  assert.ok(wp.indexOf("sums.files") < wp.indexOf("publishAssetOnce(full, rel, name, data"), "checksum files before the tarball");
  assert.ok(!wp.includes("putAsset"), "no replace path");
});

test("ci-v9.10 C222 template: release.yaml = build without secret, publish runs no repo code and alone reads the secret", () => {
  const rel = readFileSync(new URL("./woodpecker/release.yaml", import.meta.url), "utf8");
  const ci = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  assert.match(rel.split("\n")[0] as string, /template ci-v9\.16/);
  assert.match(rel, /GENERATED from Tealbrick\/opt2-tealbrick-platform: ci\/woodpecker\/release\.yaml/);
  const ref = /TB_CI_REF: (\S+)/.exec(ci)?.[1];
  const sha = /TB_CI_SHA256: "([0-9a-f]{64})"/.exec(ci)?.[1];
  for (const m of rel.matchAll(/TB_CI_REF: (\S+)/g)) assert.equal(m[1], ref, "same ref as ci.yaml");
  for (const m of rel.matchAll(/TB_CI_SHA256: "([^"]*)"/g)) assert.equal(m[1], sha, "same runner sha256 as ci.yaml");
  assert.equal(
    createHash("sha256")
      .update(readFileSync(new URL("./tb-ci.ts", import.meta.url)))
      .digest("hex"),
    sha,
    "stamped",
  );
  assert.match(rel, /^depends_on: \[ci\]$/m, "runs only after a green ci workflow");
  // events: tag, and manual on main with TB_RELEASE_TAG; never push or pull_request
  const when = rel.slice(rel.indexOf("\nwhen:"), rel.indexOf("\ndepends_on:"));
  assert.deepEqual(
    [...when.matchAll(/event: (\S+)/g)].map((m) => m[1]),
    ["tag", "tag", "manual"],
  );
  assert.match(when, /branch: main/);
  assert.match(when, /evaluate: '\(TB_RELEASE_TAG \?\? ""\) != ""'/);
  assert.match(rel, /image: docker\.io\/woodpeckerci\/plugin-git:2\.10\.1/, "the default trusted clone image (gets the netrc)");
  assert.match(rel, /tags: true/);
  const steps = rel.slice(rel.indexOf("\nsteps:"));
  const build = steps.slice(steps.indexOf("- name: release-build"), steps.indexOf("- name: release-image\n"));
  const publish = steps.slice(steps.indexOf("- name: release-publish"));
  assert.ok(!build.includes("from_secret"), "the build step never sees a secret");
  assert.deepEqual(
    [...rel.matchAll(/from_secret: (\S+)/g)].map((m) => m[1]),
    [WP_GHCR_SECRET, WP_RELEASE_SECRET],
    "two secrets: the image-push step reads the first, the publish step the second",
  );
  assert.match(publish, /depends_on: \[release-build, release-image-push\]/);
  const pubScript = stepScript(`${publish}\n\n`, "release-publish").split("\n");
  assert.deepEqual(pubScript.slice(1, 4), [
    "cd /tmp",
    'curl -fsSL "https://raw.githubusercontent.com/Tealbrick/opt2-tealbrick-platform/$TB_CI_REF/ci/tb-ci.ts" -o /tmp/tb-ci.ts',
    'echo "$TB_CI_SHA256  /tmp/tb-ci.ts" | sha256sum -c -',
  ]);
  assert.equal(pubScript[4], 'TB_OUT="$OUT" node /tmp/tb-ci.ts wp-publish', "a fresh runner outside the workspace; out/ is data");
  assert.equal(stepScript(build, "release-build").split("\n").at(-1), "node .tb-ci/tb-ci.ts wp-build");
  const runner = readFileSync(new URL("./tb-ci.ts", import.meta.url), "utf8");
  const imports = runner.match(/^import .* from "([^"]+)";$/gm) ?? [];
  assert.ok(imports.length > 0 && imports.every((l) => /from "node:/.test(l)), "the runner imports node: built-ins only (nothing from the workspace)");
});

test("ci-v9.10 C222: wp-build refuses tokens and non-main manual runs; wp-publish refuses to run inside the workspace", () => {
  const work = mkdtempSync(join(tmpdir(), "tb-wp-"));
  try {
    const runner = new URL("./tb-ci.ts", import.meta.url).pathname;
    const run = (cmd: string, env: Record<string, string>, cwd = work) => {
      try {
        execFileSync(process.execPath, [runner, cmd], { cwd, env: { PATH: process.env.PATH ?? "", CI_WORKSPACE: work, ...env }, stdio: "pipe" });
        return { code: 0, out: "" };
      } catch (e) {
        const x = e as { status: number; stderr: Buffer };
        return { code: x.status, out: x.stderr.toString() };
      }
    };
    const tok = run("wp-build", { GITHUB_TOKEN: "x", CI_PIPELINE_EVENT: "tag" });
    assert.notEqual(tok.code, 0);
    assert.match(tok.out, /wp-build must run without GITHUB_TOKEN/);
    const branch = run("wp-build", { CI_PIPELINE_EVENT: "manual", CI_COMMIT_BRANCH: "dev", TB_RELEASE_TAG: "relay-v0.1.0" });
    assert.match(branch.out, /main only/);
    const inside = run("wp-publish", { TB_OUT: join(work, ".tb-ci/out"), GITHUB_TOKEN: "x", CI_REPO_NAME: "opt2-tealbrick-cli" });
    assert.match(inside.out, /outside the workspace/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("ci-v9.10 C222: the Actions release refuses a repo that releases on Woodpecker", () => {
  const runner = readFileSync(new URL("./tb-ci.ts", import.meta.url), "utf8");
  const build = runner.slice(runner.indexOf("async function cmdGhBuild"), runner.indexOf("async function cmdGhPublish"));
  assert.match(build, /cfg\.releaseOn === "woodpecker" && !wpBuildActive/);
});

// ---------- ci-v9.11 (C232): image releases on Woodpecker ----------

interface WpStep {
  name: string;
  image: string;
  dependsOn: string[];
  secrets: string[];
  commands: string[];
}

/** Parses the `steps:` list of a template (the layout the templates use: 2-space `- name:`, anchors on `image:`). */
function wpSteps(yaml: string): WpStep[] {
  const body = yaml.slice(yaml.indexOf("\nsteps:\n") + "\nsteps:\n".length);
  const anchors = new Map<string, string>();
  const steps: WpStep[] = [];
  for (const block of body.split(/\n(?= {2}- name: )/)) {
    const name = /^ {2}- name: (\S+)/.exec(block)?.[1];
    if (!name) continue;
    const imageRaw = /^ {4}image: (.+)$/m.exec(block)?.[1] ?? "";
    const def = /^&(\S+) (\S+)$/.exec(imageRaw);
    const ref = /^\*(\S+)$/.exec(imageRaw);
    if (def) anchors.set(def[1] as string, def[2] as string);
    const image = def ? (def[2] as string) : ref ? (anchors.get(ref[1] as string) as string) : imageRaw;
    const dep = /^ {4}depends_on: \[(.*)\]$/m.exec(block)?.[1];
    const cmdBlock = block.includes("    commands:\n") ? block.slice(block.indexOf("    commands:\n") + "    commands:\n".length) : "";
    steps.push({
      name,
      image,
      dependsOn: dep ? dep.split(",").map((x) => x.trim()) : [],
      secrets: [...block.matchAll(/from_secret: (\S+)/g)].map((m) => m[1] as string),
      commands: cmdBlock
        .split("\n")
        .filter((l) => /^ {6}- /.test(l))
        .map((l) => l.replace(/^ {6}- /, "")),
    });
  }
  return steps;
}

test("ci-v9.11 C232 template: step graph, secrets per step, no secret in any step that runs repo code", () => {
  const rel = readFileSync(new URL("./woodpecker/release.yaml", import.meta.url), "utf8");
  const ci = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  const steps = wpSteps(rel);
  assert.deepEqual(
    steps.map((s) => [s.name, s.dependsOn, s.secrets]),
    [
      ["release-build", [], []],
      ["release-image", ["release-build"], []],
      ["release-image-push", ["release-image"], [WP_GHCR_SECRET]],
      ["release-publish", ["release-build", "release-image-push"], [WP_RELEASE_SECRET]],
    ],
    "graph and secrets per step",
  );
  const by = (n: string) => steps.find((s) => s.name === n) as WpStep;
  // release-image uses the SAME pinned kaniko image as the ci workflow's image-check, and the ci workflow is unchanged in that step
  const kaniko = /image: &kaniko (\S+)/.exec(ci)?.[1];
  assert.match(kaniko ?? "", /^gcr\.io\/kaniko-project\/executor:v[\d.]+-debug@sha256:[0-9a-f]{64}$/);
  assert.equal(by("release-image").image, kaniko);
  assert.deepEqual(by("release-image").commands, [`sh ${WP_IMAGE_SCRIPT}`]);
  assert.equal(wpSteps(ci).find((s) => s.name === "image-check")?.image, kaniko);
  // steps that execute anything from the workspace are repo-code steps: no secret in them, nor a token variable in their env
  const runsWorkspaceCode = (s: WpStep) =>
    s.commands.some(
      (c) => /(^|\s)(node|sh|bash|npm|pnpm|corepack|\.\/)\s*\.?\/?\.tb-ci\//.test(c) || /\.tb-ci\/tb-ci\.ts/.test(c.replace(/\/tmp\/tb-ci\.ts/, "")),
    );
  const repoCode = steps.filter(runsWorkspaceCode).map((s) => s.name);
  assert.deepEqual(repoCode, ["release-build", "release-image"]);
  for (const s of steps.filter(runsWorkspaceCode)) assert.deepEqual(s.secrets, [], `${s.name} runs repo code: no secret`);
  // the two secret steps run NO repo code: the first thing that executes is a hash-checked file under /tmp, started after cd /tmp
  for (const n of ["release-image-push", "release-publish"]) {
    const cmds = by(n).commands;
    const cd = cmds.indexOf("cd /tmp");
    const first = cmds.findIndex((c) => /^(\S+=\S+ )?node /.test(c));
    assert.ok(cd >= 0 && first > cd, `${n}: cd /tmp before the runner`);
    assert.match(cmds[first] as string, /node \/tmp\/tb-ci\.ts wp-(push|publish)$/);
    assert.ok(cmds.includes('echo "$TB_CI_SHA256  /tmp/tb-ci.ts" | sha256sum -c -'), `${n}: runner sha256 checked`);
    assert.ok(cmds.indexOf('echo "$TB_CI_SHA256  /tmp/tb-ci.ts" | sha256sum -c -') < first, `${n}: sha256 checked before the runner starts`);
    assert.ok(!cmds.some((c) => /\.tb-ci\/tb-ci\.ts|npm |pnpm |corepack|git |sh \.tb-ci/.test(c)), `${n}: nothing from the workspace is executed`);
    assert.ok(!cmds.some((c) => /TOKEN|echo \$|printenv|\benv\b/.test(c.replace("TB_CI_SHA256", ""))), `${n}: no command prints or names a token`);
  }
  assert.deepEqual(by("release-image-push").commands, [
    "set +x",
    'OUT="$CI_WORKSPACE/.tb-ci/out"',
    "cd /tmp",
    'curl -fsSL "https://raw.githubusercontent.com/Tealbrick/opt2-tealbrick-platform/$TB_CI_REF/ci/tb-ci.ts" -o /tmp/tb-ci.ts',
    'echo "$TB_CI_SHA256  /tmp/tb-ci.ts" | sha256sum -c -',
    'TB_OUT="$OUT" node /tmp/tb-ci.ts wp-push',
  ]);
  // the secret reaches the step as GHCR_TOKEN (the runner refuses GITHUB_TOKEN there and GHCR_TOKEN in wp-publish)
  assert.match(rel, /GHCR_TOKEN:\n {8}from_secret: tb_ghcr_token\n/);
  assert.match(rel, /GITHUB_TOKEN:\n {8}from_secret: tb_release_token\n/);
  // same template id and runner sha256 everywhere
  const sha = /TB_CI_SHA256: "([0-9a-f]{64})"/.exec(ci)?.[1];
  for (const m of rel.matchAll(/TB_CI_REF: (\S+)/g)) assert.equal(m[1], "ci-v9.16");
  for (const m of rel.matchAll(/TB_CI_SHA256: "([^"]*)"/g)) assert.equal(m[1], sha);
  const actions = readFileSync(new URL("./github/opt2-release.yml", import.meta.url), "utf8");
  assert.match(actions, /TB_CI_REF: ci-v9\.16/);
  assert.match(ci, /TB_CI_REF: ci-v9\.16/);
  assert.equal(readFileSync(new URL("./MIN_TEMPLATE", import.meta.url), "utf8").trim(), "ci-v9.9", "MIN_TEMPLATE is not raised by this change");
});

test("ci-v9.11 C232: crane is pinned by version and sha256 inside the runner (the same bytes as the release's checksums.txt)", () => {
  assert.match(CRANE_VERSION, /^v\d+\.\d+\.\d+$/);
  assert.equal(CRANE_URL, `https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_Linux_x86_64.tar.gz`);
  assert.match(CRANE_SHA256, /^[0-9a-f]{64}$/);
  const src = readFileSync(new URL("./tb-ci.ts", import.meta.url), "utf8");
  const push = src.slice(src.indexOf("async function cmdWpPush"), src.indexOf("function cmdPlanImages"));
  assert.ok(push.indexOf("!== CRANE_SHA256") > push.indexOf("await fetch(CRANE_URL)"), "the download is checked");
  assert.ok(push.indexOf("!== CRANE_SHA256") < push.indexOf('execFileSync("tar"'), "the bytes are checked before they are unpacked");
});

test("ci-v9.11 C232: the kaniko script builds each image from the tag without pushing (labels, platform, tarball path)", () => {
  const commit = sha40("a");
  const images = validateConfig(
    {
      kind: "bridge",
      releaseOn: "woodpecker",
      images: [
        { name: "opt2-tealbrick-bridge-server", product: "bridge", kind: "bridge", context: ".", dockerfile: "server/Dockerfile" },
        { name: "opt2-tealbrick-bridge-tool", product: "tool", kind: "portal", context: "tool" },
      ],
    },
    "opt2-tealbrick-bridge",
  ).images;
  assert.equal(images.length, 2);
  const script = renderReleaseImagesScript(images, "Tealbrick/opt2-tealbrick-bridge", "0.1.32", commit);
  const lines = script.split("\n").filter((l) => l.startsWith("/kaniko/executor"));
  assert.equal(lines.length, images.length);
  for (const [i, l] of lines.entries()) {
    const im = images[i] as { name: string; context: string; dockerfile: string };
    assert.ok(l.startsWith("/kaniko/executor --no-push "), "never pushes");
    assert.ok(!/--cache|--insecure|--registry|docker login|config\.json/.test(l), "no registry or credential flag");
    assert.ok(l.includes(`--destination ghcr.io/tealbrick/${im.name}:0.1.32`));
    assert.ok(l.includes(`--custom-platform ${KANIKO_PLATFORM}`) && KANIKO_PLATFORM === "linux/amd64");
    assert.ok(l.includes(`--label org.opencontainers.image.revision=${commit}`));
    assert.ok(l.includes("--label org.opencontainers.image.source=https://github.com/Tealbrick/opt2-tealbrick-bridge"));
    assert.ok(l.includes("--label org.opencontainers.image.version=0.1.32"));
    assert.ok(l.includes(`--tar-path "$CI_WORKSPACE/.tb-ci/out/${im.name}.tar"`));
    assert.ok(l.includes(`--context "$CI_WORKSPACE/${im.context}"`) && l.includes(`--dockerfile "$CI_WORKSPACE/${im.dockerfile}"`));
  }
  assert.match(script, /^set -eu$/m);
  // sh accepts it
  const dir = mkdtempSync(join(tmpdir(), "tb-img-"));
  try {
    writeFileSync(join(dir, "s.sh"), script);
    execFileSync("sh", ["-n", join(dir, "s.sh")]);
    writeFileSync(join(dir, "n.sh"), renderReleaseImagesScript([], "Tealbrick/x", "", commit));
    assert.match(execFileSync("sh", [join(dir, "n.sh")], { encoding: "utf8" }), /no images for this tag/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // fire on bad input: nothing odd reaches the shell
  assert.throws(() => renderReleaseImagesScript(images, "Tealbrick/x", "0.1.0", "abc"), /bad commit/);
  assert.throws(() => renderReleaseImagesScript(images, "Tealbrick/x", "0.1.0; rm -rf /", commit), /bad version/);
  assert.throws(() => renderReleaseImagesScript(images, "x y/z", "0.1.0", commit), /bad repo/);
  assert.throws(
    () => renderReleaseImagesScript([{ ...(images[0] as object), name: "a b" }] as typeof images, "Tealbrick/x", "0.1.0", commit),
    /bad image name/,
  );
  const odd = renderReleaseImagesScript([{ ...(images[0] as object), context: 'a"$(id)`b' }] as typeof images, "Tealbrick/x", "0.1.0", commit);
  assert.ok(odd.includes('--context "$CI_WORKSPACE/a\\"\\$(id)\\`b"'), "context is escaped inside the double quotes");
});

/** A `docker save` style tarball like kaniko --tar-path writes: manifest.json -> config entry (named sha256:<hex>) -> layer. */
function makeImageTar(dir: string, name: string, labels: Record<string, string>): string {
  const src = join(dir, `src-${name}`);
  mkdirSync(src, { recursive: true });
  const cfg = JSON.stringify({ architecture: "amd64", os: "linux", config: { Labels: labels } });
  const cfgName = `sha256:${createHash("sha256").update(cfg).digest("hex")}`;
  writeFileSync(join(src, cfgName), cfg);
  writeFileSync(join(src, "layer.tar.gz"), "layer");
  writeFileSync(join(src, "manifest.json"), JSON.stringify([{ Config: cfgName, RepoTags: [`ghcr.io/tealbrick/${name}:0.1.0`], Layers: ["layer.tar.gz"] }]));
  const tarPath = join(dir, `${name}.tar`);
  execFileSync("tar", ["-cf", tarPath, "-C", src, cfgName, "layer.tar.gz", "manifest.json"]);
  return tarPath;
}
const tarReader = (tarPath: string) => (member: string) => execFileSync("tar", ["-xOf", tarPath, member]);

test("ci-v9.11 C232: image tarball labels are read from the tarball and must carry the tag commit and this repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-lbl-"));
  try {
    const commit = sha40("c");
    const good = { "org.opencontainers.image.revision": commit, "org.opencontainers.image.source": "https://github.com/Tealbrick/opt2-tealbrick-bridge" };
    const tar = makeImageTar(dir, "good", good);
    assert.deepEqual(labelsFromImageTar(tarReader(tar)), good);
    assert.deepEqual(imageLabelProblems(good, "Tealbrick/opt2-tealbrick-bridge", commit), []);
    assert.match(imageLabelProblems(good, "Tealbrick/opt2-tealbrick-bridge", sha40("d")).join(), /revision label/);
    assert.match(imageLabelProblems(good, "Tealbrick/other", commit).join(), /source label/);
    assert.equal(imageLabelProblems({}, "Tealbrick/x", commit).length, 2, "an unlabelled image is refused");
    assert.deepEqual(labelsFromImageTar(tarReader(makeImageTar(dir, "none", {}))), {});
    // two images in one tarball, or a config path that climbs out: refused
    assert.throws(() => labelsFromImageTar(() => Buffer.from("[{},{}]")), /exactly one image/);
    assert.throws(() => labelsFromImageTar(() => Buffer.from('[{"Config":"../../etc/passwd"}]')), /plain config entry/);
    assert.throws(() => labelsFromImageTar(() => Buffer.from('[{"Config":"-xvf"}]')), /plain config entry/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** An in-memory registry behind the crane CLI contract the runner relies on (digest [--tarball], push). */
function fakeCrane(
  registry: Map<string, string>,
  tarDigests: Map<string, string>,
  o: { lookupError?: string; pushStores?: string; pushFails?: boolean } = {},
): { run: CraneRun; calls: string[][] } {
  const calls: string[][] = [];
  const run: CraneRun = (args) => {
    calls.push(args);
    const ok = (stdout: string) => ({ code: 0, stdout: `${stdout}\n`, stderr: "" });
    if (args[0] === "digest" && args[1] === "--tarball") {
      const d = tarDigests.get(args[2] as string);
      return d ? ok(d) : { code: 1, stdout: "", stderr: "Error: no such tarball\n" };
    }
    if (args[0] === "digest") {
      if (o.lookupError) return { code: 1, stdout: "", stderr: o.lookupError };
      const d = registry.get(args[1] as string);
      return d ? ok(d) : { code: 1, stdout: "", stderr: `Error: GET https://ghcr.io/v2/x: MANIFEST_UNKNOWN: manifest unknown; map[Tag:${args[1]}]\n` };
    }
    if (args[0] === "push") {
      if (o.pushFails) return { code: 1, stdout: "", stderr: "Error: PUT: UNAUTHORIZED: authentication required\n" };
      registry.set(args[2] as string, o.pushStores ?? (tarDigests.get(args[1] as string) as string));
      return ok(`${args[2]}@digest`);
    }
    return { code: 2, stdout: "", stderr: `unexpected ${args.join(" ")}\n` };
  };
  return { run, calls };
}
const dgst = (c: string) => `sha256:${c.repeat(64)}`;

test("ci-v9.11 C232: push step pushes a new tag, writes the digest, and never overwrites a tag with another digest", () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-push-"));
  try {
    const ns = "ghcr.io/tealbrick";
    const images = [{ name: "opt2-tealbrick-bridge-server", tar: "opt2-tealbrick-bridge-server.tar" }];
    const ref = `${ns}/opt2-tealbrick-bridge-server:0.1.32`;
    const tarPath = join(dir, images[0]?.tar as string);
    const digestFile = join(dir, "opt2-tealbrick-bridge-server.digest");
    const base = { out: dir, images, ns, version: "0.1.32" };
    // good: a new tag is pushed once and the digest file names the pushed bytes
    {
      const reg = new Map<string, string>();
      const f = fakeCrane(reg, new Map([[tarPath, dgst("a")]]));
      const lines = pushImages({ ...base, crane: f.run });
      assert.deepEqual(
        f.calls.filter((c) => c[0] === "push"),
        [["push", tarPath, ref]],
      );
      assert.equal(reg.get(ref), dgst("a"));
      assert.equal(readFileSync(digestFile, "utf8"), `${dgst("a")}\n`);
      assert.match(lines.join(), /pushed sha256:a{64}/);
      // retry of the same build: same digest = skipped, no second push
      const again = fakeCrane(reg, new Map([[tarPath, dgst("a")]]));
      assert.match(pushImages({ ...base, crane: again.run }).join(), /already published with the same digest/);
      assert.equal(again.calls.filter((c) => c[0] === "push").length, 0);
    }
    // bad: the tag exists with ANOTHER digest -> alarm, no push, no digest file
    {
      rmSync(digestFile, { force: true });
      const reg = new Map([[ref, dgst("b")]]);
      const f = fakeCrane(reg, new Map([[tarPath, dgst("a")]]));
      assert.throws(() => pushImages({ ...base, crane: f.run }), /ALARM: .*already points to sha256:b{64}.*never overwritten/);
      assert.equal(f.calls.filter((c) => c[0] === "push").length, 0, "nothing was pushed");
      assert.ok(!existsSync(digestFile), "no digest file for a refused push");
      assert.equal(reg.get(ref), dgst("b"), "the registry is unchanged");
    }
    // bad: the lookup fails for another reason than 'not found' (401/403/5xx) -> fail closed, no push
    for (const err of [
      "Error: GET: UNAUTHORIZED: authentication required\n",
      "Error: GET: DENIED: requested access to the resource is denied\n",
      "Error: dial tcp: i/o timeout\n",
    ]) {
      const f = fakeCrane(new Map(), new Map([[tarPath, dgst("a")]]), { lookupError: err });
      assert.throws(() => pushImages({ ...base, crane: f.run }), /cannot tell whether the tag exists/);
      assert.equal(f.calls.filter((c) => c[0] === "push").length, 0);
    }
    // bad: the registry reads back another digest than the tarball -> alarm; a failed push -> error, no digest file
    {
      const f = fakeCrane(new Map(), new Map([[tarPath, dgst("a")]]), { pushStores: dgst("e") });
      assert.throws(() => pushImages({ ...base, crane: f.run }), /ALARM: .*reads back as sha256:e{64}/);
      assert.ok(!existsSync(digestFile));
      const g = fakeCrane(new Map(), new Map([[tarPath, dgst("a")]]), { pushFails: true });
      assert.throws(() => pushImages({ ...base, crane: g.run }), /push failed/);
      assert.ok(!existsSync(digestFile));
    }
    // bad: an unreadable tarball
    assert.throws(() => pushImages({ ...base, crane: fakeCrane(new Map(), new Map()).run }), /cannot read the digest/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(ghcrPushDecision(null, dgst("a")), "push");
  assert.equal(ghcrPushDecision(dgst("a"), dgst("a")), "same");
  assert.equal(ghcrPushDecision(dgst("b"), dgst("a")), "conflict");
  assert.ok(craneAbsent("Error: GET https://ghcr.io/v2/tealbrick/x/manifests/1: MANIFEST_UNKNOWN: manifest unknown"));
  assert.ok(craneAbsent("Error: GET https://ghcr.io/v2/x: NAME_UNKNOWN: repository name not known"));
  assert.ok(craneAbsent("2026/10/17 HEAD request failed\nError: GET https://ghcr.io/v2/x/manifests/1: unexpected status code 404 Not Found"));
  for (const no of [
    "Error: UNAUTHORIZED",
    "Error: DENIED",
    "unexpected status code 503",
    "unexpected status code 401 Unauthorized",
    "dial tcp: lookup ghcr.io: no such host",
    "",
  ])
    assert.ok(!craneAbsent(no), `not proof of absence: ${no}`);
});

test("ci-v9.11 C232: release-candidate.json = the signer's own document, with the pushed digests (read from the digest files)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-cand-"));
  try {
    const bridge = "opt2-tealbrick-bridge";
    const cfg = validateConfig(
      {
        kind: "bridge",
        releaseOn: "woodpecker",
        images: [{ name: `${bridge}-server`, product: "bridge", kind: "bridge", dockerfile: "server/Dockerfile", upgradeFrom: ">=0.1.0" }],
      },
      bridge,
    );
    const plan = { images: [{ name: `${bridge}-server`, tar: `${bridge}-server.tar`, version: "0.1.32" }] };
    writeFileSync(join(dir, `${bridge}-server.digest`), `${dgst("f")}\n`);
    const doc = await wpCandidateDoc(cfg, bridge, "v0.1.32", sha40("1"), plan, dir);
    assert.deepEqual(doc, {
      schema: "opt2.release-candidate/v1",
      repo: `Tealbrick/${bridge}`,
      tag: "v0.1.32",
      commit: sha40("1"),
      candidates: [
        {
          product: "bridge",
          kind: "bridge",
          version: "0.1.32",
          image: `ghcr.io/tealbrick/${bridge}-server@${dgst("f")}`,
          services: [],
          manifest: null,
          runtimeFile: "server/bridge-runtime.json",
          upgradeFrom: ">=0.1.0",
        },
      ],
    });
    assert.equal(CANDIDATE_ASSET, "release-candidate.json");
    // the same document the signer builds from ghcr (one function)
    const viaGhcr = await buildCandidateDoc(cfg, bridge, "v0.1.32", sha40("1"), async (n) => `ghcr.io/tealbrick/${n}@${dgst("f")}`);
    assert.deepEqual(viaGhcr, doc);
    // fire on bad: plan and config disagree, a digest file is missing or not a digest
    await assert.rejects(wpCandidateDoc(cfg, bridge, "v0.1.32", sha40("1"), { images: [] }, dir), /plan images \[\] != tealbrick-ci\.json images/);
    rmSync(join(dir, `${bridge}-server.digest`));
    await assert.rejects(wpCandidateDoc(cfg, bridge, "v0.1.32", sha40("1"), plan, dir), /no digest for image/);
    writeFileSync(join(dir, `${bridge}-server.digest`), "latest\n");
    await assert.rejects(wpCandidateDoc(cfg, bridge, "v0.1.32", sha40("1"), plan, dir), /not a sha256 digest/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const src = readFileSync(new URL("./tb-ci.ts", import.meta.url), "utf8");
  assert.ok(src.includes("return buildCandidateDoc(cfg, repo, tag, commit, (name) => ghcrFind(name, version));"), "the signer uses the shared builder");
  const pub = src.slice(src.indexOf("async function cmdWpPublish"), src.indexOf("// ---------- Woodpecker image releases"));
  assert.ok(pub.includes("publishAssetOnce(full, rel, CANDIDATE_ASSET"), "attached once, never replaced");
  assert.ok(pub.includes("tealbrick-ci.json?ref=${target.commit}"), "the declared images come from the config at the tag commit on GitHub");
  assert.ok(!pub.includes("putAsset") && !pub.includes('"DELETE"'));
});

test("ci-v9.11 C232: the token stays out of argv, logs, the workspace and the other steps' runner paths", () => {
  const src = readFileSync(new URL("./tb-ci.ts", import.meta.url), "utf8");
  const push = src.slice(src.indexOf("async function cmdWpPush"), src.indexOf("function cmdPlanImages"));
  assert.ok(push.includes('"--password-stdin"], token)'), "login reads the token from crane's stdin");
  assert.equal([...push.matchAll(/\btoken\b/g)].length, 4, "token: the null check, the guard line and the stdin use only");
  assert.ok(!push.includes("${token}") && !/console\./.test(push), "the token value is never interpolated into a log or error line");
  assert.ok(
    push.includes("mkdtempSync(join(tmpdir()") && /finally \{\s*rmSync\(tmp, \{ recursive: true, force: true \}\);/.test(push),
    "docker config + binary live in /tmp and are removed",
  );
  assert.ok(push.includes("DOCKER_CONFIG: cfgDir") && push.includes("HOME: tmp"), "the child env holds no secret and points at the temp config");
  assert.ok(!push.includes("TB_OUT") || !/writeFileSync\(join\(out[^)]*token/.test(push));
  // the two tokens never meet in one step: each command refuses the other's variable
  assert.ok(push.includes('["GITHUB_TOKEN", "GH_TOKEN"]'), "wp-push refuses the release token variables");
  const pub = src.slice(src.indexOf("async function cmdWpPublish"), src.indexOf("// ---------- Woodpecker image releases"));
  assert.ok(pub.includes("process.env.GHCR_TOKEN"), "wp-publish refuses the ghcr token variable");
  const build = src.slice(src.indexOf("async function cmdWpBuild"), src.indexOf("async function ghBytes"));
  assert.ok(build.includes("GHCR_TOKEN"), "wp-build refuses it too");
});

/** Runs the runner binary like a Woodpecker step does (env cleared, cwd outside the workspace unless told otherwise). */
function runRunner(cmd: string, env: Record<string, string>, cwd: string): { code: number; out: string; err: string } {
  const runner = new URL("./tb-ci.ts", import.meta.url).pathname;
  try {
    const out = execFileSync(process.execPath, [runner, cmd], { cwd, env: { PATH: process.env.PATH ?? "", ...env }, stdio: "pipe" });
    return { code: 0, out: out.toString(), err: "" };
  } catch (e) {
    const x = e as { status: number; stdout: Buffer; stderr: Buffer };
    return { code: x.status, out: x.stdout.toString(), err: x.stderr.toString() };
  }
}

test("ci-v9.11 C232: wp-build on a tag with images records the plan, runs no docker and leaves the kaniko script", () => {
  const work = mkdtempSync(join(tmpdir(), "tb-wpb-"));
  try {
    const bridge = "opt2-tealbrick-bridge";
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: work, stdio: "pipe" });
    g("init", "-q", "-b", "main");
    writeFileSync(
      join(work, "tealbrick-ci.json"),
      JSON.stringify({
        kind: "bridge",
        releaseOn: "woodpecker",
        images: [{ name: `${bridge}-server`, product: "bridge", kind: "bridge", dockerfile: "server/Dockerfile" }],
      }),
    );
    mkdirSync(join(work, "server"));
    writeFileSync(join(work, "server/Dockerfile"), "FROM scratch\n");
    g("add", ".");
    g("commit", "-q", "-m", "x");
    g("tag", "v0.1.32");
    const commit = g("rev-parse", "HEAD").toString().trim();
    const env = { CI_WORKSPACE: work, CI_REPO_NAME: bridge, CI_PIPELINE_EVENT: "tag", CI_COMMIT_TAG: "v0.1.32", CI_COMMIT_SHA: commit };
    // docker must not be needed: a fake docker on PATH records any call (the Woodpecker node image has none)
    const fakeBin = join(work, "..", `fakebin-${Date.now()}`);
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "docker"), `#!/bin/sh\necho "$@" >> "${fakeBin}/docker-called"\nexit 1\n`);
    chmodSync(join(fakeBin, "docker"), 0o755);
    const path = `${fakeBin}:/usr/bin:/bin`;
    const r = runRunner("wp-build", { ...env, PATH: path }, work);
    assert.equal(r.code, 0, r.err);
    assert.ok(!existsSync(join(fakeBin, "docker-called")), "wp-build never calls docker");
    rmSync(fakeBin, { recursive: true, force: true });
    const plan = JSON.parse(readFileSync(join(work, ".tb-ci/out/plan.json"), "utf8"));
    assert.deepEqual(plan.images, [{ name: `${bridge}-server`, tar: `${bridge}-server.tar`, version: "0.1.32" }]);
    assert.deepEqual(plan.assets, []);
    const script = readFileSync(join(work, WP_IMAGE_SCRIPT), "utf8");
    assert.ok(script.includes(`--label org.opencontainers.image.revision=${commit}`));
    assert.ok(script.includes(`--tar-path "$CI_WORKSPACE/.tb-ci/out/${bridge}-server.tar"`));
    assert.ok(script.includes(`--destination ghcr.io/tealbrick/${bridge}-server:0.1.32`));
    assert.ok(script.includes(`--dockerfile "$CI_WORKSPACE/server/Dockerfile"`));
    // fire on bad: a token in the build step
    const tok = runRunner("wp-build", { ...env, GHCR_TOKEN: "x", PATH: "/usr/bin:/bin" }, work);
    assert.match(tok.err, /wp-build must run without GHCR_TOKEN/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("ci-v9.11 C232: wp-push checks the plan and the tarball labels before it touches the network, and refuses the wrong environment", () => {
  const work = mkdtempSync(join(tmpdir(), "tb-wpp-"));
  const tmpCwd = mkdtempSync(join(tmpdir(), "tb-cwd-"));
  try {
    const bridge = "opt2-tealbrick-bridge";
    const out = join(work, ".tb-ci/out");
    mkdirSync(out, { recursive: true });
    const commit = sha40("2");
    const name = `${bridge}-server`;
    const planOf = (images: unknown[], over: Record<string, string> = {}) =>
      writeFileSync(
        join(out, "plan.json"),
        JSON.stringify({ schema: "opt2.gh-release-plan/v1", repo: bridge, tag: "v0.1.32", commit, images, assets: [], ...over }),
      );
    const env = {
      CI_WORKSPACE: work,
      CI_REPO_NAME: bridge,
      CI_PIPELINE_EVENT: "tag",
      CI_COMMIT_TAG: "v0.1.32",
      CI_COMMIT_SHA: commit,
      TB_OUT: out,
      GHCR_TOKEN: "t",
      HOME: tmpCwd,
    };
    const img = { name, tar: `${name}.tar`, version: "0.1.32" };
    // no images: nothing to do, no token needed, exit 0 (also for package tags)
    planOf([]);
    const none = runRunner("wp-push", { ...env, GHCR_TOKEN: "" }, tmpCwd);
    assert.equal(none.code, 0, none.err);
    assert.match(none.out, /no images/);
    // refusals
    planOf([img]);
    assert.match(runRunner("wp-push", { ...env, GITHUB_TOKEN: "x" }, tmpCwd).err, /must run without GITHUB_TOKEN/);
    assert.match(runRunner("wp-push", env, work).err, /outside the workspace/);
    assert.match(runRunner("wp-push", { ...env, GHCR_TOKEN: "" }, tmpCwd).err, /needs the secret tb_ghcr_token/);
    assert.match(runRunner("wp-push", { ...env, CI_COMMIT_SHA: sha40("3") }, tmpCwd).err, /does not match this run/);
    planOf([img], { commit: sha40("9") });
    assert.match(runRunner("wp-push", env, tmpCwd).err, /does not match this run|points at/);
    planOf([{ ...img, name: "opt2-tealbrick-portal-core-server", tar: "opt2-tealbrick-portal-core-server.tar" }]);
    assert.match(runRunner("wp-push", env, tmpCwd).err, /does not belong to/);
    planOf([{ ...img, tar: "../../etc/passwd" }]);
    assert.match(runRunner("wp-push", env, tmpCwd).err, /unexpected plan entry/);
    planOf([img]);
    assert.match(runRunner("wp-push", env, tmpCwd).err, /did not write a regular file/);
    // labels of the tarball: wrong commit -> refused before any download or login
    makeImageTar(out, name, { "org.opencontainers.image.revision": sha40("4"), "org.opencontainers.image.source": `https://github.com/Tealbrick/${bridge}` });
    const bad = runRunner("wp-push", env, tmpCwd);
    assert.notEqual(bad.code, 0);
    assert.match(bad.err, /revision label .* != .*\(nothing was pushed\)/);
    assert.ok(!existsSync(join(out, `${name}.digest`)));
    // a symlink instead of a file is refused too
    rmSync(join(out, `${name}.tar`));
    execFileSync("ln", ["-s", "/etc/hosts", join(out, `${name}.tar`)]);
    assert.match(runRunner("wp-push", env, tmpCwd).err, /did not write a regular file/);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  }
});

test("ci-v9.11 C232: woodpecker-activate keeps tb_ghcr_token (and the bridge's tb_release_token) with events tag+manual and no image filter", () => {
  const src = readFileSync(new URL("../ops/woodpecker-activate.ts", import.meta.url), "utf8");
  const keep = src.slice(src.indexOf("const KEEP: Keep[] = ["), src.indexOf("];", src.indexOf("const KEEP: Keep[] = [")));
  assert.ok(keep.includes('{ repo: "opt2-tealbrick-bridge", name: "tb_ghcr_token", events: ["manual", "tag"] }'));
  assert.ok(keep.includes('{ repo: "opt2-tealbrick-bridge", name: "tb_release_token", events: ["manual", "tag"] }'), "the bridge publish secret is kept too");
  assert.ok(keep.includes('{ repo: "opt2-tealbrick-cli", name: "tb_release_token", events: ["manual", "tag"] }'), "the cli entry is unchanged");
  assert.ok(keep.includes(WP_GHCR_SECRET));
  // the loop keeps listed names, warns on a wrong event filter or an image filter, and never reads or sends a value
  assert.ok(src.includes("(sec.images ?? []).length === 0"), "no plugin/image filter");
  assert.ok(src.includes("if (keep.some((k) => k.name === sec.name)) continue;"), "a kept secret is never deleted");
  assert.ok(!/sec\.value|\.value\b/.test(src.slice(src.indexOf("for (const k of keep)"), src.indexOf("for (const w of want)"))), "the value is never read");
  // every other secret is still deleted
  assert.ok(src.includes('"deleted (not needed here)"') || src.includes("deleted (not needed here)"));
});

// ---------- ci-v9.14 (C262): OSV vulnerability scan ----------

const OSV_DIGEST = /^ghcr\.io\/google\/osv-scanner:v2\.6\.0@sha256:[0-9a-f]{64}$/;

/** One vulnerability in the shape osv-scanner v2.6.0 writes (`--format json`; read from a real run on lodash/minimist/semver). */
interface OsvFix {
  id: string;
  pkg?: string;
  version?: string;
  score?: string; // group max_severity
  label?: string; // database_specific.severity
  aliases?: string[];
  fixed?: string[];
}
function osvReport(fixes: OsvFix[], source = "/w/pnpm-lock.yaml"): unknown {
  const byPkg = new Map<string, OsvFix[]>();
  for (const f of fixes)
    byPkg.set(`${f.pkg ?? "left-pad"}@${f.version ?? "1.0.0"}`, [...(byPkg.get(`${f.pkg ?? "left-pad"}@${f.version ?? "1.0.0"}`) ?? []), f]);
  return {
    results: [
      {
        source: { path: source, type: "lockfile" },
        packages: [...byPkg].map(([key, vs]) => {
          const [name, version] = key.split("@") as [string, string];
          return {
            package: { name, version, ecosystem: "npm" },
            groups: vs.map((f) => ({ ids: [f.id], aliases: [...(f.aliases ?? []), f.id], ...(f.score === undefined ? {} : { max_severity: f.score }) })),
            vulnerabilities: vs.map((f) => ({
              id: f.id,
              aliases: f.aliases ?? [],
              summary: "x",
              severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
              database_specific: f.label === undefined ? {} : { severity: f.label },
              affected: [
                {
                  package: { name, ecosystem: "npm" },
                  ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, ...(f.fixed ?? []).map((x) => ({ fixed: x }))] }],
                },
              ],
            })),
          };
        }),
      },
    ],
    experimental_config: { licenses: { summary: false, allowlist: null } },
  };
}
const TODAY = "2026-10-18";
const plusDays = (n: number): string => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const verdictOf = (fixes: OsvFix[], ignores: unknown[] = []) => osvVerdict(parseOsvReport(osvReport(fixes)), parseOsvIgnore(ignores), TODAY);
const ign = (id: string, expires: string, reason = "dev-only dependency, not reachable") => ({ id, reason, expires });

test("ci-v9.14 osv-check: severity thresholds (HIGH >= 7.0, CRITICAL >= 9.0; MEDIUM and LOW print only; unknown counts as HIGH)", () => {
  assert.equal(osvSeverityOf(9.0), "CRITICAL");
  assert.equal(osvSeverityOf(8.9), "HIGH");
  assert.equal(osvSeverityOf(7.0), "HIGH");
  assert.equal(osvSeverityOf(6.9), "MEDIUM");
  assert.equal(osvSeverityOf(4.0), "MEDIUM");
  assert.equal(osvSeverityOf(3.9), "LOW");
  assert.equal(osvSeverityOf(null), "UNKNOWN");
  const high = verdictOf([{ id: "GHSA-aaaa-bbbb-cccc", score: "7.5", pkg: "semver", version: "5.7.1", fixed: ["5.7.2", "6.3.1", "7.5.2", "1.0.0"] }]);
  assert.deepEqual(
    high.blocking.map((f) => [f.id, f.severity, f.score]),
    [["GHSA-aaaa-bbbb-cccc", "HIGH", 7.5]],
  );
  assert.deepEqual(high.blocking[0]?.fixed, ["5.7.2", "6.3.1", "7.5.2"], "only fixed versions above the installed one, ascending");
  assert.equal(verdictOf([{ id: "GHSA-aaaa-bbbb-cccc", score: "9.8" }]).blocking[0]?.severity, "CRITICAL");
  const mild = verdictOf([
    { id: "GHSA-1111-1111-1111", score: "6.9" },
    { id: "GHSA-2222-2222-2222", score: "2.0", label: "LOW" },
  ]);
  assert.equal(mild.blocking.length, 0, "MEDIUM and LOW do not fail");
  assert.equal(mild.info.length, 2, "they are printed");
  // the advisory label counts when it is higher than the score (fail closed); the score counts when the label is missing
  assert.equal(verdictOf([{ id: "GHSA-aaaa-bbbb-cccc", score: "5.3", label: "HIGH" }]).blocking.length, 1);
  assert.equal(verdictOf([{ id: "GHSA-aaaa-bbbb-cccc", label: "CRITICAL" }]).blocking[0]?.severity, "CRITICAL");
  assert.equal(verdictOf([{ id: "GHSA-aaaa-bbbb-cccc", label: "MODERATE" }]).blocking.length, 0);
});

test("ci-v9.14 osv-check: unknown severity fails closed (no score, no label, or a 0.0 score without a label)", () => {
  for (const f of [
    { id: "GHSA-aaaa-bbbb-cccc" },
    { id: "GHSA-aaaa-bbbb-cccc", score: "0.0" },
    { id: "GHSA-aaaa-bbbb-cccc", score: "" },
    { id: "GHSA-aaaa-bbbb-cccc", label: "WEIRD" },
  ]) {
    const v = verdictOf([f]);
    assert.equal(v.blocking.length, 1, JSON.stringify(f));
    assert.equal(v.blocking[0]?.severity, "UNKNOWN");
  }
  assert.match(osvTable(verdictOf([{ id: "GHSA-aaaa-bbbb-cccc" }])), /UNKNOWN \(counts as HIGH\)/);
});

test("ci-v9.14 osv-check: a report that is not in the osv-scanner shape is refused (a format change never reads as clean)", () => {
  assert.throws(() => parseOsvReport(null), /must be an object/);
  assert.throws(() => parseOsvReport({}), /"results" is missing/);
  assert.throws(() => parseOsvReport({ results: [{ source: { path: "x" } }] }), /packages is missing/);
  assert.throws(() => parseOsvReport({ results: [{ packages: [{ package: { name: "a" }, vulnerabilities: [] }] }] }), /name and version/);
  assert.throws(() => parseOsvReport({ results: [{ packages: [{ package: { name: "a", version: "1.0.0" }, vulnerabilities: [{}] }] }] }), /has no id/);
  assert.deepEqual(parseOsvReport({ results: [] }), [], "an empty result list is a clean scan");
});

test("ci-v9.14 osv-check: the table lists id, package@version, severity, fixed version; blocking rows first", () => {
  const v = verdictOf([
    { id: "GHSA-mmmm-mmmm-mmmm", score: "5.0", pkg: "b", version: "2.0.0" },
    { id: "GHSA-cccc-cccc-cccc", score: "9.8", pkg: "minimist", version: "1.2.0", fixed: ["1.2.6"] },
  ]);
  const lines = osvTable(v).split("\n");
  assert.match(lines[0] as string, /^ID +PACKAGE@VERSION +SEVERITY +FIXED IN +STATUS$/);
  assert.match(lines[1] as string, /^GHSA-cccc-cccc-cccc +minimist@1\.2\.0 +CRITICAL 9\.8 +1\.2\.6 +FAIL$/);
  assert.match(lines[2] as string, /^GHSA-mmmm-mmmm-mmmm +b@2\.0\.0 +MEDIUM 5\.0 +- +info$/);
});

test("ci-v9.14 osvIgnore: a valid entry covers a HIGH finding (by id or by alias, case-insensitive) and it is printed as ignored", () => {
  const f = { id: "GHSA-aaaa-bbbb-cccc", score: "7.5", aliases: ["CVE-2026-1234"] };
  for (const id of ["GHSA-aaaa-bbbb-cccc", "ghsa-AAAA-bbbb-cccc", "CVE-2026-1234"]) {
    const v = verdictOf([f], [ign(id, plusDays(30))]);
    assert.equal(v.blocking.length, 0, id);
    assert.equal(v.ignored.length, 1);
    assert.deepEqual(v.problems, []);
    assert.deepEqual(v.stale, []);
    assert.match(osvTable(v), /ignored until /);
  }
  assert.equal(verdictOf([f], [ign("GHSA-zzzz-zzzz-zzzz", plusDays(30))]).blocking.length, 1, "another id does not cover it");
});

test("ci-v9.14 osvIgnore: expired and more-than-90-days entries fail and do not cover the finding; the boundaries", () => {
  const f = { id: "GHSA-aaaa-bbbb-cccc", score: "9.0" };
  const expired = verdictOf([f], [ign("GHSA-aaaa-bbbb-cccc", plusDays(-1))]);
  assert.equal(expired.problems.length, 1);
  assert.match(expired.problems[0] as string, /expired on /);
  assert.equal(expired.blocking.length, 1, "an expired entry no longer covers the finding");
  assert.equal(osvIgnoreProblems([ign("GHSA-aaaa-bbbb-cccc", TODAY)], TODAY).length, 1, "expires is the first day it no longer applies");
  assert.deepEqual(osvIgnoreProblems([ign("GHSA-aaaa-bbbb-cccc", plusDays(1))], TODAY), []);
  assert.deepEqual(osvIgnoreProblems([ign("GHSA-aaaa-bbbb-cccc", plusDays(OSV_IGNORE_MAX_DAYS))], TODAY), [], "exactly 90 days is allowed");
  const far = verdictOf([f], [ign("GHSA-aaaa-bbbb-cccc", plusDays(OSV_IGNORE_MAX_DAYS + 1))]);
  assert.equal(far.problems.length, 1);
  assert.match(far.problems[0] as string, /more than 90 days/);
  assert.match(far.problems[0] as string, new RegExp(plusDays(OSV_IGNORE_MAX_DAYS)), "tells the latest allowed date");
  assert.equal(far.blocking.length, 1);
  // an expired entry for a finding that is gone still fails (the repo must clean it up or renew it)
  assert.equal(verdictOf([], [ign("GHSA-aaaa-bbbb-cccc", plusDays(-5))]).problems.length, 1);
});

test("ci-v9.14 osvIgnore: an entry that matches nothing is stale (warning, not a failure); LOW/MEDIUM matches are not stale", () => {
  const v = verdictOf([{ id: "GHSA-1111-1111-1111", score: "5.0" }], [ign("GHSA-zzzz-zzzz-zzzz", plusDays(30)), ign("GHSA-1111-1111-1111", plusDays(30))]);
  assert.deepEqual(
    v.stale.map((x) => x.id),
    ["GHSA-zzzz-zzzz-zzzz"],
  );
  assert.deepEqual(v.problems, []);
  assert.equal(v.blocking.length, 0);
});

test("ci-v9.14 osvIgnore: config parsing (shape only; unknown keys, short reasons, bad dates, duplicates refused) and the schema agrees", () => {
  const base = { kind: "library", paths: ["."] };
  assert.deepEqual(validateConfig(base, repo).osvIgnore, [], "absent = no ignores");
  const ok = ign("GHSA-aaaa-bbbb-cccc", "2026-12-01");
  assert.deepEqual(validateConfig({ ...base, osvIgnore: [ok] }, repo).osvIgnore, [ok]);
  assert.throws(() => validateConfig({ ...base, osvIgnore: ok }, repo), /must be a list/);
  assert.throws(() => parseOsvIgnore([{ ...ok, extra: 1 }]), /unknown field extra/);
  assert.throws(() => parseOsvIgnore([{ id: ok.id, expires: ok.expires }]), /reason/);
  assert.throws(() => parseOsvIgnore([{ ...ok, reason: "too short" }]), /at least 10/);
  assert.throws(() => parseOsvIgnore([{ ...ok, reason: "          " }]), /at least 10/);
  assert.throws(() => parseOsvIgnore([{ ...ok, id: "nonsense" }]), /vulnerability id/);
  assert.throws(() => parseOsvIgnore([{ ...ok, expires: "2026-02-30" }]), /calendar date/);
  assert.throws(() => parseOsvIgnore([{ ...ok, expires: "01.12.2026" }]), /calendar date/);
  assert.throws(() => parseOsvIgnore([{ id: ok.id, reason: ok.reason }]), /calendar date/);
  assert.throws(() => parseOsvIgnore([ok, { ...ok, id: "ghsa-aaaa-bbbb-cccc" }]), /twice/);
  assert.throws(() => parseOsvIgnore("GHSA-aaaa-bbbb-cccc"), /must be a list/);
  // the schema accepts and refuses the same things (no JSON Schema library here: check its constraints directly)
  const schema = JSON.parse(readFileSync(new URL("./tealbrick-ci.schema.json", import.meta.url), "utf8")) as {
    properties: Record<
      string,
      { items: { additionalProperties: boolean; required: string[]; properties: Record<string, { pattern?: string; minLength?: number }> } }
    >;
  };
  const item = schema.properties.osvIgnore?.items;
  assert.ok(item, "schema has osvIgnore");
  assert.equal(item.additionalProperties, false, "unknown keys refused");
  assert.deepEqual([...item.required].sort(), ["expires", "id", "reason"]);
  const idRe = new RegExp(item.properties.id?.pattern as string);
  const dayRe = new RegExp(item.properties.expires?.pattern as string);
  assert.equal(item.properties.reason?.minLength, 10);
  for (const id of ["GHSA-aaaa-bbbb-cccc", "CVE-2026-12345", "OSV-2026-123"]) assert.ok(idRe.test(id), id);
  for (const id of ["nonsense", "", "GHSA-"]) assert.ok(!idRe.test(id), id);
  assert.ok(dayRe.test("2026-12-01"));
  for (const d of ["01.12.2026", "2026-1-1", "2026-12-01T00:00"]) assert.ok(!dayRe.test(d), d);
});

test("ci-v9.14 osvLockfiles: the pnpm or npm lockfile of each node path (setup writes the list for the osv-scan step)", () => {
  const files = new Set(["package.json", "pnpm-lock.yaml", "chat/package.json", "chat/package-lock.json", "empty/package.json", "nolock/package.json"]);
  const has = (r: string): boolean => files.has(r);
  assert.deepEqual(osvLockfiles({ paths: ["."] }, has), ["pnpm-lock.yaml"]);
  assert.deepEqual(osvLockfiles({ paths: [".", "chat", "./chat", "gone", "nolock"] }, has), ["pnpm-lock.yaml", "chat/package-lock.json"]);
  assert.deepEqual(osvLockfiles({ paths: ["gone"] }, has), [], "no package.json = nothing to scan");
  assert.equal(OSV_LOCKFILES_FILE, ".tb-ci/osv-lockfiles");
  assert.equal(OSV_REPORT_FILE, ".tb-ci/osv.json");
  assert.equal(OSV_CONFIG_FILE, ".tb-ci/osv-scanner.toml");
});

test("ci-v9.14 osvLockfiles: a lockfile that clearly lists no package is not scanned (osv-scanner exit 128); anything unclear is", () => {
  const files: Record<string, string> = {
    "package.json": "{}",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n",
    "a/package.json": "{}",
    "a/pnpm-lock.yaml":
      "lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      x:\n        specifier: 1.0.0\n        version: 1.0.0\n\npackages:\n\n  x@1.0.0:\n    resolution: {integrity: sha512-x}\n",
    "b/package.json": "{}",
    "b/package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "b" } } }),
    "c/package.json": "{}",
    "c/package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/x": { version: "1.0.0" } } }),
    "d/package.json": "{}",
    "d/package-lock.json": "{ not json",
  };
  const has = (r: string): boolean => r in files;
  const read = (r: string): string => files[r] as string;
  assert.deepEqual(osvLockfiles({ paths: [".", "a", "b", "c", "d"] }, has, read), ["a/pnpm-lock.yaml", "c/package-lock.json", "d/package-lock.json"]);
  assert.deepEqual(osvLockfiles({ paths: ["."] }, has), ["pnpm-lock.yaml"], "without read: listed as before");
  assert.equal(osvLockfileEmpty("pnpm-lock.yaml", "lockfileVersion: '9.0'\npackages: {}\n"), true);
  assert.equal(osvLockfileEmpty("pnpm-lock.yaml", "lockfileVersion: '9.0'\npackages:\n  x@1.0.0: {}\n"), false);
  assert.equal(osvLockfileEmpty("package-lock.json", JSON.stringify({ lockfileVersion: 1, dependencies: {} })), false, "v1 npm lockfile: not judged, scanned");
  assert.equal(osvLockfileEmpty("package-lock.json", JSON.stringify({ lockfileVersion: 2, packages: { "": {} }, dependencies: { x: {} } })), false);
  assert.equal(osvLockfileEmpty("yarn.lock", ""), false);
  // re-review S2: only positive evidence counts as empty; every other layout of a lockfile WITH packages is scanned
  const pkg = "  x@1.0.0:\n    resolution: {integrity: sha512-x}\n";
  for (const text of [
    `  lockfileVersion: '9.0'\n  packages:\n  ${pkg}`, // whole document indented
    `lockfileVersion: '9.0'\n"packages":\n${pkg}`, // quoted key
    `lockfileVersion: '9.0'\npackages :\n${pkg}`, // space before the colon
    "{lockfileVersion: '9.0', packages: {x@1.0.0: {resolution: {integrity: sha512-x}}}}\n", // flow style
    `lockfileVersion: '9.0'\r\npackages:\r\n${pkg.replace(/\n/g, "\r\n")}`, // CRLF
    `lockfileVersion: '9.0'\npackages: # comment\n${pkg}`,
    `lockfileVersion: '9.0'\npackages: {}\n---\npackages:\n${pkg}`, // a second document
  ])
    assert.equal(osvLockfileEmpty("pnpm-lock.yaml", text), false, JSON.stringify(text));
  assert.equal(osvLockfileEmpty("pnpm-lock.yaml", "lockfileVersion: '9.0'\r\npackages: {} # none\r\n"), true, "CRLF + comment, positive evidence");
});

test("ci-v9.15: the broken ci-v9.14 template is denied in setup and in the template audit, whatever MIN_TEMPLATE says", () => {
  assert.ok(DENIED_TEMPLATES["ci-v9.14"], "ci-v9.14 is denied");
  assert.equal(auditVerdict("opt2-tealbrick-sdk", 200, "anonymous", "ci-v9.14", "ci-v9.9"), "FAIL");
  assert.equal(auditVerdict("opt2-tealbrick-sdk", 200, "anonymous", "ci-v9.15", "ci-v9.9"), "OK");
  assert.equal(auditVerdict("opt2-tealbrick-sdk", 200, "anonymous", "ci-v9.13", "ci-v9.9"), "OK");
  const src = readFileSync(new URL("./tb-ci.ts", import.meta.url), "utf8");
  assert.match(src, /if \(DENIED_TEMPLATES\[ref\]\) fail\(/, "setup refuses a denied template");
  const tpl = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  assert.ok(!DENIED_TEMPLATES[/TB_CI_REF: (\S+)/.exec(tpl)?.[1] ?? ""], "the current template is not denied");
});

test("ci-v9.15 templates are valid YAML for Woodpecker: no unquoted list item contains ': ' or ' #' (ci-v9.14 broke on that)", () => {
  for (const f of ["woodpecker/ci.yaml", "woodpecker/release.yaml"]) {
    const lines = readFileSync(new URL(`./${f}`, import.meta.url), "utf8").split("\n");
    lines.forEach((l, i) => {
      const m = /^\s*- (.*)$/.exec(l);
      if (!m) return;
      const v = m[1] as string;
      if (/^['"[{&*]/.test(v)) return; // quoted or flow scalar, anchor or alias
      if (/^[A-Za-z_][\w-]*:( |$)/.test(v)) return; // a map item such as "- name: x"
      assert.ok(
        !v.includes(": ") && !v.includes(" #") && !v.endsWith(":"),
        `${f}:${i + 1}: a plain YAML scalar cannot hold ': ' or ' #' (quote the item): ${v}`,
      );
    });
  }
});

test("ci-v9.14 template: osv-scan after setup beside install, image pinned by digest, no secret; osv-check judges the report; pre-release waits", () => {
  const tpl = readFileSync(new URL("./woodpecker/ci.yaml", import.meta.url), "utf8");
  const g = templateGraph(tpl);
  assert.deepEqual(g.get("osv-scan")?.deps, ["setup"], "needs the runner's lockfile list from setup");
  assert.deepEqual(g.get("install")?.deps, ["setup"], "runs beside install");
  assert.deepEqual(g.get("osv-check")?.deps, ["osv-scan"]);
  assert.deepEqual(g.get("pre-release")?.deps, ["gen", "osv-check"]);
  for (const name of ["osv-scan", "osv-check"]) {
    const block = tpl.slice(tpl.indexOf(`- name: ${name}\n`)).split("\n\n")[0] as string;
    assert.doesNotMatch(block, /from_secret/, `${name}: holds no secret`);
    assert.doesNotMatch(block, /TOKEN|PASSWORD|SECRET/i, `${name}: no credential variable`);
    assert.doesNotMatch(block, /detach:/);
  }
  const scan = tpl.slice(tpl.indexOf("- name: osv-scan\n")).split("\n\n")[0] as string;
  const image = /image: (\S+)/.exec(scan)?.[1] ?? "";
  assert.match(image, OSV_DIGEST, "osv-scanner v2.6.0 (not v2.7.0, too new) pinned by digest");
  assert.doesNotMatch(scan, /environment:/, "the scan step gets no environment at all");
  const script = stepScript(tpl, "osv-scan");
  assert.match(script, /\/osv-scanner scan source /);
  assert.ok(script.includes("--format json --output-file .tb-ci/osv.json"));
  assert.ok(script.includes(OSV_LOCKFILES_FILE), "scans the lockfiles setup listed");
  assert.ok(script.includes('-L "./$f"'));
  // review S2: osv-scanner reads osv-scanner.toml next to a lockfile by default; a repo file would bypass osvIgnore's policy
  assert.ok(script.includes(`--config ${OSV_CONFIG_FILE}`), "the scan passes the template-owned config");
  assert.ok(
    script.indexOf(`> ${OSV_CONFIG_FILE}`) >= 0 && script.indexOf(`> ${OSV_CONFIG_FILE}`) < script.indexOf("/osv-scanner scan"),
    "the step writes that config itself, before the scan",
  );
  assert.doesNotMatch(script, /IgnoredVulns|ignoreUntil/, "the template config ignores nothing");
  assert.match(
    script,
    /"\$rc" -ne 0 \] && \[ "\$rc" -ne 1 \]; then .*exit 1/,
    "only exit 0 (clean) and 1 (vulnerabilities found) pass; osv.dev unreachable is exit 127",
  );
  assert.match(script, /osv\.dev unreachable/);
  assert.equal(stepScript(tpl, "osv-check"), "node .tb-ci/tb-ci.ts osv-check .tb-ci/osv.json");
  // the id and the runner hash are the same in every generated file
  for (const f of ["woodpecker/ci.yaml", "woodpecker/release.yaml", "github/opt2-release.yml"])
    assert.match(readFileSync(new URL(`./${f}`, import.meta.url), "utf8"), /ci-v9\.16/, f);
  assert.equal(readFileSync(new URL("./MIN_TEMPLATE", import.meta.url), "utf8").trim(), "ci-v9.9", "MIN_TEMPLATE is not raised by this change");
  const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  assert.match(readme, /^ci-v9\.14 \(C262\)/m, "template history entry");
  assert.ok(readme.includes(image), "the README names the same pinned image");
});

/** Runs `tb-ci osv-check` in a throw-away repo with a lockfile, the config and a report. No network. */
function runOsvCheck(report: unknown | null, config: Record<string, unknown>, lock = true): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "tb-osv-"));
  try {
    writeFileSync(join(dir, "tealbrick-ci.json"), JSON.stringify(config));
    writeFileSync(join(dir, "package.json"), "{}");
    if (lock) writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\npackages:\n\n  x@1.0.0:\n    resolution: {integrity: sha512-x}\n");
    mkdirSync(join(dir, ".tb-ci"));
    if (report !== null) writeFileSync(join(dir, OSV_REPORT_FILE), typeof report === "string" ? report : JSON.stringify(report));
    const env: NodeJS.ProcessEnv = { ...process.env, CI_WORKSPACE: dir, CI_REPO_NAME: repo };
    try {
      const out = execFileSync(process.execPath, [new URL("./tb-ci.ts", import.meta.url).pathname, "osv-check", OSV_REPORT_FILE], {
        env,
        encoding: "utf8",
        stdio: "pipe",
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("ci-v9.14 osv-check command: HIGH and CRITICAL fail, MEDIUM passes, unknown fails, a valid ignore passes", () => {
  const cfg = { kind: "library" };
  const today = new Date().toISOString().slice(0, 10);
  const inDays = (n: number): string => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const clean = runOsvCheck({ results: [] }, cfg);
  assert.equal(clean.code, 0, clean.out);
  const high = runOsvCheck(osvReport([{ id: "GHSA-aaaa-bbbb-cccc", score: "7.2", pkg: "lodash", version: "4.17.15", fixed: ["4.17.21"] }]), cfg);
  assert.equal(high.code, 1);
  assert.match(high.out, /GHSA-aaaa-bbbb-cccc +lodash@4\.17\.15 +HIGH 7\.2 +4\.17\.21 +FAIL/);
  assert.equal(runOsvCheck(osvReport([{ id: "GHSA-aaaa-bbbb-cccc", score: "9.8" }]), cfg).code, 1);
  const mid = runOsvCheck(osvReport([{ id: "GHSA-aaaa-bbbb-cccc", score: "5.3" }]), cfg);
  assert.equal(mid.code, 0, mid.out);
  assert.match(mid.out, /MEDIUM 5\.3/);
  assert.equal(runOsvCheck(osvReport([{ id: "GHSA-aaaa-bbbb-cccc" }]), cfg).code, 1, "unknown severity");
  const high1 = osvReport([{ id: "GHSA-aaaa-bbbb-cccc", score: "8.0" }]);
  const ignored = runOsvCheck(high1, { ...cfg, osvIgnore: [ign("GHSA-aaaa-bbbb-cccc", inDays(30))] });
  assert.equal(ignored.code, 0, ignored.out);
  assert.match(ignored.out, /ignored until /);
  const expired = runOsvCheck(high1, { ...cfg, osvIgnore: [ign("GHSA-aaaa-bbbb-cccc", inDays(-1))] });
  assert.equal(expired.code, 1);
  assert.match(expired.out, /expired on /);
  const far = runOsvCheck(high1, { ...cfg, osvIgnore: [ign("GHSA-aaaa-bbbb-cccc", inDays(91))] });
  assert.equal(far.code, 1);
  assert.match(far.out, /more than 90 days/);
  const stale = runOsvCheck({ results: [] }, { ...cfg, osvIgnore: [ign("GHSA-zzzz-zzzz-zzzz", inDays(30))] });
  assert.equal(stale.code, 0, stale.out);
  assert.match(stale.out, /WARNING: osvIgnore GHSA-zzzz-zzzz-zzzz matches no vulnerability/);
  const unknownKey = runOsvCheck({ results: [] }, { ...cfg, osvIgnore: [{ ...ign("GHSA-aaaa-bbbb-cccc", inDays(30)), note: "x" }] });
  assert.equal(unknownKey.code, 1);
  assert.match(unknownKey.out, /unknown field note/);
});

test("ci-v9.14 osv-check command: fails closed on a missing, empty or foreign report; a repo without a node lockfile has nothing to scan", () => {
  const cfg = { kind: "library" };
  const missing = runOsvCheck(null, cfg);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /did not write its report/);
  assert.equal(runOsvCheck("", cfg).code, 1, "empty file");
  assert.equal(runOsvCheck("not json", cfg).code, 1);
  assert.equal(runOsvCheck({ error: "boom" }, cfg).code, 1, "no results list");
  const none = runOsvCheck(null, cfg, false);
  assert.equal(none.code, 0, none.out);
  assert.match(none.out, /nothing was scanned/);
});
