"use client";

/**
 * Încărcarea unui document de șofer/curier (POST /api/couriers/documents):
 * poză + dată de expirare opțională. Documentul intră în verificare la admin.
 */
import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";

const ERROR_KEYS = new Set(["invalid_file", "document_expired", "storage_unavailable", "rate_limited"]);

export default function DocumentUploadRow({ docType, onUploaded }: { docType: string; onUploaded: () => void }) {
  const t = useTranslations("goDriver");
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    setBusy(true);
    const form = new FormData();
    form.set("doc_type", docType);
    form.set("file", file);
    if (expires) form.set("expires_at", expires);
    try {
      const res = await fetch("/api/couriers/documents", { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        toast({ title: t("upload.done"), tone: "success" });
        onUploaded();
      } else {
        const key = body.error && ERROR_KEYS.has(body.error) ? body.error : "failed";
        toast({ title: t(`upload.errors.${key}`), tone: "danger" });
      }
    } catch {
      toast({ title: t("upload.errors.failed"), tone: "danger" });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-2 pb-2">
      <label className="flex min-w-[9rem] flex-1 flex-col gap-1 text-xs text-muted">
        {t("upload.expires")}
        <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
      </label>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/avif"
        capture="environment"
        className="sr-only"
        aria-label={t("upload.button")}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />
      <Button size="sm" variant="secondary" loading={busy} onClick={() => fileRef.current?.click()}>
        <Upload aria-hidden className="h-4 w-4" />
        {t("upload.button")}
      </Button>
    </div>
  );
}
