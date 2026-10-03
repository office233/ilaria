"use client";

import { useTranslations } from "next-intl";
import { ActionDialog } from "@/components/admin/ActionDialog";
import { Card } from "@/components/ui/Card";

type Props = {
  reportId: string;
  videoId: string | null;
  creatorId: string | null;
};

/** Deciziile pe un raport: respinge raportul, ascunde/șterge clipul, suspendă creatorul. */
export default function ModerationActions({ reportId, videoId, creatorId }: Props) {
  const t = useTranslations("adminModeration");
  const url = (action: string) => `/api/admin/moderation/${reportId}/${action}`;
  const errors = {
    forbidden: t("errorForbidden"),
    unauthorized: t("errorForbidden"),
    invalid_id: t("errorInvalidId"),
    creator_not_found: t("errorCreatorNotFound"),
    report_invalid_no_video: t("errorReportInvalidNoVideo"),
    report_not_found: t("errorReportNotFound"),
    report_already_decided: t("errorReportAlreadyDecided"),
  };
  const common = {
    errors,
    note: { label: t("internalReason"), placeholder: t("journalPlaceholder") },
    redirectTo: "/admin/moderation",
  };

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold text-fg">{t("actionsTitle")}</h2>
      <div className="flex flex-wrap gap-2">
        <ActionDialog
          {...common}
          label={t("dismissReport")}
          title={t("dismissReport")}
          description={t("confirmDismiss")}
          confirmLabel={t("dismissReport")}
          url={url("dismiss")}
          successMessage={t("dismissReport")}
        />
        <ActionDialog
          {...common}
          label={t("hideVideo")}
          variant="soft"
          disabled={!videoId}
          title={t("hideVideo")}
          description={t("confirmHideVideo")}
          confirmLabel={t("hideVideo")}
          url={url("hide-video")}
          successMessage={t("hideVideo")}
        />
        <ActionDialog
          {...common}
          label={t("banCreator")}
          variant="danger"
          disabled={!creatorId}
          title={t("banCreator")}
          description={t("confirmBanCreator")}
          confirmLabel={t("banCreator")}
          url={url("ban-creator")}
          successMessage={t("banCreator")}
        />
        <ActionDialog
          {...common}
          label={t("deletePermanently")}
          variant="danger"
          disabled={!videoId}
          title={t("deletePermanently")}
          description={`${t("confirmDeleteVideo")} ${t("confirmIrreversible")}`}
          confirmLabel={t("deletePermanently")}
          url={url("delete-video")}
          successMessage={t("deletePermanently")}
        />
      </div>
    </Card>
  );
}
