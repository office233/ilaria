"use client";

import { useState } from "react";
import Image from "next/image";
import { Clapperboard, Play } from "lucide-react";
import { useTranslations } from "next-intl";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import type { ProductClip } from "@/lib/shop/product-page";

/** Clipurile creatorilor care prezintă produsul; redare într-un dialog. */
export function ProductClips({ clips }: { clips: ProductClip[] }) {
  const t = useTranslations("shopBuyer.product");
  const [playing, setPlaying] = useState<ProductClip | null>(null);

  if (clips.length === 0) return <EmptyState icon={Clapperboard} title={t("noClips")} />;

  return (
    <>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {clips.map((clip) => (
          <li key={clip.id}>
            <button
              type="button"
              onClick={() => setPlaying(clip)}
              aria-label={t("playClip", { title: clip.title || clip.creatorName || "" })}
              className="group relative block aspect-[9/16] w-full overflow-hidden rounded-card bg-surface-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            >
              {clip.thumbnailUrl ? (
                <Image src={clip.thumbnailUrl} alt="" fill sizes="(min-width: 640px) 30vw, 48vw" className="object-cover" />
              ) : (
                <span className="flex h-full items-center justify-center text-subtle">
                  <Clapperboard className="h-8 w-8" aria-hidden />
                </span>
              )}
              <span className="absolute inset-0 flex items-center justify-center bg-black/20 transition-colors group-hover:bg-black/35">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm">
                  <Play className="h-5 w-5" aria-hidden />
                </span>
              </span>
              {clip.creatorName ? (
                <span className="absolute inset-x-2 bottom-2 truncate text-xs font-semibold text-white drop-shadow">
                  {clip.creatorName}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      <Dialog
        open={playing !== null}
        onOpenChange={(open) => !open && setPlaying(null)}
        title={playing?.title || playing?.creatorName || t("clipsTitle")}
      >
        {playing ? (
          <video
            key={playing.id}
            src={playing.playbackUrl}
            poster={playing.thumbnailUrl ?? undefined}
            autoPlay
            controls
            playsInline
            className="max-h-[70dvh] w-full rounded-card bg-black object-contain"
          />
        ) : null}
      </Dialog>
    </>
  );
}
