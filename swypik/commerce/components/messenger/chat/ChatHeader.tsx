"use client";

import { MoreVertical, Phone, Video } from "lucide-react";
import { useTranslations } from "next-intl";
import { Avatar } from "@/components/ui/Avatar";
import { IconButton } from "@/components/ui/IconButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { INBOX_PATH } from "@/lib/dm/links";
import { Link } from "@/lib/i18n/navigation";
import { peerName, type ConversationDetail } from "../types";

type Props = {
  detail: ConversationDetail | null;
  typing: boolean;
  callsEnabled: boolean;
  onCall: (type: "audio" | "video") => void;
  onMore: () => void;
};

export function ChatHeader({ detail, typing, callsEnabled, onCall, onMore }: Props) {
  const t = useTranslations("dm.chat");
  const name = peerName(detail?.peer, t("unknownUser"));
  const username = detail?.peer?.username;
  const canCall = callsEnabled && detail && !detail.blocked_by_me && !detail.blocked_me;

  const title = (
    <span className="flex min-w-0 items-center gap-2.5">
      <Avatar src={detail?.peer?.avatar_url} name={name} size="sm" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-fg">{name}</span>
        <span className="block truncate text-xs font-normal text-muted">
          {typing ? t("typing") : username ? `@${username}` : ""}
        </span>
      </span>
    </span>
  );

  return (
    <PageHeader
      back={INBOX_PATH}
      title={
        username ? (
          <Link href={`/u/${username}`} className="block min-w-0 rounded-control focus-visible:outline-none focus-visible:ring-2">
            {title}
          </Link>
        ) : (
          title
        )
      }
      actions={
        <>
          {canCall ? (
            <>
              <IconButton label={t("videoCall")} onClick={() => onCall("video")}>
                <Video aria-hidden />
              </IconButton>
              <IconButton label={t("audioCall")} onClick={() => onCall("audio")}>
                <Phone aria-hidden />
              </IconButton>
            </>
          ) : null}
          <IconButton label={t("more")} onClick={onMore} disabled={!detail?.peer}>
            <MoreVertical aria-hidden />
          </IconButton>
        </>
      }
    />
  );
}
