"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Heart,
  MessageCircle,
  Package,
  Play,
  ShoppingCart,
  Star,
  Truck,
  Volume2,
  VolumeX,
  Zap,
  Sparkles,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useHlsVideo } from "@/lib/video/useHlsVideo";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import { isCurrency } from "@/lib/i18n/config";
import { isEnabledClient } from "@/lib/feature-flags-client";

// Heavy client-only components — lazy-load to keep initial bundle small.
const CommentsSheet = dynamic(() => import("./social/CommentsSheet"), { ssr: false });
const VirtualTryOnModal = dynamic(() => import("./video/VirtualTryOnModal"), { ssr: false });
// Try-On e doar o previzualizare UI (fara AR real) - vizibil doar cu NEXT_PUBLIC_FEATURE_VIRTUAL_TRYON=1
// (sau legacy NEXT_PUBLIC_FEATURE_TRY_ON=1).
const TRY_ON_ENABLED = isEnabledClient("virtualTryOn");
import {
  trackEvent as trackFeedEvent,
  trackWatchTime,
  flushWatchTime,
  resetWatchTime,
} from "@/lib/feed/track";
import type { FeedEventType } from "@/lib/feed/event-types";

// Map legacy in-component event names → granular tracking taxonomy.
// Anything not in the map is skipped for the new pipeline (legacy pipeline
// still ships it via /api/v1/events for the Go social service).
const TRACK_EVENT_MAP: Record<string, FeedEventType> = {
  video_impression: "impression",
  video_view: "video_view",
  video_play: "video_view",
  video_pause: "pause",
  video_complete: "completion",
  video_completion: "completion",
  watch_time: "watch_time",
  skip_fast: "skip_fast",
  video_like: "like",
  video_unlike: "unlike",
  video_save: "save",
  video_unsave: "unsave",
  video_share: "share",
  video_comment: "comment",
  creator_follow: "follow",
  creator_unfollow: "unfollow",
  product_click: "product_click",
  add_to_cart: "add_to_cart",
  not_interested: "not_interested",
  more_like_this: "more_like_this",
  report: "report",
};

type FeedProduct = {
  id: string;
  pgId?: number;
  title: string;
  description: string;
  benefits: string[];
  dealLabel: string;
  whyBuy: string;
  warnings: string[];
  price: number;
  oldPrice: number;
  discountPercent: number;
  rating: number;
  orders: number;
  deliveryDays: number;
  images: string[];
  category: string;
  gradient: string;
  qualityScore: number;
  viewers?: number;
  cartAdds?: number;
  likes?: number;
  commentCount?: number;
  socialProofLabel?: string;
  commerceBadge?: string;
  isEstimatedSocial?: boolean;
  video?: string | null;
  hasVideo?: boolean;
  product_id?: string | number;
  productId?: string | number;
  video_id?: string | number;
  videoId?: string | number;
  creator_id?: string;
  creatorId?: string;
  viewerLiked?: boolean;
};

type Props = {
  products: FeedProduct[];
  onAddToCart: (p: FeedProduct, qty?: number) => void;
  onLoadMore?: () => void;
  onClose?: () => void;
  isLoading: boolean;
};

type FeedEvent = {
  type: string;
  actor_id?: string;
  subject_type: string;
  subject_id: string;
  metadata?: Record<string, unknown>;
  occurred_at: string;
};

const PRODUCT_EVENT_TYPES = new Set(["product_click", "add_to_cart", "checkout_start", "purchase_complete"]);
const CREATOR_EVENT_TYPES = new Set(["profile_open", "follow_creator"]);

function firstEventId(...values: unknown[]) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const id = String(value).trim();
    if (id) return id;
  }
  return "";
}

function productEventId(product: FeedProduct) {
  return firstEventId(product.product_id, product.productId, product.pgId, product.id);
}

function videoEventId(product: FeedProduct) {
  return firstEventId(product.video_id, product.videoId, product.id);
}

