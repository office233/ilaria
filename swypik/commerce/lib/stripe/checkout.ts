/**
 * Stripe Checkout — creates a hosted checkout session
 * 
 * Flow: PostgreSQL product data → Stripe line items → redirect to Stripe
 * Server-authoritative pricing.
 */

import Stripe from "stripe";
import { APP_URL } from "@/lib/app-url";

let stripeInstance: Stripe | null = null;

export function getStripe(): Stripe {
  if (stripeInstance) return stripeInstance;

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is missing");

  stripeInstance = new Stripe(key, {
    apiVersion: "2026-04-22.dahlia",
    typescript: true,
    // Default-ul SDK-ului e 80s: prea mult pentru un utilizator care așteaptă
    // în pagina de plată, și suficient cât să epuizeze pool-ul de conexiuni.
    // Retry-urile acoperă erorile tranzitorii de rețea.
    timeout: 15_000,
    maxNetworkRetries: 2,
  });

  return stripeInstance;
}

export type CheckoutItem = {
  productId: string;
  title: string;
  price: number;        // RON — server-verified
  oldPrice?: number;
  image?: string;
  quantity: number;
  skuId?: string;
  variantId?: string;
  color?: string;
  size?: string;
  creatorId?: string;
  videoId?: string;
  creatorProductLinkId?: string;
  sellerId?: string;
};

export async function createCheckoutSession(
  items: CheckoutItem[],
  options?: {
    customerEmail?: string;
    successUrl?: string;
    cancelUrl?: string;
  }
): Promise<{ url: string; sessionId: string; expiresAt: number | null }> {
  const stripe = getStripe();
  const baseUrl = APP_URL;

  const lineItems = items.map((item) => ({
    price_data: {
      currency: "ron",
      product_data: {
        name: item.title.slice(0, 200),
        ...(item.image ? { images: [item.image] } : {}),
        metadata: {
          productId: item.productId,
          skuId: item.skuId || "",
          sellerId: item.sellerId || "",
          creatorId: item.creatorId || "",
          videoId: item.videoId || "",
          creatorProductLinkId: item.creatorProductLinkId || "",
          color: item.color || "",
          size: item.size || "",
        },
      },
      unit_amount: Math.round(item.price * 100), // Stripe uses bani (cents)
    },
    quantity: item.quantity,
  }));

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: lineItems,
    customer_email: options?.customerEmail || undefined,
    locale: "ro",
    shipping_address_collection: {
      allowed_countries: ["RO", "GB", "DE", "FR", "IT", "ES", "NL", "BE", "AT", "PL", "HU", "BG"],
    },
    phone_number_collection: { enabled: true },
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    billing_address_collection: 'auto',
    success_url: `${options?.successUrl || baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: options?.cancelUrl || baseUrl,
    metadata: {
      itemCount: String(items.length),
      productIds: items.map((i) => i.productId).join(",").slice(0, 500),
      totalRon: String(items.reduce((s, i) => s + i.price * i.quantity, 0)),
    },
    payment_intent_data: {
      metadata: {
        source: "swypik",
        productIds: items.map((i) => i.productId).join(",").slice(0, 500),
      },
    },
  });

  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL");
  }

  return {
    url: session.url,
    sessionId: session.id,
    expiresAt: session.expires_at || null,
  };
}
