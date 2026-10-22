// Engine conformance suite (S1, REDTEAM M2): every EngineAdapter - the Openship adapter of the host agent AND the compose+Caddy fixture -
// must pass it, on every host-agent release. It tests the CONTRACT (closed schema, no escape hatches, exact origins, stop keeps data,
// isolation), never an engine feature. Static rows (E-*) are pure and run in CI with `render`; live rows (L-*) need a box with Docker and
// a digest-pinned test image (`runConformance(adapter, { live: { image } })`).
//
// Row ids are stable (QA and the host-agent release gate grep them). H-8 of the S1-0 contract (namespace escape refused) is E-1/E-2: the
// two B3 probes are attempted by name against the adapter.

import { type EngineAdapter, type HostServiceSpec, SpecRefusal, type StackSpec } from "./contract.ts";
import { FORBIDDEN_FIELDS } from "./schema.ts";

export interface ConformanceRow {
  id: string;
  title: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

const DIGEST = (c: string) => `sha256:${c.repeat(64)}`;

export function sampleService(over: Partial<HostServiceSpec> & { serviceName: string }): HostServiceSpec {
  return {
    release: {
      product: "knowledge",
      releaseId: "rel_01M5EEEEEEEEEEEEEEEEEEEEE0",
      image: `ghcr.io/tealbrick/opt2-tealbrick-knowledge@${DIGEST("a")}`,
      manifestDigest: DIGEST("b"),
    },
    env: { PORT: "8080" },
    generatedSecrets: [],
    port: 8080,
    publicDomain: false,
    healthPath: "/healthz",
    volumes: [{ name: "data", mountPath: "/data", purpose: "data" }],
    resources: null,
    ...over,
  };
}
/** A bridge (public), Knowledge (app) and its database (no port): the shape of a real workspace stack. */
export function sampleStack(workspace = "ws-a", zone = "ws.example.net"): StackSpec {
  return {
    workspace,
    zone,
    services: [
      sampleService({
        serviceName: "tb-bridge",
        release: {
          product: "bridge",
          releaseId: "rel_01M5BBBBBBBBBBBBBBBBBBBBB0",
          image: `ghcr.io/tealbrick/opt2-tealbrick-bridge-server@${DIGEST("c")}`,
          manifestDigest: DIGEST("d"),
        },
        port: 3000,
        publicDomain: true,
        publicHosts: { main: `${workspace}.${zone}`, keys: `k-${workspace}.${zone}` },
        env: { PORT: "3000" },
        generatedSecrets: ["TB_KEK"],
        volumes: [{ name: "data", mountPath: "/data/bridge", purpose: "data" }],
      }),
      sampleService({ serviceName: "tb-knowledge", serviceRefs: { GBRAIN_DB_URL: { serviceName: "tb-gbrain-db", env: "DB_URL" } } }),
      sampleService({
        serviceName: "tb-gbrain-db",
        release: {
          product: "knowledge",
          releaseId: "rel_01M5EEEEEEEEEEEEEEEEEEEEE0",
          image: `ghcr.io/tealbrick/mirror/postgres@${DIGEST("e")}`,
          manifestDigest: DIGEST("b"),
        },
        env: { DB_URL: "postgres://db" },
        port: null,
        healthPath: null,
        volumes: [{ name: "pgdata", mountPath: "/var/lib/postgresql/data", purpose: "data" }],
      }),
    ],
  };
}

type Probe = (a: EngineAdapter) => string | null | Promise<string | null>;
const refused = (a: EngineAdapter, stack: StackSpec, expect?: string): string | null => {
  try {
    a.render(stack);
    return "the adapter rendered it instead of refusing";
  } catch (e) {
    if (!(e instanceof SpecRefusal)) return `refused with ${(e as Error).name}: ${(e as Error).message} (must be a SpecRefusal)`;
    if (expect && e.code !== expect) return `refused with code ${e.code}, expected ${expect}`;
    return null;
  }
};
const withService = (extra: Record<string, unknown>, base: StackSpec = sampleStack()): StackSpec => ({
  ...base,
  services: base.services.map((s, i) => (i === 1 ? ({ ...s, ...extra } as HostServiceSpec) : s)),
});

/** Tokens that must never appear in anything sent to an engine. */
const FORBIDDEN_OUTPUT =
  /network_mode|networkMode|\bpid:|\bipc:|\buts:|privileged|cap_add|\bdevices:|docker\.sock|extra_hosts|userns_mode|sysctls|volumes_from|0\.0\.0\.0|\bcontainer:/;

const STATIC: { id: string; title: string; probe: Probe }[] = [
  {
    id: "E-1",
    title: "namespace escape refused (REDTEAM B3 probes, H-8): network_mode container:<edge> and pid container:<api>",
    probe: (a) =>
      refused(a, withService({ network_mode: "container:openship-edge" }), "forbidden_field") ??
      refused(a, withService({ pid: "container:openship-api-1" }), "forbidden_field") ??
      refused(a, withService({ network_mode: "host" }), "forbidden_field"),
  },
  {
    id: "E-2",
    title: "every privilege/host field is refused by name, and unknown fields are refused",
    probe: (a) => {
      for (const f of FORBIDDEN_FIELDS) {
        const bad = refused(a, withService({ [f]: f === "privileged" ? true : "x" }), "forbidden_field");
        if (bad) return `${f}: ${bad}`;
      }
      return refused(a, withService({ somethingNew: 1 }), "unknown_field");
    },
  },
  {
    id: "E-3",
    title: "images only by digest; service names single-label tb-*",
    probe: (a) => {
      const tag = withService({ release: { ...sampleStack().services[1]?.release, image: "ghcr.io/tealbrick/opt2-tealbrick-knowledge:1.2.3" } });
      const bad = refused(a, tag, "image_not_digest");
      if (bad) return `tag image: ${bad}`;
      for (const n of ["knowledge", "tb-Knowledge", "tb-know.ledge", "tb-", "tb-a_b", `tb-${"x".repeat(41)}`]) {
        const r = refused(a, withService({ serviceName: n }), "bad_name");
        if (r) return `name ${n}: ${r}`;
      }
      return null;
    },
  },
  {
    id: "E-4",
    title: "named volumes only: host paths, bind syntax and runtime mounts are refused",
    probe: (a) => {
      for (const name of ["/var/run/docker.sock", "./data", "../x", "/", "a:b", "C:\\x"]) {
        const r = refused(a, withService({ volumes: [{ name, mountPath: "/data", purpose: "data" }] }));
        if (r) return `volume name ${name}: ${r}`;
      }
      for (const mountPath of ["/var/run/docker.sock", "/proc/x", "/etc/passwd", "/data/../etc"]) {
        const r = refused(a, withService({ volumes: [{ name: "data", mountPath, purpose: "data" }] }));
        if (r) return `mount ${mountPath}: ${r}`;
      }
      return null;
    },
  },
  {
    id: "E-5",
    title: "only the bridge is public, and its hosts stay inside the workspace zone",
    probe: (a) => {
      const notBridge = refused(
        a,
        withService({ publicDomain: true, publicHosts: { main: "a.ws.example.net", keys: "b.ws.example.net" } }),
        "public_not_bridge",
      );
      if (notBridge) return `non-bridge public: ${notBridge}`;
      const base = sampleStack();
      const outside: StackSpec = {
        ...base,
        services: base.services.map((s) => (s.publicDomain ? { ...s, publicHosts: { main: "evil.example.org", keys: `k.${base.zone}` } } : s)),
      };
      return refused(a, outside, "bad_host");
    },
  },
  {
    id: "E-6",
    title: "rendered output carries no escape hatch (no namespace/privilege/device/socket/wildcard-bind token, only named volumes, only loopback ports)",
    probe: (a) => {
      const r = a.render(sampleStack());
      if (!r.documents.length) return "render returned no documents";
      for (const d of r.documents) {
        const m = FORBIDDEN_OUTPUT.exec(d.text);
        if (m) return `${d.name}: contains ${JSON.stringify(m[0])}`;
        for (const line of d.text.split("\n")) {
          const vol = /^\s*-\s*"?([^":\s]+):\//.exec(line);
          if (vol && /^[/.~]/.test(vol[1] as string)) return `${d.name}: volume source ${vol[1]} is a path`;
          const port = /^\s*-\s*"?(\d{1,3}(?:\.\d{1,3}){3}|\d+):\d+/.exec(line);
          if (port && port[1] !== "127.0.0.1") return `${d.name}: published port ${line.trim()} is not on 127.0.0.1`;
        }
      }
      return null;
    },
  },
  {
    id: "E-7",
    title: "originsFor = exact http://tb-<name>:<port> of the stack's non-public services with a port (H-10 source), sorted, no IPs, no dots",
    probe: (a) => {
      const o = a.originsFor(sampleStack());
      const want = ["http://tb-knowledge:8080"];
      if (JSON.stringify(o) !== JSON.stringify(want)) return `got ${JSON.stringify(o)}, expected ${JSON.stringify(want)}`;
      if (o.some((x) => !/^http:\/\/tb-[a-z0-9-]+:\d+$/.test(x))) return "an origin is not single-label http://tb-*:port";
      return null;
    },
  },
  {
    id: "E-8",
    title: "render is deterministic and holds no secret value (generated secrets and refs are resolved on the box only)",
    probe: (a) => {
      const x = JSON.stringify(a.render(sampleStack()));
      if (x !== JSON.stringify(a.render(sampleStack()))) return "two renders of the same stack differ";
      const stripped = x.replace(/sha256:[0-9a-f]{64}/g, "");
      if (/(?<![0-9a-zA-Z])[0-9a-f]{64}(?![0-9a-zA-Z])/.test(stripped)) return "a 64-hex value (secret-shaped) is in the rendered output";
      if (x.includes("postgres://db")) return "a serviceRef value was resolved inside render (it must be resolved on the box)";
      return null;
    },
  },
  {
    id: "E-9",
    title: "two workspaces never share a network or a volume",
    probe: (a) => {
      const A = a.scopeOf(sampleStack("ws-a"));
      const B = a.scopeOf(sampleStack("ws-b"));
      const shared = [...A.networks.filter((n) => B.networks.includes(n)), ...A.volumes.filter((v) => B.volumes.includes(v))];
      if (shared.length) return `shared: ${shared.join(", ")}`;
      if (!A.networks.length || !A.volumes.length) return "scopeOf returned no network or no volumes";
      return null;
    },
  },
  {
    id: "E-10",
    title: "a service ref must point at a service of the same stack that defines that name",
    probe: (a) => {
      const base = sampleStack();
      const dangling = withService({ serviceRefs: { X: { serviceName: "tb-nope", env: "DB_URL" } } }, base);
      const wrongEnv = withService({ serviceRefs: { X: { serviceName: "tb-gbrain-db", env: "NOT_THERE" } } }, base);
      return refused(a, dangling, "bad_ref") ?? refused(a, wrongEnv, "bad_ref");
    },
  },
];

