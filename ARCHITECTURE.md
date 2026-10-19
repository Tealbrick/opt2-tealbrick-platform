# Tealbrick platform: architecture

State: verified against the repo on 2026-10-17. Claims cite paths in this repo. Anything not verified is marked UNVERIFIED. For the whole system see the system `ARCHITECTURE.md` and `SYSTEM-OVERVIEW.md`.

## 1. CI standard (`ci/`)

Every repo's `.woodpecker/ci.yaml` is a byte-identical copy of `ci/woodpecker/ci.yaml`. The `setup` step fetches `tb-ci.ts` at the pinned tag, checks its sha256, and fails on template drift, an invalid `tealbrick-ci.json`, a package without `"private": true`, a missing required script, a missing lockfile, any Dockerfile `VOLUME`, or an unpinned install. `ci/MIN_TEMPLATE` (`ci-v9.9`) is the floor; the daily `template-audit` pipeline names repos below it (UNVERIFIED that the Woodpecker cron exists).

Kinds: `library`, `service`, `miniapp`, `bridge`, `portal`, `web`, `static`, `desktop`, `specs`, `tests`.

Stages: secret-scan, setup, install, osv-scan + osv-check (ci-v9.14, lockfile vulnerability scan), typecheck, lint, postgres (opt-in), unit, conformance, build, gen, pre-release, image-check (kaniko, never pushes), release-record (tag `v*`, no token). Woodpecker holds NO secrets.

Template history: ci-v9.1 opt-in Postgres; v9.3 explicit `depends_on`; v9.4 manifest 0.1.12 + spec 0.1.20 and `DEV_ONLY_PRODUCTS`; v9.5 `.integrity` assets; v9.6 `distBaseUrl`, `preReleaseChecks`; v9.7 `packScripts`; v9.8 (C206) owner-agnostic runner, `OWNER = Tealbrick`, `LEGACY_OWNERS = [Martin-Atrin]` accepted on reads only, uploads through the release's own `upload_url`, new images under `ghcr.io/<repo owner>`; v9.9 (C206 B6) manifest and spec pins may be dist-host URLs; v9.14 (C262) OSV scan steps and `osvIgnore`. Every repo is on ci-v9.9 and `MIN_TEMPLATE` is ci-v9.9.

`OPT2_REPOS` (21 repos), `PRIVATE_REPOS` (portal-core, bridge, cli, portal-gui, website, sdk, specs, packages, tbd, qa: repos that are or become private; on GitHub today cli, portal-core, portal-gui, website and qa are private, the others are still public; fleet left the list with its public flip, C249), `DIST_BASES` (the Tealbrick dist repo and `releases.tealbrick.com`), `DEV_ONLY_PRODUCTS` (the four samples and `fleet`) and `DIST_PRODUCTS` (kind `cli` or `package`: cli, relay, harness-claude, harness-eve, spec, manifest, miniapp-sdk, conformance, create-tealbrick-miniapp, ui, plus three legacy pre-split tarballs) are constants in `ci/tb-ci.ts`. Library tarballs live at `<dist base>/<source repo>-<release tag>/<file>`. `opt2-tealbrick-admin` and `opt2-tealbrick-dist` are not in `OPT2_REPOS`.

## 2. Release flow

Tag `v<x>` (or `<pkg>-v<x>`) in a product repo. The generated GitHub workflow has two jobs: `build` (read-only token; builds images and tarballs, pack guard) and `publish` (built-in `GITHUB_TOKEN`, no repo code; pushes `ghcr.io/<repo owner>/<image>:<version>` (new releases: `ghcr.io/tealbrick/...`; older ones stay under `ghcr.io/martin-atrin/...`) and attaches tarballs). Then `registry-sync` (every 15 minutes nominal, manual dispatch recommended) discovers the tag, resolves digests anonymously from GHCR (packages must be public), re-derives manifest, skills and runtime from the repo AT that commit, checks OCI labels, merges, signs, self-verifies, commits (fast-forward only, 5 retries) and uploads `index.json`, `index.jws`, `keys.json`, `portal-keyset.jws`. Core syncs every 60 seconds. Channel (only `stable` and `dev` exist): app and bridge tags always land on `dev`, and `stable` comes only from a recorded promotion (`registry/promotions.json`, by pull request). For cli and package tags a plain semver is `stable` and any `-` suffix is `dev`. Dev-only products are always `dev`. Releases are immutable.

## 3. Registry and trust

