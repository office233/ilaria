"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { dbQuery } from "@/lib/db";
import { labelProduct } from "@/lib/moderation/labelProduct";
import { assertAdminPermission } from "@/lib/admin/action-guard";
import { logAdminAction } from "@/lib/security/admin-audit";

type ProductFormValues = {
  title: string;
  slug: string;
  description: string;
  brand: string;
  category: string;
  productUrl: string;
  imageUrl: string;
  currency: string;
  priceCents: number;
  compareAtPriceCents: number | null;
  status: string;
  inventoryStatus: string;
  sourceType: string;
  supplier: string;
  supplierProductId: string;
  supplierUrl: string;
  supplierCostCents: number | null;
};

function normalizeText(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionalNumber(value: FormDataEntryValue | null): number | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function encodeActionError(message: string): string {
  return encodeURIComponent(message);
}

async function readProductFormValues(formData: FormData): Promise<ProductFormValues> {
  const t = await getTranslations("adminMarketplace.editor.errors");
  const title = normalizeText(formData.get("title"));
  const derivedSlug = slugify(normalizeText(formData.get("slug")) || title);
  const priceCents = normalizeOptionalNumber(formData.get("price_cents"));
  const compareAtPriceCents = normalizeOptionalNumber(formData.get("compare_at_price_cents"));
  const supplierCostCents = normalizeOptionalNumber(formData.get("supplier_cost_cents"));

  if (!title) {
    throw new Error(t("titleRequired"));
  }

  if (!derivedSlug) {
    throw new Error(t("slugRequired"));
  }

  if (!Number.isFinite(priceCents) || priceCents === null || priceCents < 0) {
    throw new Error(t("priceInvalid"));
  }

  if (compareAtPriceCents !== null && (!Number.isFinite(compareAtPriceCents) || compareAtPriceCents < 0)) {
    throw new Error(t("compareAtPriceInvalid"));
  }

  if (supplierCostCents !== null && (!Number.isFinite(supplierCostCents) || supplierCostCents < 0)) {
    throw new Error(t("supplierCostInvalid"));
  }

  return {
    title,
    slug: derivedSlug,
    description: normalizeText(formData.get("description")),
    brand: normalizeText(formData.get("brand")),
    category: normalizeText(formData.get("category")),
    productUrl: normalizeText(formData.get("product_url")),
    imageUrl: normalizeText(formData.get("image_url")),
    currency: (normalizeText(formData.get("currency")) || "USD").toUpperCase(),
    priceCents,
    compareAtPriceCents,
    status: normalizeText(formData.get("status")) || "draft",
    inventoryStatus: normalizeText(formData.get("inventory_status")) || "unknown",
    sourceType: normalizeText(formData.get("source_type")) || "manual",
    supplier: normalizeText(formData.get("supplier")),
    supplierProductId: normalizeText(formData.get("supplier_product_id")),
    supplierUrl: normalizeText(formData.get("supplier_url")),
    supplierCostCents,
  };
}

async function ensureSlugAvailable(slug: string, currentId?: string): Promise<void> {
  const { rows } = await dbQuery(
    "SELECT id FROM marketplace_products WHERE slug = $1 LIMIT 1",
    [slug]
  );

  if (rows.length === 0) {
    return;
  }

  if (currentId && rows[0].id === currentId) {
    return;
  }

  const t = await getTranslations("adminMarketplace.editor.errors");
  throw new Error(t("slugInUse"));
}

async function writeMarketplaceProduct(values: ProductFormValues, currentId?: string): Promise<string> {
  await ensureSlugAvailable(values.slug, currentId);

  if (currentId) {
    await dbQuery(
      `
        UPDATE marketplace_products
        SET
          title = $1,
          slug = $2,
          description = $3,
          brand = $4,
          category = $5,
          product_url = $6,
          image_url = $7,
          currency = $8,
          price_cents = $9,
          compare_at_price_cents = $10,
          status = $11,
          inventory_status = $12,
          source_type = $13,
          supplier = NULLIF($14, ''),
          supplier_product_id = NULLIF($15, ''),
          supplier_url = NULLIF($16, ''),
          supplier_cost_cents = $17,
          updated_at = NOW()
        WHERE id = $18
      `,
      [
        values.title,
        values.slug,
        values.description || null,
        values.brand || null,
        values.category || null,
        values.productUrl || null,
        values.imageUrl || null,
        values.currency,
        values.priceCents,
        values.compareAtPriceCents,
        values.status,
        values.inventoryStatus,
        values.sourceType,
        values.supplier,
        values.supplierProductId,
        values.supplierUrl,
        values.supplierCostCents,
        currentId,
      ]
    );

    return currentId;
  }

  const { rows } = await dbQuery(
    `
      INSERT INTO marketplace_products (
        title,
        slug,
        description,
        brand,
        category,
        product_url,
        image_url,
        currency,
        price_cents,
        compare_at_price_cents,
        status,
        inventory_status,
        source_type,
        supplier,
        supplier_product_id,
        supplier_url,
        supplier_cost_cents
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, NULLIF($14, ''), NULLIF($15, ''), NULLIF($16, ''), $17
      )
      RETURNING id
    `,
    [
      values.title,
      values.slug,
      values.description || null,
      values.brand || null,
      values.category || null,
      values.productUrl || null,
      values.imageUrl || null,
      values.currency,
      values.priceCents,
      values.compareAtPriceCents,
      values.status,
      values.inventoryStatus,
      values.sourceType,
      values.supplier,
      values.supplierProductId,
      values.supplierUrl,
      values.supplierCostCents,
    ]
  );

  if (rows[0]?.id) {
    labelProduct({
      id: rows[0].id,
      title: values.title,
      description: values.description ?? null,
      category: values.category ?? null,
    }).catch(() => {});
  }
  return rows[0].id;
}

export async function createMarketplaceProduct(formData: FormData) {
  const actor = await assertAdminPermission("commerce");
  const t = await getTranslations("adminMarketplace.editor.errors");

  let productId = "";
  try {
    const values = await readProductFormValues(formData);
    productId = await writeMarketplaceProduct(values);
    await logAdminAction({ action: "marketplace_product.create", targetType: "marketplace_product", targetId: productId, details: { title: values.title, slug: values.slug }, actor });
    revalidatePath("/admin/marketplace");
  } catch (error) {
    const message = error instanceof Error ? error.message : t("createFailed");
    redirect(`/admin/marketplace/new?error=${encodeActionError(message)}`);
  }

  redirect(`/admin/marketplace/${productId}?created=1`);
}

export async function updateMarketplaceProduct(id: string, formData: FormData) {
  const actor = await assertAdminPermission("commerce");
  const t = await getTranslations("adminMarketplace.editor.errors");

  try {
    const values = await readProductFormValues(formData);
    await writeMarketplaceProduct(values, id);
    await logAdminAction({ action: "marketplace_product.update", targetType: "marketplace_product", targetId: id, details: { title: values.title, slug: values.slug }, actor });

    revalidatePath("/admin/marketplace");
    revalidatePath(`/admin/marketplace/${id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : t("saveFailed");
    redirect(`/admin/marketplace/${id}?error=${encodeActionError(message)}`);
  }

  redirect(`/admin/marketplace/${id}?saved=1`);
}
