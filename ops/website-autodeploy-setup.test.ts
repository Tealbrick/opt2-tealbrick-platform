// C293a: ops/website-autodeploy-setup.ts with a mocked Woodpecker (no network, no real token, no prompt).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkKey,
  checkToken,
  EVENTS,
  KEY_SECRET,
  parseArgs,
  planLines,
  REPO,
  requireHttps,
  SECRET_NAMES,
  type SecretInfo,
  storeSecrets,
  TOKEN_SECRET,
} from "./website-autodeploy-setup.ts";

// key-shaped strings are assembled at run time so the secret scan never sees a token shape in this file
const GH = ["github", "pat", "11TESTONLY0123456789", "abcdefghijklmnopqrstuvwxyz"].join("_");
const WP = { url: "https://wp.example.test", token: "wp-test-token-abcdefgh" };

/** A key-shaped test value built at run time: the openssh-key-v1 header, cipher "none", key type ssh-ed25519, filler. Not a real key. */
function fakeKey(cipher = "none", type = "ssh-ed25519"): string {
  const u32 = (n: number) => Buffer.from([0, 0, 0, n]);
  const str = (t: string) => Buffer.concat([u32(t.length), Buffer.from(t, "latin1")]);
  const raw = Buffer.concat([Buffer.from("openssh-key-v1\0", "latin1"), str(cipher), str("none"), str("none"), u32(1), str(type), Buffer.alloc(64, 7)]);
  const lines = raw.toString("base64").match(/.{1,70}/g) ?? [];
  return ["-----BEGIN OPENSSH PRIVATE KEY-----", ...lines, "-----END OPENSSH PRIVATE KEY-----"].join("\n");
}
const KEY = fakeKey();
const VALUES = { [TOKEN_SECRET]: GH, [KEY_SECRET]: KEY };
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

test("checkKey: an unencrypted ed25519 OpenSSH key passes; passphrase, other type, public key and junk are refused", T, () => {
  assert.equal(checkKey(KEY), null);
  assert.equal(checkKey(`${KEY}\n`), null);
  assert.match(checkKey(fakeKey("aes256-ctr")) ?? "", /passphrase/);
  assert.match(checkKey(fakeKey("none", "ssh-rsa")) ?? "", /ed25519/);
  for (const bad of ["", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 comment", "-----BEGIN OPENSSH PRIVATE KEY-----\n!!!\n-----END OPENSSH PRIVATE KEY-----", "hello"]) {
    const why = checkKey(bad);
    assert.ok(why, bad);
    assert.ok(!bad || !why.includes(bad));
  }
});

test("requireHttps: a Woodpecker URL that is not https is refused", T, async () => {
  requireHttps("https://wp.example.test");
  for (const bad of ["http://wp.example.test", "ftp://x", "wp.example.test", "", "javascript:alert(1)"]) assert.throws(() => requireHttps(bad), /https/);
  const m = mock();
  await assert.rejects(() => storeSecrets({ url: "http://wp.example.test", token: WP.token }, VALUES, m.fetch), /https/);
  assert.equal(m.calls.length, 0, "no call (and so no secret) goes to a plain-http URL");
});

test("parseArgs: only --dry-run", T, () => {
  assert.deepEqual(parseArgs([]), { dryRun: false });
  assert.deepEqual(parseArgs(["--dry-run"]), { dryRun: true });
  assert.throws(() => parseArgs(["--force"]), /unknown option/);
});

test("planLines: names the repo, both secrets and exactly push + tag; no value", T, () => {
  const text = planLines().join("\n");
  assert.ok(text.includes(REPO) && text.includes("site_deploy_token") && text.includes("site_deploy_key"));
  assert.ok(text.includes("push, tag"));
  assert.ok(!text.includes("github_pat_") && !text.includes("BEGIN"));
});

test("storeSecrets: stores exactly two secrets, each with events exactly push + tag and no image filter", T, async () => {
  const m = mock();
  const out = await storeSecrets(WP, VALUES, m.fetch);
  const writes = m.calls.filter((c) => c.method === "POST" || c.method === "PATCH");
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map((w) => w.body?.name).sort(), ["site_deploy_key", "site_deploy_token"]);
  for (const w of writes) {
    assert.deepEqual(w.body?.events, ["push", "tag"]);
    assert.deepEqual(w.body?.images, []);
  }
  assert.deepEqual([...EVENTS], ["push", "tag"]);
  assert.deepEqual([...SECRET_NAMES], ["site_deploy_token", "site_deploy_key"]);
  assert.equal(m.secrets.length, 2);
  assert.equal(out.at(-1), "done");
});

