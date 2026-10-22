import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Runner, RunResult } from "../box.ts";
import { ComposeCaddyAdapter, defaultHostPort } from "./compose-caddy.ts";
import { runConformance, sampleService, sampleStack } from "./conformance.ts";
import { type EngineAdapter, type Rendered, SpecRefusal, type StackSpec } from "./contract.ts";
import { validateServiceSpec, validateStack } from "./schema.ts";

const DIGEST_IMG = `ghcr.io/example/probe@sha256:${"7".repeat(64)}`;
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

/** A scripted docker: compose up/stop change container states, volumes persist. */
function fakeDocker() {
  const calls: string[][] = [];
  const state = { running: new Set<string>(), exited: new Set<string>(), caddy: false, volumes: new Set<string>() };
  const r: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd !== "docker") return { code: 127, stdout: "", stderr: "no" };
    const [sub, ...rest] = args;
    if (sub === "compose") {
      const verb = rest.find((a) => ["up", "stop"].includes(a));
      const file = rest[rest.indexOf("-f") + 1] as string;
      const services = rest.slice(rest.indexOf(verb as string) + 1).filter((a) => a !== "-d");
      const ws = /\/stacks\/([^/]+)\//.exec(file)?.[1] as string;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/^ {2}(tb-[a-z0-9-]+_[a-z0-9-]+):\n {4}name: (\S+)$/gm)) state.volumes.add(m[2] as string);
      for (const s of services) {
        const key = `${ws}/${s}`;
        if (verb === "up") {
          state.running.add(key);
          state.exited.delete(key);
        } else {
          state.running.delete(key);
          state.exited.add(key);
        }
      }
      return ok();
    }
    if (sub === "ps") {
      const proj = /project=tbws-(\S+)/.exec(rest.join(" "))?.[1] as string;
      const rows = [...state.running].filter((k) => k.startsWith(`${proj}/`)).map((k) => `${k.split("/")[1]}\t${DIGEST_IMG}\trunning\tUp 2 seconds`);
      rows.push(...[...state.exited].filter((k) => k.startsWith(`${proj}/`)).map((k) => `${k.split("/")[1]}\t${DIGEST_IMG}\texited\tExited (0) 1 second ago`));
      return ok(`${rows.join("\n")}\n`);
    }
    if (sub === "volume")
      return ok(`${[...state.volumes].filter((v) => v.startsWith(`tbws-${/name=tbws-([^_]+)_/.exec(rest.join(" "))?.[1]}_`)).join("\n")}\n`);
    if (sub === "inspect") return state.caddy ? ok("true\n") : { code: 1, stdout: "", stderr: "No such object" };
    if (sub === "run") {
      state.caddy = true;
      return ok("id\n");
    }
    return ok();
  };
  return { r, calls, state };
}

const newAdapter = (stateDir = mkdtempSync(join(tmpdir(), "tb-fixture-"))) => {
  const d = fakeDocker();
  let n = 0;
  const a = new ComposeCaddyAdapter({
    r: d.r,
    stateDir,
    acmeEmail: "ops@example.net",
    caddyImage: `caddy@sha256:${"c".repeat(64)}`,
    randomSecret: () => `secret-${++n}-${"x".repeat(40)}`,
  });
  return { a, d, stateDir };
};

test("fixture: passes the full static conformance suite", async () => {
  const { a } = newAdapter();
  const res = await runConformance(a);
  assert.deepEqual(
    res.rows.filter((r) => r.status === "fail"),
    [],
  );
  assert.equal(res.ok, true);
  assert.deepEqual(
    res.rows.filter((r) => r.status === "pass").map((r) => r.id),
    ["E-1", "E-2", "E-3", "E-4", "E-5", "E-6", "E-7", "E-8", "E-9", "E-10"],
  );
  assert.equal(res.rows.find((r) => r.id === "L-*")?.status, "skip");
});

test("fixture: the live rows pass against a scripted docker (apply, idempotent, stop keeps volumes)", async () => {
  const { a } = newAdapter();
  const res = await runConformance(a, { live: { image: DIGEST_IMG, port: 8080, sleep: async () => undefined } });
  assert.deepEqual(
    res.rows.filter((r) => r.status === "fail"),
    [],
  );
  assert.deepEqual(
    res.rows.filter((r) => r.id.startsWith("L-")).map((r) => r.id),
    ["L-1", "L-2", "L-3"],
  );
});

/** Adapters that break the contract in one way each: the suite must catch every one (a suite that cannot fail proves nothing). */
function broken(base: EngineAdapter, over: Partial<EngineAdapter>): EngineAdapter {
  return {
    name: "broken",
    render: (s) => base.render(s),
    apply: (s) => base.apply(s),
    stop: (w, n) => base.stop(w, n),
    status: (w) => base.status(w),
    originsFor: (s) => base.originsFor(s),
    volumesOf: (w) => base.volumesOf(w),
    scopeOf: (s) => base.scopeOf(s),
    ...over,
  };
}

