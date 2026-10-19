# opt2 incident runbook

Scope: our side of Teal Brick (Railway project "opt2": portal-core, portal-gui, website, Postgres, db-backup, status) plus the release index. Customer workspaces (bridge + apps in the customer's Railway) keep working while Portal is down until their grants expire (CORE §3); their incidents follow §6.
Rules that always apply: never print secrets; copy values with `railway variable set <KEY> --stdin`; deploy only pushed commits (`ops/railway-deploy.ts`); never touch v1 (project "tealbrick-portal" production, portal.tealbrick.com, tealbrick.com).

## 1. Detect
| Signal | Where | Means |
|---|---|---|
| Status page red | https://status-production-62da.up.railway.app (JSON: `/api/status`) | a probe failed: Portal, API→Core, Core health (private), website, release index |
| GlitchTip uptime alert | the GlitchTip host (URL in the operator notes), org tealbrick: "opt2 portal-gui", "opt2 dev.tealbrick.com", "opt2 website", "opt2 status page" | public endpoint down |
| GlitchTip heartbeat missed | "opt2 db-backup nightly" | last night's dump or restore test failed or did not run |
| GlitchTip issues spike | projects opt2-portal-core, opt2-portal-gui | errors in Core or GUI (PII scrubbed server-side) |
| Railway deploy failed / crash loop | Railway project opt2 → service → Deployments | health check (`/internal/health` Core, `/healthz` status) failing |
| Woodpecker red | the Woodpecker UI (private network only; URL in `~/.config/opt2-tealbrick/hosts.env` as `WOODPECKER_URL`, not in this repo) | CI; `template-audit` red = a repo below `ci/MIN_TEMPLATE`; the platform `registry-sync` GitHub Actions run red = a release candidate was rejected |

## 2. Triage (first 10 minutes)
1. Which probes are red on the status page? Core health red + API red → Core or Postgres. Only API red → gateway (portal-gui) config. Portal red → GUI deploy or DNS.
2. Railway → opt2 → the red service → latest deployment: status, build/deploy logs (`railway logs -s <service> -e production`). Note the deployed commit SHA.
3. Was there a deploy in the last hour? If yes, roll back first (§3), investigate after.
4. Postgres: Railway → Postgres → Metrics (disk, connections). Disk full → grow the volume in Railway; do not delete data.
5. DNS/TLS: `dig CNAME dev.tealbrick.com` must be `1spe7wwp.up.railway.app`; Railway → portal-gui → Settings → Domains must show the certificate VALID.
6. Write a one-line incident note (time, symptom, suspected cause) in `ops/INCIDENTS.md` before changing anything else.

## 3. Roll back (pinned SHA)
Every opt2 service is built from a pushed commit; the previous good SHA is in the Railway deployment list (and in the deploying lead's STATUS note).
```sh
cd <workspace>/opt2-tealbrick-platform
node ops/railway-deploy.ts --service <portal-core|portal-gui|website|status|db-backup> --repo opt2-tealbrick-<repo> --sha <previous good sha> [--dockerfile <path>]
```
Faster for a bad deploy: Railway → service → Deployments → previous SUCCESS deployment → "Redeploy" (same image, no rebuild).
Database: rollbacks never run down-migrations by hand. If a migration broke data, restore (§5) into a new database and switch `DATABASE_URL` only after checking it.
Customer workspaces: a bad app/bridge release is never edited in the index; publish a fixed newer version (`registry-add-source` / CI tag) — Core deploys the newest on the channel; owners can roll back an instance with `instances.rollback`.

## 4. Key rotation
| Key | Where | Procedure |
|---|---|---|
| Core `TB_KEK` | portal-core variable | `ops/KEYS.md` "Portal Core KEK rotation" (C47): previous → new → deploy re-seals → drop previous |
| Clerk DEV / Stripe TEST keys, webhook secret | portal-core variables | new key in the provider dashboard → save to a 0600 file → `railway variable set <KEY> --stdin` → deploy → revoke the old key |
| Railway OAuth client secret | portal-core `RAILWAY_OAUTH_CLIENT_SECRET` | regenerate in Railway developer settings → `--stdin` → deploy |
| Release signing key | platform repo GitHub Actions environment `registry` secret `RELEASE_SIGNING_KEY` + owner key store (`gh secret set RELEASE_SIGNING_KEY --env registry < key.pem`) | `registry/README.md` "Key handling": add new public key to `registry/keys.json`, re-sign, update the secret, remove the old key later |
| GitHub publishing | none: built-in `GITHUB_TOKEN` per workflow run (C72) | nothing to rotate |
| Woodpecker repo hook token (leaked) | Woodpecker DB repo hash | new random repo hash on the CI host, then `POST /api/repos/<id>/repair`; check a test push triggers a pipeline (done for portal-core and website, 2026-10-12) |
| GlitchTip DSN | portal-core/portal-gui `SENTRY_DSN` | new project key in GlitchTip → `--stdin` → deploy → disable the old key |
After any rotation: record date + key id (never the value) in `ops/ROTATION-LOG.md`.

## 5. Restore
- Portal DB, logical: `ops/BACKUPS.md` — latest dump on the db-backup volume; restore into a new Postgres service, verify, then point `DATABASE_URL` at it.
- Portal DB, full volume: Railway → Postgres → Backups → restore (overwrites in place; only for disaster recovery, after a dump-based restore was ruled out).
- Bridge / app volumes (customer workspace): Railway volume backups (daily, 7 days) → restore on the same service; `TB_KEK` is provider-held and unchanged, so sealed state opens again (test record in `ops/BACKUPS.md`).
- Release index: the history is in git (`registry/index.json`, `index.jws` on platform main); re-publish with `node ci/tb-ci.ts registry-sign`.

## 6. Customer workspace incidents (bridge / apps in the customer's Railway)
Portal never connects in; the owner's bridge pulls config. Symptoms: agents get refusals, canvas shows the bridge offline.
1. Portal side healthy? (status page). If Portal is down, workspaces keep working until grants expire (≤ 12 h worst case offline); fix Portal first.
2. Bridge health: the owner's Railway → bridge service → `/healthz` (live) and `/readyz` (enrolled + config fresh).
3. Re-enrol only if the bridge key is lost: Portal → workspace → bridge → new enrolment code (Core refuses the old key at once).
4. App broken after an update: FIRST check the app's SDK and whether the new version migrated (§6a). `instances.rollback` to the previous release is safe ONLY when the old version's miniapp-sdk is ≥ 0.1.25 (it restores the pre-update snapshot) or the new version never ran. Otherwise follow §6a (INC-20261019-04: old code on migrated data crash-loops).
5. If a workspace's Rules app is down, every agent call in that workspace is refused (hook_failed), reads included, because the Rules gate covers all ops and hooks fail closed. Triage: Rules instance health → redeploy Rules (data is kept) → calls resume within ~30 s.

## 6a. Held or failed app update (E3, RS-7.4 freeze; INC-20261019-04)
Since RS-7.4 Core never puts old code on possibly migrated data: an app update whose old version runs miniapp-sdk < 0.1.25 (or unknown) and that failed after Core touched the provider is FROZEN — state `failed`, phase `held`, `last_update.outcome` `held`, `last_error.code` `update_held`; owner Rollback / Retry / Update refuse `409 update_held`. A target that reported and did not fail its boot is kept (`kept_new`).
Where it lands: admin health line "App updates held" (FAILED while any instance is held), the structured log event `update.held` (portal-core logs), the GlitchTip project opt2-portal-core (event `update_held`), and `admin.maintenance_runs` (job `instance.update_safety`).
Read-only check, FROZEN NOW (operator, live Core Postgres; prints no secret; the BOARD rule after every owner update on live): `SELECT id, ws, product, version, release_id, serving_release_id, last_error->>'code' AS code FROM instances WHERE phase = 'held' ORDER BY id;` (0 rows = nothing frozen; the admin health line keys on the same condition). History (cleared holds included): `SELECT id, ws, product, version, phase, last_update->>'outcome' AS outcome, last_update->>'at' AS at FROM instances WHERE last_update->>'outcome' IN ('held','kept_new','rollback_failed') ORDER BY last_update->>'at' DESC;`
Every case below leaves state `failed` (instances.retry runs only from failed/refused/cancelled) and clears phase `held` (else Retry refuses 409 update_held). Procedure (every write: ONE guarded SQL statement in a transaction on the live Core DB, only with the owner's GO, the Coordinator runs it; record each step in coordination/INCIDENTS.md):
1. Read the instance row (query above) and the app's provider logs (owner's Railway: the app service's latest deployments). Decide which case applies:
   (a) the NEW version runs and is healthy (logs show "app started ok", health 200 `status: ok`);
   (b) the new version never ran or failed BEFORE migrating (build failed; or the SDK logged a pre-snapshot failure: `preupdate_snapshot_failed`, `migration_locked`, `schema_newer`, `restore_failed`, `preupdate_snapshot_no_space`);
   (c) the new version migrated the data and then failed, and the old version cannot read it.
2. Case (a), keep the new version: `UPDATE instances SET serving_release_id = release_id, phase = NULL, update_attempt = NULL WHERE id = '<ins>' AND phase = 'held' RETURNING id, state, version;` (expect 1 row; state stays `failed`, which Retry needs), then the owner presses Retry (`instances.retry`: redeploys the same, new release with a fresh sign-in code, no gate).
3. Case (b), back to the old version (nothing migrated): `UPDATE instances SET release_id = '<old rel>', version = '<old version>', serving_release_id = '<old rel>', phase = NULL, update_attempt = NULL WHERE id = '<ins>' AND phase = 'held' RETURNING id, state, version;` then the owner presses Retry.
4. Case (c), fix forward (the INC-04 recipe): `UPDATE instances SET release_id = '<new rel>', version = '<new version>', serving_release_id = '<new rel>', phase = NULL, update_attempt = NULL, previous_release_ids = jsonb_build_array('<old rel>') || COALESCE(previous_release_ids, '[]'::jsonb) WHERE id = '<ins>' AND phase = 'held' RETURNING id, state, version, serving_release_id;` then the owner presses Retry; if the new version itself cannot start, restore its pre-update snapshot with a version that CAN read it (SDK ≥ 0.1.25) — never the old code.
5. Verify: state `running`, phase `ready`, health ok, the expected version, no bridge refusal; the admin health line "App updates held" back to ok. Before any of 2–4 (optional, recommended): copy the app's `tb-preupdate-to-<version>.tar.gz` aside on its volume (owner's Railway) — it is the only pre-update copy.
6. Record (L67): the case, the SQL, the 1-row result, the verification, in INCIDENTS.md; mark this procedure "verified on prod <date>" after its first real use. First verified use of case (c): INC-20261019-04, 2026-10-19 13:09–13:10Z (before the freeze existed; state was `failed`/`rollback_failed`, guard `state = 'failed' AND version = '<old>'` instead of `phase = 'held'`).

## 7. Close
Status page green for 15 minutes, GlitchTip quiet, root cause written in `ops/INCIDENTS.md` (what, why, fix, follow-up), follow-up tasks filed with the owning lead.

## 8. Own infrastructure bridge (C158)
The CLI has no `bridge enrol` / `bridge run` since cli 0.2.0. An owner who runs the bridge on their own machine or server runs the public bridge-server image (the same image Core deploys; GHCR package public, the source repo is private).
```sh
docker run -d --name tealbrick-bridge --restart unless-stopped \
  -v <data dir>:/data \
  -e TB_ENROL_CODE=<tbe_ enrolment code from Portal> \
  -e TB_PORTAL_URL=<Portal address, https> \
  -e TB_PUBLIC_URL=<https address where agents reach this bridge> \
  -e TB_KEK=<32 random bytes: base64url (43 chars) or hex (64 chars)> \
  -p 8080:8080 \
  ghcr.io/tealbrick/opt2-tealbrick-bridge-server:<version>
```
- Image path (C206 org move): bridge versions released from the Tealbrick org are in `ghcr.io/tealbrick/opt2-tealbrick-bridge-server`. Versions released before the move stay in `ghcr.io/martin-atrin/opt2-tealbrick-bridge-server` (never deleted). Use the image reference of the version's entry in the signed release index (`image`), which names the right path and digest.
- `<version>`: a bridge version from the signed release index (`kind: "bridge"`); pin it, never `latest`. Never run a `-conformance` tag (test roots on; never in the index).
- `TB_KEK` (C35): generate once (`openssl rand -hex 32`), keep it in the owner's secret store; it seals the bridge state on the volume. Lost KEK = re-enrol with a new code. Rotation: new key as `TB_KEK`, old as `TB_KEK_PREVIOUS` for one start (BRG-05).
- The enrolment code is used once; a restart with the same volume needs no new code. Optional: `TB_PUBLIC_HOST=127.0.0.1` behind a local TLS proxy (C171); `TB_INTERNAL_PORT` (default 8788) is the private companion listener for apps on the same host network.
- Checks: `curl -fsS <TB_PUBLIC_URL>/healthz` (live) and `/readyz` (enrolled + config fresh); Portal shows the bridge online.
- Coolify: same image, same env, a persistent volume on `/data`, port 8080.

## 9. Private repos (C154/C173)
Private: `opt2-tealbrick-portal-core`, `opt2-tealbrick-bridge`, `opt2-tealbrick-cli` (`PRIVATE_REPOS` in `ci/tb-ci.ts`). Public: the release index (platform), the dist repo, the GHCR bridge image, the mini apps.
- registry-sync and the template audit read private repos ONLY with `TB_PRIVATE_READ_TOKEN` (fine-grained, read-only: Contents + Metadata on the private repos); the platform `GITHUB_TOKEN` cannot see them. A private repo it cannot read = a red registry-sync run naming the token (the other repos are still synced). The daily Woodpecker template audit has no token: it logs `SKIP` for private repos (each repo's own `setup` step enforces `ci/MIN_TEMPLATE`).
- Release files of a private repo are public only through the dist repo (`opt2-tealbrick-dist`, pull mirror C164) and only when the signed index points at them; never link a private repo's release URL in a public repo (C154).
- `ops/railway-deploy.ts` checks a private repo's commit through your own `gh` login; Railway builds a private repo through its GitHub app (repository access must include it).
- Visibility is reversible (GitHub → repo → Settings → Danger Zone). A GHCR package keeps its own visibility; a public package cannot be made private again.
