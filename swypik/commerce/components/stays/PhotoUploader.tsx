"use client";

/** Încărcare poze pentru o listare (POST /api/host/upload), cu ordonare simplă: prima e coperta. */
import { useRef, useState } from "react";
import { ImagePlus, Star, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/ui/cn";

type Props = { value: string[]; onChange: (urls: string[]) => void; max: number };

export function PhotoUploader({ value, onChange, max }: Props) {
    const t = useTranslations("staysHost");
    const input = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState(false);

    const upload = async (files: FileList | null) => {
        if (!files?.length) return;
        setUploading(true);
        setError(false);
        const added: string[] = [];
        for (const file of Array.from(files).slice(0, max - value.length)) {
            const form = new FormData();
            form.append("file", file);
            const res = await fetch("/api/host/upload", { method: "POST", body: form }).catch(() => null);
            const j = res?.ok ? ((await res.json()) as { url?: string }) : null;
            if (j?.url) added.push(j.url);
            else setError(true);
        }
        onChange([...value, ...added]);
        setUploading(false);
        if (input.current) input.current.value = "";
    };

    return (
        <div>
            <div className="grid grid-cols-3 gap-2">
                {value.map((url, i) => (
                    <div key={url} className="relative aspect-square overflow-hidden rounded-control bg-surface-2">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url} alt="" className="h-full w-full object-cover" />
                        <div className="absolute inset-x-0 top-0 flex justify-between p-1">
                            <IconButton
                                size="sm"
                                variant="overlay"
                                label={i === 0 ? t("coverPhoto") : t("makeCover")}
                                onClick={() => onChange([url, ...value.filter((u) => u !== url)])}
                            >
                                <Star className={cn(i === 0 && "fill-current")} aria-hidden />
                            </IconButton>
                            <IconButton size="sm" variant="overlay" label={t("removePhoto")} onClick={() => onChange(value.filter((u) => u !== url))}>
                                <X aria-hidden />
                            </IconButton>
                        </div>
                    </div>
                ))}
                {value.length < max ? (
                    <button
                        type="button"
                        onClick={() => input.current?.click()}
                        disabled={uploading}
                        className="flex aspect-square flex-col items-center justify-center gap-1 rounded-control border border-dashed border-strong text-sm text-muted disabled:opacity-60"
                    >
                        <ImagePlus className="h-6 w-6" aria-hidden />
                        {uploading ? t("uploading") : t("addPhotos")}
                    </button>
                ) : null}
            </div>
            <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple hidden onChange={(e) => void upload(e.target.files)} />
            <p className={cn("mt-1 text-xs", error ? "text-danger" : "text-muted")}>{error ? t("uploadFailed") : t("photosHint", { max })}</p>
        </div>
    );
}
