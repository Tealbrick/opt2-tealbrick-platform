# opt2 backups and restore test

## Portal DB (Railway Postgres 18 in project "opt2") — decision C7
1. Layer 1, volume snapshots (on): Railway volume backups DAILY (6 d) + WEEKLY (27 d) for `postgres-volume`. Use for full disaster recovery. A Railway restore overwrites the volume in place: never use it as a test.
2. Layer 2, logical dump + restore test (live): service `db-backup` (Railway cron `17 19 * * *` UTC = 02:17 Bangkok, restart policy NEVER), source `ops/db-backup/` (Dockerfile: Postgres 18 client + Node 24, job `backup.ts`). Volume `db-backup-volume` at `/backups`. Env: `DATABASE_URL` = reference `${{Postgres.DATABASE_URL}}`, `BACKUP_DIR=/backups`, `KEEP=14`, `HEARTBEAT_URL` (GlitchTip heartbeat monitor "opt2 db-backup nightly", set unprinted).
   Each run: canary row in `tb_ops.restore_canary` → `pg_dump -Fc` → restore into scratch database `tb_restore_test` on the same server → verify (every source table exists in the restore, canary row present) → drop scratch database → keep 14 dumps → append to `/backups/RESTORE-LOG.jsonl` → heartbeat on success only (a missed heartbeat alerts in GlitchTip).
   Credentials reach pg tools only through PG* env vars (never argv, never logs).
   Portal Core: schema `tb_ops` belongs to Platform; Core migrations must not touch it. Database name `tb_restore_test` is reserved.

## Restore test evidence
- 2026-10-11 11:05 UTC: first real run `portal-2026-10-11T110532Z.dump`, restore **pass** (`tables=1 rows=3 canary=ok`, 497 ms), heartbeat 200. (DB holds only the canary until Core ships its schema; the check covers every table automatically.)

## Full-server restore drill (before cutover)
1. Create a temporary Postgres 18 service `pg-restore-drill` (private).
2. `pg_restore --no-owner --exit-on-error` the latest dump from `/backups` into it (from a one-off run of `db-backup` with `DATABASE_URL` pointed at the drill service).
3. Point a temporary Core deployment at it; Core health + read-only registry queries pass.
4. Record in this file; delete the drill service.

## Bridge + app volume restore test — C16 S7 / C56 D8 (2026-10-12) — PASS
Target: Core's running probe in project opt2-test-customer: workspace ws_01M4Q5KRKQDG4MZN117XG2GBWP, bridge brg_01M4Q5KRKQDG4MZN117XG2GBWQ (0.1.8, service tb-bridge), Knowledge ins_01M4Q5N4791549VB8MTQQCMDEY (service tb-knowledge). No browser, no person sign-in: Railway API + `railway ssh` only.
1. Before: bridge kid `ltaGNA8NU8noEzD9jeLBcn4B95qujNeTYWTrzNyx1Gs` (public, from /data/bridge/identity.json; private key sealed with TB_KEK), `/readyz` 200. Knowledge app.db row counts recorded (tb_migrations=3, tb_meta=2, tb_scope_instances=1, tb_audit=2, kn_areas=1, …). Canary `/data/tb-d8-canary.txt` ("D8 canary 20261012T042916Z") written on both volumes.
2. Railway backups (`volumeInstanceBackupCreate`) at 04:29:54 UTC: bridge 5d946251-… ("d8-restore-test-bridge"), Knowledge 89c7e54e-… ("d8-restore-test-knowledge").
3. After the backup: marker `/data/tb-d8-marker-post-backup.txt` written on both volumes.
4. Restore (`volumeInstanceBackupRestore`): Railway creates a NEW volume from the snapshot and stages a mount swap; the staged change must be committed (`environmentPatchCommitStaged`), which redeploys the service. Restore one volume at a time: two restores in a row left only the last staged change.
5. After: tb-bridge redeployed SUCCESS on the restored volume; `/healthz` 200, `/readyz` 200; same kid `ltaGNA8…yx1Gs`, same bridgeId; canary present; marker GONE; no re-enrolment (identity unsealed with the provider-held TB_KEK). tb-knowledge redeployed SUCCESS on the restored volume; `/tb/v1/health` 200 (`needs_keys`, as before: no model key entered); canary present; marker GONE; every app.db row count identical; bridge stayed ready.
6. Backup schedules (DAILY 6 d, WEEKLY 27 d) carried over to the restored volumes. The replaced volumes (tb-bridge-volume-cJBb, tb-knowledge-volume-4vl-) are detached and fall under Railway's 48 h deletion.
Runbook implication: a Railway volume restore = new volume + staged swap + commit + redeploy; budget ~2 min per service; restore services one at a time.

## Bridge + app volumes (customer workspaces) — C16 S7
Bridge: Railway volume backup DAILY, kept 7 days, set by the bridge template (BRIDGE.md). `TB_KEK` is provider-held and not in the volume. Restore test at P2 in project opt2-test-customer: restore the latest bridge volume backup into a fresh bridge service with the same `TB_KEK` reference, check it unseals its state and serves its last good config.
Apps: baked into the Miniapp SDK (each app's backup volume in its Railway template) — owned by Lead · Specs & SDK; Platform adds the restore test for the test customer workspace at P2.

## Cleanup note: opt2-test-customer orphaned volumes (2026-10-12)
22 volumes left by Core's probe/e2e deploys (tb-bridge*, tb-knowledge*, vol-probe*; ~14 GB) have no attached service. Railway already shows every one with a scheduled `deletedAt` (2026-10-13 11:42 → 2026-10-14 00:04 UTC, = 48 h after detach), so Railway deletes them itself. None were deleted by hand. redis-volume and postgres-volume (attached, buzz-test-relay stack) untouched.
- D8 clean-up (2026-10-12 ~05:03 UTC): after Core removed the probe, Platform deleted its three restore-copy volumes (`volumeDelete`): `tb-bridge-cJBb-2026-10-12 04:29 UTC` (8104ab58-…), `tb-knowledge-4vl--2026-10-12 04:29 UTC-47XW` (7deb1b58-…) and `tb-knowledge-4vl--2026-10-12 04:29 UTC` (264d395d-…, the first Knowledge restore whose staged swap was overwritten, never mounted). Railway keeps them 48 h in pending deletion. Redis/Postgres/buzz-test-relay volumes untouched.

## Own-server workspace boxes (S1, C308)
Boxes that run Openship are backed up off-box with restic, with a restore drill and an Openship upgrade/rollback drill: `ops/engine/README.md`. Until the drills pass on a real box the label is "preview: no customer data".