test("conformance: an adapter that passes compose through (no closed schema) fails E-1, E-2, E-6", async () => {
  const { a } = newAdapter();
  const leaky = broken(a, {
    render: (s: StackSpec): Rendered => ({
      engine: "leaky",
      documents: [
        {
          name: "compose.yaml",
          text: s.services
            .map((x) => `  ${x.serviceName}:\n    network_mode: ${JSON.stringify((x as unknown as Record<string, string>).network_mode ?? "bridge")}\n`)
            .join(""),
        },
      ],
    }),
  });
  const res = await runConformance(leaky);
  const failed = res.rows.filter((r) => r.status === "fail").map((r) => r.id);
  for (const id of ["E-1", "E-2", "E-3", "E-4", "E-5", "E-6"]) assert.ok(failed.includes(id), `${id} should fail, failed: ${failed}`);
  assert.equal(res.ok, false);
});

test("conformance: wrong origins, shared networks, wildcard publish, stop that drops volumes are each caught", async () => {
  const { a } = newAdapter();
  assert.ok(
    (await runConformance(broken(a, { originsFor: () => ["http://172.18.0.5:8080", "http://tb-knowledge.internal:8080"] }))).rows.find(
      (r) => r.id === "E-7" && r.status === "fail",
    ),
  );
  assert.ok(
    (await runConformance(broken(a, { scopeOf: () => ({ networks: ["shared"], volumes: ["v"] }) }))).rows.find((r) => r.id === "E-9" && r.status === "fail"),
  );
  const wide = broken(a, {
    render: (s) => {
      const r = a.render(s);
      return { ...r, documents: r.documents.map((d) => (d.name === "compose.yaml" ? { ...d, text: d.text.replace("127.0.0.1:", "0.0.0.0:") } : d)) };
    },
  });
  assert.ok((await runConformance(wide)).rows.find((r) => r.id === "E-6" && r.status === "fail"));
  const secretLeak = broken(a, { render: (s) => ({ engine: "x", documents: [...a.render(s).documents, { name: "env", text: `KEK=${"ab".repeat(32)}\n` }] }) });
  assert.ok((await runConformance(secretLeak)).rows.find((r) => r.id === "E-8" && r.status === "fail"));
  // live: a stop that removes the volumes
  const { a: b, d } = newAdapter();
  const dropper = broken(b, {
    stop: async (w, n) => {
      await b.stop(w, n);
      d.state.volumes.clear();
    },
  });
  const res = await runConformance(dropper, { live: { image: DIGEST_IMG, port: 8080, sleep: async () => undefined } });
  assert.equal(res.rows.find((r) => r.id === "L-3")?.status, "fail");
});

