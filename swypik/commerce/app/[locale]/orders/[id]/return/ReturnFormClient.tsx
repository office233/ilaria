"use client";

import { useRef, useState } from "react";
import { useRouter } from "@/lib/i18n/navigation";
import { X, Camera, Check } from "lucide-react";
import { useTranslations } from "next-intl";

const MAX_PHOTOS = 4;

type Item = {
  id: string;
  title: string;
  quantity: number;
  unit_amount_cents: number;
  currency: string;
};

type Selected = { qty: number };
type UploadedPhoto = { url: string; key: string };

export default function ReturnFormClient({
  orderId,
  lookupToken,
  items,
}: {
  orderId: string;
  lookupToken: string | null;
  items: Item[];
}) {
  const t = useTranslations("returnForm");
  const router = useRouter();
  const [selection, setSelection] = useState<Record<string, Selected>>({});
  const [reason, setReason] = useState("");
  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const fmt = (cents: number, cur: string) =>
    `${(cents / 100).toFixed(2)} ${cur}`;

  function toggleItem(item: Item) {
    setSelection((prev) => {
      const next = { ...prev };
      if (next[item.id]) delete next[item.id];
      else next[item.id] = { qty: item.quantity };
      return next;
    });
  }

  function setQty(itemId: string, qty: number, max: number) {
    const safe = Math.max(1, Math.min(max, qty || 1));
    setSelection((prev) => ({ ...prev, [itemId]: { qty: safe } }));
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0 || !lookupToken) return;
    setError(null);
    const remaining = MAX_PHOTOS - photos.length;
    const toUpload = Array.from(files).slice(0, remaining);
    if (toUpload.length === 0) {
      setError(t("maxPhotos", { max: MAX_PHOTOS }));
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
          setError(json.error || t("uploadPhotoError"));
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
    setError(null);
    const selectedItems = Object.entries(selection).map(([item_id, s]) => ({
      item_id,
      qty: s.qty,
    }));
    if (selectedItems.length === 0) {
      setError(t("selectAtLeastOne"));
      return;
    }
    if (reason.trim().length < 10) {
      setError(t("reasonTooShort"));
      return;
    }

    setSubmitting(true);
    try {
      const body: any = {
        reason: reason.trim(),
        items: selectedItems,
        evidenceUrls: photos.map((p) => p.url),
        photos: photos.map((p) => p.key),
      };
      if (lookupToken) body.token = lookupToken;
      const res = await fetch(`/api/orders/${orderId}/return`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || t("submitError"));
        setSubmitting(false);
        return;
      }
      router.replace(`/account/orders/${orderId}?return=requested`);
      router.refresh();
    } catch {
      setError(t("networkError"));
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-white/10 bg-white/[0.04] divide-y divide-white/5 overflow-hidden">
        <div className="px-4 py-3 bg-white/[0.02]">
          <h2 className="text-sm font-bold">{t("produsePentruRetur")}</h2>
          <p className="text-xs text-white/50 mt-0.5">
            
            {t("bifeazaProduseleSiAlege")}
          </p>
        </div>
        {items.map((it) => {
          const sel = selection[it.id];
          const checked = !!sel;
          return (
            <label
              key={it.id}
              className="flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-white/[0.02]"
            >
              <span
                className={`mt-1 w-5 h-5 rounded border flex items-center justify-center shrink-0 ${
                  checked
                    ? "bg-white border-white text-black"
                    : "border-white/30 bg-transparent"
                }`}
                aria-hidden="true"
              >
                {checked && <Check size={14} strokeWidth={3} />}
              </span>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleItem(it)}
                className="sr-only"
                aria-label={t("selectItem", { title: it.title })}
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold line-clamp-2">{it.title}</div>
                <div className="text-xs text-white/50 mt-0.5">
                  {t("orderedQty", { qty: it.quantity, price: fmt(it.unit_amount_cents, it.currency) })}
                </div>
                {checked && (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-xs text-white/60">{t("returnQtyLabel")}</span>
                    <div className="inline-flex items-center rounded-lg border border-white/15 overflow-hidden">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          setQty(it.id, (sel?.qty || 1) - 1, it.quantity);
                        }}
                        className="px-2 py-1 text-sm hover:bg-white/10"
                        aria-label={t("decreaseQty")}
                      >
                        −
                      </button>
                      <input
                        type="number"
                        min={1}
                        max={it.quantity}
                        value={sel?.qty || 1}
                        onChange={(e) =>
                          setQty(it.id, parseInt(e.target.value, 10) || 1, it.quantity)
                        }
                        onClick={(e) => e.preventDefault()}
                        className="w-12 bg-transparent text-center text-sm py-1 outline-none"
                        aria-label={t("returnQty")}
                      />
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          setQty(it.id, (sel?.qty || 1) + 1, it.quantity);
                        }}
                        className="px-2 py-1 text-sm hover:bg-white/10"
                        aria-label={t("cresteCantitate")}
                      >
                        +
                      </button>
                    </div>
                    <span className="text-xs text-white/40">/ {it.quantity}</span>
                  </div>
                )}
              </div>
            </label>
          );
        })}
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
        <label htmlFor="return-reason" className="block text-sm font-bold mb-2">
          {t("reasonLabel")}
        </label>
        <textarea
          id="return-reason"
          rows={4}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t("descriePeScurtMotivul")}
          className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-white/30 resize-none"
        />
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
        <h3 className="text-sm font-bold mb-2">{t("fotografiiOptionalMax")} {MAX_PHOTOS})</h3>
        <div className="grid grid-cols-4 gap-2">
          {photos.map((p, i) => (
            <div key={p.key} className="relative aspect-square rounded-lg overflow-hidden border border-white/10">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt={t("evidenceAlt", { n: i + 1 })} className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => removePhoto(i)}
                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white flex items-center justify-center"
                aria-label={t("deletePhoto")}
              >
                <X size={14} />
              </button>
            </div>
          ))}
          {photos.length < MAX_PHOTOS && (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading || !lookupToken}
              className="aspect-square rounded-lg border border-dashed border-white/20 flex flex-col items-center justify-center text-white/50 hover:bg-white/5 disabled:opacity-50"
              aria-label={t("adaugaFotografie")}
            >
              <Camera size={20} />
              <span className="text-[10px] mt-1">{uploading ? "..." : t("add")}</span>
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
        {!lookupToken && (
          <p className="mt-2 text-xs text-white/40">
            
            {t("tokenComandaLipsaFotografiile")}
          </p>
        )}
      </section>

      {error && (
        <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={submitting}
        className="w-full rounded-xl bg-white px-6 py-3.5 text-sm font-bold text-black hover:bg-white/90 disabled:opacity-50"
      >
        {submitting ? t("submitting") : t("submit")}
      </button>
    </div>
  );
}
