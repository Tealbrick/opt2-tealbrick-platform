// C187: the non-secret logic of ops/prod-secrets.ts (no Railway call, no prompt, no real secret).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
// Key-like strings are assembled at run time (k()) so the secret scan never sees a provider-key shape in this file.
import {
  checkValue,
  firstPriceId,
  generateKek,
  kekIdOf,
  parseArgs,
  planLines,
  railwaySetArgs,
  redact,
  restrictedKeyMode,
  SECRETS,
  type SecretSpec,
  selectSpecs,
  storeSecrets,
  stripeModeNotes,
  stripePreflight,
} from "./prod-secrets.ts";

const k = (prefix: string, mode: string, body: string): string => [prefix, mode, body].join("_");

const spec = (name: string): SecretSpec => {
  const s = SECRETS.find((x) => x.name === name);
  assert.ok(s, name);
  return s;
};

test("parseArgs: default environment live; the dev environment is refused", () => {
  assert.deepEqual(parseArgs([]), { environment: "live", dryRun: false, only: null, skipStripePreflight: false });
  assert.equal(parseArgs(["--dry-run"]).dryRun, true);
  assert.throws(() => parseArgs(["--environment", "production"]), /dev environment/);
  assert.throws(() => parseArgs(["--environment"]), /needs a value/);
  assert.throws(() => parseArgs(["--environment", "Live!"]), /environment name/);
  assert.throws(() => parseArgs(["--force"]), /unknown option/);
});

test("parseArgs/selectSpecs: --only takes known names; TB_KEK and TB_KEK_ID travel together", () => {
  assert.throws(() => parseArgs(["--only", "DATABASE_URL"]), /not a secret/);
  const o = parseArgs(["--only", "STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET"]);
  assert.deepEqual(o.only, ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
  assert.deepEqual(
    selectSpecs(o.only).map((s) => s.name),
    ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  );
  assert.deepEqual(
    selectSpecs(["TB_KEK_ID"]).map((s) => s.name),
    ["TB_KEK", "TB_KEK_ID"],
  );
  assert.equal(selectSpecs(null).length, SECRETS.length);
});

test("SECRETS: no flag or non-secret config sneaks in; dev-only knobs are absent", () => {
  const names = SECRETS.map((s) => s.name);
  assert.equal(new Set(names).size, names.length, "unique names");
  for (const forbidden of ["TB_RELEASE_DEV_FALLBACK", "TB_STRIPE_QA_PROMO", "TB_PORTAL_KEY_ROTATE_NOW", "TB_KEK_PREVIOUS", "DATABASE_URL", "PORTAL_PUBLIC_URL"])
    assert.ok(!names.includes(forbidden), forbidden);
  for (const s of SECRETS) assert.ok(["portal-core", "portal-gui", "db-backup"].includes(s.service));
});

test("planLines: names and services only", () => {
  const lines = planLines(SECRETS, "live").join("\n");
  for (const s of SECRETS) assert.ok(lines.includes(s.name));
  assert.match(lines, /environment live/);
  assert.match(lines, /nothing is deployed/);
});

test("checkValue: provider key prefixes; Stripe live restricted or test; live Clerk only", () => {
  const sk = k("sk", "live", "a".repeat(40));
  assert.equal(checkValue(spec("CLERK_SECRET_KEY"), sk), null);
  assert.match(checkValue(spec("CLERK_SECRET_KEY"), k("sk", "test", "a".repeat(40))) ?? "", /sk_live_/);
  assert.equal(checkValue(spec("CLERK_PUBLISHABLE_KEY"), k("pk", "live", "Y2xlcmsuZXhhbXBsZS5jb20k")), null);
  assert.ok(checkValue(spec("CLERK_PUBLISHABLE_KEY"), k("pk", "test", "abcdefghijk")));
  assert.equal(checkValue(spec("STRIPE_SECRET_KEY"), k("rk", "test", "A1".repeat(20))), null);
  assert.equal(checkValue(spec("STRIPE_SECRET_KEY"), k("sk", "test", "A1".repeat(20))), null);
  // C231: a LIVE restricted key is accepted; a full live secret key is refused (least privilege)
  assert.equal(checkValue(spec("STRIPE_SECRET_KEY"), k("rk", "live", "A1".repeat(20))), null);
  assert.match(checkValue(spec("STRIPE_SECRET_KEY"), k("sk", "live", "A1".repeat(20))) ?? "", /sk_live_\) is refused/);
  assert.ok(checkValue(spec("STRIPE_SECRET_KEY"), k("pk", "live", "A1".repeat(20))));
  assert.equal(checkValue(spec("STRIPE_WEBHOOK_SECRET"), ["whsec", "b".repeat(32)].join("_")), null);
  assert.equal(checkValue(spec("CLERK_WEBHOOK_SECRET"), ["whsec", "b+/=".repeat(8)].join("_")), null);
  assert.ok(checkValue(spec("CLERK_WEBHOOK_SECRET"), "secret"));
});

