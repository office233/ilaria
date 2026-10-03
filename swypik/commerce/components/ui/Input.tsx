import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/ui/cn";

/** Clasele comune pentru câmpuri (input, textarea, select). */
export const fieldClasses =
  "w-full rounded-control border border-subtle bg-surface px-3.5 text-base text-fg placeholder:text-subtle transition-colors duration-fast focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger/25";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  /** Iconiță în stânga (lucide, 16–20px). */
  leadingIcon?: ReactNode;
  trailing?: ReactNode;
};

/** Input simplu (16px text → fără zoom pe iOS, 44px înălțime). */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, leadingIcon, trailing, ...props },
  ref,
) {
  if (!leadingIcon && !trailing) {
    return <input ref={ref} className={cn(fieldClasses, "h-11", className)} {...props} />;
  }
  return (
    <div className="relative flex items-center">
      {leadingIcon ? (
        <span className="pointer-events-none absolute left-3 flex text-subtle [&_svg]:h-4 [&_svg]:w-4">{leadingIcon}</span>
      ) : null}
      <input
        ref={ref}
        className={cn(fieldClasses, "h-11", leadingIcon && "pl-10", trailing && "pr-11", className)}
        {...props}
      />
      {trailing ? <span className="absolute right-1 flex">{trailing}</span> : null}
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(fieldClasses, "min-h-24 py-2.5", className)} {...props} />;
  },
);

export type FieldProps = {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  /** Primește id-ul generat și atributele aria pentru control. */
  children: (field: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode;
};

/** Etichetă + control + hint/eroare, legate corect prin id/aria. */
export function Field({ label, hint, error, required, className, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        {label}
        {required ? <span className="ml-0.5 text-danger" aria-hidden>*</span> : null}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint && !error ? <p id={hintId} className="text-xs text-muted">{hint}</p> : null}
      {error ? <p id={errorId} className="text-xs font-medium text-danger">{error}</p> : null}
    </div>
  );
}

export type TextFieldProps = InputProps & { label: ReactNode; hint?: ReactNode; error?: ReactNode };

/** Scurtătură: <Field> + <Input>. */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, required, className, ...props },
  ref,
) {
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className}>
      {(field) => <Input ref={ref} required={required} {...field} {...props} />}
    </Field>
  );
});
