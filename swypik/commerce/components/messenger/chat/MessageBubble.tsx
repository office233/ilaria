"use client";

import { AlertCircle, Check, CheckCheck, RotateCw } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { cn } from "@/lib/ui/cn";
import type { ChatMessage } from "../types";

type Props = {
  message: ChatMessage;
  mine: boolean;
  seen: boolean;
  onRetry: (id: string) => void;
};

/** O bulă de chat: text și/sau imagine, oră, stare (trimis/văzut/eșuat). */
export function MessageBubble({ message, mine, seen, onRetry }: Props) {
  const t = useTranslations("dm.chat");
  const format = useFormatter();
  const time = format.dateTime(new Date(message.created_at), { hour: "2-digit", minute: "2-digit" });

  return (
    <div className={cn("flex flex-col", mine ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[80%] overflow-hidden rounded-card text-sm shadow-elev-1",
          mine ? "rounded-br-control bg-brand text-brand-fg" : "rounded-bl-control bg-surface text-fg",
          message.pending && "opacity-70",
        )}
      >
        {message.media_url ? (
          <a href={message.pending ? undefined : message.media_url} target="_blank" rel="noopener noreferrer" className="block">
            {/* eslint-disable-next-line @next/next/no-img-element -- URL din storage-ul propriu / blob local */}
            <img
              src={message.media_url}
              alt={t("imageAlt")}
              loading="lazy"
              className="max-h-80 w-full min-w-[160px] object-cover"
            />
          </a>
        ) : null}
        {message.body ? <p className="whitespace-pre-wrap break-words px-3.5 py-2 leading-relaxed">{message.body}</p> : null}
      </div>
      <div className="mt-1 flex items-center gap-1 px-1 text-xs text-subtle">
        {message.failed ? (
          <button
            type="button"
            onClick={() => onRetry(message.id)}
            className="inline-flex min-h-11 items-center gap-1 font-semibold text-danger focus-visible:outline-none focus-visible:ring-2"
          >
            <AlertCircle className="h-3.5 w-3.5" aria-hidden />
            {t("failed")}
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
            <span className="underline">{t("retry")}</span>
          </button>
        ) : (
          <>
            <time dateTime={message.created_at}>{time}</time>
            {mine ? (
              message.pending ? (
                <Check className="h-3.5 w-3.5" aria-label={t("sending")} />
              ) : seen ? (
                <span className="inline-flex items-center gap-0.5 text-info">
                  <CheckCheck className="h-3.5 w-3.5" aria-hidden />
                  {t("seen")}
                </span>
              ) : (
                <CheckCheck className="h-3.5 w-3.5" aria-label={t("sent")} />
              )
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
