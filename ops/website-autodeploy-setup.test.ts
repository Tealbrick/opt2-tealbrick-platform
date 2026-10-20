// C293a: ops/website-autodeploy-setup.ts with a mocked Woodpecker (no network, no real token, no prompt).
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkToken, EVENTS, parseArgs, planLines, REPO, SECRET_NAME, type SecretInfo, storeSecret } from "./website-autodeploy-setup.ts";

// key-shaped strings are assembled at run time so the secret scan never sees a token shape in this file
const GH = ["github", "pat", "11TESTONLY0123456789", "abcdefghijklmnopqrstuvwxyz"].join("_");
const WP = { url: "https://wp.example.test", token: "wp-test-token-abcdefgh" };
const T = { timeout: 10_000 };

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  auth: string | null;
}
interface Mock {
  fetch: typeof fetch;
  calls: Call[];
  secrets: SecretInfo[];
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A small Woodpecker: repo lookup, secret list/get/create/update. `storeEvents` lets a test simulate a server that changes the filter. */
function mock(opts: { secrets?: SecretInfo[]; lookup?: Record<string, number>; storeEvents?: string[] } = {}): Mock {
  const m: Mock = { calls: [], secrets: opts.secrets ?? [], fetch: undefined as unknown as typeof fetch };
  const lookup = opts.lookup ?? { [REPO]: 42 };
  m.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    m.calls.push({ method, path: u.pathname + u.search, ...(body ? { body } : {}), auth: (init?.headers as Record<string, string>)?.authorization ?? null });
    const lookupHit = /^\/api\/repos\/lookup\/(.+)$/.exec(u.pathname);
    if (lookupHit) {
      const id = lookup[decodeURIComponent(lookupHit[1] as string)];
      return id ? json(200, { id, active: true }) : json(404, { message: "not found" });
    }
    if (method === "GET" && u.pathname === "/api/repos/42/secrets")
      return json(
        200,
        m.secrets.map((s) => ({ ...s, value: undefined })),
      );
    const one = /^\/api\/repos\/42\/secrets\/(.+)$/.exec(u.pathname);
    if (one && method === "GET") return m.secrets.some((s) => s.name === one[1]) ? json(200, { name: one[1] }) : json(404, { message: "not found" });
    if (method === "POST" && u.pathname === "/api/repos/42/secrets") {
      m.secrets.push({ name: String(body?.name), events: opts.storeEvents ?? (body?.events as string[]), images: [] });
      return json(200, { name: body?.name });
    }
    if (method === "PATCH" && one) {
      const i = m.secrets.findIndex((s) => s.name === one[1]);
      m.secrets[i] = { name: String(body?.name), events: opts.storeEvents ?? (body?.events as string[]), images: [] };
      return json(200, { name: body?.name });
    }
    return json(500, { message: `unmocked ${method} ${u.pathname}` });
  }) as typeof fetch;
  return m;
}

