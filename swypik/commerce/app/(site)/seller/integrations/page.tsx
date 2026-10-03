import { requireSellerPage } from "@/lib/seller/page-auth";
import { listCatalogConnections } from "@/lib/seller/imports/connections";
import SellerIntegrationsClient from "./SellerIntegrationsClient";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{ shopify?: string; code?: string }>;
};

export default async function SellerIntegrationsPage({ searchParams }: Props) {
  const sellerId = await requireSellerPage("/seller/integrations");
  const params = await searchParams;
  const integrations = await listCatalogConnections(sellerId);
  const shopifyResult =
    params.shopify === "connected"
      ? ({ status: "connected" } as const)
      : params.shopify === "error"
        ? ({ status: "error", code: params.code || "server_error" } as const)
        : null;
  return (
    <SellerIntegrationsClient
      initialIntegrations={integrations}
      shopifyResult={shopifyResult}
    />
  );
}
