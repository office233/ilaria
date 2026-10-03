import { handleShopifyPrivacyWebhook } from "@/lib/seller/imports/shopify-privacy-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleShopifyPrivacyWebhook(req, "shop/redact");
}
