"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { ProductData } from "@/components/ProductDrawer";
import { haptic } from "@/lib/haptic";
import { routeForProduct } from "@/lib/products/product-route";
import { formatMoneyCents } from "@/lib/i18n/currency";
import type { Locale } from "@/lib/i18n/config";
import { trackEvent } from "@/lib/feed/track";
import type { FeedSource, FeedVideo } from "@/lib/feed/types";
import FeedTopBar from "./FeedTopBar";
import { FeedEmpty, FeedEnd, FeedError, FeedLoading } from "./FeedStates";
import ModuleCardSlide from "./ModuleCardSlide";
import VideoSlide from "./VideoSlide";
import { usePrefersReducedMotion } from "./format";
import { useActiveIndex } from "./useActiveIndex";
import { useFeed } from "./useFeed";
import { useFeedPreload } from "./useFeedPreload";
import { useFeedTelemetry } from "./useFeedTelemetry";
import { useMutedPreference, usePageVisible } from "./usePlaybackPrefs";
import { toDrawerProduct } from "./drawer-product";
import { findLinkedVideo, parseFeedDeepLink } from "./deep-link";
import { VIDEO_PLAYBACK } from "@/lib/config/video-playback";

const ProductDrawer = dynamic(() => import("@/components/ProductDrawer"), { ssr: false });
const CommentsSheet = dynamic(() => import("@/components/social/CommentsSheet"), { ssr: false });

/** Cerem pagina următoare cu atâtea slide-uri înainte de final. */
const PREFETCH_THRESHOLD = 3;

type Props = { initialCategory?: string };

