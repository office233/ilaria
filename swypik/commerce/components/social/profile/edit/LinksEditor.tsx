"use client";

import { Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";

export type EditableLink = { label: string; url: string };

export const MAX_LINKS = 8;

/** Lista de linkuri publice (etichetă + URL https). */
export function LinksEditor({ links, onChange }: { links: EditableLink[]; onChange: (links: EditableLink[]) => void }) {
  const t = useTranslations("social.edit");
  const update = (idx: number, patch: Partial<EditableLink>) =>
    onChange(links.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 flex w-full justify-between text-sm font-medium text-fg">
        <span>{t("links")}</span>
        <span className="text-xs text-muted">
          {links.length}/{MAX_LINKS}
        </span>
      </legend>
      {links.map((link, idx) => (
        <div key={idx} className="flex gap-2">
          <Input
            value={link.label}
            onChange={(e) => update(idx, { label: e.target.value })}
            maxLength={30}
            placeholder={t("linkLabel")}
            aria-label={t("linkLabel")}
            className="w-28 shrink-0"
          />
          <Input
            type="url"
            inputMode="url"
            value={link.url}
            onChange={(e) => update(idx, { url: e.target.value })}
            maxLength={500}
            placeholder={t("linkUrl")}
            aria-label={t("linkUrl")}
            className="min-w-0 flex-1"
          />
          <IconButton label={t("removeLink")} onClick={() => onChange(links.filter((_, i) => i !== idx))}>
            <X aria-hidden />
          </IconButton>
        </div>
      ))}
      {links.length < MAX_LINKS ? (
        <Button variant="secondary" size="sm" block onClick={() => onChange([...links, { label: "", url: "" }])}>
          <Plus aria-hidden className="h-4 w-4" />
          {t("addLink")}
        </Button>
      ) : null}
    </fieldset>
  );
}
