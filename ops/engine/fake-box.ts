// Test double of a box for ops/engine/*.test.ts: real temp directories for the files, a scripted `docker`, `restic`, `df`.
// It records every command (cmd + args + env names) so tests can assert what was run and that no secret was in argv.
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResticConfig } from "./backup.ts";
import type { BoxLayout, Runner, RunOpts, RunResult } from "./box.ts";

export interface Call {
  cmd: string;
  args: string[];
  env: string[];
}
export interface FakeBox {
  root: string;
  layout: BoxLayout;
  restic: ResticConfig;
  calls: Call[];
  r: Runner;
  /** secret values written into files; tests assert none of them shows up in a command line */
  secrets: string[];
  repo: string;
  state: {
    resticInitialised: boolean;
    failBackupCode: number;
    hideSnapshot: boolean;
    failPull: boolean;
    pullsAllowed: boolean;
    apiHealthy: boolean;
    breakApiAfterUp: boolean;
    tables: string[];
    migrate: boolean;
    containers: { name: string; image: string; state: string; status: string }[];
    baseImages: Record<string, string>;
    localImages: Set<string>;
    drillTables: string[] | null;
    drillContainers: Set<string>;
    postgresMajorImage: string;
    moveWorkspaceOnUp: boolean;
  };
}

export const PIN_IMAGES = {
  api: `ghcr.io/tealbrick/mirror/openship-api@sha256:${"1".repeat(64)}`,
  dashboard: `ghcr.io/tealbrick/mirror/openship-dashboard@sha256:${"2".repeat(64)}`,
  edge: `ghcr.io/tealbrick/mirror/openship-edge@sha256:${"3".repeat(64)}`,
  postgres: `ghcr.io/tealbrick/mirror/postgres@sha256:${"4".repeat(64)}`,
  redis: `ghcr.io/tealbrick/mirror/redis@sha256:${"5".repeat(64)}`,
};

function psRow(c: { name: string; image: string; state: string; status: string }): string {
  return `${c.name}\t${c.image}\t${c.state}\t${c.status}`;
}

