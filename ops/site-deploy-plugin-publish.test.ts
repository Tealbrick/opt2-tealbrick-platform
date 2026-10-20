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
function harness(over: { status?: number; build?: Partial<RunResult>; login?: Partial<RunResult> } = {}) {
  const calls: Call[] = [];
  const fetches: { url: string; auth: string | null }[] = [];
  const logs: string[] = [];
  const deps: Deps = {
    log: (l) => logs.push(l),
    readToken: () => TOKEN,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      fetches.push({ url: String(url), auth: (init?.headers as Record<string, string>)?.authorization ?? null });
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
  return { deps, calls, fetches, logs };
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
  assert.match(h.fetches[0]?.url ?? "", /\/api\/v1\/packages\/polygonface\/container\/tb-site-deploy\/1\.0\.0$/);
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
