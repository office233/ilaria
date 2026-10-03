"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Package } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/ui/cn";

export type GallerySlide = { kind: "image"; src: string } | { kind: "video"; src: string; poster?: string | null };

type Props = {
  slides: GallerySlide[];
  title: string;
  discountPercent?: number;
  /** Când se schimbă (ex. varianta cu imagine proprie), galeria sare la slide-ul ăsta. */
  focusIndex?: number;
};

/**
 * Galerie cu swipe nativ (scroll-snap, fără librării): funcționează cu degetul,
 * cu trackpad-ul și cu tastatura; punctele sunt butoane de 44px.
 */
export function ProductGallery({ slides, title, discountPercent = 0, focusIndex = 0 }: Props) {
  const t = useTranslations("shopBuyer.product");
  const tc = useTranslations("shopBuyer.common");
  const track = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(0);

  const goTo = (index: number) => {
    const el = track.current;
    if (!el) return;
    el.scrollTo({ left: index * el.clientWidth, behavior: "smooth" });
  };

  useEffect(() => {
    if (focusIndex >= 0 && focusIndex < slides.length) goTo(focusIndex);
  }, [focusIndex, slides.length]);

  const onScroll = () => {
    const el = track.current;
    if (!el || el.clientWidth === 0) return;
    setActive(Math.round(el.scrollLeft / el.clientWidth));
  };

  if (slides.length === 0) {
    return (
      <div className="flex aspect-square w-full items-center justify-center bg-surface-2 text-subtle">
        <Package className="h-16 w-16" aria-hidden />
      </div>
    );
  }

  return (
    <section aria-roledescription="carousel" aria-label={t("gallery")} className="relative">
      <div
        ref={track}
        onScroll={onScroll}
        tabIndex={0}
        className="no-scrollbar flex aspect-square w-full snap-x snap-mandatory overflow-x-auto bg-surface-2 focus-visible:outline-none sm:aspect-[4/3]"
      >
        {slides.map((slide, i) => (
          <div
            key={`${slide.kind}:${slide.src}`}
            className="relative h-full w-full shrink-0 snap-center"
            role="group"
            aria-roledescription="slide"
            aria-label={t("imageOf", { index: i + 1, total: slides.length })}
          >
            {slide.kind === "video" ? (
              <video
                src={slide.src}
                poster={slide.poster ?? undefined}
                className="h-full w-full object-cover"
                autoPlay={i === 0}
                muted
                loop
                playsInline
                controls={i !== 0}
              />
            ) : (
              <Image
                src={slide.src}
                alt={i === 0 ? title : ""}
                fill
                priority={i === 0}
                sizes="(min-width: 1024px) 50vw, 100vw"
                className="object-cover"
              />
            )}
          </div>
        ))}
      </div>
      {discountPercent > 0 ? (
        <Badge tone="danger" className="absolute left-3 top-3">
          {tc("discountBadge", { percent: discountPercent })}
        </Badge>
      ) : null}
      {slides.length > 1 ? (
        <div className="absolute inset-x-0 bottom-1 flex justify-center">
          {slides.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => goTo(i)}
              aria-label={t("imageOf", { index: i + 1, total: slides.length })}
              aria-current={i === active}
              className="flex h-11 w-7 items-center justify-center"
            >
              <span
                className={cn(
                  "block h-2 rounded-full bg-white/90 shadow-elev-1 transition-all duration-fast",
                  i === active ? "w-5" : "w-2 opacity-60",
                )}
              />
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
