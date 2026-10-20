// C293a: ops/site-deploy-plugin-publish.ts with a mocked registry and a mocked docker (no network, no real token, nothing built).
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IMAGE_NAME, pluginImage, pluginVersion } from "./site-deploy-plugin/image.ts";
import { type Deps, parseArgs, publish, type RunResult, readTokenFile, tagExists } from "./site-deploy-plugin-publish.ts";

const T = { timeout: 10_000 };
const TOKEN = ["fg", "TESTONLY0123456789abcdef0123456789abcd"].join("");
const DIGEST = `sha256:${"a".repeat(64)}`;

interface Call {
  cmd: string;
  args: string[];
  input?: string;
}
interface Over {
  /** HTTP status of the version path (default 404 = free) */
  status?: number;
  /** HTTP status of the package list (default 200) */
  listStatus?: number;
  listBody?: unknown;
  build?: Partial<RunResult>;
  login?: Partial<RunResult>;
}
function harness(over: Over = {}) {
  const calls: Call[] = [];
  const fetches: { url: string; auth: string | null }[] = [];
  const logs: string[] = [];
  const digests: string[] = [];
  const handlers = new Map<string, () => void | Promise<void>>();
  const exits: number[] = [];
  let killed = 0;
  const deps: Deps = {
    log: (l) => logs.push(l),
    readToken: () => TOKEN,
    writeDigest: (version, digest) => digests.push(`${version} ${digest}`),
    killChild: () => {
      killed++;
    },
    signals: {
      on: (sig, fn) => handlers.set(sig, fn),
      off: (sig, fn) => {
        if (handlers.get(sig) === fn) handlers.delete(sig);
      },
      exit: (code) => {
        exits.push(code);
      },
    },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      fetches.push({ url: u, auth: (init?.headers as Record<string, string>)?.authorization ?? null });
      if (u.includes("?type=container")) return new Response(JSON.stringify(over.listBody ?? []), { status: over.listStatus ?? 200 });
      return new Response("{}", { status: over.status ?? 404 });
    }) as typeof fetch,
    run: (cmd, args, input) => {
      calls.push({ cmd, args, ...(input === undefined ? {} : { input }) });
      if (args[0] === "login") return { status: 0, stdout: "", stderr: "", ...over.login };
      if (args[0] === "buildx") {
        const meta = args[args.indexOf("--metadata-file") + 1] as string;
        writeFileSync(meta, JSON.stringify({ "containerimage.digest": DIGEST }));
        return { status: 0, stdout: "", stderr: "", ...over.build };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  return { deps, calls, fetches, logs, digests, handlers, exits, killed: () => killed };
}

test("the image name and the version come from one place", T, () => {
  assert.equal(IMAGE_NAME, "forge.polygonface.com/polygonface/tb-site-deploy");
  assert.equal(pluginVersion(), "1.0.0");
  assert.equal(pluginImage(), "forge.polygonface.com/polygonface/tb-site-deploy:1.0.0");
  assert.throws(() => pluginVersion(() => "latest"), /X\.Y\.Z/);
  assert.throws(() => pluginVersion(() => "1.0"), /X\.Y\.Z/);
});

test("dry run is the default: it prints the plan and makes no call", T, async () => {
  const h = harness();
  const out = await publish(parseArgs([]), h.deps);
  assert.ok(out.join("\n").includes("forge.polygonface.com/polygonface/tb-site-deploy:1.0.0"));
  assert.match(out.join("\n"), /dry run: nothing was built, nothing was pushed/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.fetches.length, 0);
});

test("parseArgs: --push, --user, FORGE_USER; unknown options and bad names are refused", T, () => {
  assert.deepEqual(parseArgs([], {}), { push: false, user: null });
  assert.deepEqual(parseArgs(["--push", "--user", "martin"], {}), { push: true, user: "martin" });
  assert.deepEqual(parseArgs(["--push"], { FORGE_USER: "martin" }), { push: true, user: "martin" });
  assert.throws(() => parseArgs(["--force"], {}), /unknown option/);
  assert.throws(() => parseArgs(["--user"], {}), /needs a value/);
  assert.throws(() => parseArgs(["--user", "a b; rm"], {}), /login name/);
});

test("--push without --user is refused before the token is read", T, async () => {
  const h = harness();
  let read = 0;
  h.deps.readToken = () => {
    read++;
    return TOKEN;
  };
  await assert.rejects(() => publish({ push: true, user: null }, h.deps), /--user/);
  assert.equal(read, 0);
});

test("--push: a free tag -> login (token on stdin only), multi-arch buildx --push of exactly that tag, logout, digest printed", T, async () => {
  const h = harness({ status: 404 });
  const out = await publish({ push: true, user: "martin" }, h.deps);
  assert.deepEqual(
    h.calls.map((c) => `${c.cmd} ${c.args[0]}`),
    ["docker login", "docker buildx", "docker logout"],
  );
  const login = h.calls[0] as Call;
  assert.equal(login.input, `${TOKEN}\n`);
  assert.ok(login.args.includes("--password-stdin"));
  const build = h.calls[1] as Call;
  assert.ok(build.args.includes("--push"));
  assert.equal(build.args[build.args.indexOf("--tag") + 1], "forge.polygonface.com/polygonface/tb-site-deploy:1.0.0");
  assert.equal(build.args[build.args.indexOf("--platform") + 1], "linux/amd64,linux/arm64");
  assert.ok(!build.args.includes("--force") && !build.args.some((a) => a.includes("latest")));
  assert.ok(out.some((l) => l === "pushed forge.polygonface.com/polygonface/tb-site-deploy:1.0.0"));
  assert.ok(out.some((l) => l === `digest ${DIGEST}`));
  assert.ok(out.some((l) => l.endsWith(`:1.0.0@${DIGEST}`)));
  for (const c of h.calls) assert.ok(!JSON.stringify(c.args).includes(TOKEN), "the token is never on argv");
  assert.match(h.fetches[1]?.url ?? "", /\/api\/v1\/packages\/polygonface\/container\/tb-site-deploy\/1\.0\.0$/);
});

test("--push: a tag that already exists in the registry is REFUSED; no login, no build, no push", T, async () => {
  const h = harness({ status: 200 });
  await assert.rejects(
    () => publish({ push: true, user: "martin" }, h.deps),
    (e: Error) =>
      /already exists in the registry\. A tag is never reused/.test(e.message) && /Nothing was pushed/.test(e.message) && !e.message.includes(TOKEN),
  );
  assert.equal(h.calls.length, 0);
});

test("--push: if the registry cannot say (HTTP 500 or network down) nothing is pushed", T, async () => {
  for (const status of [401, 403, 500]) {
    const h = harness({ status });
    await assert.rejects(() => publish({ push: true, user: "martin" }, h.deps), /cannot tell whether/);
    assert.equal(h.calls.length, 0);
  }
  const h = harness();
  h.deps.fetch = (async () => {
    throw new Error(`down ${TOKEN}`);
  }) as typeof fetch;
  await assert.rejects(
    () => publish({ push: true, user: "martin" }, h.deps),
    (e: Error) => /cannot ask the registry/.test(e.message) && !e.message.includes(TOKEN),
  );
  assert.equal(h.calls.length, 0);
});

test("no token text in any output or error, also when docker echoes it; logout still runs", T, async () => {
  const h = harness({ build: { status: 1, stderr: `denied for ${TOKEN}` } });
  await assert.rejects(
    () => publish({ push: true, user: "martin" }, h.deps),
    (e: Error) => /docker buildx build --push failed/.test(e.message) && !e.message.includes(TOKEN),
  );
  assert.deepEqual(h.calls.at(-1)?.args, ["logout", "forge.polygonface.com"]);
  const h2 = harness({ login: { status: 1, stderr: `bad login ${TOKEN}` } });
  await assert.rejects(
    () => publish({ push: true, user: "martin" }, h2.deps),
    (e: Error) => !e.message.includes(TOKEN),
  );
  assert.ok(!h2.calls.some((c) => c.args[0] === "buildx"), "no build after a failed login");
});

test("the token is sent to Forgejo only as an Authorization header", T, async () => {
  const h = harness({ status: 404 });
  await tagExists(h.deps.fetch, TOKEN, "1.0.0");
  assert.equal(h.fetches[0]?.auth, `token ${TOKEN}`);
  assert.ok(!h.fetches[0]?.url.includes(TOKEN));
});

test("readTokenFile: mode 600 and one token; group-readable or empty files are refused without printing the content", T, () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-publish-test-"));
  const f = join(dir, "forge-packages-token");
  writeFileSync(f, `${TOKEN}\n`);
  chmodSync(f, 0o644);
  assert.throws(
    () => readTokenFile(f),
    (e: Error) => /must be mode 600/.test(e.message) && !e.message.includes(TOKEN),
  );
  chmodSync(f, 0o600);
  assert.equal(readTokenFile(f), TOKEN);
  writeFileSync(f, "two words\n");
  assert.throws(() => readTokenFile(f), /exactly one token/);
  assert.throws(() => readTokenFile(join(dir, "missing")), /no token file/);
});

