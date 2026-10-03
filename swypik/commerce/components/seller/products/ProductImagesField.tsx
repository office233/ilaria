"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ImagePlus, Star, X } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/ui/cn";

type Props = { images: string[]; max: number; onChange: (images: string[]) => void };

/** Imaginile produsului: upload în R2 (/api/seller/products/upload-image), prima = copertă. */
export function ProductImagesField({ images, max, onChange }: Props) {
  const t = useTranslations("sellerPanel.products.editor");
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    const list = Array.from(files).slice(0, Math.max(0, max - images.length));
    setUploading((n) => n + list.length);
    const added: string[] = [];
    for (const f of list) {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("filename", f.name);
      try {
        const res = await fetch("/api/seller/products/upload-image", { method: "POST", body: fd });
        const data = (await res.json().catch(() => ({}))) as { success?: boolean; url?: string; code?: string };
        if (!res.ok || !data.success || !data.url) throw new Error(data.code === "image_rejected" ? "rejected" : "upload");
        added.push(data.url);
      } catch (err) {
        const rejected = err instanceof Error && err.message === "rejected";
        setError(t(rejected ? "imageRejected" : "uploadError", { name: f.name }));
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (added.length) onChange([...images, ...added]);
    if (input.current) input.current.value = "";
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-fg">{t("images", { count: images.length, max })}</p>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {images.map((url, i) => (
          <div key={url} className={cn("relative aspect-square overflow-hidden rounded-control border", i === 0 ? "border-brand" : "border-subtle")}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" className="h-full w-full object-cover" />
            <div className="absolute right-1 top-1 flex gap-1">
              {i > 0 ? (
                <IconButton size="sm" variant="overlay" label={t("makeCover")} onClick={() => onChange([url, ...images.filter((x) => x !== url)])}>
                  <Star aria-hidden />
                </IconButton>
              ) : null}
              <IconButton size="sm" variant="overlay" label={t("removeImage")} onClick={() => onChange(images.filter((x) => x !== url))}>
                <X aria-hidden />
              </IconButton>
            </div>
          </div>
        ))}
        {images.length < max ? (
          <button
            type="button"
            onClick={() => input.current?.click()}
            disabled={uploading > 0}
            className="flex aspect-square flex-col items-center justify-center gap-1 rounded-control border border-dashed border-strong text-xs text-muted hover:bg-surface-2 disabled:opacity-60"
          >
            <ImagePlus className="h-6 w-6" aria-hidden />
            {uploading > 0 ? t("uploading") : t("addImage")}
          </button>
        ) : null}
      </div>
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => void upload(e.target.files)} />
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
