"use client";
import { useTranslations } from "next-intl";
import { Disc3, Mic, Radio, Sparkles, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/ui/cn";
import { haptic } from "@/lib/haptic";
import type { AudioSourceType } from "@/lib/audio/types";
import type { AudioTabId } from "../_lib/useAudioFeed";

const TABS: Array<{ id: AudioTabId; labelKey: string; icon: LucideIcon }> = [
  { id: "all", labelKey: "audio.tabs.all", icon: Sparkles },
  { id: "radio", labelKey: "audio.tabs.radio", icon: Radio },
  { id: "audius", labelKey: "audio.tabs.audius", icon: Disc3 },
  { id: "jamendo", labelKey: "audio.tabs.jamendo", icon: Sparkles },
  { id: "podcast", labelKey: "audio.tabs.podcast", icon: Mic },
];

type Props = { active: AudioTabId; onChange: (tab: AudioTabId) => void; unconfigured: AudioSourceType[] };

/** Filtrele de sursă; sursele neconfigurate (fără cheie) nu apar deloc. */
export default function SourceTabs({ active, onChange, unconfigured }: Props) {
  const t = useTranslations("music");
  return (
    <nav aria-label={t("audio.sourcesLabel")} className="flex items-center gap-2 overflow-x-auto px-gutter pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {TABS.filter((tab) => tab.id === "all" || !unconfigured.includes(tab.id)).map(({ id, labelKey, icon: Icon }) => (
        <button
          key={id}
          type="button"
          aria-pressed={active === id}
          onClick={() => { haptic("tap"); onChange(id); }}
          className={cn(
            "flex h-11 shrink-0 select-none items-center gap-1.5 whitespace-nowrap rounded-full px-4 text-sm font-semibold transition-colors duration-fast",
            active === id ? "bg-brand text-brand-fg" : "border border-subtle bg-surface-2 text-muted hover:text-fg",
          )}
        >
          <Icon className="h-4 w-4" aria-hidden />
          {t(labelKey)}
        </button>
      ))}
    </nav>
  );
}
