// C187: the non-secret logic of ops/prod-secrets.ts (no Railway call, no prompt, no real secret).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
// Key-like strings are assembled at run time (k()) so the secret scan never sees a provider-key shape in this file.
import {
  checkValue,
  generateKek,
  kekIdOf,
  parseArgs,
  planLines,
  railwaySetArgs,
  redact,
  SECRETS,
  type SecretSpec,
  selectSpecs,
  stripeModeNotes,
} from "./prod-secrets.ts";

const k = (prefix: string, mode: string, body: string): string => [prefix, mode, body].join("_");

const spec = (name: string): SecretSpec => {
  const s = SECRETS.find((x) => x.name === name);
  assert.ok(s, name);
  return s;
};

test("parseArgs: default environment live; the dev environment is refused", () => {
  assert.deepEqual(parseArgs([]), { environment: "live", dryRun: false, only: null });
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
