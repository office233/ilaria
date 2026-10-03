"use client";

import { useRef } from "react";
import { useFormStatus } from "react-dom";
import { useTranslations } from "next-intl";
import { useConfirm } from "@/components/ui/ConfirmDialog";

export default function ApproveSellerButton() {
  const t = useTranslations("adminSellers");
  const { pending } = useFormStatus();
  const [confirm, confirmDialog] = useConfirm();
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={buttonRef}
        type="submit"
        disabled={pending}
        onClick={async (e) => {
          // Formularul (server action) pleacă doar după confirmarea din dialog.
          e.preventDefault();
          const button = buttonRef.current;
          if (!(await confirm({ title: t("confirmApprove"), confirmLabel: t("approve") }))) return;
          button?.form?.requestSubmit(button);
        }}
        className="bg-[#0D0D0D] text-white px-4 py-2 rounded-lg font-bold text-xs hover:bg-[#0D0D0D]/80 transition disabled:opacity-50"
      >
        {pending ? t("loading") : t("approve")}
      </button>
      {confirmDialog}
    </>
  );
}
