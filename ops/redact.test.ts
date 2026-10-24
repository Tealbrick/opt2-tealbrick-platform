import assert from "node:assert/strict";
import { test } from "node:test";
import { MASK, redact } from "./redact.ts";

// fake secrets are assembled at runtime so the repo's secret scan (gitleaks) never sees a key-shaped literal
const SK = ["sk", "live", "abcdefgh12345678"].join("_");
const RK = ["rk", "test", "abcdefgh12345678"].join("_");
const GHP = ["ghp", "abcdefghijklmnopqrstuvwxyz0123"].join("_");
const GHS = ["ghs", "abcdefghij12"].join("_");
const WHSEC = ["whsec", "abcdefgh123"].join("_");
const GPAT = ["github", "pat", "11ABCDEFG0123456789", "abcdefghijkl"].join("_");

test("redact: every token pattern is masked (GitHub, PAT, Stripe, webhook, bearer)", () => {
  const text = `a ${SK} b ${RK} c ${GHP} d ${GHS} e ${WHSEC} f ${GPAT} g Bearer abc.def-ghi_123`;
  const out = redact(text);
  for (const secret of [SK, RK, GHP, GHS, WHSEC, GPAT, "abc.def-ghi_123"]) assert.ok(!out.includes(secret), secret);
  assert.equal(out.split(MASK).length - 1, 7);
});

test("redact: Authorization header values, with or without a scheme", () => {
  assert.equal(redact("authorization: token xyz123 rest"), `authorization: ${MASK} rest`);
  assert.equal(redact("Authorization: Basic dXNlcjpwYXNz"), `Authorization: ${MASK}`);
});

test("redact: given values (length >= 4) and each long line of a multi-line value; short values stay", () => {
  assert.equal(redact("error: bad value whsec_abcdef for X; whsec_abcdef again", ["whsec_abcdef", "ab"]), `error: bad value ${MASK} for X; ${MASK} again`);
  assert.equal(redact("tok abcd here", ["abcd"]), `tok ${MASK} here`);
  assert.equal(redact("a ab b", ["ab"]), "a ab b");
  assert.equal(redact("line two-of-the-secret-value", ["first-line-of-secret\ntwo-of-the-secret-value"]), `line ${MASK}`);
});

test("redact: private key blocks, also when cut off", () => {
  const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----";
  assert.equal(redact(`key:\n${pem}\nafter`), `key:\n${MASK}\nafter`);
  assert.equal(redact("-----BEGIN PRIVATE KEY-----\nAAAA"), MASK);
});

test("redact: strips terminal control sequences (ANSI colours, OSC titles)", () => {
  assert.equal(redact("\u001b[1;3mREDACTED\u001b[0m ok \u001b]0;title\u0007done"), "REDACTED ok done");
});

test("redact: quiet on ordinary text", () => {
  assert.equal(redact("pnpm test: 120 passed, sk_ is a prefix, Bearer x"), "pnpm test: 120 passed, sk_ is a prefix, Bearer x");
  assert.equal(redact("railway: service portal-core not found", []), "railway: service portal-core not found");
});
