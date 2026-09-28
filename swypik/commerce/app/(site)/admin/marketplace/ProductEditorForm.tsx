import Link from "next/link";
import { AlertCircle, ArrowLeft, CheckCircle2, ExternalLink, ImageIcon, Package, Save, Video } from "lucide-react";
import { getTranslations } from "next-intl/server";

type ProductRecord = {
  id?: string;
  title?: string | null;
  slug?: string | null;
  description?: string | null;
  brand?: string | null;
  category?: string | null;
  product_url?: string | null;
  image_url?: string | null;
  currency?: string | null;
  price_cents?: number | null;
  compare_at_price_cents?: number | null;
  status?: string | null;
  inventory_status?: string | null;
  source_type?: string | null;
  supplier?: string | null;
  supplier_product_id?: string | null;
  supplier_url?: string | null;
  supplier_cost_cents?: number | null;
  metadata?: Record<string, unknown> | null;
};

type ProductEditorFormProps = {
  mode: "create" | "edit";
  action: (formData: FormData) => void | Promise<void>;
  product?: ProductRecord;
  notice?: { type: "success" | "error"; message: string } | null;
};

const statusOptions = ["draft", "active", "out_of_stock", "archived", "disabled"];
const inventoryOptions = ["unknown", "in_stock", "low_stock", "out_of_stock", "preorder"];
const sourceOptions = ["manual", "seller", "affiliate", "other"];
// Multi-ERP retras (2026-09-28): „multi_erp” rămâne doar pe produsele istorice,
// afișat ca opțiune numai când produsul editat îl are deja (salvarea nu-l rescrie).
const LEGACY_SOURCE = "multi_erp";

