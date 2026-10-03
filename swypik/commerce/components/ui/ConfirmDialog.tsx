"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

export type ConfirmOptions = {
  title: ReactNode;
  description?: ReactNode;
  /** Eticheta butonului de confirmare (implicit „Confirmă”). */
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  tone?: "primary" | "danger";
};

export type ConfirmDialogProps = ConfirmOptions & {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Confirmare accesibilă (Radix Dialog: focus prins în dialog, Esc = anulare,
 * titlu + descriere anunțate de cititoarele de ecran). Înlocuiește confirm()
 * nativ, care blochează pagina și nu poate fi tradus/stilizat.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = "primary",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t = useTranslations("ui");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={title}
      description={description}
      hideClose
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {cancelLabel ?? t("cancel")}
          </Button>
          <Button variant={tone} onClick={onConfirm} autoFocus>
            {confirmLabel ?? t("confirm")}
          </Button>
        </>
      }
    />
  );
}

/**
 * Variantă imperativă, drop-in pentru `confirm()`:
 *
 *   const [confirm, confirmDialog] = useConfirm();
 *   if (!(await confirm({ title: t("confirmDelete"), tone: "danger" }))) return;
 *   …
 *   return <>{…}{confirmDialog}</>;
 */
export function useConfirm(): [(opts: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpts(null);
  }, []);

  const confirm = useCallback((next: ConfirmOptions) => {
    // O confirmare nouă o anulează pe cea rămasă deschisă.
    resolver.current?.(false);
    setOpts(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const dialog = (
    <ConfirmDialog
      open={opts !== null}
      title={opts?.title ?? ""}
      description={opts?.description}
      confirmLabel={opts?.confirmLabel}
      cancelLabel={opts?.cancelLabel}
      tone={opts?.tone}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );
  return [confirm, dialog];
}