test("checkToken: only a fine-grained GitHub token passes; the reason never holds the value", T, () => {
  assert.equal(checkToken(GH), null);
  for (const bad of ["", "abc", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", `${GH} x`, "github_pat_short"]) {
    const why = checkToken(bad);
    assert.ok(why, bad);
    assert.ok(!why.includes(bad) || bad === "");
  }
});

test("parseArgs: only --dry-run", T, () => {
  assert.deepEqual(parseArgs([]), { dryRun: false });
  assert.deepEqual(parseArgs(["--dry-run"]), { dryRun: true });
  assert.throws(() => parseArgs(["--force"]), /unknown option/);
});

test("planLines: names the repo, the secret and exactly push + tag; no value", T, () => {
  const text = planLines().join("\n");
  assert.ok(text.includes(REPO) && text.includes(SECRET_NAME));
  assert.ok(text.includes("push, tag"));
  assert.ok(!text.includes("github_pat_"));
});

test("storeSecret: creates the secret with events exactly push + tag and no image filter", T, async () => {
  const m = mock();
  const out = await storeSecret(WP, GH, m.fetch);
  const post = m.calls.find((c) => c.method === "POST");
  assert.deepEqual(post?.body, { name: "site_deploy_token", value: GH, events: ["push", "tag"], images: [] });
  assert.deepEqual([...EVENTS], ["push", "tag"]);
  assert.equal(out.at(-1), "done");
  assert.match(out[0] ?? "", /created site_deploy_token for Tealbrick\/opt2-tealbrick-website \(events push, tag\)/);
});

test("storeSecret: an existing secret is updated (PATCH), not duplicated", T, async () => {
  const m = mock({ secrets: [{ name: "site_deploy_token", events: ["push", "tag", "pull_request"], images: [] }] });
  const out = await storeSecret(WP, GH, m.fetch);
  assert.ok(m.calls.some((c) => c.method === "PATCH"));
  assert.ok(!m.calls.some((c) => c.method === "POST"));
  assert.deepEqual(m.secrets[0]?.events, ["push", "tag"]);
  assert.match(out[0] ?? "", /^updated /);
});

test("storeSecret: the value appears in no output line, no URL and only in the one write body", T, async () => {
  const m = mock({ secrets: [{ name: "tb_release_token", events: ["manual", "tag"] }] });
  const out = await storeSecret(WP, GH, m.fetch);
  assert.ok(!out.join("\n").includes(GH));
  assert.match(out[1] ?? "", /secret names of .*: site_deploy_token, tb_release_token/);
  for (const c of m.calls) assert.ok(!c.path.includes(GH), "no value in a URL");
  const withValue = m.calls.filter((c) => JSON.stringify(c.body ?? {}).includes(GH));
  assert.equal(withValue.length, 1);
  assert.ok(withValue[0]?.method === "POST" || withValue[0]?.method === "PATCH");
  for (const c of m.calls) assert.equal(c.auth, `Bearer ${WP.token}`, "the GitHub value is never an Authorization header");
});

test("storeSecret: the verification lists names only and never reads a value back", T, async () => {
  const m = mock();
  await storeSecret(WP, GH, m.fetch);
  const reads = m.calls.filter((c) => c.method === "GET" && c.path.includes("/secrets"));
  assert.ok(reads.length >= 1);
  assert.ok(m.calls.every((c) => c.method !== "DELETE"));
});

test("storeSecret: refuses when Woodpecker keeps other events than push + tag", T, async () => {
  const m = mock({ storeEvents: ["push", "tag", "pull_request"] });
  await assert.rejects(
    () => storeSecret(WP, GH, m.fetch),
    (e: Error) => /must have exactly \[push, tag\]/.test(e.message) && !e.message.includes(GH),
  );
});

test("storeSecret: an unknown repo gives a clear error and writes nothing", T, async () => {
  const m = mock({ lookup: {} });
  await assert.rejects(() => storeSecret(WP, GH, m.fetch), /not in Woodpecker/);
  assert.ok(m.calls.every((c) => c.method === "GET"));
});

test("storeSecret: falls back to the old owner name Woodpecker may still use", T, async () => {
  const m = mock({ lookup: { "Martin-Atrin/opt2-tealbrick-website": 42 } });
  const out = await storeSecret(WP, GH, m.fetch);
  assert.equal(out.at(-1), "done");
});

test("storeSecret: a Woodpecker failure and a network error carry no token", T, async () => {
  const failing = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.pathname.startsWith("/api/repos/lookup/")) return json(200, { id: 42 });
    if ((init?.method ?? "GET") === "GET") return json(404, {});
    return json(500, { message: `boom ${GH}` });
  }) as typeof fetch;
  await assert.rejects(
    () => storeSecret(WP, GH, failing),
    (e: Error) => /HTTP 500/.test(e.message) && !e.message.includes(GH),
  );
  const down = (async () => {
    throw new Error(`connect refused ${GH} ${WP.token}`);
  }) as typeof fetch;
  await assert.rejects(
    () => storeSecret(WP, GH, down),
    (e: Error) => !e.message.includes(GH) && !e.message.includes(WP.token),
  );
});
