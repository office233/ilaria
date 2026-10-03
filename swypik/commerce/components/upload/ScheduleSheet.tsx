"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { Sheet } from "@/components/ui/Sheet";

const MIN_LEAD_MS = 5 * 60 * 1000;

function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Programarea publicării: dată/oră locală → ISO (serverul cere o dată viitoare). */
export function ScheduleSheet(props: { open: boolean; onOpenChange: (v: boolean) => void; busy: boolean; onConfirm: (iso: string) => void }) {
  const t = useTranslations("videoUpload.schedule");
  const min = useMemo(() => localInputValue(new Date(Date.now() + MIN_LEAD_MS)), [props.open]); // eslint-disable-line react-hooks/exhaustive-deps
  const [value, setValue] = useState("");
  const parsed = value ? new Date(value) : null;
  const valid = Boolean(parsed && parsed.getTime() > Date.now() + MIN_LEAD_MS / 5);

  return (
    <Sheet
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={t("title")}
      description={t("hint")}
      footer={
        <Button block disabled={!valid} loading={props.busy} onClick={() => parsed && props.onConfirm(parsed.toISOString())}>
          {t("confirm")}
        </Button>
      }
    >
      <Field label={t("when")} error={value && !valid ? t("mustBeFuture") : undefined}>
        {(f) => <Input {...f} type="datetime-local" min={min} value={value} onChange={(e) => setValue(e.target.value)} />}
      </Field>
    </Sheet>
  );
}
