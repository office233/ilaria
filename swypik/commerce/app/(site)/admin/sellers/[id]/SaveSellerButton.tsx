"use client";

import { useFormStatus } from "react-dom";
import { useTranslations } from "next-intl";
import { Save } from "lucide-react";

export default function SaveSellerButton() {
  const t = useTranslations("adminSellers");
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="bg-slate-900 text-white px-6 py-2.5 rounded-xl font-bold flex items-center gap-2 hover:bg-slate-800 transition-colors disabled:opacity-50"
    >
      <Save className="w-4 h-4" /> {pending ? t("saving") : t("saveChanges")}
    </button>
  );
}
