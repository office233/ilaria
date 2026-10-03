"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/ui/cn";

export type ToastTone = "neutral" | "success" | "danger" | "info";

export type ToastInput = {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** ms; implicit 3500. 0 = rămâne până la închidere. */
  duration?: number;
};

type ToastItem = ToastInput & { id: number };

type ToastApi = { toast: (input: ToastInput) => void; dismiss: (id: number) => void };

const ToastContext = createContext<ToastApi | null>(null);

const TONE_ICON = { neutral: Info, info: Info, success: CheckCircle2, danger: AlertTriangle } as const;
const MAX_VISIBLE = 3;

/** Montat o singură dată în AppShell. Folosește `useToast()` din orice componentă client. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("ui");
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((it) => it.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      setItems((list) => [...list, { ...input, id }].slice(-MAX_VISIBLE));
      const duration = input.duration ?? 3500;
      if (duration > 0) window.setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-relevant="additions"
        className="pointer-events-none fixed inset-x-0 z-toast flex flex-col items-center gap-2 px-gutter"
        style={{ bottom: "calc(var(--bottom-inset) + 12px)" }}
      >
        {items.map((it) => {
          const tone = it.tone ?? "neutral";
          const Icon = TONE_ICON[tone];
          return (
            <div
              key={it.id}
              role={tone === "danger" ? "alert" : "status"}
              className="pointer-events-auto flex w-full max-w-sm animate-scale-in items-start gap-3 rounded-card bg-fg px-4 py-3 text-fg-inverse shadow-elev-3"
            >
              <Icon
                className={cn(
                  "mt-0.5 h-5 w-5 shrink-0",
                  tone === "success" && "text-success",
                  tone === "danger" && "text-danger",
                )}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{it.title}</p>
                {it.description ? <p className="mt-0.5 text-xs opacity-80">{it.description}</p> : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(it.id)}
                aria-label={t("dismiss")}
                className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full opacity-70 hover:opacity-100"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/** `const { toast } = useToast(); toast({ title: t("saved"), tone: "success" })` */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast() trebuie folosit în interiorul <ToastProvider> (AppShell)");
  return ctx;
}
