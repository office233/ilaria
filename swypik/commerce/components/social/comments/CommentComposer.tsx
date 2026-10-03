"use client";

import { forwardRef, useState, type FormEvent } from "react";
import { Send, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { IconButton } from "@/components/ui/IconButton";
import { Textarea } from "@/components/ui/Input";
import type { CommentItemData } from "./types";

const MAX_LENGTH = 500;

export type CommentComposerProps = {
  replyTo: CommentItemData | null;
  onCancelReply: () => void;
  /** Întoarce true dacă textul a fost acceptat (câmpul se golește). */
  onSubmit: (text: string) => Promise<boolean>;
  error: string | null;
};

export const CommentComposer = forwardRef<HTMLTextAreaElement, CommentComposerProps>(function CommentComposer(
  { replyTo, onCancelReply, onSubmit, error },
  ref,
) {
  const t = useTranslations("commentsSheet");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmed = text.trim();

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    const accepted = await onSubmit(trimmed);
    setBusy(false);
    if (accepted) setText("");
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      {replyTo ? (
        <div className="flex items-center justify-between gap-2 rounded-control bg-surface-2 px-3 py-1 text-xs text-muted">
          <span className="truncate">{t("replyingTo", { name: replyTo.author.displayName })}</span>
          <IconButton label={t("cancel")} size="sm" onClick={onCancelReply}>
            <X aria-hidden />
          </IconButton>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex items-end gap-2">
        <Textarea
          ref={ref}
          rows={1}
          value={text}
          maxLength={MAX_LENGTH}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={replyTo ? t("replyPlaceholder") : t("commentPlaceholder")}
          aria-label={replyTo ? t("replyPlaceholder") : t("commentPlaceholder")}
          className="max-h-32 min-h-11 flex-1 resize-none"
        />
        <IconButton label={t("send")} variant="primary" type="submit" disabled={!trimmed || busy}>
          <Send aria-hidden />
        </IconButton>
      </div>
      {text.length > MAX_LENGTH - 50 ? (
        <p className="text-right text-xs text-subtle">
          {text.length}/{MAX_LENGTH}
        </p>
      ) : null}
    </form>
  );
});