function FeedScreenInner({ initialCategory }: Props) {
  const t = useTranslations("explore");
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const deepLink = useMemo(() => parseFeedDeepLink(searchParams), [searchParams]);
  const pinnedVideoId = deepLink?.videoId;
  const creatorId = searchParams.get("creator_id") || undefined;
  const [source, setSource] = useState<FeedSource>("foryou");
  const feed = useFeed({ source, category: initialCategory || undefined, creatorId, pinnedVideoId, locale });
  const { items, status, hasMore, loadMore, serveInfo } = feed;

  const containerRef = useRef<HTMLDivElement>(null);
  const itemsKey = useMemo(() => items.map((i) => i.key).join("|"), [items]);
  const active = useActiveIndex(containerRef, itemsKey);
  const preload = useFeedPreload(items, active);
  const [muted, setMuted] = useMutedPreference();
  const pageVisible = usePageVisible();
  const reducedMotion = usePrefersReducedMotion();
  const [product, setProduct] = useState<(ProductData & { videoId: string }) | null>(null);
  const [commentsVideo, setCommentsVideo] = useState<FeedVideo | null>(null);
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null);

  // Deep link `?v=…&comment=…` (notificări): la prima pagină deschidem foaia pe clipul țintă.
  const deepLinkHandled = useRef<string | null>(null);
  useEffect(() => {
    if (!deepLink?.commentId || status !== "ready") return;
    const key = `${deepLink.videoId}:${deepLink.commentId}`;
    if (deepLinkHandled.current === key) return;
    deepLinkHandled.current = key;
    const video = findLinkedVideo(items, deepLink);
    if (!video) return;
    setFocusCommentId(deepLink.commentId);
    setCommentsVideo(video);
  }, [deepLink, status, items]);

  const videoEls = useRef<Map<string, HTMLVideoElement>>(new Map());
  const registerEl = useCallback((id: string, el: HTMLVideoElement | null) => {
    if (el) videoEls.current.set(id, el);
    else videoEls.current.delete(id);
  }, []);
  const telemetry = useFeedTelemetry(useCallback((id: string) => videoEls.current.get(id) ?? null, []));

  const activeItem = items[active];
  const prevItemRef = useRef<typeof activeItem>(undefined);
  useEffect(() => {
    if (prevItemRef.current?.key === activeItem?.key) return;
    if (prevItemRef.current) telemetry.onDeactivate(prevItemRef.current);
    if (activeItem) telemetry.onActivate(activeItem, serveInfo(activeItem.key));
    prevItemRef.current = activeItem;
  }, [activeItem, telemetry, serveInfo]);

  useEffect(() => {
    if (items.length > 0 && active >= items.length - PREFETCH_THRESHOLD) loadMore();
  }, [active, items.length, loadMore]);

  const changeSource = (next: FeedSource) => {
    if (next === source) return;
    haptic("tap");
    containerRef.current?.scrollTo({ top: 0 });
    setSource(next);
  };

  const toggleMute = () => {
    haptic("tap");
    const next = !muted;
    videoEls.current.forEach((el) => {
      el.muted = next;
    });
    setMuted(next);
  };

  const notInterested = async (videoId: string) => {
    haptic("tap");
    feed.removeVideo(videoId);
    await fetch("/api/feed/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ video_id: videoId, action: "not_interested" }),
    }).catch(() => undefined);
  };

  const openProduct = (video: FeedVideo) => {
    if (!video.product) return;
    trackEvent("product_click", { video_id: video.id, metadata: { product_id: video.product.id, surface: "feed_chip" } });
    const currency = video.product.currency;
    const formatPrice = (cents: number) => formatMoneyCents(cents, currency, locale as Locale);
    setProduct({ ...toDrawerProduct(video.product, t, formatPrice), videoId: video.id });
  };

  const autoPlay = pageVisible && !reducedMotion && !product && !commentsVideo;
  const showTabs = !creatorId && !initialCategory;

  return (
    <main className="fixed inset-0 overflow-hidden bg-canvas text-fg" aria-label={t("discoverVideosAria")}>
      <h1 className="sr-only">{t("descoperaVideoclipuriSwypik")}</h1>
      <FeedTopBar source={source} onSourceChange={changeSource} showTabs={showTabs} muted={muted} onToggleMute={toggleMute} />
      <div ref={containerRef} className="h-dvh w-full snap-y snap-mandatory overflow-y-scroll overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {status === "loading" ? (
          <section className="h-dvh w-full snap-start">
            <FeedLoading />
          </section>
        ) : status === "error" ? (
          <section className="h-dvh w-full snap-start">
            <FeedError onRetry={feed.reload} />
          </section>
        ) : items.length === 0 ? (
          <section className="h-dvh w-full snap-start">
            <FeedEmpty source={source} onForYou={() => changeSource("foryou")} />
          </section>
        ) : (
          <>
            {items.map((item, idx) => (
              <section
                key={item.key}
                data-feed-index={idx}
                className="h-dvh w-full snap-start snap-always"
                aria-roledescription={t("slideRole")}
                aria-label={t("slideLabel", { n: idx + 1 })}
              >
                {item.kind === "video" ? (
                  <VideoSlide
                    video={item.video}
                    slot={preload.slotFor(idx)}
                    mounted={Math.abs(idx - active) <= VIDEO_PLAYBACK.attachRadius}
                    posterSrc={preload.posterSrc(item.video.thumbnail)}
                    priority={idx === 0}
                    muted={muted}
                    autoPlay={autoPlay}
                    captionLang={locale}
                    registerEl={registerEl}
                    onTimeUpdate={telemetry.onTimeUpdate}
                    onPatch={(patch) => feed.patchVideo(item.video.id, patch)}
                    onFollowChange={feed.patchCreator}
                    onOpenComments={() => {
                      setFocusCommentId(null);
                      setCommentsVideo(item.video);
                    }}
                    onNotInterested={() => void notInterested(item.video.id)}
                    onOpenProduct={() => openProduct(item.video)}
                  />
                ) : (
                  <ModuleCardSlide card={item.card} />
                )}
              </section>
            ))}
            {!hasMore ? (
              <section className="h-dvh w-full snap-start">
                <FeedEnd />
              </section>
            ) : null}
          </>
        )}
      </div>

      {product ? (
        <ProductDrawer
          initialProduct={product}
          onClose={() => setProduct(null)}
          onBuyNow={() => {
            trackEvent("product_click", { video_id: product.videoId, metadata: { product_id: product.id, surface: "product_drawer" } });
            router.push(routeForProduct(product));
          }}
        />
      ) : null}
      <CommentsSheet
        open={Boolean(commentsVideo)}
        videoId={commentsVideo?.id ?? null}
        initialCount={commentsVideo?.comments}
        focusCommentId={focusCommentId}
        onClose={() => {
          setCommentsVideo(null);
          setFocusCommentId(null);
        }}
        onCountChange={(count: number) => {
          if (commentsVideo) feed.patchVideo(commentsVideo.id, (v) => ({ ...v, comments: count }));
        }}
      />
    </main>
  );
}

/** Feed-ul vertical unificat (Home + /explore): clipuri + carduri de modul. */
export default function FeedScreen(props: Props) {
  return (
    <Suspense fallback={<FeedLoading />}>
      <FeedScreenInner {...props} />
    </Suspense>
  );
}
