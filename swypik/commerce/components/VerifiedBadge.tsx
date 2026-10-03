"use client";

import { BadgeCheck } from "lucide-react";
import { useTranslations } from "next-intl";

export default function VerifiedBadge({ size = 14, className = "" }: { size?: number; className?: string }) {
  const t = useTranslations("verifiedBadge");
  return (
    <span
      className={`inline-flex items-center justify-center text-[#1D9BF0] ${className}`}
      title={t("verifiedAccount")}
      role="img"
      aria-label={t("verifiedAccount")}
    >
      <BadgeCheck size={size} fill="currentColor" stroke="#fff" strokeWidth={2.5} />
    </span>
  );
}
