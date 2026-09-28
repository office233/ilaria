"use client";

import { useEffect, useState } from "react";
import { Link } from "@/lib/i18n/navigation";
import { ChevronLeft, Mail, Bell } from "lucide-react";
import PushDeviceToggle from "@/components/notifications/PushDeviceToggle";
import { useTranslations } from "next-intl";

type Prefs = {
  email_likes: boolean; email_comments: boolean; email_follows: boolean; email_messages: boolean; email_sales: boolean; email_marketing: boolean;
  push_likes: boolean; push_comments: boolean; push_follows: boolean; push_messages: boolean; push_sales: boolean;
};

/** Chei din namespace-ul `notificationsSettings`. */
type RowLabel = "likes" | "comments" | "newFollowers" | "messages" | "salesCommissions" | "marketingNews";

const EMAIL_ROWS: { key: keyof Prefs; label: RowLabel }[] = [
  { key: "email_likes", label: "likes" },
  { key: "email_comments", label: "comments" },
  { key: "email_follows", label: "newFollowers" },
  { key: "email_messages", label: "messages" },
  { key: "email_sales", label: "salesCommissions" },
  { key: "email_marketing", label: "marketingNews" },
];
const PUSH_ROWS: { key: keyof Prefs; label: RowLabel }[] = [
  { key: "push_likes", label: "likes" },
  { key: "push_comments", label: "comments" },
  { key: "push_follows", label: "newFollowers" },
  { key: "push_messages", label: "messages" },
  { key: "push_sales", label: "salesCommissions" },
];

export default function NotificationsSettingsClient() {
  const t = useTranslations("notificationsSettings");
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/users/me/notification-preferences")
      .then((r) => r.json())
      .then((d) => setPrefs(d.prefs))
      .catch(() => {});
  }, []);

  async function toggle(key: keyof Prefs) {
    if (!prefs) return;
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    setSaving(key);
    try {
      await fetch("/api/users/me/notification-preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: next[key] }),
      });
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-white/10 bg-black/90 px-4 py-3 backdrop-blur">
        <Link href="/account" className="text-white/70 hover:text-white"><ChevronLeft size={22} /></Link>
        <h1 className="text-base font-black">{t("notificari")}</h1>
      </header>

      <div className="mx-auto max-w-md px-4 py-6 space-y-6">
        <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
          <h2 className="flex items-center gap-2 text-sm font-black"><Bell size={16} />  {t("pushPeAcestDevice")}</h2>
          <p className="mt-1 text-xs text-white/60">{t("activeazaSauDezactiveazaNotificarile")}</p>
          <div className="mt-3"><PushDeviceToggle /></div>
        </section>

        <Section title={t("emailSection")} icon={<Mail size={16} />}>
          {EMAIL_ROWS.map((r) => (
            <Row key={r.key} label={t(r.label)} on={!!prefs?.[r.key]} disabled={!prefs || saving === r.key} onToggle={() => toggle(r.key)} />
          ))}
        </Section>

        <Section title={t("pushSection")} icon={<Bell size={16} />}>
          {PUSH_ROWS.map((r) => (
            <Row key={r.key} label={t(r.label)} on={!!prefs?.[r.key]} disabled={!prefs || saving === r.key} onToggle={() => toggle(r.key)} />
          ))}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.04] overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-white/10 text-sm font-black">{icon}{title}</div>
      <div className="divide-y divide-white/5">{children}</div>
    </section>
  );
}

function Row({ label, on, disabled, onToggle }: { label: string; on: boolean; disabled: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className="flex w-full items-center justify-between px-5 py-3.5 text-left hover:bg-white/[0.06] disabled:opacity-60"
    >
      <span className="text-sm">{label}</span>
      <span className={`relative h-6 w-11 rounded-full transition-colors ${on ? "bg-[#7C3AED]" : "bg-white/20"}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${on ? "translate-x-5" : "translate-x-0.5"}`} />
      </span>
    </button>
  );
}
