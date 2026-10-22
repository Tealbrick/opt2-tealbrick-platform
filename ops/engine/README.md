# Own-server engine ops: backup, restore drill, upgrade (S1, C308)

Scripts for a workspace box that runs Openship (own-server deployment). They run on the box as root. The host agent calls them; an
operator can run them by hand. Plain TypeScript, Node 24, no dependencies, no shell. Layout facts come from the S1 test box (Openship 0.9.3,
2026-10-22): see the header of `box.ts`. Everything is tested against a scripted box (`fake-box.ts`). **The scripts have not run against a
real box yet**; the first real runs are the S1-8 QA drills (checklist at the end). Until `restore.ts drill` has passed on a real box and
`restore.ts restore` on a throwaway VPS, the product label stays "preview: no customer data".

| File | What |
|---|---|
| `backup.ts` | `run` one off-box backup (restic), `prune` (operator side only), `status` |
| `restore.ts` | `drill` (safe on a live box) and `restore --confirm-empty-box` (disaster recovery onto an empty box) |
| `upgrade.ts` | `apply --pin <engine record>` with snapshot, pull-first, health gate, verify and automatic rollback; `drill --pin` = the M6 upgrade + restore drill |
| `box.ts` | runner, layout (`TB_ENGINE_*` env), guards |

## Backup
- Encrypted restic repository OFF the box (`sftp:`, `rest:`, `s3:`, `b2:`). A path on the box is refused. Install restic from the Ubuntu 24.04
  archive (`apt install restic`, 0.16.x); the host agent installs it.
- Env file `/etc/tealbrick/backup.env` (mode 0600, root): `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE` (a 0600 file, never argv/env), backend
  credentials, `TB_BACKUP_HOST_ID` (default hostname = `srv_...`), `TB_BACKUP_EXTRA_PATHS` (host agent state dir, colon list),
  `TB_BACKUP_DEEP_PERCENT` (read N % of the data in the run check).
