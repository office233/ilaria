"use client";

/** Onboarding-ul șoferului: status verificare + documente (aprobat / în verificare / lipsă / expirat). */
import Link from "next/link";
import { CheckCircle2, Clock, FileWarning, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import DocumentUploadRow from "./DocumentUploadRow";

export type DriverMe = {
  courier: {
    kind: "courier" | "driver";
    full_name: string;
    verification_status: string;
    active: boolean;
    rating: string | null;
  } | null;
  documents: { doc_type: string; status: string; expires_at: string | null }[];
  required_documents: string[];
};

type DocState = "approved" | "pending" | "rejected" | "missing" | "expired";

function docState(doc: DriverMe["documents"][number] | undefined): DocState {
  if (!doc) return "missing";
  if (doc.expires_at && Date.parse(doc.expires_at) < Date.now()) return "expired";
  return (["approved", "pending", "rejected"] as const).includes(doc.status as "approved") ? (doc.status as DocState) : "pending";
}

const TONE: Record<DocState, "success" | "info" | "danger" | "warning"> = {
  approved: "success",
  pending: "info",
  rejected: "danger",
  missing: "warning",
  expired: "danger",
};

export default function DriverStatusCard({ me, onDocsChanged }: { me: DriverMe; onDocsChanged: () => void }) {
  const t = useTranslations("goDriver");
  if (!me.courier) {
    return (
      <Card className="space-y-3 text-center">
        <p className="text-sm text-fg">{t("onboarding.notApplied")}</p>
        <Button asChild block>
          <Link href="/join/fleet?kind=driver">{t("onboarding.apply")}</Link>
        </Button>
      </Card>
    );
  }
  const c = me.courier;
  const status = !c.active && c.verification_status === "approved" ? "suspended" : c.verification_status;
  const Icon = status === "approved" ? CheckCircle2 : status === "rejected" || status === "suspended" ? XCircle : Clock;
  const docs = new Map(me.documents.map((d) => [d.doc_type, d]));
  const types = Array.from(new Set([...me.required_documents, ...me.documents.map((d) => d.doc_type)]));
  const problems = types.filter((ty) => docState(docs.get(ty)) !== "approved").length;

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon aria-hidden className="h-5 w-5 text-muted" />
        <p className="flex-1 text-sm font-semibold text-fg">{t(`onboarding.status.${status}`)}</p>
        {c.rating ? <Badge tone="neutral">★ {Number(c.rating).toFixed(2)}</Badge> : null}
      </div>
      {types.length ? (
        <details open={problems > 0}>
          <summary className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-fg">
            <FileWarning aria-hidden className="h-4 w-4 text-muted" />
            {problems ? t("onboarding.docsProblems", { count: problems }) : t("onboarding.docsOk")}
          </summary>
          <ul className="space-y-1 pt-1">
            {types.map((ty) => {
              const st = docState(docs.get(ty));
              const needsUpload = st === "missing" || st === "rejected" || st === "expired";
              return (
                <li key={ty} className="space-y-1 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-fg">{t(`docs.${ty}`)}</span>
                    <Badge tone={TONE[st]}>{t(`docState.${st}`)}</Badge>
                  </div>
                  {needsUpload ? <DocumentUploadRow docType={ty} onUploaded={onDocsChanged} /> : null}
                </li>
              );
            })}
          </ul>
          {problems ? <p className="pt-2 text-xs text-muted">{t("onboarding.docsHelp")}</p> : null}
        </details>
      ) : null}
    </Card>
  );
}
