"use client";

/** Listările gazdei: adăugare, editare, publicare/retragere, arhivare (Dialog). */
import { useState } from "react";
import { BedDouble, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { errorKey, useStaysFormat } from "@/components/stays/format";
import { Link } from "@/lib/i18n/navigation";
import type { HostListing } from "@/lib/stays/listings";
import type { HostLimits } from "./HostPanelClient";
import ListingFormSheet from "./ListingFormSheet";

type Props = { listings: HostListing[]; limits: HostLimits; defaultCity: string | null; onChanged: () => void };

export default function HostListings({ listings, limits, defaultCity, onChanged }: Props) {
    const t = useTranslations("staysHost");
    const tu = useTranslations("staysUi");
    const f = useStaysFormat();
    const { toast } = useToast();
    const [editing, setEditing] = useState<HostListing | "new" | null>(null);
    const [archiving, setArchiving] = useState<HostListing | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const request = async (id: string, method: "PATCH" | "DELETE", body: unknown, ok: string) => {
        setBusy(id);
        const res = await fetch(`/api/host/listings/${id}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body ? JSON.stringify(body) : undefined,
        }).catch(() => null);
        setBusy(null);
        if (!res?.ok) {
            const j = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
            toast({ title: tu(errorKey(j.error)), tone: "danger" });
            return false;
        }
        toast({ title: ok, tone: "success" });
        onChanged();
        return true;
    };

    return (
        <div className="space-y-3">
            <Button block onClick={() => setEditing("new")}>
                <Plus className="h-4 w-4" aria-hidden />
                {t("addListing")}
            </Button>
            {listings.length === 0 ? (
                <EmptyState icon={BedDouble} title={t("noListingsTitle")} description={t("noListingsBody")} />
            ) : (
                listings.map((l) => (
                    <Card key={l.id} padding="none" className="overflow-hidden">
                        <div className="flex gap-3 p-3">
                            {l.image_url ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={l.image_url} alt="" className="h-20 w-20 shrink-0 rounded-control object-cover" />
                            ) : (
                                <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-control bg-surface-2">
                                    <BedDouble className="h-6 w-6 text-subtle" aria-hidden />
                                </span>
                            )}
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-semibold text-fg">{l.title}</p>
                                <p className="text-sm text-muted">
                                    {l.location_city} · {l.price_cents ? f.money(l.price_cents) : "—"} {tu("perNight")}
                                </p>
                                <div className="mt-1 flex flex-wrap gap-1">
                                    <Badge tone={l.status === "active" ? "success" : "neutral"}>{t(l.status === "active" ? "statusActive" : "statusDraft")}</Badge>
                                    {l.upcoming_bookings > 0 ? <Badge tone="info">{t("upcomingCount", { count: l.upcoming_bookings })}</Badge> : null}
                                </div>
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-2 border-t border-subtle p-2">
                            <Button size="sm" variant="ghost" onClick={() => setEditing(l)}>{t("edit")}</Button>
                            <Button
                                size="sm"
                                variant={l.status === "active" ? "ghost" : "soft"}
                                loading={busy === l.id}
                                onClick={() =>
                                    void request(l.id, "PATCH", { action: l.status === "active" ? "unpublish" : "publish" }, l.status === "active" ? t("unpublishedToast") : t("publishedToast"))
                                }
                            >
                                {l.status === "active" ? t("unpublish") : t("publish")}
                            </Button>
                            {l.status === "active" ? (
                                <Button asChild size="sm" variant="ghost"><Link href={`/stays/${l.id}`}>{t("view")}</Link></Button>
                            ) : null}
                            <Button size="sm" variant="ghost" className="ml-auto text-danger" onClick={() => setArchiving(l)}>{t("archive")}</Button>
                        </div>
                    </Card>
                ))
            )}

            {editing ? (
                <ListingFormSheet
                    key={editing === "new" ? "new" : editing.id}
                    open
                    onOpenChange={(o) => !o && setEditing(null)}
                    listing={editing === "new" ? null : editing}
                    limits={limits}
                    defaultCity={defaultCity}
                    onSaved={onChanged}
                />
            ) : null}

            <Dialog
                open={archiving !== null}
                onOpenChange={(o) => !o && setArchiving(null)}
                title={t("archiveTitle")}
                description={t("archiveBody")}
                footer={
                    <div className="flex gap-2">
                        <Button variant="secondary" className="flex-1" onClick={() => setArchiving(null)}>{t("back")}</Button>
                        <Button
                            variant="danger"
                            className="flex-1"
                            loading={busy === archiving?.id}
                            onClick={async () => {
                                if (archiving && (await request(archiving.id, "DELETE", null, t("archivedToast")))) setArchiving(null);
                            }}
                        >
                            {t("archive")}
                        </Button>
                    </div>
                }
            />
        </div>
    );
}
