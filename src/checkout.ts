import { createFlagsmithInstance } from "flagsmith/isomorphic";
import type { IFlags } from "flagsmith/types";
import offlineSnapshot from "../public/flags.json" with { type: "json" };

class CartStore {
  private values = new Map<string, string>([["currency", "USD"]]);
  getValue(key: string): string | undefined {
    return this.values.get(key);
  }
}

function buildDefaultFlags(): IFlags {
  const defaults: IFlags = {};
  for (const [key, entry] of Object.entries(offlineSnapshot.flags)) {
    defaults[key] = {
      enabled: Boolean(entry.enabled),
      value: entry.value ?? null,
    };
  }
  return defaults;
}

export async function loadCheckoutFlags(environmentID: string) {
  const client = createFlagsmithInstance();
  const defaultFlags = buildDefaultFlags();

  await client.init({
    environmentID,
    api: "https://edge.api.flagsmith.com/api/v1/",
    defaultFlags,
    cacheFlags: false,
  });

  const cart = new CartStore();
  const currency = cart.getValue("currency");

  const showPromo = client.hasFeature("checkout_promo_banner") ?? false;
  const promoCode = client.getValue("checkout_promo_banner") ?? "";
  const discountPct =
    client.getValue("promo_discount_pct", {
      skipAnalytics: true,
    }) ?? 0;
  const aiAssistant = client.hasFeature("ai_checkout_assistant") ?? false;

  return { currency, showPromo, promoCode, discountPct, aiAssistant };
}