test("tagExists fails CLOSED: the package list must answer 200 with a JSON array before a 404 on the tag counts as 'free'", T, async () => {
  const free = harness({ status: 404 });
  assert.equal(await tagExists(free.deps.fetch, TOKEN, "1.0.0"), false);
  assert.match(free.fetches[0]?.url ?? "", /\/api\/v1\/packages\/polygonface\?type=container&q=tb-site-deploy&limit=50$/, "the list is asked first");
  assert.match(free.fetches[1]?.url ?? "", /container\/tb-site-deploy\/1\.0\.0$/);
  for (const listStatus of [401, 403, 404, 500]) {
    const h = harness({ listStatus, status: 404 });
    await assert.rejects(() => tagExists(h.deps.fetch, TOKEN, "1.0.0"), /cannot tell whether .*the package list answered HTTP/);
    assert.equal(h.fetches.length, 1, "no version request after a bad list");
  }
  const notArray = harness({ listBody: { message: "hi" }, status: 404 });
  await assert.rejects(() => tagExists(notArray.deps.fetch, TOKEN, "1.0.0"), /not a JSON array/);
  const full = harness({ listBody: Array.from({ length: 50 }, (_, i) => ({ name: `p${i}`, version: "1" })), status: 404 });
  await assert.rejects(() => tagExists(full.deps.fetch, TOKEN, "1.0.0"), /full/);
  const odd = harness({ status: 502 });
  await assert.rejects(() => tagExists(odd.deps.fetch, TOKEN, "1.0.0"), /version path answered HTTP 502/);
});

