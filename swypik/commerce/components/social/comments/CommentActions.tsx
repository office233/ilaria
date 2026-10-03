"use client";

import { useState } from "react";
import { Flag, Pin, PinOff, Reply, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogClose } from "@/components/ui/Dialog";
import { ListItem } from "@/components/ui/ListItem";
import { Sheet } from "@/components/ui/Sheet";
import ReportDialog from "../ReportDialog";
import type { CommentItemData, CommentsViewer } from "./types";

export type CommentActionsProps = {
  comment: CommentItemData | null;
  viewer: CommentsViewer;
  onClose: () => void;
  onReply: (comment: CommentItemData) => void;
  onDelete: (comment: CommentItemData) => Promise<boolean>;
  onTogglePin: (comment: CommentItemData) => Promise<boolean>;
};

/** Foaia de acțiuni pe un comentariu: răspunde, fixează, șterge (cu confirmare), raportează. */
export function CommentActions({ comment, viewer, onClose, onReply, onDelete, onTogglePin }: CommentActionsProps) {
  const t = useTranslations("social.comments");
  const [confirming, setConfirming] = useState<CommentItemData | null>(null);
  const [reporting, setReporting] = useState<CommentItemData | null>(null);
  const [busy, setBusy] = useState(false);
  const isOwn = Boolean(comment && viewer.id && comment.userId === viewer.id);

  return (
    <>
      <Sheet open={Boolean(comment)} onOpenChange={(o) => !o && onClose()} title={t("actionsTitle")}>
        {comment ? (
          <div className="flex flex-col">
            <ListItem icon={Reply} title={t("reply")} onClick={() => { onReply(comment); onClose(); }} />
            {comment.canPin ? (
              <ListItem
                icon={comment.isPinned ? PinOff : Pin}
                title={comment.isPinned ? t("unpin") : t("pin")}
                onClick={async () => {
                  onClose();
                  await onTogglePin(comment);
                }}
              />
            ) : null}
            {comment.canDelete ? (
              <ListItem icon={Trash2} title={t("delete")} onClick={() => { setConfirming(comment); onClose(); }} />
            ) : null}
            {!isOwn ? (
              <ListItem icon={Flag} title={t("report")} onClick={() => { setReporting(comment); onClose(); }} />
            ) : null}
          </div>
        ) : null}
      </Sheet>

      <Dialog
        open={Boolean(confirming)}
        onOpenChange={(o) => !o && setConfirming(null)}
        title={t("deleteConfirmTitle")}
        description={confirming && !confirming.parentCommentId && confirming.replyCount > 0 ? t("deleteConfirmWithReplies") : t("deleteConfirmBody")}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary">{t("cancel")}</Button>
            </DialogClose>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                if (!confirming) return;
                setBusy(true);
                const ok = await onDelete(confirming);
                setBusy(false);
                if (ok) setConfirming(null);
              }}
            >
              {t("delete")}
            </Button>
          </>
        }
      />

      {reporting ? (
        <ReportDialog
          open
          onOpenChange={(o) => !o && setReporting(null)}
          target="comment"
          targetId={reporting.id}
        />
      ) : null}
    </>
  );
}
