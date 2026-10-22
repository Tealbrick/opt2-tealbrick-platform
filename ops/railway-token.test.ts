import assert from "node:assert/strict";
import { test } from "node:test";
import { needsRefresh, pickToken, REFRESH_MARGIN_MS } from "./railway-token.ts";

test("pickToken: CLI 5 access token first, CLI 4 token as fallback, none → null", () => {
  assert.equal(pickToken({ accessToken: "a", token: null }), "a");
  assert.equal(pickToken({ accessToken: "a", token: "t" }), "a");
  assert.equal(pickToken({ token: "t" }), "t");
  assert.equal(pickToken({ accessToken: null, token: null }), null);
  assert.equal(pickToken({}), null);
});

test("needsRefresh: only CLI 5 tokens, near or past expiry, or without an expiry", () => {
  const now = 1_800_000_000_000;
  assert.equal(needsRefresh({ token: "t" }, now), false);
  assert.equal(needsRefresh({ accessToken: "a", tokenExpiresAt: now / 1000 + 3600 }, now), false);
  assert.equal(needsRefresh({ accessToken: "a", tokenExpiresAt: (now + REFRESH_MARGIN_MS - 1000) / 1000 }, now), true);
  assert.equal(needsRefresh({ accessToken: "a", tokenExpiresAt: now / 1000 - 10 }, now), true);
  assert.equal(needsRefresh({ accessToken: "a" }, now), true);
});
