"use client";

import { useState } from "react";
import { BedDouble } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/Badge";

/** Galerie orizontală cu scroll-snap (swipe pe telefon) + contor. */
export function StayGallery({ images, title }: { images: string[]; title: string }) {
    const t = useTranslations("staysUi");
    const [index, setIndex] = useState(0);
    if (!images.length) {
        return (
            <div className="flex aspect-[4/3] w-full items-center justify-center bg-surface-2">
                <BedDouble className="h-12 w-12 text-subtle" aria-hidden />
            </div>
        );
    }
    return (
        <div className="relative">
            <div
                className="flex aspect-[4/3] w-full snap-x snap-mandatory overflow-x-auto overscroll-x-contain bg-surface-2 [scrollbar-width:none]"
                onScroll={(e) => {
                    const el = e.currentTarget;
                    setIndex(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
                }}
                aria-label={t("galleryLabel", { title })}
                role="region"
            >
                {images.map((src, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        key={src}
                        src={src}
                        alt={t("photoAlt", { title, n: i + 1 })}
                        loading={i === 0 ? "eager" : "lazy"}
                        className="h-full w-full shrink-0 snap-center object-cover"
                    />
                ))}
            </div>
            {images.length > 1 ? (
                <Badge tone="overlay" className="absolute bottom-3 right-3">
                    {index + 1} / {images.length}
                </Badge>
            ) : null}
        </div>
    );
}
