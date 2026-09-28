"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Field, Textarea } from "@/components/ui/Input";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  tone?: "primary" | "danger";
  /** Afișează un câmp de text (motiv / notă). */
  noteLabel?: string;
  noteMaxLength?: number;
  busy?: boolean;
  error?: string | null;
  onConfirm: (note: string) => void;
  children?: ReactNode;
};

/** Dialog de confirmare pentru acțiunile ireversibile (plată, respingere, închidere). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone = "primary",
  noteLabel,
  noteMaxLength = 300,
  busy,
  error,
  onConfirm,
  children,
}: Props) {
  const t = useTranslations("adminMissions");
  const [note, setNote] = useState("");
  const errorId = useId();

  useEffect(() => {
    if (open) setNote("");
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button variant={tone} loading={busy} disabled={busy} onClick={() => onConfirm(note.trim())}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {noteLabel ? (
        <Field label={noteLabel} className={children ? "mt-4" : undefined}>
          {(f) => (
            <Textarea
              {...f}
              value={note}
              maxLength={noteMaxLength}
              rows={3}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </Field>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="mt-3 rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
