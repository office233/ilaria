"use client";

/**
 * Swypik Food — listarea restaurantelor.
 * Partenerii comandabili primii; restaurantele care nu sunt încă pe Swypik
 * apar separat, onest („Nu încă pe Swypik”), cu „Sugerează proprietarului”.
 */
import { useMemo, useState } from "react";
import { Link } from "@/lib/i18n/navigation";
import { MapPin, Receipt, Store, UtensilsCrossed } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/ui/PageHeader";
import { IconButton } from "@/components/ui/IconButton";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import FoodFilters, { type FoodFilterState } from "@/components/food/FoodFilters";
import CitySheet from "@/components/food/CitySheet";
import MerchantCard from "@/components/food/MerchantCard";
import UnclaimedMerchantRow from "@/components/food/UnclaimedMerchantRow";
import { useFoodLocation } from "@/components/food/useFoodLocation";
import { useMerchantList } from "@/components/food/useMerchantList";
import { useSuggestMerchant } from "@/components/food/useSuggestMerchant";

const INITIAL: FoodFilterState = { q: "", cuisine: null, sort: "recommended", openNow: false };

export default function FoodClient() {
  const t = useTranslations("foodHub");
  const { toast } = useToast();
  const loc = useFoodLocation();
  const [filters, setFilters] = useState<FoodFilterState>(INITIAL);
  const [cityOpen, setCityOpen] = useState(false);
  const list = useMerchantList({ filters, city: loc.city, geo: loc.geo, enabled: loc.ready });
  const sug = useSuggestMerchant();

  const partners = useMemo(() => list.items.filter((m) => m.is_orderable), [list.items]);
  const unclaimed = useMemo(() => list.items.filter((m) => !m.is_orderable), [list.items]);
  const filtered = filters.q.trim() !== "" || filters.cuisine !== null || filters.openNow;

  const locate = async () => {
    const err = await loc.locate();
    if (err) toast({ title: t(`geo.${err}`), tone: "danger" });
    else setCityOpen(false);
  };

  const placeLabel = loc.geo ? t("nearMe") : loc.city ?? t("chooseCity");

  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <>
            <Button variant="ghost" size="sm" className="max-w-[9rem] min-h-11" onClick={() => setCityOpen(true)}>
              <MapPin size={16} aria-hidden className="shrink-0 text-brand" />
              <span className="truncate">{placeLabel}</span>
            </Button>
            <IconButton asChild label={t("myOrders")}>
              <Link href="/food/orders">
                <Receipt aria-hidden />
              </Link>
            </IconButton>
          </>
        }
      >
        <FoodFilters value={filters} onChange={setFilters} hasGeo={!!loc.geo} />
      </PageHeader>

      <main className="mx-auto max-w-3xl space-y-6 px-gutter pt-4">
        {!loc.city && !loc.geo && loc.ready ? (
          <button
            type="button"
            onClick={() => setCityOpen(true)}
            className="flex w-full items-center gap-3 rounded-card border-2 border-dashed border-strong p-4 text-left"
          >
            <span className="grid h-11 w-11 place-items-center rounded-control bg-brand-soft text-brand-soft-fg" aria-hidden>
              <MapPin size={20} />
            </span>
            <span>
              <span className="block text-sm font-bold text-fg">{t("chooseCityTitle")}</span>
              <span className="block text-sm text-muted">{t("chooseCitySub")}</span>
            </span>
          </button>
        ) : null}

        {list.error && list.items.length === 0 ? (
          <ErrorState title={t("loadError")} onRetry={() => void list.reload()} />
        ) : list.loading && list.items.length === 0 ? (
          <div className="space-y-3" aria-busy="true">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-card" />
            ))}
          </div>
        ) : list.items.length === 0 ? (
          <EmptyState
            icon={UtensilsCrossed}
            title={filtered ? t("noResults") : t("noRestaurants")}
            description={filtered ? t("noResultsSub") : t("ownerCta")}
            action={
              filtered ? (
                <Button variant="secondary" onClick={() => setFilters(INITIAL)}>{t("clearFilters")}</Button>
              ) : (
                <Button asChild><Link href="/food/aplica">{t("ownerBtn")}</Link></Button>
              )
            }
          />
        ) : (
          <>
            {partners.length > 0 ? (
              <section aria-labelledby="food-partners" className="space-y-3">
                <h2 id="food-partners" className="text-base font-bold text-fg">{t("partnersTitle")}</h2>
                {partners.map((m) => <MerchantCard key={m.id} m={m} />)}
              </section>
            ) : null}

            {unclaimed.length > 0 ? (
              <section aria-labelledby="food-unclaimed" className="space-y-3">
                <div>
                  <h2 id="food-unclaimed" className="text-base font-bold text-fg">{t("notOnSwypikTitle")}</h2>
                  <p className="text-sm text-muted">{t("notOnSwypikSub")}</p>
                </div>
                {unclaimed.map((m) => (
                  <UnclaimedMerchantRow
                    key={m.id}
                    m={m}
                    suggested={sug.suggested.has(m.id)}
                    count={sug.counts[m.id] ?? m.suggestion_count}
                    busy={sug.busyId === m.id}
                    onSuggest={(id) => void sug.suggest(id)}
                  />
                ))}
              </section>
            ) : null}

            {list.hasMore ? (
              <Button variant="secondary" block loading={list.loading} onClick={() => void list.loadMore()}>
                {t("loadMore")}
              </Button>
            ) : null}

            <Link href="/food/aplica" className="flex min-h-11 items-center justify-center gap-2 text-sm font-semibold text-muted">
              <Store size={16} aria-hidden /> {t("ownerBtn")}
            </Link>
          </>
        )}
      </main>

      <CitySheet
        open={cityOpen}
        onOpenChange={setCityOpen}
        city={loc.city}
        locating={loc.locating}
        onLocate={() => void locate()}
        onSaveCity={(c) => {
          loc.setCity(c);
          setCityOpen(false);
        }}
      />
    </div>
  );
}