test("tagExists: the version in the list means 'exists' even if the version path says 404; 200 on the path means 'exists'", T, async () => {
  const listed = harness({ listBody: [{ name: "tb-site-deploy", version: "1.0.0" }], status: 404 });
  assert.equal(await tagExists(listed.deps.fetch, TOKEN, "1.0.0"), true);
  assert.equal(listed.fetches.length, 1);
  const other = harness({ listBody: [{ name: "tb-site-deploy", version: "0.9.0" }], status: 404 });
  assert.equal(await tagExists(other.deps.fetch, TOKEN, "1.0.0"), false);
  const direct = harness({ status: 200 });
  assert.equal(await tagExists(direct.deps.fetch, TOKEN, "1.0.0"), true);
});

test("--push: records the digest for the version and tells the next step; a refused or failed run records nothing", T, async () => {
  const h = harness();
  const out = await publish({ push: true, user: "martin" }, h.deps);
  assert.deepEqual(h.digests, [`1.0.0 ${DIGEST}`]);
  assert.ok(out.some((l) => l.includes("IMAGE-DIGEST")) && out.some((l) => l.startsWith("next:")));
  const bad = harness({ status: 200 });
  await assert.rejects(() => publish({ push: true, user: "martin" }, bad.deps));
  assert.deepEqual(bad.digests, []);
  const failed = harness({ build: { status: 1 } });
  await assert.rejects(() => publish({ push: true, user: "martin" }, failed.deps));
  assert.deepEqual(failed.digests, []);
});

test("logout runs in the finally block on success and on failure, exactly once", T, async () => {
  const ok = harness();
  await publish({ push: true, user: "martin" }, ok.deps);
  assert.equal(ok.calls.filter((c) => c.args[0] === "logout").length, 1);
  const failed = harness({ build: { status: 1, stderr: "x" } });
  await assert.rejects(() => publish({ push: true, user: "martin" }, failed.deps));
  assert.equal(failed.calls.filter((c) => c.args[0] === "logout").length, 1);
});

test("SIGINT and SIGTERM: the child is stopped, docker logout runs, the process exits 130/143; the handlers are removed after the run", T, async () => {
  for (const [sig, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    const h = harness();
    // stop the run in the middle of the build: the signal arrives while docker buildx is running
    const run = h.deps.run;
    let pending: Promise<void> | undefined;
    h.deps.run = (cmd, args, input) => {
      if (args[0] === "buildx") pending = Promise.resolve(h.handlers.get(sig)?.());
      return run(cmd, args, input);
    };
    await publish({ push: true, user: "martin" }, h.deps);
    await pending;
    assert.equal(h.killed(), 1, `${sig}: the running build is stopped`);
    assert.equal(h.calls.filter((c) => c.args[0] === "logout").length, 1, `${sig}: exactly one logout (the handler's; the finally does not repeat it)`);
    assert.deepEqual(h.exits, [code]);
    assert.equal(h.handlers.size, 0, "the handlers are removed at the end");
  }
});

test("before the login no handler is needed and no logout happens when the registry check stops the run", T, async () => {
  const h = harness({ status: 200 });
  await assert.rejects(() => publish({ push: true, user: "martin" }, h.deps));
  assert.equal(h.calls.length, 0);
  assert.equal(h.handlers.size, 0);
});
