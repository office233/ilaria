import { requireAdminSession } from "@/lib/security/admin-auth";
import ProductEditorForm from "../ProductEditorForm";
import { createMarketplaceProduct } from "../actions";

export const dynamic = "force-dynamic";

type NewMarketplaceProductPageProps = {
  searchParams?: Promise<{ error?: string }>;
};

export default async function NewMarketplaceProductPage({ searchParams }: NewMarketplaceProductPageProps) {
  await requireAdminSession();
  const sp = searchParams ? await searchParams : undefined;
  const notice = sp?.error
    ? { type: "error" as const, message: decodeURIComponent(sp.error) }
    : null;

  return <ProductEditorForm mode="create" action={createMarketplaceProduct} notice={notice} />;
}
