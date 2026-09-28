"use client";

/**
 * Șoferii Go: aprobare / respingere / suspendare / reactivare (PATCH
 * /api/admin/fleet/[id] — auditat, email, treaptă comision) + revizia
 * documentelor (PATCH /api/admin/go/drivers/[id]/documents — auditat).
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { goFetch } from "@/components/go/format";
import { useAdminResource } from "./useAdminApi";

type Doc = { doc_type: string; status: string; expires_at: string | null; file_url: string | null; has_file?: boolean };
type Driver = {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  city: string;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_plate: string | null;
  verification_status: string;
  active: boolean;
  has_account: boolean;
  documents: Doc[];
};

/** Doar linkuri http(s) — documentele pot veni din formulare publice. */
const SAFE_URL = /^https?:\/\//i;

const STATUSES = ["pending", "approved", "suspended", "rejected"] as const;
const ACTIONS: Record<(typeof STATUSES)[number], ("approve" | "reject" | "suspend" | "reactivate")[]> = {
  pending: ["approve", "reject"],
  approved: ["suspend"],
  suspended: ["reactivate"],
  rejected: ["approve"],
};

export default function DriversTab() {
  const t = useTranslations("adminGo");
  const tDocs = useTranslations("goDriver");
  const { toast } = useToast();
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("pending");
  const { data, reload } = useAdminResource<{ drivers: Driver[] }>(`/api/admin/go/drivers?status=${status}`);

  const fleetAction = async (id: string, action: string) => {
    const r = await goFetch(`/api/admin/fleet/${id}`, { method: "PATCH", body: JSON.stringify({ action }) });
    // Aprobarea e refuzată cât lipsesc documente obligatorii (aprobate, neexpirate).
    const title = r.ok ? t("done") : r.error === "documents_missing" ? t("documentsMissing") : t("saveError");
    toast({ title, tone: r.ok ? "success" : "danger" });
    void reload();
  };

  const reviewDoc = async (id: string, doc_type: string, docStatus: string, expires_at?: string) => {
    const r = await goFetch(`/api/admin/go/drivers/${id}/documents`, {
      method: "PATCH",
      body: JSON.stringify({ doc_type, status: docStatus, ...(expires_at ? { expires_at } : {}) }),
    });
    toast({ title: r.ok ? t("saved") : t("saveError"), tone: r.ok ? "success" : "danger" });
    void reload();
  };

  return (
    <div className="space-y-3">
      <Tabs value={status} onValueChange={(v) => setStatus(v as (typeof STATUSES)[number])}>
        <TabsList variant="pill">
          {STATUSES.map((s) => (
            <TabsTrigger key={s} value={s}>
              {t(`driverStatus.${s}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {!data ? <Skeleton className="h-32 w-full" /> : null}
      {data?.drivers.length === 0 ? <EmptyState title={t("noDriversInStatus")} /> : null}
      {data?.drivers.map((d) => (
        <Card key={d.id} className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="flex-1 font-medium text-fg">
              {d.full_name} · {d.city}
            </p>
            {!d.has_account ? <Badge tone="warning">{t("noAccount")}</Badge> : null}
          </div>
          <p className="text-xs text-muted">
            {[d.phone, d.email, [d.vehicle_make, d.vehicle_model].filter(Boolean).join(" "), d.vehicle_plate].filter(Boolean).join(" · ")}
          </p>
          {d.documents.length ? (
            <ul className="space-y-2">
              {d.documents.map((doc) => (
                <li key={doc.doc_type} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-[10rem] flex-1 text-fg">
                    {doc.has_file ? (
                      <a
                        className="underline"
                        href={`/api/admin/go/drivers/${d.id}/documents/file?doc_type=${doc.doc_type}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {tDocs(`docs.${doc.doc_type}`)}
                      </a>
                    ) : doc.file_url && SAFE_URL.test(doc.file_url) ? (
                      <a className="underline" href={doc.file_url} target="_blank" rel="noopener noreferrer">
                        {tDocs(`docs.${doc.doc_type}`)}
                      </a>
                    ) : (
                      tDocs(`docs.${doc.doc_type}`)
                    )}
                  </span>
                  <Input
                    type="date"
                    className="w-40"
                    aria-label={t("docExpires")}
                    defaultValue={doc.expires_at?.slice(0, 10) ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value;
                      if (v && v !== doc.expires_at?.slice(0, 10)) void reviewDoc(d.id, doc.doc_type, doc.status, v);
                    }}
                  />
                  <Select
                    aria-label={tDocs(`docs.${doc.doc_type}`)}
                    className="w-40"
                    value={doc.status}
                    onChange={(e) => void reviewDoc(d.id, doc.doc_type, e.target.value)}
                    options={["pending", "approved", "rejected"].map((s) => ({ value: s, label: tDocs(`docState.${s}`) }))}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">{t("noDocuments")}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {ACTIONS[status].map((a) => (
              <Button key={a} size="sm" variant={a === "approve" || a === "reactivate" ? "primary" : "danger"} onClick={() => void fleetAction(d.id, a)}>
                {t(`driverAction.${a}`)}
              </Button>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