- Signing key: Ed25519, GitHub Actions environment `registry` (restricted to `main`), secret `RELEASE_SIGNING_KEY`. The public half is in `registry/keys.json`. The signer refuses a key not in `keys.json` and self-verifies.
- Envelope: `typ tb-release-index+jws`, claims `{iss tb:releases, aud tb:portal, iat, exp = iat + 180 days, schema, indexDigest, releases, offers}`. The signature covers a digest. Current envelope: issued 2026-10-16, expires 2027-04-14. `registry-sync` re-publishes (re-signs) when the envelope is under 30 days from expiry, or offers, harness options or owner rewrites change.
- `products.json` binds each product to its repo and kind (GTP-01). A release from another repo or kind is refused.
- Offers (`offers.json`, 10): Knowledge and Connect 9900 USD minor units; Rules, Inbox, Kanban, Evolution, Sample Gate and Sample Caller 100 (test prices); Sample Pay and Sample Mismatch amount 0. The Fleet offer was removed (C208). Eight carry a TEST Stripe price; the two free fixtures (amount 0) have none. `live` is null everywhere.
- Root keys: `portal-root-keys.dev.json` holds the PUBLIC dev roots. Both the dev Core statement and the live Core statement (seq 1) are signed by dev root-a (kid `xr8nlOuIDP8GqJOnDvBe6dIc2jwy2T83j2YqlPz6x7A`; recorded exception C187.3). Private dev roots exist only on the operator Mac and production roots do not exist (UNVERIFIED: operator machine, not visible from the repo).

## 4. Ops tools

- `railway-deploy.ts`: refuses an unpushed SHA; sets the service source to the repo; `serviceInstanceDeployV2` with the commit SHA. Default environment `production` (= DEV).
- `promote.ts`: validates a release set (`adminGui` optional), checks CI status (a manual Woodpecker run counts) and stable-with-digest releases, deploys core, admin-gui, gui, website in a fixed order with smoke checks on the public hosts (admin accepts the Cloudflare Access login), stops at the first failure, writes `RS-<n>.promoted.json`. Flags: `--dry-run`, `--environment live` (default; `production` refused), `--repoint` (redeploy every service from its current source; record `RS-<n>.repointed.json`), `--rollback` (re-promote an older set; app and bridge index problems become warnings). Does not deploy `status`, `db-backup`, Postgres, the bridge or apps.
- `prod-secrets.ts`: the owner's interactive script for live secrets (hidden prompts, validates before the first write, refuses `production`, never replaces an existing `TB_KEK`, `--dry-run`, `--only`).
- `root-key.ts`: generate, sign and verify root keys and key-set statements. The root key is read only inside the process.
- `woodpecker-activate.ts`: activate repos, set visibility, read each repo's current owner from GitHub and check the Woodpecker id. It deletes org-level Woodpecker secrets ONLY in the `Martin-Atrin` Woodpecker org, and deletes every repo-level Woodpecker secret on each opt2 repo (the wanted list is empty: Woodpecker holds no secrets). Never run org-wide cleanup in the `Tealbrick` org: it is shared with v1 repos (INCIDENT-1, C212).
- `db-backup`: Railway cron `17 19 * * *` UTC (as recorded in `ops/BACKUPS.md` and `ops/ENVIRONMENTS.md`; the live Railway setting is UNVERIFIED here). Canary row, `pg_dump -Fc`, restore into scratch database `tb_restore_test`, verify, drop, keep 14 dumps, heartbeat on success only. It creates schema `tb_ops` in the Core database; Core migrations must not touch it.
- `status`: public page and `/api/status`, 8 probes every 60 s: live portal, live API (`/api/v1/me` 401), live tealbrick.com and the release index, plus dev portal, API, Core health and the website preview (`ops/status/targets.json`). In-memory history.

## 5. Known gaps

1. Live trust anchor is a dev key (see section 3).
2. The status page keeps its history in memory only.
3. The index re-sign depends on `registry-sync` running (it re-publishes under 30 days from expiry).
4. `TB_PRIVATE_READ_TOKEN` is a long-lived fine-grained personal token. The docs say no personal token exists; that is not strictly true (UNVERIFIED: the token cannot be inspected from the repo).
5. Operator-machine files live outside the repo by design (`~/.config/opt2-tealbrick/{hosts.env, woodpecker-token, release-key.pem, portal-root-{a,b}.key, qa.env}`, Railway and `gh` logins). Only `hosts.env`, `woodpecker-token` and `portal-root-a.key` are named in `ops/` docs or scripts; `release-key.pem`, `portal-root-b.key` and `qa.env` are not named anywhere in the repo (UNVERIFIED). Hand them over out of band.
6. The Railway project id is hard-coded in three scripts (`ops/railway-deploy.ts`, `promote.ts`, `prod-secrets.ts`) and the dev environment id in `ops/railway-deploy.ts`. (The owner constant is now `Tealbrick`.)
7. `promote.ts` deploys core, admin-gui, gui and website only.
8. db-backup dumps contain personal data; GDPR erasure does not reach them (they expire within 14 dumps).
9. `registry/inputs/bridge-runtime-*.json` has gaps and is only for dev source records.