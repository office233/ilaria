"use client";

/** Alegerea orașului / a locației GPS (înlocuiește prompt()/alert()). */
import { useEffect, useState } from "react";
import { LocateFixed } from "lucide-react";
import { useTranslations } from "next-intl";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Input";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  city: string | null;
  locating: boolean;
  onSaveCity: (city: string) => void;
  onLocate: () => void;
};

export default function CitySheet({ open, onOpenChange, city, locating, onSaveCity, onLocate }: Props) {
  const t = useTranslations("foodHub");
  const [draft, setDraft] = useState(city ?? "");
  useEffect(() => {
    if (open) setDraft(city ?? "");
  }, [open, city]);

  const valid = draft.trim().length >= 2;
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("cityTitle")}
      description={t("citySub")}
      footer={
        <Button block disabled={!valid} onClick={() => onSaveCity(draft.trim())}>
          {t("citySave")}
        </Button>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSaveCity(draft.trim());
        }}
      >
        <TextField
          label={t("cityLabel")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoComplete="address-level2"
          maxLength={120}
          autoFocus
        />
        <Button type="button" variant="secondary" block loading={locating} onClick={onLocate}>
          <LocateFixed size={18} aria-hidden />
          {t("useMyLocation")}
        </Button>
      </form>
    </Sheet>
  );
}
