"use client";

import { useState } from "react";
import { Ban, Flag, MoreHorizontal, Settings, Share2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Dialog, DialogClose } from "@/components/ui/Dialog";
import { IconButton } from "@/components/ui/IconButton";
import { ListItem } from "@/components/ui/ListItem";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { useRouter } from "@/lib/i18n/navigation";
import ReportDialog from "../ReportDialog";
import { useAuthRedirect } from "../useAuthRedirect";
import { useShareProfile } from "./useShareProfile";

export type ProfileMenuProps = {
  userId: string;
  username: string;
  displayName: string;
  isOwnProfile: boolean;
  blockedByViewer: boolean;
};

/** Meniul „⋯" din antetul profilului: share, setări (propriu), blocare, raportare. */
export function ProfileMenu({ userId, username, displayName, isOwnProfile, blockedByViewer }: ProfileMenuProps) {
  const t = useTranslations("social.profile");
  const { toast } = useToast();
  const router = useRouter();
  const toAuth = useAuthRedirect();
  const share = useShareProfile(username, displayName);
  const [open, setOpen] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [busy, setBusy] = useState(false);

  async function setBlocked(block: boolean) {
    setBusy(true);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(userId)}/block`, {
        method: block ? "PUT" : "DELETE",
        credentials: "include",
      });
      if (res.status === 401) return toAuth();
      if (!res.ok) throw new Error(String(res.status));
      toast({ title: block ? t("blockedToast", { name: displayName }) : t("unblockedToast"), tone: "success" });
      setConfirmBlock(false);
      router.refresh();
    } catch {
      toast({ title: t("actionError"), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <IconButton label={t("moreActions")} onClick={() => setOpen(true)}>
        <MoreHorizontal aria-hidden />
      </IconButton>
      <Sheet open={open} onOpenChange={setOpen} title={`@${username}`}>
        <div className="flex flex-col">
          <ListItem icon={Share2} title={t("share")} onClick={() => { setOpen(false); void share(); }} />
          {isOwnProfile ? (
            <ListItem icon={Settings} title={t("settings")} href="/account/settings" />
          ) : (
            <>
              <ListItem
                icon={Ban}
                title={blockedByViewer ? t("unblock") : t("block")}
                onClick={() => {
                  setOpen(false);
                  if (blockedByViewer) void setBlocked(false);
                  else setConfirmBlock(true);
                }}
              />
              <ListItem icon={Flag} title={t("report")} onClick={() => { setOpen(false); setReporting(true); }} />
            </>
          )}
        </div>
      </Sheet>

      <Dialog
        open={confirmBlock}
        onOpenChange={setConfirmBlock}
        title={t("blockConfirmTitle", { name: displayName })}
        description={t("blockConfirmBody")}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary">{t("cancel")}</Button>
            </DialogClose>
            <Button variant="danger" loading={busy} onClick={() => void setBlocked(true)}>
              {t("block")}
            </Button>
          </>
        }
      />

      {reporting ? <ReportDialog open onOpenChange={setReporting} target="user" targetId={userId} /> : null}
    </>
  );
}
