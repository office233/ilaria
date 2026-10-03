"use client";

import { useState } from "react";
import { BadgeCheck, PenLine } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { ReviewFormSheet } from "./ReviewFormSheet";

/** Butonul „Scrie o recenzie” de pe o linie din comandă (comandă plătită ⇒ cumpărător verificat). */
export function OrderReviewButton({ productId, productTitle, reviewed }: { productId: string; productTitle: string; reviewed: boolean }) {
  const t = useTranslations("shopBuyer.orders");
  const [done, setDone] = useState(reviewed);
  if (done) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-success">
        <BadgeCheck className="h-4 w-4" aria-hidden />
        {t("reviewed")}
      </p>
    );
  }
  return (
    <ReviewFormSheet
      productId={productId}
      productTitle={productTitle}
      onSubmitted={() => setDone(true)}
      trigger={
        <Button variant="secondary" size="sm" className="min-h-[2.75rem]">
          <PenLine aria-hidden className="h-4 w-4" />
          {t("review")}
        </Button>
      }
    />
  );
}
