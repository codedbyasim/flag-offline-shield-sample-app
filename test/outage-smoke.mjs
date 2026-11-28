import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadCheckoutFlags } from "../dist/checkout.js";

const OUTAGE_API_URL = "http://127.0.0.1:59999/api/v1/";
const snapshotPath = path.resolve(process.cwd(), "public", "flags.json");
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));

const result = await loadCheckoutFlags("offline-smoke-test", OUTAGE_API_URL);

assert.equal(result.currency, "USD", "Non-Flagsmith CartStore value should be intact");
assert.ok(snapshot.flags.checkout_promo_banner, "Snapshot must contain checkout_promo_banner");
assert.ok(snapshot.flags.promo_discount_pct, "Snapshot must contain promo_discount_pct");
assert.ok(snapshot.flags.ai_checkout_assistant, "Snapshot must contain ai_checkout_assistant");

assert.equal(
  result.showPromo,
  Boolean(snapshot.flags.checkout_promo_banner.enabled),
  `Expected showPromo=${Boolean(snapshot.flags.checkout_promo_banner.enabled)} during outage, got ${result.showPromo}`
);
assert.equal(
  result.promoCode,
  snapshot.flags.checkout_promo_banner.value,
  `Expected promoCode=${JSON.stringify(snapshot.flags.checkout_promo_banner.value)} during outage, got ${JSON.stringify(result.promoCode)}`
);
assert.equal(
  result.discountPct,
  snapshot.flags.promo_discount_pct.value,
  `Expected discountPct=${JSON.stringify(snapshot.flags.promo_discount_pct.value)} during outage, got ${JSON.stringify(result.discountPct)}`
);
assert.equal(
  result.aiAssistant,
  Boolean(snapshot.flags.ai_checkout_assistant.enabled),
  `Expected aiAssistant=${Boolean(snapshot.flags.ai_checkout_assistant.enabled)} during outage, got ${result.aiAssistant}`
);

console.log(
  JSON.stringify(
    {
      passed: true,
      outageApiUrl: OUTAGE_API_URL,
      result,
    },
    null,
    2
  )
);
