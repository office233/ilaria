import { Ban } from "lucide-react";
import { getTranslations, getLocale } from "next-intl/server";
import { UserFraudActions } from "./UserFraudActions";

export type BlockedUser = {
  id: string;
  email: string | null;
  username: string | null;
  blocked_at: string | null;
  reason: string | null;
  blocked_by: string | null;
  recreation_signal: string | null;
  recreation_of: string | null;
  flagged_orders_count: number;
};

export async function BlockedUsersList({ users }: { users: BlockedUser[] }) {
  if (users.length === 0) return null;
  const t = await getTranslations("adminRisk");
  const locale = await getLocale();
  return (
    <details
      className="bg-red-50 border border-red-200 rounded p-3"
      open={users.length <= 3}
    >
      <summary className="text-xs font-semibold text-red-900 cursor-pointer list-none flex items-center justify-between">
        <span className="inline-flex items-center gap-1"><Ban size={14} /> {t("blockedUsers", { count: users.length })}</span>
        <span className="text-[10px] font-normal text-red-700">{t("clickForDetails")}</span>
      </summary>
      <div className="mt-2 space-y-1.5">
        {users.map((u) => (
          <BlockedUserRow key={u.id} user={u} t={t} locale={locale} />
        ))}
      </div>
    </details>
  );
}

function BlockedUserRow({
  user: u,
  t,
  locale,
}: {
  user: BlockedUser;
  t: Awaited<ReturnType<typeof getTranslations>>;
  locale: string;
}) {
  return (
    <div className="bg-white border border-red-100 rounded p-2 flex items-start justify-between gap-2">
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-gray-900 truncate flex items-center gap-1.5">
          {u.recreation_signal && (
            <span
              title={t("recreationOfTitle", { id: u.recreation_of?.slice(0, 8) || "?", signal: u.recreation_signal })}
              className="shrink-0 text-[9px] font-bold uppercase bg-fuchsia-600 text-white px-1.5 py-0.5 rounded"
            >
              &#8635; {u.recreation_signal}
            </span>
          )}
          <span className="truncate">
            {u.email || u.username || t("noEmail")}{" "}
            <span className="text-[10px] font-normal text-gray-500">
              &middot; {t("flaggedIn30d", { count: u.flagged_orders_count })}
            </span>
          </span>
        </div>
        <div className="text-[11px] text-gray-600 truncate">
          <code className="font-mono text-[10px] text-gray-500">{u.id.slice(0, 8)}</code>
          {u.blocked_by && ` · ${u.blocked_by}`}
          {u.blocked_at && ` · ${new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(u.blocked_at))}`}
        </div>
        {u.reason && (
          <div className="text-[11px] italic text-gray-700 mt-0.5 truncate">{u.reason}</div>
        )}
      </div>
      <UserFraudActions userId={u.id} blocked={true} />
    </div>
  );
}
