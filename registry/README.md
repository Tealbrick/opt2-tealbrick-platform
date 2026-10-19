# opt2 release registry

The release index tells Portal Core what it can deploy (apps, the bridge) and what it sells (offers), and it is TBD's update feed (desktop entries, C24).

## Files and URLs
| What | Repo path | Public URL |
|---|---|---|
| Index body | `registry/index.json` | `https://github.com/Tealbrick/opt2-tealbrick-platform/releases/download/registry/index.json` (also raw on `main`) |
| Signed envelope | `registry/index.jws` | `https://github.com/Tealbrick/opt2-tealbrick-platform/releases/download/registry/index.jws` |
| Offers (reviewed input) | `registry/offers.json` | change by PR only; the next publish carries them |
| Harness options (reviewed input, C40) | `registry/harnesses.json` | change by PR only; the next publish carries them |
| Public signing key | `registry/keys.json` (JWKS, Ed25519) | `https://github.com/Tealbrick/opt2-tealbrick-platform/releases/download/registry/keys.json` (re-uploaded with every publish; D12/C30) and raw on `main`; Core pins it in config (`RELEASE_INDEX_PUBLIC_JWKS`) |

C206 org move: the repo moved from `Martin-Atrin` to `Tealbrick`. The old URLs redirect (release downloads 301, raw served); clients should use the Tealbrick URLs. Entries signed before the move keep `repo: Martin-Atrin/…` and images in `ghcr.io/martin-atrin` (history is never rewritten); `products.json` `formerRepos` binds those to the same product.

Caching: raw.githubusercontent.com serves `main` with up to ~5 min CDN lag, and release-asset downloads can also lag briefly after a publish. Core should poll the release-asset URLs and accept that a new release can take up to ~5 min to appear (the signature check makes a stale copy harmless, never wrong). Supersession: releases are never edited or withdrawn in place; Core deploys the newest version on the workspace's channel (a later version supersedes an earlier one by semver).

## Trust rule
Core (and TBD) accept the index only if `index.jws` verifies with the pinned key and `claims.indexDigest == digest(index.json body)`.
All crypto and canonical JSON come from `@opt2-tealbrick/manifest` (`verifyJws`, `digest`), never a local copy (CORE §3).
- Signed by `signReleaseIndex(body, {iat}, key)`; JWS compact, `alg EdDSA`, `kid` = RFC 7638 thumbprint, `typ tb-release-index+jws` (spec 0.1.2 `TYP.releaseIndex`).
- Claims: `{iss: "tb:releases", aud: "tb:portal", iat, exp (iat + 180 d), schema: "opt2.release-index/v2", indexDigest, releases, offers}` (counts).
- The JWS signs a digest, not the body, so the envelope stays far below `MAX_JWS_BYTES` however many releases exist.
- The envelope expires after 180 days. Every publish signs a fresh one, and `registry-sync` re-publishes when less than 30 days remain (`expiring` in `cmdRegistrySync`), so no separate schedule is needed while the workflow runs (`ci/README.md` § "Index expiry and renewal"); `registry-sign` re-signs by hand. An expired envelope = no new releases accepted; existing Core rows stay.

**Signed since 2026-10-11 ~20:20 Bangkok (C30).** Core verifies with `verifyReleaseIndex(jws, body, { now, keys: keySetFrom(jwks, "tb:releases") })` from `@opt2-tealbrick/manifest` ≥ 0.1.0 and rejects an unsigned index. Every publish self-verifies before it commits. Unsigned mode (`TB_REGISTRY_UNSIGNED=1`) is retired.