export interface LiveOptions {
  /** a small image pinned by digest that listens on its port and answers GET /healthz (the box must have it or may pull it) */
  image: string;
  port: number;
  sleep?: (ms: number) => Promise<void>;
}

async function waitFor<T>(fn: () => Promise<T | null>, seconds: number, sleep: (ms: number) => Promise<void>): Promise<T | null> {
  for (let i = 0; i < seconds; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(1000);
  }
  return null;
}

async function liveRows(a: EngineAdapter, live: LiveOptions): Promise<ConformanceRow[]> {
  const sleep = live.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ws = `conf-${Date.now().toString(36)}`;
  const stack: StackSpec = {
    workspace: ws,
    zone: "ws.example.net",
    services: [
      sampleService({
        serviceName: "tb-probe",
        release: { product: "knowledge", releaseId: "rel_01M5EEEEEEEEEEEEEEEEEEEEE0", image: live.image, manifestDigest: DIGEST("b") },
        port: live.port,
        env: { PORT: String(live.port) },
      }),
    ],
  };
  const rows: ConformanceRow[] = [];
  const row = (id: string, title: string, problem: string | null) => rows.push({ id, title, status: problem ? "fail" : "pass", detail: problem ?? "ok" });
  try {
    await a.apply(stack);
    const up = await waitFor(async () => (await a.status(ws)).find((s) => s.serviceName === "tb-probe" && s.state === "running") ?? null, 60, sleep);
    row("L-1", "apply brings the service up from its digest image", up ? null : "tb-probe not running after 60 s");
    await a.apply(stack);
    const again = (await a.status(ws)).filter((s) => s.serviceName === "tb-probe");
    row(
      "L-2",
      "apply is idempotent (same single service, still running)",
      again.length === 1 && again[0]?.state === "running" ? null : `status after second apply: ${JSON.stringify(again)}`,
    );
    const volsBefore = await a.volumesOf(ws);
    await a.stop(ws, "tb-probe");
    const stopped = await waitFor(async () => ((await a.status(ws)).find((s) => s.serviceName === "tb-probe")?.state === "stopped" ? true : null), 30, sleep);
    const volsAfter = await a.volumesOf(ws);
    row(
      "L-3",
      "stop stops the service and KEEPS its volumes (H-9)",
      stopped && volsBefore.length > 0 && JSON.stringify(volsBefore) === JSON.stringify(volsAfter)
        ? null
        : `stopped=${Boolean(stopped)} volumes before ${JSON.stringify(volsBefore)} after ${JSON.stringify(volsAfter)}`,
    );
  } catch (e) {
    rows.push({ id: "L-0", title: "live run", status: "fail", detail: (e as Error).message });
  }
  return rows;
}

/** Runs every static row; the live rows only when `live` is given. The suite passes only when no row is "fail". */
export async function runConformance(
  adapter: EngineAdapter,
  opts: { live?: LiveOptions } = {},
): Promise<{ ok: boolean; adapter: string; rows: ConformanceRow[] }> {
  const rows: ConformanceRow[] = [];
  for (const s of STATIC) {
    let problem: string | null;
    try {
      problem = await s.probe(adapter);
    } catch (e) {
      problem = `threw ${(e as Error).name}: ${(e as Error).message}`;
    }
    rows.push({ id: s.id, title: s.title, status: problem ? "fail" : "pass", detail: problem ?? "ok" });
  }
  if (opts.live) rows.push(...(await liveRows(adapter, opts.live)));
  else
    rows.push({
      id: "L-*",
      title: "live rows (apply, idempotent, stop keeps volumes)",
      status: "skip",
      detail: "no live options: run on a box with Docker (TB_FIXTURE_LIVE=1)",
    });
  return { ok: rows.every((r) => r.status !== "fail"), adapter: adapter.name, rows };
}