test("render: one compose project per workspace, named volumes, only the bridge published and only on loopback, Caddy for both hosts", () => {
  const { a } = newAdapter();
  const r = a.render(sampleStack("ws-a"));
  const compose = r.documents.find((d) => d.name === "compose.yaml")?.text as string;
  assert.match(compose, /^name: tbws-ws-a$/m);
  assert.match(compose, /^ {2}tb-bridge:\n {4}image: ghcr\.io\/tealbrick\/opt2-tealbrick-bridge-server@sha256:c{64}$/m);
  assert.deepEqual(compose.match(/^\s+ports:/gm)?.length, 1, "exactly one service publishes a port");
  assert.match(compose, new RegExp(`"127\\.0\\.0\\.1:${defaultHostPort("ws-a", "tb-bridge")}:3000"`));
  assert.match(compose, /- "tb-gbrain-db_pgdata:\/var\/lib\/postgresql\/data"/);
  assert.match(compose, /name: tbws-ws-a_tb-gbrain-db_pgdata/);
  assert.ok(!/volumes:\s*\n\s+- "\//.test(compose), "no bind mount");
  assert.match(compose, /security_opt: \["no-new-privileges:true"\]/);
  const caddy = r.documents.find((d) => d.name === "ws-a.caddy")?.text as string;
  assert.match(caddy, /^ws-a\.ws\.example\.net \{\n {2}reverse_proxy 127\.0\.0\.1:\d+\n\}/m);
  assert.match(caddy, /^k-ws-a\.ws\.example\.net \{/m);
  assert.equal(JSON.stringify(a.render(sampleStack("ws-a"))), JSON.stringify(r), "deterministic");
  // a hostPorts override from the agent's registry wins
  const o = a.render({ ...sampleStack("ws-a"), hostPorts: { "tb-bridge": 24567 } });
  assert.match(o.documents.find((d) => d.name === "compose.yaml")?.text as string, /127\.0\.0\.1:24567:3000/);
});

test("apply: env files are root-only, secrets generated once and kept, refs resolved on the box, Caddy ensured and reloaded", async () => {
  const { a, d, stateDir } = newAdapter();
  const stack = sampleStack("ws-a");
  await a.apply(stack);
  const bridgeEnv = join(stateDir, "stacks", "ws-a", "env", "tb-bridge.env");
  assert.equal(statSync(bridgeEnv).mode & 0o777, 0o600);
  const kek1 = /TB_KEK=(\S+)/.exec(readFileSync(bridgeEnv, "utf8"))?.[1];
  assert.match(kek1 ?? "", /^secret-1-/);
  assert.match(readFileSync(join(stateDir, "stacks", "ws-a", "env", "tb-knowledge.env"), "utf8"), /^GBRAIN_DB_URL=postgres:\/\/db$/m);
  await a.apply(stack);
  assert.equal(/TB_KEK=(\S+)/.exec(readFileSync(bridgeEnv, "utf8"))?.[1], kek1, "a second apply keeps the generated secret");
  // the secret never appears in the command lines or the rendered documents
  assert.ok(!d.calls.some((c) => c.join(" ").includes(kek1 as string)));
  assert.ok(!a.render(stack).documents.some((x) => x.text.includes(kek1 as string)));
  assert.equal(d.calls.filter((c) => c[1] === "run").length, 1, "Caddy is started once");
  assert.ok(d.calls.some((c) => c[1] === "exec" && c.includes("reload")));
  assert.ok(
    d.calls.some((c) => c[1] === "run" && c.includes("--network") && c[c.indexOf("--network") + 1] === "host" && c.some((x) => x.startsWith("caddy@sha256:"))),
  );
});

test("stop keeps the volumes and the service stays stopped through the next apply", async () => {
  const { a, d } = newAdapter();
  const stack = sampleStack("ws-a");
  await a.apply(stack);
  const volumes = await a.volumesOf("ws-a");
  assert.equal(volumes.length, 3);
  await a.stop("ws-a", "tb-knowledge");
  assert.ok(
    !d.calls.some(
      (c) =>
        (c[1] === "compose" && (c.includes("down") || c.includes("-v") || c.includes("--volumes") || c.includes("rm"))) ||
        (c[1] === "volume" && c.includes("rm")),
    ),
    "no compose down/rm/-v, no volume rm",
  );
  assert.deepEqual(await a.volumesOf("ws-a"), volumes);
  assert.equal((await a.status("ws-a")).find((s) => s.serviceName === "tb-knowledge")?.state, "stopped");
  await a.apply(stack);
  assert.equal((await a.status("ws-a")).find((s) => s.serviceName === "tb-knowledge")?.state, "stopped", "apply does not restart a stopped service");
  const up = d.calls.filter((c) => c[1] === "compose" && c.includes("up")).pop() as string[];
  assert.ok(!up.includes("tb-knowledge"));
});

test("schema: the closed service schema refuses what the contract says", () => {
  const s = sampleService({ serviceName: "tb-x" });
  assert.doesNotThrow(() => validateServiceSpec(s));
  const code = (over: Record<string, unknown>) => {
    try {
      validateServiceSpec({ ...s, ...over });
      return "accepted";
    } catch (e) {
      return e instanceof SpecRefusal ? e.code : "other";
    }
  };
  assert.equal(code({ privileged: true }), "forbidden_field");
  assert.equal(code({ cap_add: ["SYS_ADMIN"] }), "forbidden_field");
  assert.equal(code({ devices: ["/dev/kvm"] }), "forbidden_field");
  assert.equal(code({ env_file: ["/etc/shadow"] }), "forbidden_field");
  assert.equal(code({ whatever: 1 }), "unknown_field");
  assert.equal(code({ port: 70000 }), "bad_field");
  assert.equal(code({ env: { lower: "x" } }), "bad_field");
  assert.equal(code({ env: { A: "line1\nline2" } }), "bad_field");
  assert.equal(code({ generatedSecrets: ["A", "A"] }), "duplicate");
  assert.equal(code({ env: { A: "1" }, generatedSecrets: ["A"] }), "duplicate");
  assert.equal(code({ healthPath: "/../x" }), "bad_field");
  assert.equal(code({ resources: { cpu: 64 } }), "bad_field");
  assert.equal(
    code({
      volumes: [
        { name: "d", mountPath: "/data", purpose: "data" },
        { name: "e", mountPath: "/data", purpose: "data" },
      ],
    }),
    "duplicate",
  );
  assert.throws(() => validateStack({ workspace: "Bad WS", zone: "ws.example.net", services: [] }), SpecRefusal);
  assert.throws(() => validateStack({ ...sampleStack(), services: [...sampleStack().services, sampleStack().services[1] as never] }), /appears twice/);
  const two = sampleStack();
  const b = two.services[0] as never;
  assert.throws(
    () => validateStack({ ...two, services: [...two.services, { ...(b as object), serviceName: "tb-bridge-2" } as never] }),
    /more than one public service/,
  );
});