test("checkValue: required vs optional, spaces refused, reasons never echo the value", () => {
  assert.equal(checkValue(spec("CLERK_SECRET_KEY"), ""), "a value is required");
  assert.equal(checkValue(spec("SENTRY_DSN"), ""), null);
  assert.equal(checkValue(spec("HEARTBEAT_URL"), ""), null);
  assert.ok(checkValue(spec("HEARTBEAT_URL"), "http://plain"));
  const bad = `${k("sk", "live", "x".repeat(30))} trailing`;
  const why = checkValue(spec("CLERK_SECRET_KEY"), bad) ?? "";
  assert.ok(why.length > 0);
  assert.ok(!why.includes("xxxx"), "reason must not contain the value");
});

test("generateKek: 32 bytes as base64url (43 chars, C35)", () => {
  const k = generateKek();
  assert.match(k, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(k, "base64url").length, 32);
  assert.notEqual(generateKek(), k);
  assert.throws(() => generateKek(() => Buffer.alloc(16)), /wrong length/);
});

test("kekIdOf: equals Core's default id (manifest kekFromEnv)", () => {
  const key = Buffer.alloc(32, 7);
  const want = `kek_${createHash("sha256").update("tb:kek-id:").update(key).digest("hex").slice(0, 16)}`;
  assert.equal(kekIdOf(key.toString("base64url")), want);
  assert.match(want, /^kek_[0-9a-f]{16}$/);
  assert.throws(() => kekIdOf("short"), /32 bytes/);
});

test("redact: removes every value from CLI output", () => {
  const out = redact("error: bad value whsec_abcdef for X; whsec_abcdef again", ["whsec_abcdef", "ab"]);
  assert.equal(out, "error: bad value *** for X; *** again");
});

test("railwaySetArgs: value never in argv; always --stdin and --skip-deploys", () => {
  const a = railwaySetArgs("STRIPE_SECRET_KEY", "portal-core", "live");
  assert.deepEqual(a, ["variable", "set", "STRIPE_SECRET_KEY", "--stdin", "--skip-deploys", "--service", "portal-core", "--environment", "live"]);
});

test("C231 stripeModeNotes: live key → flag reminder (and webhook secret when missing); test key → roll-back note; never the value", () => {
  const live = k("rk", "live", "Z9".repeat(20));
  const notes = stripeModeNotes([{ spec: { name: "STRIPE_SECRET_KEY" }, value: live }]);
  assert.equal(notes.length, 2);
  assert.match(notes[0] ?? "", /TB_STRIPE_ALLOW_LIVE=1/);
  assert.match(notes[1] ?? "", /STRIPE_WEBHOOK_SECRET/);
  assert.equal(
    stripeModeNotes([
      { spec: { name: "STRIPE_SECRET_KEY" }, value: live },
      { spec: { name: "STRIPE_WEBHOOK_SECRET" }, value: "w" },
    ]).length,
    1,
  );
  assert.match(stripeModeNotes([{ spec: { name: "STRIPE_SECRET_KEY" }, value: k("rk", "test", "Z9".repeat(20)) }]).join(" "), /TEST key/);
  assert.deepEqual(stripeModeNotes([]), []);
  assert.doesNotMatch(notes.join(" "), /Z9Z9/);
});

// ---- Stripe permission preflight (mocked fetch; fake keys only; no network) ----

const FAKE_OFFERS = [
  { stripePrice: { test: "price_TESTfirst1", live: null } },
  { stripePrice: { test: "price_TESTsecond", live: "price_LIVEfirst1" } },
  { stripePrice: { test: null, live: "price_LIVEsecond" } },
];

interface Call {
  url: string;
  auth: string | null;
}

/** A fetch that answers per resource; records each call. */
function mockStripe(answers: Partial<Record<"prices" | "customers" | "sessions", Response | Error>>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization") });
    const which = url.includes("/v1/prices/") ? "prices" : url.includes("/v1/customers") ? "customers" : "sessions";
    const a = answers[which] ?? new Response("{}", { status: 200 });
    if (a instanceof Error) throw a;
    return a.clone();
  }) as typeof fetch;
  return { fetch: f, calls };
}

const err = (status: number, error: Record<string, string>): Response => new Response(JSON.stringify({ error }), { status });

const permErr = (): Response => err(403, { type: "StripePermissionError", code: "more_permissions_required", message: "secret body text" });

function secretsFor(key: string): { spec: SecretSpec; value: string }[] {
  return [
    { spec: spec("TB_KEK"), value: "kek-value-0123456789" },
    { spec: spec("STRIPE_SECRET_KEY"), value: key },
    { spec: spec("STRIPE_WEBHOOK_SECRET"), value: ["whsec", "c".repeat(32)].join("_") },
  ];
}