export default async function ProductEditorForm({ mode, action, product, notice }: ProductEditorFormProps) {
  const t = await getTranslations("adminMarketplace.editor");
  const isEdit = mode === "edit";
  const pageTitle = isEdit ? t("editTitle") : t("createTitle");
  const submitLabel = isEdit ? t("saveChanges") : t("createProduct");
  const metadata = product?.metadata ?? {};
  const hasVideo = Boolean(metadata.has_video);
  const ordersCount = Number((metadata.orders_count as number | string | undefined) || 0);
  const videoUrl = typeof metadata.video_url === "string" ? metadata.video_url : null;

  const statusLabels: Record<string, string> = {
    draft: t("status.draft"),
    active: t("status.active"),
    out_of_stock: t("status.outOfStock"),
    archived: t("status.archived"),
    disabled: t("status.disabled"),
  };
  const inventoryLabels: Record<string, string> = {
    unknown: t("inventory.unknown"),
    in_stock: t("inventory.inStock"),
    low_stock: t("inventory.lowStock"),
    out_of_stock: t("inventory.outOfStock"),
    preorder: t("inventory.preorder"),
  };
  const sourceLabels: Record<string, string> = {
    manual: t("source.manual"),
    seller: t("source.seller"),
    affiliate: t("source.affiliate"),
    multi_erp: t("source.multiErp"),
    other: t("source.other"),
  };

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <Link
          href="/admin/marketplace"
          className="inline-flex items-center text-sm font-bold text-slate-500 hover:text-slate-900 transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          {t("backToMarketplace")}
        </Link>
        {product?.product_url ? (
          <a
            href={product.product_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 text-sm font-bold text-slate-600 hover:text-slate-900"
          >
            {t("openSourceLink")}
            <ExternalLink className="w-4 h-4" />
          </a>
        ) : null}
      </div>

      <form action={action} className="space-y-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-3xl font-black text-slate-900">{pageTitle}</h1>
            <p className="mt-2 text-sm text-slate-500">
              {isEdit ? t("editSubtitle") : t("createSubtitle")}
            </p>
            {product?.id ? <p className="mt-2 font-mono text-xs text-slate-500 break-all">{product.id}</p> : null}
          </div>
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 py-3 text-sm font-bold text-white hover:bg-slate-800 transition-colors"
          >
            <Save className="w-4 h-4" />
            {submitLabel}
          </button>
        </div>

        {notice ? (
          <div
            className={`rounded-2xl border px-4 py-3 text-sm ${notice.type === "success"
                ? "border-neutral-100 bg-neutral-100 text-neutral-900"
                : "border-red-200 bg-red-50 text-red-900"
              }`}
          >
            <div className="flex items-start gap-2">
              {notice.type === "success" ? (
                <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              )}
              <span>{notice.message}</span>
            </div>
          </div>
        ) : null}

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-6 min-w-0">
            <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
              <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2 mb-4">
                <Package className="w-5 h-5 text-slate-400" />
                {t("productDetails")}
              </h2>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label={t("field.title")} name="title" defaultValue={product?.title} required />
                <Field label={t("field.slug")} name="slug" defaultValue={product?.slug} hint={t("field.slugHint")} />
                <Field label={t("field.brand")} name="brand" defaultValue={product?.brand} />
                <Field label={t("field.category")} name="category" defaultValue={product?.category} />
                <Field label={t("field.sourceLink")} name="product_url" defaultValue={product?.product_url} className="md:col-span-2" />
                <TextArea label={t("field.description")} name="description" defaultValue={product?.description} className="md:col-span-2" />
              </div>
            </section>

            <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
              <h2 className="text-lg font-bold text-slate-900 mb-4">{t("pricingAvailability")}</h2>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label={t("field.priceCents")} name="price_cents" type="number" defaultValue={asInputValue(product?.price_cents)} required />
                <Field
                  label={t("field.compareAtPriceCents")}
                  name="compare_at_price_cents"
                  type="number"
                  defaultValue={asInputValue(product?.compare_at_price_cents)}
                />
                <Field label={t("field.currency")} name="currency" defaultValue={product?.currency || "USD"} maxLength={3} />
                <SelectField label={t("field.status")} name="status" defaultValue={product?.status || "draft"} options={statusOptions} labels={statusLabels} />
                <SelectField
                  label={t("field.inventoryStatus")}
                  name="inventory_status"
                  defaultValue={product?.inventory_status || "unknown"}
                  options={inventoryOptions}
                  labels={inventoryLabels}
                />
                <SelectField label={t("field.sourceType")} name="source_type" defaultValue={product?.source_type || "manual"} options={product?.source_type === LEGACY_SOURCE ? [...sourceOptions, LEGACY_SOURCE] : sourceOptions} labels={sourceLabels} />
              </div>
            </section>

            <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
              <h2 className="text-lg font-bold text-slate-900 mb-4">{t("mediaSourcing")}</h2>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label={t("field.imageUrl")} name="image_url" defaultValue={product?.image_url} className="md:col-span-2" />
                <Field label={t("field.supplier")} name="supplier" defaultValue={product?.supplier} />
                <Field label={t("field.supplierProductId")} name="supplier_product_id" defaultValue={product?.supplier_product_id} />
                <Field label={t("field.supplierUrl")} name="supplier_url" defaultValue={product?.supplier_url} className="md:col-span-2" />
                <Field
                  label={t("field.supplierCostCents")}
                  name="supplier_cost_cents"
                  type="number"
                  defaultValue={asInputValue(product?.supplier_cost_cents)}
                />
              </div>
            </section>
          </div>

          <aside className="space-y-6 min-w-0">
            <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
              <h2 className="text-sm font-black uppercase tracking-[0.12em] text-slate-500 mb-4">{t("listingSnapshot")}</h2>
              <div className="space-y-4">
                <div className="aspect-square rounded-2xl border border-slate-200 bg-slate-50 overflow-hidden flex items-center justify-center">
                  {product?.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element -- external/arbitrary product image hosts, not a fixed known set
                    <img src={product.image_url} alt={product.title || t("productImageAlt")} className="h-full w-full object-cover" />
                  ) : (
                    <div className="text-center text-slate-400 px-6">
                      <ImageIcon className="w-8 h-8 mx-auto mb-2" />
                      <p className="text-sm font-semibold">{t("noImageAssigned")}</p>
                      <p className="text-xs mt-1">{t("noImageHint")}</p>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <StatCard label={t("stat.orders")} value={String(ordersCount)} />
                  <StatCard label={t("stat.video")} value={hasVideo ? t("stat.attached") : t("stat.unavailable")} />
                </div>
              </div>
            </section>

            <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
              <h2 className="text-sm font-black uppercase tracking-[0.12em] text-slate-500 mb-4">{t("mediaControls")}</h2>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-200 text-slate-700">
                    <Video className="w-4 h-4" />
                  </div>
                  <div className="space-y-1 min-w-0">
                    <p className="text-sm font-bold text-slate-900">
                      {hasVideo ? t("videoAttached") : t("videoUploadDisabled")}
                    </p>
                    <p className="text-xs text-slate-500 break-words">
                      {hasVideo ? videoUrl || t("videoMetadataPreserved") : t("videoUploadHint")}
                    </p>
                  </div>
                </div>
              </div>
            </section>
          </aside>
        </div>
      </form>
    </div>
  );
}

function asInputValue(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : "";
}

function Field({
  label,
  name,
  defaultValue,
  required,
  type = "text",
  hint,
  className,
  maxLength,
}: {
  label: string;
  name: string;
  defaultValue?: string | null;
  required?: boolean;
  type?: string;
  hint?: string;
  className?: string;
  maxLength?: number;
}) {
  return (
    <div className={className}>
      <label className="block text-sm font-bold text-slate-700 mb-1.5">{label}</label>
      <input
        type={type}
        name={name}
        required={required}
        defaultValue={defaultValue || ""}
        maxLength={maxLength}
        className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
      />
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function TextArea({
  label,
  name,
  defaultValue,
  className,
}: {
  label: string;
  name: string;
  defaultValue?: string | null;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="block text-sm font-bold text-slate-700 mb-1.5">{label}</label>
      <textarea
        name={name}
        rows={6}
        defaultValue={defaultValue || ""}
        className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
      />
    </div>
  );
}

function SelectField({
  label,
  name,
  defaultValue,
  options,
  labels,
}: {
  label: string;
  name: string;
  defaultValue: string;
  options: string[];
  labels: Record<string, string>;
}) {
  return (
    <div>
      <label className="block text-sm font-bold text-slate-700 mb-1.5">{label}</label>
      <select
        name={name}
        defaultValue={defaultValue}
        className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {labels[option] ?? option.replace(/_/g, " ")}
          </option>
        ))}
      </select>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
      <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-bold text-slate-900">{value}</p>
    </div>
  );
}
