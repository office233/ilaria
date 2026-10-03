"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useToast } from "@/components/ui/Toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import { Link } from "@/lib/i18n/navigation";
import type { Currency } from "@/lib/i18n/config";
import type { ProductDetail } from "@/lib/products/get-product-detail";
import type { CatalogCard } from "@/lib/shop/catalog";
import type { ProductClip } from "@/lib/shop/product-page";
import { Stars } from "../Stars";
import { QuantityStepper } from "../QuantityStepper";
import { useShopError } from "../useShopError";
import { ProductClips } from "./ProductClips";
import { ProductDetails } from "./ProductDetails";
import { ProductGallery, type GallerySlide } from "./ProductGallery";
import { SimilarProducts } from "./SimilarProducts";
import { StickyBuyBar } from "./StickyBuyBar";
import { VariantPicker } from "./VariantPicker";

type Props = {
  detail: ProductDetail;
  clips: ProductClip[];
  similar: CatalogCard[];
  reviewSummary: { average: number | null; total: number };
  reviews: ReactNode;
  sourceVideoId: string | null;
  maxLineQty: number;
};

/** Pagina de produs (client): galerie, variantă, cantitate, tab-uri, bara fixă de cumpărare. */
export function ProductView({ detail, clips, similar, reviewSummary, reviews, sourceVideoId, maxLineQty }: Props) {
  const t = useTranslations("shopBuyer");
  const formatPrice = useFormatPrice();
  const { toast } = useToast();
  const errorMessage = useShopError();
  const { product, variants } = detail;
  const currency = product.currency as Currency;
  const isListing = product.listingType !== "product";

  const [variantId, setVariantId] = useState<string | null>(
    () => (variants.find((v) => v.stock > 0) ?? variants[0])?.id ?? null,
  );
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [justAdded, setJustAdded] = useState(false);
  const [tab, setTab] = useState(clips.length > 0 ? "clips" : "details");

  const selected = variants.find((v) => v.id === variantId) ?? null;
  const unitCents = Math.round((selected?.priceRon ?? product.price) * 100);
  const compareCents = product.oldPrice ? Math.round(product.oldPrice * 100) : 0;
  const stock = selected ? selected.stock : product.availableStock;
  const canBuy = !isListing && (stock == null || stock > 0);
  const maxQty = Math.max(1, Math.min(maxLineQty, stock ?? maxLineQty));
  const discount = compareCents > unitCents ? Math.round(((compareCents - unitCents) / compareCents) * 100) : 0;

  const slides = useMemo<GallerySlide[]>(() => {
    const out: GallerySlide[] = [];
    if (clips[0]) out.push({ kind: "video", src: clips[0].playbackUrl, poster: clips[0].thumbnailUrl ?? product.images[0] });
    const images = [...product.images];
    for (const v of variants) if (v.image && !images.includes(v.image)) images.push(v.image);
    for (const src of images) out.push({ kind: "image", src });
    return out;
  }, [clips, product.images, variants]);
  const focusIndex = selected?.image ? slides.findIndex((s) => s.kind === "image" && s.src === selected.image) : -1;

  const stockHint =
    isListing || stock == null ? null : stock <= 0 ? t("common.outOfStock") : stock <= 5 ? t("common.lowStock", { count: stock }) : t("common.inStock");

  const addToCart = async () => {
    if (busy || !canBuy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/cart/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ productId: product.id, variantId, quantity: qty, videoId: sourceVideoId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: errorMessage(data), tone: "danger" });
        return;
      }
      setJustAdded(true);
      toast({ title: t("common.added"), tone: "success" });
      window.setTimeout(() => setJustAdded(false), 4000);
    } catch {
      toast({ title: errorMessage({ code: "network" }), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const taxonomy = product.taxonomyPath ?? [];

  return (
    <div className="pb-28">
      <div className="mx-auto max-w-5xl lg:grid lg:grid-cols-2 lg:gap-8 lg:px-gutter lg:pt-4">
        <ProductGallery slides={slides} title={product.title} discountPercent={discount} focusIndex={focusIndex} />

        <div className="space-y-5 px-gutter pt-4 lg:px-0">
          {taxonomy.length > 0 ? (
            <nav aria-label={t("categories.breadcrumb")} className="no-scrollbar flex gap-1 overflow-x-auto text-xs text-muted">
              {taxonomy.map((node, i) => (
                <span key={node.slug} className="flex shrink-0 items-center gap-1">
                  {i > 0 ? <span aria-hidden>/</span> : null}
                  <Link href={`/categories/${encodeURIComponent(node.slug)}`} className="hover:text-fg">
                    {node.label}
                  </Link>
                </span>
              ))}
            </nav>
          ) : null}
          <div className="space-y-2">
            <h1 className="text-xl font-semibold leading-snug text-fg">{product.title}</h1>
            {reviewSummary.total > 0 && reviewSummary.average != null ? (
              <button
                type="button"
                onClick={() => {
                  setTab("reviews");
                  document.getElementById("product-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                className="inline-flex min-h-[2.75rem] items-center gap-2 text-sm text-muted"
              >
                <Stars value={reviewSummary.average} label={t("reviews.starsAria", { value: reviewSummary.average })} />
                {t("reviews.basedOn", { count: reviewSummary.total })}
              </button>
            ) : null}
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums text-fg">{formatPrice(unitCents, { sourceCurrency: currency })}</span>
              {discount > 0 ? (
                <span className="text-sm text-subtle line-through">{formatPrice(compareCents, { sourceCurrency: currency })}</span>
              ) : null}
            </div>
          </div>

          {!isListing && variants.length > 0 ? (
            <VariantPicker
              variants={variants}
              selectedId={variantId}
              onSelect={(id) => {
                setVariantId(id);
                setQty(1);
              }}
            />
          ) : null}

          {!isListing && canBuy ? (
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-fg">{t("common.quantity")}</span>
              <QuantityStepper value={Math.min(qty, maxQty)} max={maxQty} onChange={setQty} />
            </div>
          ) : null}

          <Tabs value={tab} onValueChange={setTab} id="product-tabs" className="scroll-mt-20">
            <TabsList variant="underline">
              <TabsTrigger value="clips">{t("product.tabClips", { count: clips.length })}</TabsTrigger>
              <TabsTrigger value="details">{t("product.tabDetails")}</TabsTrigger>
              <TabsTrigger value="reviews">{t("product.tabReviews", { count: reviewSummary.total })}</TabsTrigger>
            </TabsList>
            <TabsContent value="clips" className="pt-4">
              <ProductClips clips={clips} />
            </TabsContent>
            <TabsContent value="details" className="pt-4">
              <ProductDetails product={product} />
            </TabsContent>
            <TabsContent value="reviews" className="pt-4">
              {reviews}
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <div className="mx-auto mt-8 max-w-5xl px-gutter">
        <SimilarProducts products={similar} />
      </div>

      <StickyBuyBar
        priceLabel={formatPrice(unitCents * (canBuy ? Math.min(qty, maxQty) : 1), { sourceCurrency: currency })}
        compareLabel={discount > 0 && qty === 1 ? formatPrice(compareCents, { sourceCurrency: currency }) : null}
        stockHint={stockHint}
        mode={isListing ? "listing" : "product"}
        listingHref={product.ctaUrl}
        canBuy={canBuy}
        busy={busy}
        justAdded={justAdded}
        onAdd={() => void addToCart()}
      />
    </div>
  );
}
