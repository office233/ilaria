import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { dbQuery } from "@/lib/db";
import { requireAdminSession } from "@/lib/security/admin-auth";
import ProductEditorForm from "../ProductEditorForm";
import { updateMarketplaceProduct } from "../actions";

export const dynamic = "force-dynamic";

type EditMarketplaceProductPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ saved?: string; created?: string; error?: string }>;
};

async function getNotice(searchParams?: { saved?: string; created?: string; error?: string }) {
  if (searchParams?.error) {
    return { type: "error" as const, message: decodeURIComponent(searchParams.error) };
  }

  const t = await getTranslations("adminMarketplace.editor.notices");

  if (searchParams?.created) {
    return { type: "success" as const, message: t("created") };
  }

  if (searchParams?.saved) {
    return { type: "success" as const, message: t("saved") };
  }

  return null;
}

export default async function EditMarketplaceProductPage({
  params,
  searchParams,
}: EditMarketplaceProductPageProps) {
  await requireAdminSession();
  const { id } = await params;
  const sp = searchParams ? await searchParams : undefined;
  const { rows } = await dbQuery("SELECT * FROM marketplace_products WHERE id = $1", [id]);

  if (rows.length === 0) {
    notFound();
  }

  return (
    <ProductEditorForm
      mode="edit"
      product={rows[0]}
      action={updateMarketplaceProduct.bind(null, id)}
      notice={await getNotice(sp)}
    />
  );
}