## Body (`opt2.release-index/v2`)
```json
{
  "schema": "opt2.release-index/v2",
  "generatedAt": "2026-10-11T12:00:00.000Z",
  "releases": [{
    "id": "rel_01M4...", "product": "knowledge", "kind": "app", "version": "0.1.0", "channel": "stable",
    "manifestDigest": "sha256:<hex of JCS(manifest)>", "manifestUrl": "https://github.com/.../releases/download/v0.1.0/tealbrick.manifest.json",
    "skillsDigest": "sha256:<digest of the skills archive>",
    "image": "ghcr.io/tealbrick/opt2-tealbrick-knowledge@sha256:<hex>", "artifact": null, "source": null,
    "minOs": null, "notarized": null, "upgradeFrom": "*",
    "repo": "Tealbrick/opt2-tealbrick-knowledge", "commit": "<sha>", "tag": "v0.1.0", "publishedAt": "..."
  }],
  "harnesses": [{ "id": "claude-desktop", "kind": "desktop", "label": "Claude Desktop", "icon": null, "authorise": "instruction_set", "noAgentPath": false,
                  "instructions": [{ "title": "Add a custom connector", "detail": "...", "copy": { "kind": "url", "value": "{{mcpUrl}}" } }] }],
  "offers": [{
    "id": "off_01M4...", "kind": "single", "name": "Knowledge", "products": ["knowledge"], "major": 0,
    "amount": 9900, "currency": "usd", "taxNote": "...", "stripePrice": { "test": "price_...", "live": null }
  }]
}
```
- `kind`: `app` | `bridge` | `desktop` (PORTAL-API `Release`). `channel`: `stable` (plain semver) | `dev` (any prerelease).
- `kind` `cli` (C174, for the C173 one-line installer and `tealbrick self-update`; Core skips it, readers skip kinds they do not know, L24): product `cli`, from the PRIVATE repo `opt2-tealbrick-cli`, tag `cli-v<ver>`. Only `artifact` is set: `{url, sha256: "sha256:<hex>", integrity: "sha512-<base64>"}`; `url` is always `<dist base>/opt2-tealbrick-cli-cli-v<ver>/opt2-tealbrick-cli-<ver>.tgz` on a platform dist host (`DIST_BASES`; never a private GitHub URL); `image`, `source`, `runtime`, `services`, `manifest*`, `skillsDigest`, `minOs`, `notarized` are `null`; `commit` = the tag commit. registry-sync downloads the tarball and its `.sha256` / `.integrity` assets from the private release with `TB_PRIVATE_READ_TOKEN` (C164, `registry` environment secret), hashes the bytes itself, and checks the packed `package.json` is `@opt2-tealbrick/cli@<ver>` with a `tealbrick` bin. Without the token the cli source is PENDING: the run stays green and no cli entry appears. The dist mirror (C164) publishes the file at `url` after the sync and verifies it against this entry.
- Apps with companion services (manifest `runtime.services[]`): one release covers the app and all its services. With `source`, Core builds the app from `source.dockerfile` and every service from its manifest `services[].build.dockerfile`, all at the SAME `source.ref` (images bake the manifest). With `image`, CI publishes one image per service and the app entry carries `services: [{id, image}]` (each `ghcr.io/tealbrick/<repo>-<service>@sha256:…` for releases from the org; records signed before the move keep `ghcr.io/martin-atrin/…`, which stays); Core deploys those instead of building. `services` is `null` on source records, bridge and desktop entries.
- Exactly one of `image` (pinned by digest), `source` (C29 interim, dev only: `{repo, ref: <commit sha>, dockerfile, context?}` — both repo-relative; `context` is the build root, absent = `.`; for apps it equals the manifest `runtime.build` (checked); Core builds with Railway root directory = `context`), `artifact` (desktop: `{url, sha256}` of the notarized download, plus `minOs`, `notarized`).
- `runtime` (kind `bridge` only; `null` elsewhere, apps use their manifest `runtime`): `{port (public), internalPort (private network), healthPath (liveness), readyPath (ready after enrolment), volumes: [{mountPath, backup}], env: [{name, source: portal | provider-secret | public-url | public-url-keys | fixed, value? (fixed only)}]}`. Core's deploy recipe: `provider-secret` = Railway `${{secret(43, "<base64url alphabet>")}}` (ops/KEYS.md), `portal` = values Core issues (Portal URL, one-time K6 code), `public-url` = the service's public domain, `public-url-keys` = the second public domain for the key page (C59, from bridge 0.1.11), `backup: true` = `volumeInstanceBackupScheduleUpdate(kinds: [DAILY, WEEKLY])` (C28/S7). CI bridge releases read it from `bridge-runtime.json` next to the bridge Dockerfile; source records from `registry/inputs/`.
- A stable release always has `image`. Releases are immutable: `(product, version, channel)` never changes content (a dev source build and the later stable image of the same version are two releases).
- Free fixture offers: `amount: 0` with `stripePrice: {test: null, live: null}` is allowed ONLY for a single offer of a `DEV_ONLY_PRODUCTS` product (validateOffers refuses anything else). Core makes it available only in test mode and only when the verified index marks the product devOnly; `checkout.create` then grants the licence at once (no Stripe session), only for a dev-channel workspace. Today: sample-pay, sample-mismatch.
- `devOnly: true` (C113, optional; absent = false): the signer stamps it on every NEW release of a product in `DEV_ONLY_PRODUCTS` (`ci/tb-ci.ts`; test fixtures such as the samples), and such a release has channel `dev`. A stamp on an OLDER record stays when its product leaves the list (signed records are never rewritten): fleet left with C278 (ci-v9.16), so its C208-era dev records keep the stamp. Promotion reads the current list, never the stamp; Core (portal-core#31) ends dev-only at the first stored stable release. Core never offers or deploys a devOnly product in a stable-channel workspace (dev fallback on or off) and reads the mark only from the verified index. One-off C113 edit (2026-10-13): the stable records `sample-gate@0.1.1` and `sample-caller@0.1.1` (signed before ci-v9.4) were RE-CLASSIFIED to dev, same ids and digests; the identical dev copies the ci-v9.4 sync had added for the same versions were folded into them. Covered by `indexDigest`.
- `harnesses` (C40, C40a, C43): harness options as DATA. Each entry = the frozen PORTAL-API `HarnessOption` (types/routes.ts) `{id, kind: desktop | agentic_system | other, label, icon (opt2 GitHub URL or null), authorise: device_approval | instruction_set | url, noAgentPath}` PLUS `instructions`: an InstructionSet-shaped step template `[{title, detail, copy?: {kind: command | json | url | text, value}}]`. Allowed placeholders (anything else fails validation): `{{mcpUrl}}`, `{{agentId}}` (Core fills them when it serves `agents.instructions`), `{{pairingCode}}` (the GUI fills it from `agents.pairing_code`). Array order = display order. Core syncs the rows into its Agent Registry; `harness.options` returns the HarnessOption fields, `agents.instructions` renders the template into `InstructionSet.steps`. Source: `registry/harnesses.json`, imported from the Bridge lead's connection assets (`opt2-tealbrick-bridge/packages/cli/assets/harnesses.json`, last import @af4fd5d; the `sort` field becomes array order); change by PR. Covered by `indexDigest`.
- Offers: $99 per app per major, no bundles (C29). `stripePrice.test` is used in opt2 (Stripe TEST); `live` stays null until cutover. Core verifies each price against Stripe at sync (active, one-time, amount, currency, tax behaviour, livemode).

## Writers (only these)
- The platform `registry-sync` GitHub Actions workflow (every 15 min + manual; environment `registry`, the only job with the signing key) from `v*` tags whose images the repo's `opt2-release` workflow pushed to ghcr; it re-derives every digest and checks provenance before signing (SEC-03, C72; see ci/README.md).
- `node ci/tb-ci.ts registry-add-source --product <id> --kind app|bridge --repo opt2-tealbrick-<x> --ref <sha> --dockerfile <path> [--context <dir>] --version <semver> [--manifest tealbrick.manifest.json | --runtime registry/inputs/bridge-runtime-<v>.json]` (C29 interim; always channel dev).
- `node ci/tb-ci.ts registry-add-desktop --product tbd --version <semver> --url <GitHub release asset | platform dist file> [--repo opt2-tealbrick-<name>, required for a dist URL] --sha256 <hex> [--min-os 14.0]` (TBD release Mac; downloads and checks the sha256 first). Dist hosts: `ci/README.md`, "Dist host for the assets of private repos".
- `node ci/tb-ci.ts registry-sign` (offers changed / re-sign).
Local runs need `GITHUB_TOKEN` in the environment (e.g. `GITHUB_TOKEN="$(gh auth token)"`, never echoed), `RELEASE_SIGNING_KEY_FILE`, and the manifest package (`TB_MANIFEST_PKG` release URL, or `TB_MANIFEST_MODULE` path to a built package).

## Key handling
Private key: GitHub Actions environment secret `RELEASE_SIGNING_KEY` (platform repo, environment `registry`, main only) and the owner's local key store (`~/.config/opt2-tealbrick/release-key.pem`, 0600). Never committed or printed.
Rotation: add the new public key to `keys.json`, re-sign with the new key, then remove the old key in a later change (Core accepts any key in its pinned JWKS).

## Portal Root Keys (C63 / BSD-08)
- `registry/portal-root-keys.dev.json`: the two PUBLIC JWKs (`root-a` primary, `root-b` backup) of the DEV Portal Root Keys: `{schema: "opt2.portal-root-keys/v1", channel: "dev", keys: [{kty, crv, x, kid (RFC 7638), alg: "EdDSA", use: "sig", tb_role}]}`. Specs pins them as release data in `@opt2-tealbrick/spec` for dev-channel builds.
- The dev private keys exist ONLY on the Platform operator machine (`~/.config/opt2-tealbrick/portal-root-{a,b}.key`, 0600), never on Railway, Core, CI or in a repo, never printed. Generated with `node ops/root-key.ts generate --channel dev --no-passphrase`.
- Production roots (`portal-root-keys.stable.json`) do not exist yet: they are generated at cutover in the offline ceremony with Martin (`ops/root-key.ts generate --channel stable`, passphrase per key, separate custody; leads/specs/BSD-08-DESIGN.md "Operations").
- The root-signed key-set statement (`portal-keyset.jws`, typ `tb-keyset+jws`) is added once Specs ships the typ in `@opt2-tealbrick/manifest`.

## Release guard and channels (C207 E1 + E4)
- **Release guard (E1).** registry-sync indexes a tag only if its commit is on `main` (or a `hotfix/*` branch), has a green
  Woodpecker push or tag status (`ci/woodpecker/push/ci` | `ci/woodpecker/tag/ci`), and — from 2026-10-25 (`PR_REQUIRED_FROM`) —
  came from a merged PR into `main`/`hotfix/*` (before that date: a WARN line). A refused tag makes the run red until it is
  either fixed by a new tag or listed in `registry/ignored-tags.json` (PR only: `{repo, tag, reason, decision}`). Private repos
  are read with `TB_PRIVATE_READ_TOKEN`, which needs Contents, Metadata, Commit statuses and Pull requests: read.
- **Channels (E4).** A new app or bridge tag is indexed on `dev` only, with its image. `stable` comes only from a recorded
  promotion in `registry/promotions.json` (PR only): `{product, version, devReleaseId, promotedAt, by, decision, evidence:
  {soakStart, soakEnd, workspace, qaRun, platform: {core, bridge}, upgradeTest?}, expedited?, incident?}`. registry-sync
  checks the dev record (image, not dev-only, no stable record of that version yet), the soak (app 24 h, bridge 48 h, from the
  dev publish time; `expedited` needs `incident: "INC-…"`) and emits a NEW stable record that copies the dev record (same
  image, manifest digest, services, runtime) with `promotedFrom: <dev id>`. mergeIndex refuses any other new stable app/bridge
  record. Records that were stable before E4 stay stable; cli/package keep the version rule; desktop is added by hand.
  Procedure: `coordination/practice/PROMOTE-STABLE.md` (operator) and the `promote-stable` skill.

