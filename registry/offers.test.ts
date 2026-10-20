// C231 live Stripe: rules for registry/offers.json that validateOffers (shape) does not cover.
// - "Live is on" = at least one offer carries a live Stripe price.
// - When live is on, every sellable offer (single, amount > 0, not a DEV_ONLY_PRODUCTS product) has a live price.
// - A DEV_ONLY_PRODUCTS product (samples, fixtures) never has a live price, with ONE exception: the go-live proof offer
//   (C231a) on LIVE_CHECK_PRODUCT at no more than 1 USD. Core sells it live only to TB_LIVE_TEST_ACCOUNTS.
// - Test and live amounts are the same field: a test price must exist for every priced offer (dev keeps working).
// - No placeholder ids (a prepared PR stays red until the real price ids are filled in).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isDevOnlyProduct, type Offer, validateOffers } from "../ci/tb-ci.ts";

export const LIVE_CHECK_PRODUCT = "sample-gate";
export const LIVE_CHECK_MAX_AMOUNT = 100;

/** The rule breaks of an offers list (empty = fine). */
export function liveOfferProblems(offers: readonly Offer[]): string[] {
  const out: string[] = [];
  const liveOn = offers.some((o) => o.stripePrice.live !== null);
  for (const o of offers) {
    const tag = `${o.id} (${o.name})`;
    for (const m of ["test", "live"] as const) {
      const v = o.stripePrice[m];
      if (v !== null && /REPLACE|TODO|XXX/i.test(v)) out.push(`${tag}: stripePrice.${m} is a placeholder`);
    }
    const devOnly = o.products.some((p) => isDevOnlyProduct(p));
    const sellable = o.kind === "single" && o.amount > 0 && !devOnly;
    if (o.amount > 0 && o.kind === "single" && o.stripePrice.test === null) out.push(`${tag}: a priced offer needs a test price (dev)`);
    if (devOnly && o.stripePrice.live !== null) {
      const proof = o.kind === "single" && o.products[0] === LIVE_CHECK_PRODUCT && o.amount > 0 && o.amount <= LIVE_CHECK_MAX_AMOUNT;
      if (!proof) out.push(`${tag}: a dev-only product is never sold live (only the ${LIVE_CHECK_PRODUCT} go-live proof offer, <= ${LIVE_CHECK_MAX_AMOUNT})`);
    }
    if (liveOn && sellable && o.stripePrice.live === null) out.push(`${tag}: live is on, so this sellable offer needs a live price`);
    if (o.kind === "bundle" && o.stripePrice.live !== null) out.push(`${tag}: bundles are hidden (no live price)`);
  }
  return out;
}

const offer = (over: Partial<Offer>): Offer => ({
  id: "off_01JA0000000000000000000000",
  kind: "single",
  name: "Knowledge",
  products: ["knowledge"],
  major: 0,
  amount: 9900,
  currency: "usd",
  taxNote: "Lifetime licence for this major version. Tax is added at checkout.",
  stripePrice: { test: "price_t1", live: null },
  ...over,
});

test("live off (no live price anywhere): nothing is required", () => {
  assert.deepEqual(liveOfferProblems([offer({}), offer({ products: ["sample-gate"], amount: 100 })]), []);
});

test("live on: every sellable offer needs a live price", () => {
  const p = liveOfferProblems([offer({ stripePrice: { test: "price_t1", live: "price_l1" } }), offer({ name: "Connect", products: ["connect"] })]);
  assert.equal(p.length, 1);
  assert.match(p[0] ?? "", /Connect.*needs a live price/);
});

test("samples are never sold live, except the sample-gate go-live proof offer at <= 1 USD", () => {
  assert.match(
    liveOfferProblems([offer({ products: ["sample-caller"], amount: 100, stripePrice: { test: "price_t", live: "price_l" } })]).join(),
    /never sold live/,
  );
  assert.match(
    liveOfferProblems([offer({ products: ["sample-gate"], amount: 9900, stripePrice: { test: "price_t", live: "price_l" } })]).join(),
    /never sold live/,
  );
  assert.deepEqual(liveOfferProblems([offer({ products: ["sample-gate"], amount: 100, stripePrice: { test: "price_t", live: "price_l" } })]), []);
  // the free fixtures stay free (validateOffers refuses a price on them anyway)
  assert.deepEqual(liveOfferProblems([offer({ products: ["sample-pay"], amount: 0, stripePrice: { test: null, live: null } })]), []);
});

test("placeholders and a missing test price are refused", () => {
  assert.match(liveOfferProblems([offer({ stripePrice: { test: "price_t1", live: "price_REPLACEknowledge" } })]).join(), /placeholder/);
  assert.match(liveOfferProblems([offer({ stripePrice: { test: null, live: "price_l1" } })]).join(), /needs a test price/);
});

test("registry/offers.json follows the live rules", () => {
  const offers = validateOffers(JSON.parse(readFileSync(new URL("./offers.json", import.meta.url), "utf8")));
  assert.deepEqual(liveOfferProblems(offers), []);
});