interface Run {
  stored: string[];
  out: string[];
  error: string | null;
  calls: Call[];
}

async function runStore(key: string, answers: Parameters<typeof mockStripe>[0], skip = false, offers: unknown = FAKE_OFFERS): Promise<Run> {
  const m = mockStripe(answers);
  const stored: string[] = [];
  const out: string[] = [];
  let error: string | null = null;
  try {
    await storeSecrets(
      secretsFor(key),
      { skipStripePreflight: skip },
      {
        set: (sp) => {
          stored.push(sp.name);
          return { ok: true, err: "" };
        },
        doFetch: m.fetch,
        offers,
        log: (l) => out.push(l),
      },
    );
  } catch (e) {
    error = (e as Error).message;
  }
  return { stored, out, error, calls: m.calls };
}

const LIVE_KEY = k("rk", "live", "Q7".repeat(20));
const TEST_KEY = k("rk", "test", "Q7".repeat(20));
const FULL_TEST_KEY = k("sk", "test", "Q7".repeat(20));

function assertNoKey(r: Run, key: string): void {
  const text = [...r.out, r.error ?? ""].join("\n");
  assert.ok(!text.includes(key), "key text in output");
  assert.ok(!text.includes("Q7Q7Q7"), "key body in output");
  assert.ok(!text.includes("secret body text"), "response body in output");
}

test("firstPriceId/restrictedKeyMode: first price of the mode; only rk_ keys have a mode", () => {
  assert.equal(firstPriceId(FAKE_OFFERS, "test"), "price_TESTfirst1");
  assert.equal(firstPriceId(FAKE_OFFERS, "live"), "price_LIVEfirst1");
  assert.equal(firstPriceId([], "live"), null);
  assert.equal(firstPriceId(null, "live"), null);
  assert.equal(restrictedKeyMode(LIVE_KEY), "live");
  assert.equal(restrictedKeyMode(TEST_KEY), "test");
  assert.equal(restrictedKeyMode(FULL_TEST_KEY), null);
});

