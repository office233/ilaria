"use client";

import { useRef, useState } from "react";
import { Camera } from "lucide-react";
import { useTranslations } from "next-intl";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

const ACCEPT = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;
const KNOWN = new Set([
  "avatar_type", "avatar_too_large", "avatar_empty", "avatar_invalid_image", "avatar_rejected", "rate_limited",
  "avatar_upload_failed",
]);

/** Avatar + încărcare (POST /api/users/me/avatar: serverul redimensionează la 512px WebP). */
export function AvatarPicker({ name, initialUrl, onChange }: { name: string; initialUrl: string | null; onChange?: (url: string) => void }) {
  const t = useTranslations("social.edit");
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(initialUrl);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function fail(code: string) {
    toast({ title: t(`errors.${KNOWN.has(code) ? code : "avatar_upload_failed"}`), tone: "danger" });
  }

  async function upload(file: File) {
    if (!ACCEPT.includes(file.type)) return fail("avatar_type");
    if (file.size > MAX_BYTES) return fail("avatar_too_large");
    const local = URL.createObjectURL(file);
    setPreview(local);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("avatar", file);
      const res = await fetch("/api/users/me/avatar", { method: "POST", body: fd, credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return fail(String(data?.error ?? ""));
      setUrl(data.avatar_url);
      onChange?.(data.avatar_url);
      toast({ title: t("avatarUpdated"), tone: "success" });
    } catch {
      fail("avatar_upload_failed");
    } finally {
      setPreview(null);
      setBusy(false);
      URL.revokeObjectURL(local);
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy}
        aria-label={t("changePhoto")}
        className="relative rounded-full focus-visible:outline-none focus-visible:ring-2 disabled:opacity-60"
      >
        <Avatar src={preview ?? url} name={name} size="xl" className="h-24 w-24 text-3xl" />
        <span className="absolute bottom-0 right-0 grid h-8 w-8 place-items-center rounded-full bg-brand text-brand-fg shadow-elev-1">
          <Camera aria-hidden className="h-4 w-4" />
        </span>
      </button>
      <Button variant="link" size="sm" onClick={() => input.current?.click()} loading={busy}>
        {t("changePhoto")}
      </Button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT.join(",")}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void upload(file);
        }}
      />
    </div>
  );
}
