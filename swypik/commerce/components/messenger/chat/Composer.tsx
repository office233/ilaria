"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ImagePlus, Send, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { IconButton } from "@/components/ui/IconButton";
import { useToast } from "@/components/ui/Toast";
import { DM_ATTACHMENT_MIME } from "@/lib/dm/config";
import { cn } from "@/lib/ui/cn";

type Props = {
  onSend: (body: string, file: File | null) => void;
  onTyping: () => void;
  maxLength: number;
  maxImageMb: number;
};

/** Compozitor: text 16px (fără zoom iOS), imagine atașată cu previzualizare, Enter trimite. */
export function Composer({ onSend, onTyping, maxLength, maxImageMb }: Props) {
  const t = useTranslations("dm.composer");
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Înălțime automată (max ~5 rânduri).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  const pickFile = (f: File | undefined) => {
    if (!f) return;
    if (!(DM_ATTACHMENT_MIME as readonly string[]).includes(f.type)) {
      toast({ title: t("unsupportedImage"), tone: "danger" });
      return;
    }
    if (f.size > maxImageMb * 1024 * 1024) {
      toast({ title: t("imageTooLarge", { mb: maxImageMb }), tone: "danger" });
      return;
    }
    setFile(f);
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body && !file) return;
    onSend(body, file);
    setText("");
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit();
  };

  return (
    <form onSubmit={submit} className="border-t border-subtle bg-surface px-3 py-2 pb-safe-b">
      {preview ? (
        <div className="relative mb-2 inline-block">
          {/* eslint-disable-next-line @next/next/no-img-element -- previzualizare blob locală */}
          <img src={preview} alt={t("previewAlt")} className="h-20 w-20 rounded-control object-cover" />
          <IconButton
            label={t("removeImage")}
            size="sm"
            variant="overlay"
            className="absolute -right-2 -top-2"
            onClick={() => setFile(null)}
          >
            <X aria-hidden />
          </IconButton>
        </div>
      ) : null}
      <div className="flex items-end gap-1">
        <input
          ref={fileRef}
          type="file"
          accept={DM_ATTACHMENT_MIME.join(",")}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => pickFile(e.target.files?.[0])}
        />
        <IconButton label={t("attachImage")} onClick={() => fileRef.current?.click()}>
          <ImagePlus aria-hidden />
        </IconButton>
        <label htmlFor="dm-composer" className="sr-only">
          {t("placeholder")}
        </label>
        <textarea
          id="dm-composer"
          ref={inputRef}
          rows={1}
          value={text}
          maxLength={maxLength}
          placeholder={t("placeholder")}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value) onTyping();
          }}
          onKeyDown={onKeyDown}
          className={cn(
            "min-h-11 flex-1 resize-none rounded-control border border-subtle bg-canvas px-3.5 py-2.5 text-base text-fg",
            "placeholder:text-subtle focus-visible:outline-none focus-visible:ring-2",
          )}
        />
        <IconButton type="submit" variant="primary" label={t("send")} disabled={!text.trim() && !file}>
          <Send aria-hidden />
        </IconButton>
      </div>
    </form>
  );
}
