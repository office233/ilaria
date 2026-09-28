import { redirect } from "next/navigation";
import Link from "next/link";
import { getTranslations, getLocale } from "next-intl/server";
import { dbQuery } from "@/lib/db";
import { getCreatorUserId } from "@/lib/creator/session";
import { Pencil, Clock } from "lucide-react";
import DraftActions from "./DraftActions";
import Countdown from "./Countdown";

export const dynamic = "force-dynamic";
export async function generateMetadata() {
  const t = await getTranslations("creatorDrafts");
  return { title: t("metaTitle") };
}

type Tab = "drafts" | "scheduled";

export default async function DraftsPage(
  { searchParams }: { searchParams: Promise<{ tab?: string }> },
) {
  const creatorId = await getCreatorUserId();
  if (!creatorId) redirect("/auth?next=/creator/drafts");
  const t = await getTranslations("creatorDrafts");
  const locale = await getLocale();

  const sp = await searchParams;
  const tab: Tab = sp.tab === "scheduled" ? "scheduled" : "drafts";

  const drafts =
    tab === "drafts"
      ? (
          await dbQuery<{
            id: string;
            title: string | null;
            description: string | null;
            thumbnail_url: string | null;
            updated_at: string;
          }>(
            `SELECT id, title, description, thumbnail_url, updated_at
               FROM videos
              WHERE creator_id = $1 AND is_draft = true AND status <> 'deleted'
              ORDER BY updated_at DESC
              LIMIT 100`,
            [creatorId],
          )
        ).rows
      : [];

  const scheduled =
    tab === "scheduled"
      ? (
          await dbQuery<{
            id: string;
            title: string | null;
            thumbnail_url: string | null;
            scheduled_publish_at: string;
          }>(
            `SELECT id, title, thumbnail_url, scheduled_publish_at
               FROM videos
              WHERE creator_id = $1
                AND scheduled_publish_at IS NOT NULL
                AND scheduled_publish_at > now()
                AND status <> 'deleted'
              ORDER BY scheduled_publish_at ASC
              LIMIT 100`,
            [creatorId],
          )
        ).rows
      : [];

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6">
      <h1 className="text-2xl font-black text-fg mb-6">{t("titlu")}</h1>

      <div className="flex gap-2 mb-6 border-b border-subtle overflow-x-auto">
        <Link
          href="/creator/drafts?tab=drafts"
          className={`px-4 py-3 min-h-[44px] text-sm font-bold border-b-2 transition focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none whitespace-nowrap ${
            tab === "drafts" ? "border-brand text-brand" : "border-transparent text-muted hover:text-fg"
          }`}
        >
          {t("tabSchite")} ({tab === "drafts" ? drafts.length : "·"})
        </Link>
        <Link
          href="/creator/drafts?tab=scheduled"
          className={`px-4 py-3 min-h-[44px] text-sm font-bold border-b-2 transition focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none whitespace-nowrap ${
            tab === "scheduled" ? "border-brand text-brand" : "border-transparent text-muted hover:text-fg"
          }`}
        >
          {t("tabProgramate")} ({tab === "scheduled" ? scheduled.length : "·"})
        </Link>
      </div>

      {tab === "drafts" ? (
        drafts.length === 0 ? (
          <EmptyState
            title={t("emptyDraftsTitle")}
            hint={t("emptyDraftsHint")}
            uploadLabel={t("incarcaClip")}
          />
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {drafts.map((d) => (
              <li
                key={d.id}
                className="bg-surface border border-subtle rounded-2xl overflow-hidden flex flex-col"
              >
                <div className="aspect-[9/16] bg-surface-2 relative">
                  {d.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={d.thumbnail_url} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-subtle text-xs">
                      {t("faraPreview")}
                    </div>
                  )}
                </div>
                <div className="p-3 flex-1 flex flex-col">
                  <p className="text-sm font-bold text-fg line-clamp-2 mb-1">
                    {d.title || t("faraTitlu")}
                  </p>
                  <p className="text-[11px] text-muted mb-3">
                    {t("ultimaEditare", { date: new Date(d.updated_at).toLocaleDateString(locale) })}
                  </p>
                  <div className="mt-auto flex gap-2">
                    <Link
                      href={`/upload?draft=${d.id}`}
                      className="flex-1 h-11 rounded-lg bg-brand text-brand-fg text-xs font-bold flex items-center justify-center gap-1 hover:bg-brand-hover focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none"
                    >
                      <Pencil size={14} /> {t("editeaza")}
                    </Link>
                    <DraftActions
                      videoId={d.id}
                      action="publish-now"
                      label={t("publica")}
                      icon="send"
                      confirm={t("confirmPublica")}
                    />
                    <DraftActions
                      videoId={d.id}
                      action="delete"
                      label={t("sterge")}
                      icon="trash"
                      confirm={t("confirmSterge")}
                    />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : scheduled.length === 0 ? (
        <EmptyState
          title={t("emptySchedTitle")}
          hint={t("emptySchedHint")}
          uploadLabel={t("incarcaClip")}
        />
      ) : (
        <ul className="space-y-3">
          {scheduled.map((s) => (
            <li
              key={s.id}
              className="bg-surface border border-subtle rounded-2xl p-4 flex items-center gap-4"
            >
              <div className="w-16 aspect-[9/16] bg-surface-2 rounded-lg overflow-hidden flex-shrink-0">
                {s.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.thumbnail_url} alt="" className="w-full h-full object-cover" />
                ) : null}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-fg truncate">{s.title || t("faraTitlu")}</p>
                <p className="text-xs text-muted flex items-center gap-1.5 mt-1">
                  <Clock size={12} />
                  <Countdown target={s.scheduled_publish_at} />
                </p>
              </div>
              <DraftActions
                videoId={s.id}
                action="cancel-schedule"
                label={t("anuleaza")}
                icon="x"
                confirm={t("confirmAnuleaza")}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState({ title, hint, uploadLabel }: { title: string; hint: string; uploadLabel: string }) {
  return (
    <div className="text-center py-16 px-6 bg-surface border border-dashed border-subtle rounded-2xl">
      <p className="text-base font-bold text-fg mb-2">{title}</p>
      <p className="text-sm text-muted max-w-sm mx-auto">{hint}</p>
      <Link
        href="/upload"
        className="inline-flex mt-4 h-11 px-5 rounded-xl bg-brand text-brand-fg text-sm font-bold items-center focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none hover:bg-brand-hover"
      >
        {uploadLabel}
      </Link>
    </div>
  );
}