function creatorEventId(product: FeedProduct) {
  return firstEventId(product.creator_id, product.creatorId, "swypik");
}

function eventSubject(type: string, product: FeedProduct) {
  if (CREATOR_EVENT_TYPES.has(type)) return { subject_type: "creator", subject_id: creatorEventId(product) };
  if (PRODUCT_EVENT_TYPES.has(type)) return { subject_type: "product", subject_id: productEventId(product) };
  const videoId = videoEventId(product);
  return videoId ? { subject_type: "video", subject_id: videoId } : { subject_type: "product", subject_id: productEventId(product) };
}

function aiOverlay(product: FeedProduct, t: (key: string) => string) {
  if (product.commerceBadge) return product.commerceBadge;
  if (product.discountPercent >= 20) return t("badgeGoodDeal");
  if (product.rating >= 4.8) return t("badgeTopQuality");
  if ((product.orders || 0) > 250) return t("badgePopular");
  return t("badgeAiPick");
}

function getRealLikes(product: FeedProduct) {
  // 2026-08-10: fara engagement sintetic — doar numere reale (0 daca nu exista).
  return product.likes || 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getRealComments(product: FeedProduct) {
  return product.commentCount || 0;
}

/**
 * FeedVideo — wraps <video> with HLS support via useHlsVideo. The src is set
 * by the hook (not as an attribute) so hls.js can intercept .m3u8 URLs.
 */
type FeedVideoProps = Omit<React.VideoHTMLAttributes<HTMLVideoElement>, "src" | "ref"> & {
  src: string;
  registerRef: (el: HTMLVideoElement | null) => void;
};

function FeedVideo({ src, registerRef, ...rest }: FeedVideoProps) {
  const ref = useHlsVideo(src);
  useEffect(() => {
    registerRef(ref.current);
    return () => registerRef(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.current]);
  return <video ref={ref} {...rest} />;
}

export default function ProductFeed({ products, onAddToCart, onLoadMore, onClose, isLoading }: Props) {
  const router = useRouter();
  const t = useTranslations("productFeed");
  const formatPrice = useFormatPrice();
  const tapAction = { touchAction: "manipulation" } as const;
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const videoMapRef = useRef<Record<string, HTMLVideoElement>>({});
  const sessionIdRef = useRef("");
  const eventQueueRef = useRef<FeedEvent[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenViewRef = useRef(new Set<string>());
  const [currentIdx, setCurrentIdx] = useState(0);
  const [likes, setLikes] = useState<Record<string, boolean>>({});
  // Contorul de like vine din răspunsul serverului (sursa adevărului), nu din
  // aritmetică locală peste snapshot-ul feed-ului.
  const [likeCounts, setLikeCounts] = useState<Record<string, number>>({});

  // Seed din server: fără asta, inima apărea gri după refresh chiar dacă
  // like-ul era salvat (audit 2026-08-25). Nu suprascrie toggle-urile locale —
  // setează doar id-urile pe care userul nu le-a atins în sesiunea curentă.
  useEffect(() => {
    setLikes((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const product of products) {
        if (product.viewerLiked && !(product.id in next)) {
          next[product.id] = true;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [products]);
  const [heartBurst, setHeartBurst] = useState<string | null>(null);
  const [videoErrors, setVideoErrors] = useState<Record<string, boolean>>({});
  const [isMuted, setIsMuted] = useState(true);
  const [addedToCart, setAddedToCart] = useState<string | null>(null);
  const [showComments, setShowComments] = useState<string | null>(null);
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});

  const getSessionId = useCallback(() => {
    if (sessionIdRef.current) return sessionIdRef.current;
    try {
      const stored = window.localStorage.getItem("aicv_feed_session_id");
      if (stored) {
        sessionIdRef.current = stored;
        return stored;
      }
    } catch { }

    const next =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `feed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    sessionIdRef.current = next;
    try {
      window.localStorage.setItem("aicv_feed_session_id", next);
    } catch { }
    return next;
  }, []);

  const flushFeedEvents = useCallback((useBeacon = false) => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const events = eventQueueRef.current.splice(0);
    if (events.length === 0) return;

    const sessionId = getSessionId();
    const eventsWithActor = events.map((event) => ({
      ...event,
      actor_id: event.actor_id || sessionId,
      metadata: { session_id: sessionId, ...(event.metadata || {}) },
    }));
    const batchBody = JSON.stringify({ events: eventsWithActor });
    const sendLegacyFallback = () => {
      eventsWithActor.forEach((event) => {
        fetch("/api/v1/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
          keepalive: true,
        }).catch(() => { });
      });
    };

    if (useBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
      try {
        const blob = new Blob([batchBody], { type: "application/json" });
        if (navigator.sendBeacon("/api/v1/events/batch", blob)) return;
      } catch { }
    }

    fetch("/api/v1/events/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: batchBody,
      keepalive: true,
    })
      .then((res) => {
        if (!res.ok) sendLegacyFallback();
      })
      .catch(sendLegacyFallback);
  }, [getSessionId]);

  const sendFeedEvent = useCallback((type: string, product: FeedProduct, details: Record<string, unknown> = {}) => {
    const { watchMs, positionMs, ...metadata } = details;
    const subject = eventSubject(type, product);
    eventQueueRef.current.push({
      type,
      actor_id: getSessionId(),
      subject_type: subject.subject_type,
      subject_id: subject.subject_id,
      occurred_at: new Date().toISOString(),
      metadata: {
        source: "next-feed",
        product_id: productEventId(product),
        video_id: videoEventId(product),
        creator_id: creatorEventId(product),
        ...(typeof watchMs === "number" ? { watch_ms: Math.max(0, Math.trunc(watchMs)) } : {}),
        ...(typeof positionMs === "number" ? { position_ms: Math.max(0, Math.trunc(positionMs)) } : {}),
        ...metadata,
      },
    });

    // Parallel emit to the granular ranking pipeline (lib/feed/track).
    const mapped = TRACK_EVENT_MAP[type];
    const videoId = videoEventId(product);
    if (mapped && videoId) {
      trackFeedEvent(mapped, {
        video_id: videoId,
        watch_ms: typeof watchMs === "number" ? Math.max(0, Math.trunc(watchMs)) : undefined,
        position_ms: typeof positionMs === "number" ? Math.max(0, Math.trunc(positionMs)) : undefined,
        metadata: {
          product_id: productEventId(product),
          creator_id: creatorEventId(product),
          source: "product-feed",
          ...metadata,
        },
      });
      if (mapped === "completion") resetWatchTime(videoId);
      if (mapped === "pause" || mapped === "skip_fast") flushWatchTime(videoId);
    }

    if (eventQueueRef.current.length >= 10) {
      flushFeedEvents();
      return;
    }
    if (!flushTimerRef.current) flushTimerRef.current = setTimeout(() => flushFeedEvents(), 2500);
  }, [flushFeedEvents, getSessionId]);

  useEffect(() => {
    const flushOnHide = () => {
      if (document.visibilityState === "hidden") flushFeedEvents(true);
    };
    // P2-04: handler cu referință stabilă — un listener anonim nu poate fi
    // scos la cleanup, așa că se acumula câte unul la fiecare remount al
    // feed-ului (navigare SPA înapoi), producând flush-uri duplicate.
    const flushOnPageHide = () => flushFeedEvents(true);
    window.addEventListener("pagehide", flushOnPageHide);
    document.addEventListener("visibilitychange", flushOnHide);
    return () => {
      window.removeEventListener("pagehide", flushOnPageHide);
      document.removeEventListener("visibilitychange", flushOnHide);
      flushFeedEvents(true);
    };
  }, [flushFeedEvents]);

  useEffect(() => {
    const product = products[currentIdx];
    if (!product || seenViewRef.current.has(product.id)) return;
    seenViewRef.current.add(product.id);
    sendFeedEvent("video_impression", product, { position: currentIdx });
  }, [currentIdx, products, sendFeedEvent]);

  // ── CONTRACT DE EVENIMENTE (lib/feed/track.ts) ─────────────────────────
  // video_view: DOAR dupa >=3s de redare activa (VIEW_MIN_MS=3000).
  // watch_time: incremental, prin trackWatchTime pe timeupdate.
  const VIEW_MIN_MS = 3000;
  const qualifiedViewRef = useRef(new Set<string>());
  const lastTimeUpdateRef = useRef<Record<string, number>>({});
  const activeWatchMsRef = useRef<Record<string, number>>({});

  useEffect(() => {
    const product = products[currentIdx];
    if (!product) return;
    const videoEl = videoMapRef.current[product.id];
    if (!videoEl) return;

    const key = product.id;
    lastTimeUpdateRef.current[key] = 0;

    const onTimeUpdate = () => {
      const nowMs = videoEl.currentTime * 1000;
      const prevMs = lastTimeUpdateRef.current[key] ?? 0;
      const deltaMs = nowMs - prevMs;
      lastTimeUpdateRef.current[key] = nowMs;
      // Ignora seek-uri / loop restart (delta negativ sau sarituri mari).
      if (deltaMs <= 0 || deltaMs > 2000) return;

      const videoId = videoEventId(product);
      if (!videoId) return;

      // watch_time incremental (batched intern in lib/feed/track).
      trackWatchTime(videoId, deltaMs);

      // video_view dupa >=3s cumulat de redare activa, o data per clip.
      activeWatchMsRef.current[key] = (activeWatchMsRef.current[key] ?? 0) + deltaMs;
      if (
        !qualifiedViewRef.current.has(key) &&
        activeWatchMsRef.current[key] >= VIEW_MIN_MS
      ) {
        qualifiedViewRef.current.add(key);
        sendFeedEvent("video_view", product, {
          position: currentIdx,
          watchMs: Math.trunc(activeWatchMsRef.current[key]),
        });
      }
    };

    videoEl.addEventListener("timeupdate", onTimeUpdate);
    return () => {
      videoEl.removeEventListener("timeupdate", onTimeUpdate);
      const videoId = videoEventId(product);
      if (videoId) flushWatchTime(videoId);
    };
  }, [currentIdx, products, sendFeedEvent]);

  // ── Overlay "vezi produsul" la timestamp (video_product_links) ────────
  type OverlayTag = {
    product_id: string;
    start_ms: number | null;
    end_ms: number | null;
    label: string | null;
    title: string;
    image_url: string | null;
    price_cents: number | null;
    currency: string;
  };
  const [overlayTags, setOverlayTags] = useState<Record<string, OverlayTag[]>>({});
  const [activeOverlay, setActiveOverlay] = useState<OverlayTag | null>(null);
  const overlayFetchedRef = useRef(new Set<string>());

  const [tryOnProduct, setTryOnProduct] = useState<FeedProduct | null>(null);

  useEffect(() => {
    const product = products[currentIdx];
    if (!product) return;
    const videoId = videoEventId(product);
    if (!videoId || overlayFetchedRef.current.has(videoId)) return;
    overlayFetchedRef.current.add(videoId);
    fetch(`/api/videos/${videoId}/products`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { tags?: OverlayTag[] } | null) => {
        if (data?.tags?.length) {
          setOverlayTags((prev) => ({ ...prev, [product.id]: data.tags ?? [] }));
        }
      })
      .catch(() => { });
  }, [currentIdx, products]);

  useEffect(() => {
    const product = products[currentIdx];
    if (!product) {
      setActiveOverlay(null);
      return;
    }
    const tags = overlayTags[product.id];
    const videoEl = videoMapRef.current[product.id];
    if (!tags?.length || !videoEl) {
      setActiveOverlay(null);
      return;
    }
    const onTick = () => {
      const posMs = videoEl.currentTime * 1000;
      const match = tags.find((tag) => {
        const start = tag.start_ms ?? 0;
        const end = tag.end_ms ?? Number.POSITIVE_INFINITY;
        return posMs >= start && posMs <= end;
      });
      setActiveOverlay((prev) => (prev?.product_id === match?.product_id ? prev : match ?? null));
    };
    videoEl.addEventListener("timeupdate", onTick);
    onTick();
    return () => videoEl.removeEventListener("timeupdate", onTick);
  }, [currentIdx, products, overlayTags]);

  // ── Double-tap like ────────────────────────────────────────────────────
  const lastTapRef = useRef<{ at: number; id: string } | null>(null);
  const handleMediaTap = (product: FeedProduct) => {
    const now = Date.now();
    const prev = lastTapRef.current;
    lastTapRef.current = { at: now, id: product.id };
    if (prev && prev.id === product.id && now - prev.at < 350) {
      lastTapRef.current = null;
      if (!likes[product.id]) toggleLike(product);
      else {
        setHeartBurst(product.id);
        setTimeout(() => setHeartBurst(null), 900);
      }
    }
  };

  // skip_fast detection: when the user swipes to the next card in under 1s
  // since the previous card became active, emit `skip_fast` on the previous
  // card. This is the strongest negative signal for the ranker.
  const lastIdxRef = useRef<{ idx: number; at: number } | null>(null);
  useEffect(() => {
    const prev = lastIdxRef.current;
    const now = Date.now();
    if (prev && prev.idx !== currentIdx) {
      const elapsed = now - prev.at;
      const prevProduct = products[prev.idx];
      if (prevProduct && elapsed < 1000) {
        sendFeedEvent("skip_fast", prevProduct, {
          position: prev.idx,
          watchMs: elapsed,
        });
      }
    }
    lastIdxRef.current = { idx: currentIdx, at: now };
  }, [currentIdx, products, sendFeedEvent]);

  useEffect(() => {
    if (!sentinelRef.current || !onLoadMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadMore();
      },
      { root: scrollRef.current, threshold: 0.1 }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [onLoadMore, products.length]);

  useEffect(() => {
    if (!scrollRef.current) return;
    const cards = scrollRef.current.querySelectorAll("[data-feed-idx]");
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const idx = Number(entry.target.getAttribute("data-feed-idx"));
          if (entry.isIntersecting && entry.intersectionRatio > 0.6) setCurrentIdx(idx);
        });
      },
      { root: scrollRef.current, threshold: [0, 0.6] }
    );
    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [products]);

  useEffect(() => {
    const product = products[currentIdx];
    if (!product) return;
    Object.entries(videoMapRef.current).forEach(([id, video]) => {
      video.muted = isMuted;
      if (id === product.id) video.play().catch(() => { });
      else video.pause();
    });
  }, [currentIdx, isMuted, products]);

  const openProduct = useCallback((product: FeedProduct) => {
    sendFeedEvent("product_click", product, { position: currentIdx });
    router.push(`/product/${product.pgId || product.id}`);
  }, [currentIdx, router, sendFeedEvent]);

  const toggleLike = (product: FeedProduct) => {
    // REAL LIKES (2026-08-09, întărit 2026-08-24): serverul e sursa adevărului.
    // Fără un UUID real de video nu există unde persista like-ul — butonul nici
    // nu se randează în acest caz (vezi canLike la render).
    const videoId = videoEventId(product);
    if (!UUID_RE.test(videoId)) return;
    const isNextLiked = !likes[product.id];
    setLikes((prev) => ({ ...prev, [product.id]: isNextLiked }));
    // Evenimentul de ranking 'like'/'unlike' e emis de server în tranzacția
    // like-ului (o singură sursă) — nu-l mai dublăm din client.
    fetch(`/api/videos/${videoId}/like`, { method: "POST" })
      .then(async (res) => {
        if (!res.ok) {
          setLikes((prev) => ({ ...prev, [product.id]: !isNextLiked }));
          // 401 e acum doar un caz-limită (cookies blocate) — like-ul anonim e
          // permis. `next` întoarce userul EXACT unde era, nu în /explore.
          if (res.status === 401) {
            const here = encodeURIComponent(window.location.pathname + window.location.search);
            router.push(`/auth?next=${here}`);
          }
          return;
        }
        const data = await res.json().catch(() => null);
        if (data && typeof data.liked === "boolean") {
          setLikes((prev) => ({ ...prev, [product.id]: data.liked }));
          if (typeof data.like_count === "number") {
            setLikeCounts((prev) => ({ ...prev, [product.id]: data.like_count }));
          }
        }
      })
      .catch(() => setLikes((prev) => ({ ...prev, [product.id]: !isNextLiked })));
    if (isNextLiked) {
      setHeartBurst(product.id);
      setTimeout(() => setHeartBurst(null), 900);
    }
  };

  const handleAddToCart = (product: FeedProduct) => {
    sendFeedEvent("add_to_cart", product, { position: currentIdx, quantity: 1 });
    onAddToCart(product, 1);
    setAddedToCart(product.id);
    setTimeout(() => setAddedToCart(null), 2000);
  };

  // "Cumpara acum": cosul real + pagina reala de checkout (Stripe). Modalul
  // anterior "1-Click" simula o comanda cu setTimeout si un id aleatoriu.
  const handleBuyNow = (product: FeedProduct) => {
    handleAddToCart(product);
    router.push("/checkout");
  };

  if (isLoading && products.length === 0) {
    return (
      <div className="feed-scroll flex items-center justify-center">
        <div className="text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-[#333] border-t-[#10A37F]" />
          <p className="mt-4 text-sm font-bold text-[#888]">{t("loadingClips")}</p>
        </div>
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="feed-scroll flex items-center justify-center">
        <div className="px-8 text-center">
          <Package className="mx-auto mb-4 text-[#333]" size={48} />
          <p className="font-black text-[#888]">{t("niciunClipDisponibil")}</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="feed-scroll">
      <div className="fixed left-0 right-0 top-0 z-50 flex items-center justify-between px-4" style={{ paddingTop: "max(12px, env(safe-area-inset-top))" }}>
        {onClose ? (
          <button type="button" onClick={onClose} className="rounded-full bg-black/50 p-2.5 text-white backdrop-blur-sm" style={tapAction} aria-label={t("closeFeed")}>
            <ArrowLeft size={20} />
          </button>
        ) : <span />}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsMuted((value) => !value)}
            className="rounded-full bg-black/50 p-2.5 text-white backdrop-blur-sm"
            style={tapAction}
            aria-label={isMuted ? t("unmuteFeed") : t("muteFeed")}
          >
            {isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
        </div>
      </div>

      {products.map((product, idx) => {
        const posterImage = product.images?.[0];
        const hasWorkingVideo = Boolean(product.video && !videoErrors[product.id]);
        return (
          <div key={product.id} data-feed-idx={idx} className="feed-card">
            <div className="feed-media" onClick={() => handleMediaTap(product)}>
              {posterImage ? (
                <Image
                  src={posterImage}
                  alt={product.title}
                  fill
                  sizes="100vw"
                  loading={idx < 3 ? "eager" : "lazy"}
                  priority={idx === 0}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 grid place-items-center bg-[#0D0D0D] text-white/50">
                  <Package size={48} />
                </div>
              )}
              {hasWorkingVideo && Math.abs(idx - currentIdx) <= 1 && (
                <FeedVideo
                  src={product.video!}
                  registerRef={(el) => {
                    if (el) videoMapRef.current[product.id] = el;
                    else delete videoMapRef.current[product.id];
                  }}
                  poster={posterImage}
                  loop
                  muted={isMuted}
                  playsInline
                  preload="auto"
                  autoPlay={idx === currentIdx}
                  style={{ transform: "translateZ(0)", willChange: "transform", backfaceVisibility: "hidden" }}
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={() => setVideoErrors((prev) => ({ ...prev, [product.id]: true }))}
                />
              )}
              {hasWorkingVideo && Math.abs(idx - currentIdx) > 1 && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="grid h-14 w-14 place-items-center rounded-full bg-white/20 backdrop-blur-sm">
                    <Play size={28} className="ml-0.5 text-white" fill="white" />
                  </div>
                </div>
              )}
            </div>

            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/30 pointer-events-none" />

            {heartBurst === product.id && (
              <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
                <Heart className="animate-like-burst text-[#EF4444]" size={100} fill="currentColor" />
              </div>
            )}

            {idx === currentIdx && activeOverlay && (
              <button
                type="button"
                onClick={() => {
                  sendFeedEvent("product_click", product, {
                    position: currentIdx,
                    overlay_product_id: activeOverlay.product_id,
                  });
                  router.push(`/product/${activeOverlay.product_id}`);
                }}
                style={tapAction}
                className="absolute left-3 top-20 z-20 flex max-w-[70%] items-center gap-2 rounded-2xl bg-black/60 px-3 py-2 text-left backdrop-blur-md transition-transform active:scale-[0.97]"
                aria-label={t("viewProductNamed", { name: activeOverlay.title })}
              >
                {activeOverlay.image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={activeOverlay.image_url}
                    alt=""
                    className="h-10 w-10 shrink-0 rounded-lg object-cover"
                  />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-xs font-bold text-white">
                    {activeOverlay.label || activeOverlay.title}
                  </span>
                  <span className="block text-[11px] font-black text-[#34D399]">
                    {activeOverlay.price_cents != null
                      ? formatPrice(activeOverlay.price_cents, {
                        sourceCurrency: isCurrency(activeOverlay.currency) ? activeOverlay.currency : "RON",
                      })
                      : t("viewProduct")}
                  </span>
                </span>
              </button>
            )}

            <div className="absolute bottom-48 right-3 z-20 flex flex-col items-center gap-4">
              {UUID_RE.test(videoEventId(product)) && (
                <button type="button" onClick={() => toggleLike(product)} className="flex flex-col items-center gap-0.5" style={tapAction} aria-label={likes[product.id] ? t("unlike") : t("like")}>
                  <div className={`rounded-full p-3 shadow-lg ${likes[product.id] ? "bg-[#EF4444] text-white" : "bg-black/30 backdrop-blur-sm text-white"}`}>
                    <Heart size={24} fill={likes[product.id] ? "currentColor" : "none"} />
                  </div>
                  <span className="text-[10px] font-bold text-white/90">{likeCounts[product.id] ?? (getRealLikes(product) + (likes[product.id] ? 1 : 0))}</span>
                </button>
              )}
              <button type="button" onClick={() => setShowComments(product.id)} className="flex flex-col items-center gap-0.5" style={tapAction} aria-label={t("openComments")}>
                <div className="rounded-full bg-black/30 backdrop-blur-sm p-3 text-white shadow-lg">
                  <MessageCircle size={24} />
                </div>
                <span className="text-[10px] font-bold text-white/90">{commentCounts[product.id] ?? getRealComments(product)}</span>
              </button>
              <button type="button" onClick={() => openProduct(product)} className="flex flex-col items-center gap-0.5" style={tapAction} aria-label={t("openProductDetails")}>
                <div className="rounded-full bg-black/30 backdrop-blur-sm p-3 text-white shadow-lg">
                  <ShoppingCart size={24} />
                </div>
                <span className="text-[10px] font-bold text-white/90">{t("details")}</span>
              </button>

              {TRY_ON_ENABLED && (
              <button
                type="button"
                onClick={() => setTryOnProduct(product)}
                className="flex flex-col items-center gap-0.5"
                style={tapAction}
                aria-label={t("virtualTryOnAr")}
              >
                <div className="rounded-full bg-purple-600/80 backdrop-blur-sm p-3 text-white shadow-lg border border-purple-400/40">
                  <Sparkles size={24} />
                </div>
                <span className="text-[10px] font-black text-purple-200">{t("tryOnLabel")}</span>
              </button>
              )}
            </div>

            <div className="absolute bottom-0 left-0 right-0 z-20 px-4" style={{ paddingBottom: "max(84px, calc(72px + env(safe-area-inset-bottom)))" }}>
              <div className="mb-3">
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-[10px] font-black text-white backdrop-blur-sm">{aiOverlay(product, t)}</span>
                  {product.discountPercent > 0 && <span className="rounded-full bg-[#DC2626] px-2.5 py-0.5 text-[10px] font-black text-white">-{product.discountPercent}%</span>}
                  
                </div>
                <h2 className="line-clamp-2 text-[15px] font-black leading-snug text-white drop-shadow-lg">{product.title}</h2>
                <div className="mt-1 flex items-center gap-3 text-[11px] font-semibold text-white/70">
                  {product.rating > 0 && <span><Star size={11} className="mr-0.5 inline text-[#B45309]" fill="currentColor" />{product.rating.toFixed(1)}</span>}
                  <span>{product.isEstimatedSocial || product.orders === 0 ? t("badgePopular") : t("ordersSoldCount", { count: product.orders.toLocaleString() })}</span>
                  {product.deliveryDays > 0 && <span><Truck size={11} className="mr-0.5 inline" />{product.deliveryDays}z</span>}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <span className="text-2xl font-black text-white">{formatPrice(Math.round(product.price * 100), { sourceCurrency: "RON" })}</span>
                  {product.oldPrice > product.price && <span className="ml-2 text-sm text-white/40 line-through">{formatPrice(Math.round(product.oldPrice * 100), { sourceCurrency: "RON" })}</span>}
                </div>

                <button
                  type="button"
                  onClick={() => handleBuyNow(product)}
                  style={tapAction}
                  className="rounded-2xl px-3.5 py-3 text-xs font-black bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-300 text-black shadow-[0_4px_20px_rgba(245,158,11,0.4)] flex items-center gap-1.5 active:scale-[0.95] shrink-0"
                  aria-label={t("buyNow")}
                >
                  <Zap size={14} className="fill-black" />
                  <span>{t("buyNow")}</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleAddToCart(product)}
                  style={tapAction}
                  className={`rounded-2xl px-4 py-3 text-xs font-black shadow-lg transition-all active:scale-[0.95] shrink-0 ${addedToCart === product.id ? "bg-white text-[#10A37F]" : "bg-[#10A37F] text-white shadow-[0_4px_20px_rgba(16,163,127,0.4)]"
                    }`}
                >
                  {addedToCart === product.id ? t("added") : <><ShoppingCart size={14} className="mr-1 inline" />{t("cart")}</>}
                </button>
              </div>
            </div>
          </div>
        );
      })}

      <div ref={sentinelRef} className="h-10" />

      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-[#333] border-t-[#10A37F]" />
        </div>
      )}

      {showComments && (() => {
        const product = products.find((item) => item.id === showComments);
        const videoId = product ? videoEventId(product) : "";
        if (!product || !videoId) return null;
        return (
          <CommentsSheet
            open={Boolean(showComments)}
            videoId={videoId}
            initialCount={commentCounts[product.id] ?? product.commentCount}
            onClose={() => setShowComments(null)}
            onCountChange={(nextCount) => {
              setCommentCounts((current) => ({ ...current, [product.id]: nextCount }));
            }}
          />
        );
      })()}

      {/* Virtual Try-On AR Modal */}
      {tryOnProduct && (
        <VirtualTryOnModal
          product={{
            id: tryOnProduct.id,
            title: tryOnProduct.title,
            images: tryOnProduct.images,
            category: tryOnProduct.category,
          }}
          onClose={() => setTryOnProduct(null)}
          onApplyShade={(_shade) => {
            setTryOnProduct(null);
          }}
        />
      )}

    </div>
  );
}
