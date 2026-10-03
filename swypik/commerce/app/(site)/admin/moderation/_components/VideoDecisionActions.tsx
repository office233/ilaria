"use client";

import { useTranslations } from "next-intl";
import { ActionDialog } from "@/components/admin/ActionDialog";

/** Aprobă / respinge un clip din coada „în așteptare” sau „semnalate”. */
export function VideoDecisionActions({ videoId, title }: { videoId: string; title: string }) {
  const t = useTranslations("adminConsole.moderation");
  const url = `/api/admin/moderation/videos/${videoId}`;
  const errors = {
    not_found: t("errNotFound"),
    already_decided: t("errAlreadyDecided"),
    reason_required: t("errReasonRequired"),
    forbidden: t("errForbidden"),
  };
  return (
    <>
      <ActionDialog
        label={t("approve")}
        variant="primary"
        title={t("approveTitle")}
        description={t("approveBody", { title })}
        confirmLabel={t("approve")}
        url={url}
        body={(note) => ({ decision: "approve", reason: note || undefined })}
        note={{ label: t("noteOptional") }}
        errors={errors}
        successMessage={t("approvedToast")}
      />
      <ActionDialog
        label={t("reject")}
        variant="danger"
        title={t("rejectTitle")}
        description={t("rejectBody", { title })}
        confirmLabel={t("reject")}
        url={url}
        body={(note) => ({ decision: "reject", reason: note })}
        note={{ label: t("reasonRequired"), required: true, placeholder: t("reasonPlaceholder") }}
        errors={errors}
        successMessage={t("rejectedToast")}
      />
    </>
  );
}