- First run only: `TB_BACKUP_INIT=1`. A wrong URL must never create a new repository by accident.
- In the snapshot: `pg_dump -Fc` of the Openship DB and of every companion Postgres container of the workspace stacks (consistent); the
  compose dir (`.env` holds the keys that decrypt Openship's stored secrets, `host-ssh/` the host key); edge state and certificates;
  the workspace stack volumes and the Redis volume as files (crash-consistent: SQLite apps and the bridge identity are copied while they run;
  the apps' own pre-update dumps in their `backup` volume are the consistent source and are in the same snapshot);
  the extra paths. `BACKUP-MANIFEST.json` lists it with sha256 of each dump, table names, `.env` key NAMES and hash, and the engine images.
- Fails closed: any restic error (also exit 3, unreadable file), a snapshot not listed afterwards, or a failed `restic check` = exit 1.
  `last-backup.json` only ever names a GOOD run; failures go to `backup-log.jsonl`.
- **Append-only credentials.** The box holds write credentials. Give it an append-only backend (restic `rest-server --append-only`, or an
  object-store key without delete). The box never runs `forget`. `prune` needs `TB_BACKUP_ALLOW_PRUNE=1` and runs from another machine.
- Schedule (agent, S2): systemd timer, daily. S1: run by hand or by the QA journey.

## Restore drill
`node ops/engine/restore.ts drill [--snapshot <id>]` restores the snapshot into a scratch dir under the state dir and a throwaway Postgres
(same image as the box, `--network none`, trust auth, no mounts, never pulls), then checks (names are stable, QA greps them):
`snapshot-structure`, `manifest`, `dump:<file>` (sha256), `path:<p>`, `volume:<v>`, `compose-env` (byte-equal, same key names, mode 0600, host
key), `db:<file>` (restore OK and table set equals the manifest). It never touches a running container or volume and removes only its own
`tbdrill-*` containers and scratch dir. Result: JSON on stdout, line in `drills.jsonl`, exit 0 only when every check passes.

`restore --confirm-empty-box`: restores onto a box with no Openship (QA: a throwaway VPS). It first restores to scratch and runs the drill
checks; only a clean result places files. Then: volumes created, files restored to their original paths, Postgres up, Openship DB restored
(`--clean --if-exists --exit-on-error`), stack up, API health on loopback. Companion dumps go to `<state>/restored/` for the host agent
re-apply step. Open: whether Openship re-creates the workspace stack containers from its restored DB is only known after the first real
run; the agent's re-apply of Core's current plan covers it either way.

## Upgrade
An engine bump is a pin in the signed index (`registry/engines.json` -> kind `engine`, see `registry/README.md`), never `openship upgrade` /
`openship up` on the box (they rewrite Openship's compose file and use mutable tags). `upgrade.ts apply --pin <record>`:
1. check the pin shape; refuse a Postgres major change (data dir) and an unhealthy start;
2. off-box backup must pass; local safety copy (compose dir, `pg_dump`, container list) in `<state>/upgrade/<run>/`;
3. write `docker-compose.digests.yml` beside Openship's compose file (image of postgres/redis/api/dashboard/edge = pinned `name@sha256`), pull
   BEFORE anything changes; `up -d` only the services that exist on this box (a `--no-ui` box gets no dashboard);
4. health gate (`/api/health`, plus `--smoke-path` with `--token-file` if the agent wants an authenticated probe), then verify: every control-plane
   container runs the pinned reference, workspace containers unchanged, no Openship table lost;
5. any failure after `up`: rollback = stop api+dashboard, restore compose files and the database from the local copy, `up -d`, verify the
   recorded pre-state. The new API may have migrated the schema, so an old image on the new schema is not a rollback.
`upgrade.ts drill --pin <record>` (the M6 done-when, `evidence.upgradeDrill`): (1) a forced failure after `up` must end in a verified rollback,
(2) the real upgrade, (3) `restore drill` on the snapshot taken before step 2. Pass = all three.

## Interface for the host agent (Lead B)
- Call by path: `node ops/engine/{backup,restore,upgrade}.ts ...` (exit code + JSON on stdout), or import `runBackup`, `runDrill`, `runRestore`,
  `runUpgrade`, `runUpgradeDrill` (they take a `Runner`, a `BoxLayout` and a `ResticConfig`).
- The agent supplies: the restic env file, `TB_BACKUP_EXTRA_PATHS` (its state dir: host key, last applied seq; policy call: the backup then
  holds the box identity, encrypted), and for `apply` the engine record it already verified against the root-signed index.
- The agent must not run `openship up|upgrade`. It may use the Openship API with its scoped token.

## What QA runs on a real box (S1-8)
1. `backup.ts run` (twice; second shows dedup) -> `restore.ts drill` -> all checks green.
2. Break each of: restic repo URL, password file mode, a full disk (staging) -> the run fails and `last-backup.json` is unchanged.
3. `upgrade.ts drill --pin <dev record>` on a box with a workspace (bridge + Knowledge) running; the bridge answers throughout.
4. `restore.ts restore --confirm-empty-box` on a throwaway VPS from that snapshot; the host agent re-applies; the bridge enrols with its old identity.
5. Record the run ids in `registry/engines.json` evidence (`restoreDrill`, `upgradeDrill`) before a stable pin.

## Exit path: engine contract, conformance suite, compose+Caddy fixture (`fixture/`)
REDTEAM M2: "behind our adapter" is an exit path only if the contract, not Openship, defines the features and a second tiny engine passes the
same suite on every host-agent release. Tripwires that start the swap are in `SPRINT-S1-OWN-VPS.md` (no release 60 d, unpatched critical 7 d /
high 14 d, breaking API without migration, main author inactive 45 d, reproduced container-to-host escape unfixed 14 d, licence/telemetry
change, headless/token grants removed, adapter upkeep > 5 lead-days per quarter).

| File | What |
|---|---|
| `fixture/contract.ts` | `EngineAdapter` (what the host agent needs from ANY engine), `StackSpec`, `HostServiceSpec` (copy of the S1-0 draft section 4; replace with the spec 0.1.58 types), `SpecRefusal` |
| `fixture/schema.ts` | `validateServiceSpec` / `validateStack`: the closed schema as code (forbidden fields refused by name, digest images, named volumes, bridge-only public, hosts inside the zone, refs inside the stack) |
| `fixture/compose-caddy.ts` | `ComposeCaddyAdapter`: generates one compose project per workspace + one Caddy per box (host network, loopback upstream); never takes compose from outside |
| `fixture/conformance.ts` | `runConformance(adapter, { live? })`: rows E-1..E-10 (pure, CI) and L-1..L-3 (a box with Docker) |
| `fixture/run.ts` | CLI: static rows, or `TB_FIXTURE_LIVE=1 TB_FIXTURE_IMAGE=<digest ref>` for the live rows |

`EngineAdapter` (all methods take the closed `StackSpec`; the host agent does the signature, index and local-policy checks BEFORE it calls them):
`render(stack): Rendered` (pure; throws `SpecRefusal`; returns every document the engine would receive), `apply(stack)` (idempotent; stopped services stay
stopped), `stop(workspace, service)` (keeps volumes), `status(workspace)`, `originsFor(stack)` (value of `TB_OWN_INFRA_ORIGINS`), `volumesOf(workspace)`,
`scopeOf(stack)` (networks and volumes it would create). Rows: E-1 the two B3 namespace-escape probes (`network_mode: container:<edge>`, `pid: container:<api>`) and
`network_mode: host` refused (= H-8) · E-2 every privilege/host field refused by name, unknown fields refused · E-3 digest-only images, `tb-*` single-label names ·
E-4 named volumes only · E-5 only the bridge is public, hosts inside the zone · E-6 no escape token in the rendered output, only loopback ports · E-7 exact origins
(= H-10 source) · E-8 deterministic, no secret value in render · E-9 no shared network/volume between workspaces · E-10 refs stay inside the stack · L-1 apply
brings the service up from its digest · L-2 idempotent · L-3 stop keeps volumes (= H-9). H-1..H-7 (signature, replay, index, downgrade, env) and H-11 (firewall
from an app network) are agent/QA rows, not adapter rows.

For Lead B: implement `EngineAdapter` for Openship (its `render` returns the API payloads it would send, as text documents) and call `runConformance` from the
host-agent tests and from the release gate, next to this fixture. Import these files by copy with provenance or from a vendored path; they have no dependencies.
Gaps on purpose: egress control for agent containers, the firewall and TLS issuance are the agent's job (H-11 and S1-6), not the engine's; the fixture's
Caddy needs `caddyImage` pinned by digest by whoever runs it (no default, a default would be a floating pin); `serviceRefs.env` is read as "the referenced
service's env entry or generated secret of that name" - the S1-0 contract must say it.
