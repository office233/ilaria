"use client";

import { useRef, useState } from "react";
import { X, Camera } from "lucide-react";
import { useTranslations } from "next-intl";

const MAX_PHOTOS = 4;

const ERROR_CODES = new Set([
  "rate_limited", "validation_error", "invalid_evidence", "order_not_found", "not_returnable",
  "return_already_requested", "internal_error", "storage_unavailable", "invalid_request",
  "token_missing", "file_missing", "photo_limit", "upload_failed", "feature_frozen",
]);

type UploadedPhoto = { url: string; key: string };

export default function OrderReturnButton({
  orderId,
  lookupToken,
}: {
  orderId: string;
  lookupToken: string;
}) {
  const t = useTranslations("ordersOrderReturnButton");
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const errorText = (code: unknown, fallback: string) =>
    typeof code === "string" && ERROR_CODES.has(code) ? t(`errors.${code}`, { max: MAX_PHOTOS }) : fallback;

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    const remaining = MAX_PHOTOS - photos.length;
    const toUpload = Array.from(files).slice(0, remaining);
    if (toUpload.length === 0) {
      setError(t("errors.photo_limit", { max: MAX_PHOTOS }));
      return;
    }
    setUploading(true);
    try {
      for (const f of toUpload) {
        const fd = new FormData();
        fd.append("token", lookupToken);
        fd.append("file", f);
        const res = await fetch(`/api/orders/${orderId}/return/photos`, {
          method: "POST",
          body: fd,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(errorText(json.error, t("errors.upload_failed", { max: MAX_PHOTOS })));
          break;
        }
        setPhotos((prev) => [...prev, { url: json.url, key: json.key }]);
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function removePhoto(idx: number) {
    setPhotos((prev) => prev.filter((_, i) => i !== idx));
  }

  async function submit() {
    if (reason.trim().length < 5) {
      setError(t("reasonTooShort"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/orders/${orderId}/return`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason,
          token: lookupToken,
          evidenceUrls: photos.map((p) => p.url),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(errorText(json.error, t("errors.internal_error", { max: MAX_PHOTOS })));
      } else {
        setDone(true);
      }
    } catch {
      setError(t("errors.network"));
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-success/30 bg-success-soft p-4 text-sm text-success">
        
        {t("cerereaDeReturA")}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full rounded-xl border border-subtle bg-surface hover:bg-surface-2 py-3 text-sm font-semibold"
      >
        
        {t("solicitaRetur")}
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-subtle bg-surface p-4">
      <label className="text-sm font-semibold">{t("reasonLabel")}</label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={4}
        placeholder={t("descrieProblemaDefectMarime")}
        className="mt-2 w-full rounded-lg bg-surface-2 border border-subtle p-3 text-sm"
      />

      <div className="mt-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">
            
            {t("photosOptional", { max: MAX_PHOTOS })}
          </span>
          <span className="text-xs text-subtle">{photos.length}/{MAX_PHOTOS}</span>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-2">
          {photos.map((p, i) => (
            <div key={p.key} className="relative aspect-square overflow-hidden rounded-lg border border-subtle bg-surface-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt={t("photoAlt", { n: i + 1 })} className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => removePhoto(i)}
                className="absolute right-1 top-1 rounded-full bg-black/70 p-1 text-white hover:bg-black"
                aria-label={t("stergeFotografia")}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {photos.length < MAX_PHOTOS && (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="flex aspect-square items-center justify-center rounded-lg border border-dashed border-strong bg-surface text-muted hover:bg-surface-2 disabled:opacity-50"
              aria-label={t("adaugaFotografie")}
            >
              <Camera size={20} />
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
          multiple
          onChange={(e) => handleFiles(e.target.files)}
          className="hidden"
        />
        {uploading && <p className="mt-2 text-xs text-muted">{t("seIncarca")}</p>}
      </div>

      {error && <p className="mt-3 text-xs text-danger">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => setOpen(false)}
          className="flex-1 rounded-lg border border-subtle py-2 text-sm"
        >
          
          {t("renunta")}
        </button>
        <button
          onClick={submit}
          disabled={submitting || uploading}
          className="flex-1 rounded-control bg-brand text-brand-fg min-h-[2.75rem] py-2 text-sm font-bold disabled:opacity-50"
        >
          {submitting ? t("submitting") : t("submit")}
        </button>
      </div>
    </div>
  );
}
