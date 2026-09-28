/**
 * Admin Health Dashboard — live status DB, Redis, R2, Queue.
 */
import { getTranslations } from "next-intl/server";
import { checkDb, checkQueue, checkR2, checkRedis, type HealthResult } from "@/lib/health";
import { requireAdminSession } from "@/lib/security/admin-auth";
import HealthRefresh from "./HealthRefresh";
import WebVitalsCard from "./WebVitalsCard";

export const dynamic = "force-dynamic";

type CardKey = "db" | "redis" | "r2" | "queue";

export default async function AdminHealthPage() {
  await requireAdminSession();
  const t = await getTranslations("adminHealth");

  const [db, redis, r2, queue] = await Promise.all([
    checkDb(),
    checkRedis(),
    checkR2(),
    checkQueue(),
  ]);

  const initial: Record<CardKey, HealthResult> = { db, redis, r2, queue };
  const checkedAt = new Date().toISOString();
  const meta: Record<CardKey, { title: string; desc: string }> = {
    db: { title: t("meta.db.title"), desc: t("meta.db.desc") },
    redis: { title: t("meta.redis.title"), desc: t("meta.redis.desc") },
    r2: { title: t("meta.r2.title"), desc: t("meta.r2.desc") },
    queue: { title: t("meta.queue.title"), desc: t("meta.queue.desc") },
  };

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-black text-[#0D0D0D]">{t("title")}</h1>
        <p className="text-sm text-[#0D0D0D]/60 mt-1">
          {t("subtitle")}
        </p>
      </div>
      <HealthRefresh initial={initial} checkedAt={checkedAt} meta={meta} />
      <WebVitalsCard />
    </div>
  );
}
