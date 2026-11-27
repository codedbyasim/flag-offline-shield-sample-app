import { createFlagsmithInstance } from "flagsmith/isomorphic";

class CartStore {
  private values = new Map<string, string>([["currency", "USD"]]);
  getValue(key: string): string | undefined {
    return this.values.get(key);
  }
}

export async function loadCheckoutFlags(environmentID: string) {
  const client = createFlagsmithInstance();
  await client.init({
    environmentID,
    api: "https://edge.api.flagsmith.com/api/v1/",
    cacheFlags: false,
  });

  const cart = new CartStore();
  const currency = cart.getValue("currency");

  const showPromo = client.hasFeature("checkout_promo_banner");
  const promoCode = client.getValue("checkout_promo_banner");
  const discountPct = client.getValue("promo_discount_pct", {
    skipAnalytics: true,
  });
  const aiAssistant = client.hasFeature("ai_checkout_assistant");

  return { currency, showPromo, promoCode, discountPct, aiAssistant };
}