test("preflight: all three 200 → three read-only GETs on api.stripe.com with the Bearer key, then everything is stored", async () => {
  const r = await runStore(LIVE_KEY, {});
  assert.equal(r.error, null);
  assert.deepEqual(r.stored, ["TB_KEK", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
  assert.deepEqual(
    r.calls.map((c) => c.url),
    ["https://api.stripe.com/v1/prices/price_LIVEfirst1", "https://api.stripe.com/v1/customers?limit=1", "https://api.stripe.com/v1/checkout/sessions?limit=1"],
  );
  for (const c of r.calls) assert.equal(c.auth, `Bearer ${LIVE_KEY}`);
  assert.match(r.out.join("\n"), /prices ok/);
  assertNoKey(r, LIVE_KEY);
});

test("preflight: 403 more_permissions_required on prices → 'permission missing: prices', nothing stored", async () => {
  const r = await runStore(LIVE_KEY, { prices: permErr() });
  assert.ok(r.out.includes("permission missing: prices"));
  assert.deepEqual(r.stored, []);
  assert.match(r.error ?? "", /nothing was stored/);
  assert.match(r.error ?? "", /Fix the key's permissions in the Stripe dashboard, then run this again/);
  // the other two checks still ran and are reported
  assert.equal(r.calls.length, 3);
  assertNoKey(r, LIVE_KEY);
});

test("preflight: a permission error type or code counts even on another status; 401 counts too", async () => {
  const a = await runStore(LIVE_KEY, { customers: err(400, { type: "StripePermissionError" }) });
  assert.ok(a.out.includes("permission missing: customers"));
  const b = await runStore(LIVE_KEY, { customers: err(400, { code: "more_permissions_required" }) });
  assert.ok(b.out.includes("permission missing: customers"));
  const c = await runStore(LIVE_KEY, { customers: err(401, { type: "invalid_request_error" }) });
  assert.ok(c.out.includes("permission missing: customers"));
  for (const r of [a, b, c]) assert.deepEqual(r.stored, []);
});

test("preflight: customers missing and checkout.sessions missing are each named; all lines are printed", async () => {
  const c = await runStore(LIVE_KEY, { customers: permErr() });
  assert.ok(c.out.includes("permission missing: customers"));
  assert.deepEqual(c.stored, []);
  const s = await runStore(LIVE_KEY, { sessions: permErr() });
  assert.ok(s.out.includes("permission missing: checkout.sessions"));
  assert.deepEqual(s.stored, []);
  const both = await runStore(LIVE_KEY, { prices: permErr(), customers: permErr(), sessions: permErr() });
  for (const r of ["prices", "customers", "checkout.sessions"]) assert.ok(both.out.includes(`permission missing: ${r}`));
  assertNoKey(both, LIVE_KEY);
});

test("preflight: 404 on the price → price id not found for this key's account/mode, nothing stored", async () => {
  const r = await runStore(LIVE_KEY, { prices: err(404, { type: "invalid_request_error", code: "resource_missing" }) });
  assert.ok(r.out.includes("price price_LIVEfirst1 not found for this key's account/mode"));
  assert.deepEqual(r.stored, []);
  assert.notEqual(r.error, null);
});

test("preflight: other failures → 'Stripe preflight failed: <resource> HTTP <status>'; 404 on customers is not a price 404", async () => {
  const r = await runStore(LIVE_KEY, { customers: new Response("<html>oops</html>", { status: 500 }), sessions: err(404, { type: "invalid_request_error" }) });
  assert.ok(r.out.includes("Stripe preflight failed: customers HTTP 500"));
  assert.ok(r.out.some((l) => l.startsWith("Stripe preflight failed: checkout.sessions HTTP 404")));
  assert.ok(!r.out.some((l) => l.includes("not found for this key")));
  assert.deepEqual(r.stored, []);
});

test("preflight: network error → failed line, nothing stored, no key text", async () => {
  const boom = new Error(`connect ECONNREFUSED while sending ${LIVE_KEY}`);
  const r = await runStore(LIVE_KEY, { customers: boom });
  assert.ok(r.out.includes("Stripe preflight failed: customers no response (network error or timeout)"));
  assert.deepEqual(r.stored, []);
  assertNoKey(r, LIVE_KEY);
});

test("preflight: rk_test_ uses the first TEST price id", async () => {
  const r = await runStore(TEST_KEY, {});
  assert.equal(r.error, null);
  assert.equal(r.calls[0]?.url, "https://api.stripe.com/v1/prices/price_TESTfirst1");
  assert.equal(r.calls.length, 3);
  assert.deepEqual(r.stored, ["TB_KEK", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
});

test("preflight: no price id in the registry → prices check skipped with a note; the other two still run", async () => {
  const r = await runStore(LIVE_KEY, {}, false, [{ stripePrice: { test: "price_x", live: null } }]);
  assert.equal(r.error, null);
  assert.equal(r.calls.length, 2);
  assert.ok(r.out.some((l) => /prices check skipped/.test(l)));
  assert.deepEqual(r.stored, ["TB_KEK", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
});

test("preflight: sk_test_ (full test key) makes no Stripe call and stores", async () => {
  const r = await runStore(FULL_TEST_KEY, { prices: permErr(), customers: permErr(), sessions: permErr() });
  assert.equal(r.calls.length, 0);
  assert.equal(r.error, null);
  assert.deepEqual(r.stored, ["TB_KEK", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
});

test("preflight: no STRIPE_SECRET_KEY in this run (--only other names) → no call", async () => {
  const m = mockStripe({});
  const stored: string[] = [];
  await storeSecrets(
    [{ spec: spec("STRIPE_WEBHOOK_SECRET"), value: ["whsec", "d".repeat(32)].join("_") }],
    { skipStripePreflight: false },
    {
      set: (sp) => {
        stored.push(sp.name);
        return { ok: true, err: "" };
      },
      doFetch: m.fetch,
      offers: FAKE_OFFERS,
      log: () => {},
    },
  );
  assert.equal(m.calls.length, 0);
  assert.deepEqual(stored, ["STRIPE_WEBHOOK_SECRET"]);
});

test("--skip-stripe-preflight: parsed, no call, loud warning, stores even with a bad key", async () => {
  assert.equal(parseArgs(["--skip-stripe-preflight"]).skipStripePreflight, true);
  const r = await runStore(LIVE_KEY, { prices: permErr() }, true);
  assert.equal(r.calls.length, 0);
  assert.equal(r.error, null);
  assert.match(r.out[0] ?? "", /WARNING.*--skip-stripe-preflight.*NOT checked/);
  assert.deepEqual(r.stored, ["TB_KEK", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
  assertNoKey(r, LIVE_KEY);
});

test("stripePreflight: every output line passes redact (a response that echoes the key shows nothing of it)", async () => {
  const m = mockStripe({ prices: new Response(JSON.stringify({ error: { type: `x_${LIVE_KEY}`, code: "ok_code" } }), { status: 500 }) });
  const r = await stripePreflight(LIVE_KEY, "price_LIVEfirst1", m.fetch);
  assert.equal(r.ok, false);
  const text = r.lines.join("\n");
  assert.ok(!text.includes(LIVE_KEY));
  assert.ok(!text.includes("Q7Q7Q7"));
  assert.match(text, /prices HTTP 500/);
});