test("storeSecrets: existing secrets are updated (PATCH), not duplicated, and the events are reset", T, async () => {
  const m = mock({ secrets: [{ name: "site_deploy_token", events: ["push", "tag", "pull_request"], images: [] }] });
  const out = await storeSecrets(WP, VALUES, m.fetch);
  assert.equal(m.calls.filter((c) => c.method === "PATCH").length, 1);
  assert.equal(m.calls.filter((c) => c.method === "POST").length, 1);
  assert.deepEqual(m.secrets.find((s) => s.name === "site_deploy_token")?.events, ["push", "tag"]);
  assert.match(out[0] ?? "", /^updated site_deploy_token/);
});

test("storeSecrets: no token or key text in any output line or URL; each value is in exactly one request body", T, async () => {
  const m = mock({ secrets: [{ name: "tb_release_token", events: ["manual", "tag"] }] });
  const out = await storeSecrets(WP, VALUES, m.fetch);
  const text = out.join("\n");
  assert.ok(!text.includes(GH) && !text.includes("BEGIN OPENSSH") && !text.includes(KEY.split("\n")[1] as string));
  assert.match(out.at(-2) ?? "", /secret names of .*: site_deploy_key, site_deploy_token, tb_release_token/);
  for (const c of m.calls) assert.ok(!c.path.includes(GH) && !c.path.includes("OPENSSH"), "no value in a URL");
  assert.equal(m.calls.filter((c) => JSON.stringify(c.body ?? {}).includes(GH)).length, 1);
  assert.equal(m.calls.filter((c) => JSON.stringify(c.body ?? {}).includes("BEGIN OPENSSH")).length, 1);
  for (const c of m.calls) assert.equal(c.auth, `Bearer ${WP.token}`);
});

test("storeSecrets: verification reads names and events only and deletes nothing", T, async () => {
  const m = mock();
  await storeSecrets(WP, VALUES, m.fetch);
  assert.ok(m.calls.some((c) => c.method === "GET" && c.path.endsWith("/secrets")));
  assert.ok(m.calls.every((c) => c.method !== "DELETE"));
});

test("storeSecrets: refuses when Woodpecker keeps other events than push + tag, naming the secret and not the value", T, async () => {
  const m = mock({ storeEvents: ["push", "tag", "pull_request"] });
  await assert.rejects(
    () => storeSecrets(WP, VALUES, m.fetch),
    (e: Error) => /site_deploy_token has the events .* must have exactly \[push, tag\]/.test(e.message) && !e.message.includes(GH),
  );
});

test("storeSecrets: an unknown repo gives a clear error and writes nothing", T, async () => {
  const m = mock({ lookup: {} });
  await assert.rejects(() => storeSecrets(WP, VALUES, m.fetch), /not in Woodpecker/);
  assert.ok(m.calls.every((c) => c.method === "GET"));
});

test("storeSecrets: falls back to the old owner name Woodpecker may still use", T, async () => {
  const m = mock({ lookup: { "Martin-Atrin/opt2-tealbrick-website": 42 } });
  assert.equal((await storeSecrets(WP, VALUES, m.fetch)).at(-1), "done");
});

test("storeSecrets: a Woodpecker failure and a network error carry no token and no key", T, async () => {
  const failing = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.pathname.startsWith("/api/repos/lookup/")) return json(200, { id: 42 });
    if ((init?.method ?? "GET") === "GET") return json(404, {});
    return json(500, { message: `boom ${GH}` });
  }) as typeof fetch;
  await assert.rejects(
    () => storeSecrets(WP, VALUES, failing),
    (e: Error) => /HTTP 500/.test(e.message) && !e.message.includes(GH),
  );
  const down = (async () => {
    throw new Error(`connect refused ${GH} ${WP.token} ${KEY}`);
  }) as typeof fetch;
  await assert.rejects(
    () => storeSecrets(WP, VALUES, down),
    (e: Error) =>
      !e.message.includes(GH) && !e.message.includes(WP.token) && !e.message.includes("OPENSSH") && !e.message.includes(KEY.split("\n")[1] as string),
  );
});
