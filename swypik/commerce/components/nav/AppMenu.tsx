"use client";

import { useState, type FormEvent, type MouseEvent } from "react";
import { Search, LogIn } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/lib/i18n/navigation";
import { Sheet } from "@/components/ui/Sheet";
import { Input } from "@/components/ui/Input";
import { ListItem } from "@/components/ui/ListItem";
import { Avatar } from "@/components/ui/Avatar";
import { Skeleton } from "@/components/ui/Skeleton";
import { useViewer, type Viewer } from "@/lib/nav/useViewer";
import AppMenuSections from "./AppMenuSections";

type Props = { open: boolean; onOpenChange: (open: boolean) => void };

/**
 * Meniul aplicației (sertar din stânga). Grupuri din lib/nav/modules.ts:
 * Cumpărături · Mobilitate & livrare · Călătorii · Divertisment · Comunitate ·
 * Business & roluri (după rol) · Setări & ajutor. Modulele cu flag OFF lipsesc.
 */
export default function AppMenu({ open, onOpenChange }: Props) {
  const t = useTranslations("appMenu");
  const { viewer, roles, loading } = useViewer(open);

  // Închidem la orice click pe link, nu doar la schimbarea rutei — altfel
  // tap pe ruta curentă (pathname neschimbat) lasă meniul deschis.
  const closeOnLinkClick = (e: MouseEvent<HTMLDivElement>) => {
    // Tastatura (Enter pe link) emite tot un click, deci e acoperită.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if ((e.target as Element).closest("a[href]")) onOpenChange(false);
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side="left"
      title={t("title")}
      bodyClassName="px-2 pb-6"
    >
      <div onClick={closeOnLinkClick}>
        <div className="space-y-3 px-2 pb-2">
          <ProfileBlock viewer={viewer} loading={loading} />
          <MenuSearch onDone={() => onOpenChange(false)} />
        </div>
        <AppMenuSections roles={roles} />
      </div>
    </Sheet>
  );
}

function ProfileBlock({ viewer, loading }: { viewer: Viewer | null; loading: boolean }) {
  const t = useTranslations("appMenu");
  if (loading) {
    return (
      <div className="flex items-center gap-3 px-1 py-2" aria-hidden>
        <Skeleton className="h-10 w-10 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
    );
  }
  if (!viewer) {
    return (
      <ListItem
        href="/auth/login"
        icon={LogIn}
        title={t("signIn")}
        subtitle={t("signInHint")}
        className="bg-surface-2"
      />
    );
  }
  const name = viewer.displayName || viewer.username || t("account");
  return (
    <ListItem
      href="/account"
      leading={<Avatar src={viewer.avatarUrl} name={name} size="md" />}
      title={name}
      subtitle={t("viewProfile")}
      className="bg-surface-2"
    />
  );
}

function MenuSearch({ onDone }: { onDone: () => void }) {
  const t = useTranslations("appMenu");
  const router = useRouter();
  const [q, setQ] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const query = q.trim();
    if (!query) return;
    onDone();
    router.push(`/search?q=${encodeURIComponent(query)}`);
  };
  return (
    <form role="search" onSubmit={submit}>
      <Input
        type="search"
        enterKeyHint="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("searchPlaceholder")}
        aria-label={t("searchAria")}
        leadingIcon={<Search />}
      />
    </form>
  );
}
