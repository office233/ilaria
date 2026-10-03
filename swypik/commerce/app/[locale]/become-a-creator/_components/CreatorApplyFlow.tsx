"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import type { ApplicationState, ApplicationView } from "@/lib/creator/application";
import { ApplicationStatusCard } from "./ApplicationStatusCard";
import { CreatorApplicationForm } from "./CreatorApplicationForm";

export type ApplyFlowState =
  | { state: "none" }
  | { state: "pending" | "rejected"; application: ApplicationView };

type Props = {
  initial: ApplyFlowState;
  categories: readonly string[];
  defaultHandle: string;
};

/**
 * none → formular; pending → card „în analiză”; rejected → card cu nota + formular de re-aplicare.
 * După trimitere API-ul întoarce starea `pending` → afișăm cardul (fără redirect, rolul NU se schimbă încă).
 */
export function CreatorApplyFlow({ initial, categories, defaultHandle }: Props) {
  const t = useTranslations("becomeCreatorForm");
  const [current, setCurrent] = useState<ApplyFlowState>(initial);

  const onSubmitted = (next: ApplicationState) => {
    if (next.state === "pending" || next.state === "rejected") {
      setCurrent({ state: next.state, application: next.application });
    } else if (next.state === "creator") {
      window.location.assign("/creator");
    }
  };

  if (current.state === "pending") {
    return <ApplicationStatusCard kind="pending" application={current.application} />;
  }

  return (
    <div className="space-y-4">
      {current.state === "rejected" ? <ApplicationStatusCard kind="rejected" application={current.application} /> : null}
      <Card padding="lg">
        <CardHeader className="flex-col gap-1">
          <CardTitle>{current.state === "rejected" ? t("reapplyTitle") : t("formTitle")}</CardTitle>
          <CardDescription>{t("formBody")}</CardDescription>
        </CardHeader>
        <CreatorApplicationForm
          categories={categories}
          defaultHandle={current.state === "rejected" ? current.application.handle : defaultHandle}
          onSubmitted={onSubmitted}
        />
      </Card>
    </div>
  );
}
