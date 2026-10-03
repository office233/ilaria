"use client";

import type { ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/ui/cn";
import { IconButton } from "./IconButton";

export type DialogProps = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Butoanele de acțiune (aliniate la dreapta; pe mobil pe toată lățimea). */
  footer?: ReactNode;
  /** Ascunde butonul X (ex. confirmări care cer o alegere explicită). */
  hideClose?: boolean;
  className?: string;
  children?: ReactNode;
};

/**
 * Dialog modal centrat (Radix): confirmări, formulare scurte. Pentru liste lungi
 * sau acțiuni pe mobil preferă <Sheet side="bottom">.
 */
export function Dialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  footer,
  hideClose = false,
  className,
  children,
}: DialogProps) {
  const t = useTranslations("ui");
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger> : null}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-overlay animate-fade-in bg-overlay/50 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-overlay flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 animate-scale-in flex-col rounded-sheet bg-elevated p-5 text-fg shadow-elev-3 focus:outline-none",
            className,
          )}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          <div className="flex items-start justify-between gap-3">
            <DialogPrimitive.Title className="text-lg font-semibold leading-tight">{title}</DialogPrimitive.Title>
            {hideClose ? null : (
              <DialogPrimitive.Close asChild>
                <IconButton label={t("close")} size="sm" className="-mr-1 -mt-1">
                  <X aria-hidden />
                </IconButton>
              </DialogPrimitive.Close>
            )}
          </div>
          {description ? (
            <DialogPrimitive.Description className="mt-1 text-sm text-muted">{description}</DialogPrimitive.Description>
          ) : null}
          {children ? <div className="mt-4 min-h-0 overflow-y-auto">{children}</div> : null}
          {footer ? (
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{footer}</div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export const DialogClose = DialogPrimitive.Close;
