"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, type ButtonProps } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Textarea } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";

export type ActionDialogProps = {
  /** Eticheta butonului care deschide confirmarea. */
  label: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  disabled?: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  /** Endpoint-ul POST. */
  url: string;
  /** Corpul cererii; primește nota introdusă (dacă există câmp). */
  body?: (note: string) => Record<string, unknown>;
  /** Câmp de notă/motiv opțional sau obligatoriu. */
  note?: { label: string; required?: boolean; placeholder?: string };
  /** Conținut suplimentar în dialog (ex. alegerea duratei). */
  children?: ReactNode;
  /** Mesaje pentru codurile de eroare ale API-ului. */
  errors?: Record<string, string>;
  successMessage: string;
  /** După succes: navigare (altfel router.refresh()). */
  redirectTo?: string;
};

const NOTE_MAX = 500;

/**
 * Buton → dialog de confirmare → POST → toast + refresh. Înlocuiește
 * confirm()/prompt() din paginile de admin. Erorile rămân în dialog.
 */
export function ActionDialog(props: ActionDialogProps) {
  const t = useTranslations("adminConsole.common");
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noteMissing = Boolean(props.note?.required) && note.trim() === "";

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(props.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(props.body ? props.body(note.trim()) : { note: note.trim() || undefined }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(props.errors?.[data.error ?? ""] ?? t("errorStatus", { status: res.status }));
        return;
      }
      setOpen(false);
      setNote("");
      toast({ title: props.successMessage, tone: "success" });
      if (props.redirectTo) router.push(props.redirectTo);
      router.refresh();
    } catch {
      setError(t("errorNetwork"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setError(null);
      }}
      title={props.title}
      description={props.description}
      trigger={
        <Button variant={props.variant ?? "secondary"} size={props.size ?? "sm"} disabled={props.disabled}>
          {props.label}
        </Button>
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button
            variant={props.variant === "danger" ? "danger" : "primary"}
            onClick={submit}
            loading={busy}
            disabled={noteMissing}
          >
            {props.confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {props.children}
        {props.note ? (
          <Field label={props.note.label} required={props.note.required}>
            {(f) => (
              <Textarea
                {...f}
                rows={3}
                maxLength={NOTE_MAX}
                value={note}
                placeholder={props.note?.placeholder}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </Field>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
