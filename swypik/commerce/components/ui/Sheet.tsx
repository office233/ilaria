"use client";

import type { ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva } from "class-variance-authority";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/ui/cn";
import { IconButton } from "./IconButton";

const sheetVariants = cva(
  "fixed z-overlay flex flex-col bg-elevated text-fg shadow-elev-3 focus:outline-none",
  {
    variants: {
      side: {
        bottom:
          "inset-x-0 bottom-0 mx-auto max-h-[90dvh] w-full max-w-lg animate-sheet-in-bottom rounded-t-sheet pb-safe-b",
        left: "inset-y-0 left-0 h-dvh w-[88%] max-w-sm animate-sheet-in-left pb-safe-b pt-safe-t",
        right: "inset-y-0 right-0 h-dvh w-[88%] max-w-sm animate-sheet-in-right pb-safe-b pt-safe-t",
      },
    },
    defaultVariants: { side: "bottom" },
  },
);

export type SheetSide = "bottom" | "left" | "right";

export type SheetProps = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Element care deschide sheet-ul (opțional dacă e controlat). Primește `asChild`. */
  trigger?: ReactNode;
  /** Titlu vizibil + nume accesibil (obligatoriu pentru cititoarele de ecran). */
  title: ReactNode;
  /** Ascunde titlul vizual, dar îl păstrează pentru cititoarele de ecran. */
  hideTitle?: boolean;
  description?: ReactNode;
  side?: SheetSide;
  /** Conținut fix sub zona scrollabilă (ex. butoane de acțiune). */
  footer?: ReactNode;
  /** Înlocuiește header-ul standard (titlul rămâne ca nume accesibil). */
  header?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
};

/**
 * Sheet (Radix Dialog): bottom sheet pe mobil sau sertar lateral (left/right).
 * Închidere cu Escape, click pe fundal, butonul X; focus-ul e captat în interior.
 */
export function Sheet({
  open,
  onOpenChange,
  trigger,
  title,
  hideTitle = false,
  description,
  side = "bottom",
  footer,
  header,
  className,
  bodyClassName,
  children,
}: SheetProps) {
  const t = useTranslations("ui");
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger> : null}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-overlay animate-fade-in bg-overlay/50 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          className={cn(sheetVariants({ side }), className)}
          {...(description ? {} : { "aria-describedby": undefined })}
        >
          {side === "bottom" ? (
            <div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-fg/15" />
          ) : null}
          {header ? (
            <>
              <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
              {header}
            </>
          ) : (
            <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-2 pt-3">
              <DialogPrimitive.Title className={cn("text-lg font-semibold text-fg", hideTitle && "sr-only")}>
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Close asChild>
                <IconButton label={t("close")} size="md" className="-mr-2">
                  <X aria-hidden />
                </IconButton>
              </DialogPrimitive.Close>
            </div>
          )}
          {description ? (
            <DialogPrimitive.Description className="px-4 pb-2 text-sm text-muted">{description}</DialogPrimitive.Description>
          ) : null}
          <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4", bodyClassName)}>{children}</div>
          {footer ? <div className="shrink-0 border-t border-subtle px-4 py-3">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Buton care închide sheet-ul/dialogul părinte (pentru acțiuni din footer). */
export const SheetClose = DialogPrimitive.Close;