export function makeBox(opts: { dashboard?: boolean } = {}): FakeBox {
  const root = mkdtempSync(join(tmpdir(), "tb-engine-test-"));
  const layout: BoxLayout = {
    composeDir: join(root, "openship-compose"),
    composeProject: "openship",
    postgresContainer: "openship-postgres-1",
    postgresUser: "openship",
    postgresDb: "openship",
    hostState: [join(root, "edge"), join(root, "letsencrypt"), join(root, "missing-static")],
    postgresVolume: "openship_postgres_data",
    redisVolume: "openship_redis_data",
    stateDir: join(root, "state"),
    extraPaths: [],
    apiUrl: "http://127.0.0.1:4000",
  };
  const secrets = ["s3cr3t-encryption-key-value", "pa55word-for-ssh-key"];
  mkdirSync(join(layout.composeDir, "host-ssh"), { recursive: true });
  writeFileSync(join(layout.composeDir, "docker-compose.yml"), "services: {}\n");
  writeFileSync(join(layout.composeDir, ".env"), `OPENSHIP_VERSION=0.9.3\nENCRYPTION_KEY=${secrets[0]}\nPOSTGRES_PASSWORD=${secrets[1]}\n`, { mode: 0o600 });
  writeFileSync(join(layout.composeDir, "host-ssh", "id_ed25519"), "-----BEGIN FAKE KEY-----\n", { mode: 0o600 });
  mkdirSync(join(root, "edge", "sites-enabled"), { recursive: true });
  writeFileSync(join(root, "edge", "sites-enabled", "ws.conf"), "server {}\n");
  mkdirSync(join(root, "letsencrypt", "live"), { recursive: true });
  writeFileSync(join(root, "letsencrypt", "live", "cert.pem"), "CERT\n");
  mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
  const pw = join(root, "restic-password");
  writeFileSync(pw, "restic-pass\n", { mode: 0o600 });
  chmodSync(pw, 0o600);
  const volumes: Record<string, string> = {};
  for (const v of [
    "openship_postgres_data",
    "openship_redis_data",
    "openship-wsa_bridge_data",
    "openship-wsa_knowledge_data",
    "openship-wsa_gbrain-db_data",
    "other_project_data",
  ]) {
    const dir = join(root, "docker-volumes", v, "_data");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "file.txt"), `data of ${v}\n`);
    volumes[v] = dir;
  }
  const baseImages: Record<string, string> = {
    postgres: "postgres:16-alpine",
    redis: "redis:7-alpine",
    api: "ghcr.io/oblien/openship-api:0.9.3",
    dashboard: "ghcr.io/oblien/openship-dashboard:0.9.3",
    edge: "ghcr.io/oblien/openship-edge:0.9.3",
  };
  const cname = (svc: string) => (svc === "edge" ? "openship-edge" : `openship-${svc}-1`);
  const containers = Object.entries(baseImages)
    .filter(([svc]) => opts.dashboard !== false || svc !== "dashboard")
    .map(([svc, image]) => ({ name: cname(svc), image, state: "running", status: "Up 3 days (healthy)" }));
  containers.push(
    {
      name: "openship-wsa-tb-bridge-1",
      image: "ghcr.io/tealbrick/opt2-tealbrick-bridge-server@sha256:" + "a".repeat(64),
      state: "running",
      status: "Up 1 day",
    },
    { name: "openship-wsa-tb-gbrain-db-1", image: "postgres:16-alpine", state: "running", status: "Up 1 day" },
  );
  const state: FakeBox["state"] = {
    resticInitialised: true,
    failBackupCode: 0,
    hideSnapshot: false,
    failPull: false,
    pullsAllowed: true,
    apiHealthy: true,
    breakApiAfterUp: false,
    tables: ["public.users", "public.projects", "public.tokens"],
    migrate: false,
    containers,
    baseImages,
    localImages: new Set(["postgres:16-alpine", `sha256:none`]),
    drillTables: null,
    drillContainers: new Set(),
    postgresMajorImage: "postgres:16-alpine",
    moveWorkspaceOnUp: false,
  };
  const repo = join(root, "fake-restic-repo");
  mkdirSync(repo, { recursive: true });
  const calls: Call[] = [];
  const drillTablesOf = new Map<string, string[]>();
  let snapN = 0;

  const out = (stdout = "", code = 0, stderr = ""): RunResult => ({ code, stdout, stderr });
  const composeImages = (args: string[]): Record<string, string> => {
    const files = args.flatMap((a, i) => (args[i - 1] === "-f" ? [a] : []));
    const merged = { ...baseImages };
    for (const f of files) {
      if (!f.endsWith("digests.yml") || !existsSync(f)) continue;
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/^ {2}(\w+):\n {4}image: (\S+)$/gm)) merged[m[1] as string] = m[2] as string;
    }
    return merged;
  };

  const r: Runner = async (cmd, args, o: RunOpts = {}) => {
    calls.push({ cmd, args: [...args], env: Object.keys(o.env ?? {}) });
    if (cmd === "df") return out("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 999999999 1 999999998 1% /\n");
    if (cmd === "cp") {
      cpSync(args[args.length - 2] as string, args[args.length - 1] as string);
      return out();
    }
    if (cmd === "restic") {
      const sub = args[0];
      if (sub === "version") return out("restic 0.16.4\n");
      if (sub === "cat") return state.resticInitialised ? out("{}") : out("", 10, "Is there a repository at the following location?");
      if (sub === "init") {
        state.resticInitialised = true;
        return out();
      }
      if (sub === "backup") {
        if (state.failBackupCode) return out("", state.failBackupCode, "error: at least one source file could not be read");
        const id = `${(++snapN).toString(16).padStart(8, "0")}`.padEnd(8, "0");
        const paths = args.filter((a) => a.startsWith("/"));
        for (const p of paths) cpSync(p, join(repo, id, p), { recursive: true });
        return out(`${JSON.stringify({ message_type: "status", percent_done: 0.5 })}\n${JSON.stringify({ message_type: "summary", snapshot_id: id })}\n`);
      }
      if (sub === "snapshots") {
        const ids = readdirSync(repo).sort();
        const idArg = args.find((a) => /^[0-9a-f]{8}$/.test(a));
        const list = ids.filter((i) => !idArg || i === idArg).map((id) => ({ id, time: `2026-10-23T00:00:${id.slice(-2)}Z` }));
        if (state.hideSnapshot && idArg) return out("[]");
        return out(JSON.stringify(list));
      }
      if (sub === "check") return out("no errors were found\n");
      if (sub === "stats") return out(JSON.stringify({ total_size: 1024 }));
      if (sub === "restore") {
        const id = args[1] as string;
        const target = args[args.indexOf("--target") + 1] as string;
        const includes = args.flatMap((a, i) => (args[i - 1] === "--include" ? [a] : []));
        if (!existsSync(join(repo, id))) return out("", 1, "snapshot not found");
        if (includes.length) for (const p of includes) cpSync(join(repo, id, p), join(target, p), { recursive: true });
        else cpSync(join(repo, id), target, { recursive: true });
        return out();
      }
      if (sub === "forget") return out();
      return out("", 2, `fake restic: unknown ${sub}`);
    }
    if (cmd !== "docker") return out("", 127, `fake: no ${cmd}`);
    const [sub, ...rest] = args;
    if (sub === "ps") {
      const fmt = rest[rest.indexOf("--format") + 1] ?? "";
      const control = (c: { name: string }) => c.name.startsWith("openship-") && !c.name.startsWith("openship-wsa");
      const rows = rest.includes("--filter") ? state.containers.filter(control) : state.containers;
      if (fmt === "{{.Names}}") return out(`${rows.map((c) => c.name).join("\n")}\n`);
      if (fmt === "{{.Names}}\t{{.Image}}") return out(`${rows.map((c) => `${c.name}\t${c.image}`).join("\n")}\n`);
      return out(`${rows.map(psRow).join("\n")}\n`);
    }
    if (sub === "volume" && rest[0] === "ls") return out(`${Object.keys(volumes).join("\n")}\n`);
    if (sub === "volume" && rest[0] === "inspect") return out(`${volumes[rest[rest.length - 1] as string] ?? "/nope"}\n`);
    if (sub === "volume" && rest[0] === "create") {
      const dir = join(root, "docker-volumes", rest[1] as string, "_data");
      mkdirSync(dir, { recursive: true });
      volumes[rest[1] as string] = dir;
      return out();
    }
    if (sub === "image" && rest[0] === "inspect") {
      const image = rest[rest.length - 1] as string;
      if (rest.includes("--format")) return out(JSON.stringify([`${image.split(":")[0]}@sha256:${"9".repeat(64)}`]));
      return state.localImages.has(image) || image.startsWith("postgres@") ? out("[{}]") : out("", 1, "No such image");
    }
    if (sub === "inspect") {
      const name = rest[0] as string;
      return out(
        JSON.stringify([
          {
            Name: `/${name}`,
            Config: {
              Image: state.containers.find((c) => c.name === name)?.image ?? "postgres:16-alpine",
              Env: ["POSTGRES_USER=app", "POSTGRES_DB=appdb", `POSTGRES_PASSWORD=${secrets[1]}`, "PG_MAJOR=16"],
            },
            Mounts: name.includes("gbrain-db") ? [{ Type: "volume", Name: "openship-wsa_gbrain-db_data" }] : [],
          },
        ]),
      );
    }
    if (sub === "exec") {
      const c = rest[0] as string;
      const tool = rest[1];
      if (tool === "pg_dump") {
        if (o.stdoutFile) {
          const tables = c.includes("gbrain-db") ? ["public.notes"] : state.tables;
          writeFileSync(o.stdoutFile, `PGDMP fake dump of ${c}\nTABLES:${JSON.stringify(tables)}\n`);
        }
        return out();
      }
      if (tool === "psql") {
        const restored = drillTablesOf.get(c);
        const tables =
          state.drillContainers.has(c) && state.drillTables ? state.drillTables : (restored ?? (c.includes("gbrain-db") ? ["public.notes"] : state.tables));
        return out(`${tables.join("\n")}\n`);
      }
      if (tool === "pg_isready") return out("accepting connections\n");
      if (tool === "pg_restore") {
        if (!state.drillContainers.has(c) && rest.includes("--clean") && state.migrate) state.tables = state.tables.filter((t) => t !== "public.migrated_new");
        return out();
      }
      return out();
    }
    if (sub === "run") {
      const name = rest[rest.indexOf("--name") + 1] as string;
      state.drillContainers.add(name);
      return out("containerid\n");
    }
    if (sub === "cp") {
      const [from, to] = rest as [string, string];
      if (existsSync(from) && to.includes(":")) {
        const text = readFileSync(from, "utf8");
        const t = /TABLES:(\[.*\])/.exec(text);
        if (/PGDMP fake dump of/.test(text) && t) drillTablesOf.set(to.split(":")[0] as string, JSON.parse(t[1] as string) as string[]);
      }
      return out();
    }
    if (sub === "rm") {
      state.drillContainers.delete(rest[rest.length - 1] as string);
      return out();
    }
    if (sub === "compose") {
      const verb = rest.find((a) => ["pull", "up", "stop"].includes(a));
      if (verb === "pull") return state.failPull ? out("", 1, "manifest unknown") : out();
      if (verb === "stop") return out();
      if (verb === "up") {
        const imgs = composeImages(rest);
        for (const c of state.containers) {
          const svc = c.name === "openship-edge" ? "edge" : /^openship-(\w+)-1$/.exec(c.name)?.[1];
          if (svc && imgs[svc]) {
            c.image = imgs[svc];
            c.state = "running";
          }
        }
        if (!rest.includes("-d")) return out();
        const newImages = Object.values(imgs).some((i) => i.includes("@sha256"));
        if (newImages) {
          state.migrate = true;
          if (!state.tables.includes("public.migrated_new")) state.tables = [...state.tables, "public.migrated_new"];
        }
        if (state.moveWorkspaceOnUp) {
          const ws = state.containers.find((c) => c.name === "openship-wsa-tb-bridge-1");
          if (ws) ws.state = "exited";
        }
        return out();
      }
      return out();
    }
    return out("", 1, `fake docker: unknown ${sub}`);
  };

  const restic: ResticConfig = { repository: "sftp:backup@backup.example:/repo", passwordFile: pw, hostId: "srv_test", init: false, deepPercent: 0 };
  return { root, layout, restic, calls, r, secrets, repo, state };
}
