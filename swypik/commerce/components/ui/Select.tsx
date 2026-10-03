import { forwardRef, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/ui/cn";
import { fieldClasses } from "./Input";

export type SelectOption = { value: string; label: string; disabled?: boolean };

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> & {
  options: SelectOption[];
  /** Opțiune goală inițială (text tradus), ex. „Alege…”. */
  placeholder?: string;
};

/**
 * Select nativ stilizat — pe mobil deschide pickerul sistemului (cel mai
 * accesibil). Folosește-l cu <Field> pentru etichetă.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, options, placeholder, ...props },
  ref,
) {
  return (
    <div className="relative">
      <select ref={ref} className={cn(fieldClasses, "h-11 appearance-none pr-10", className)} {...props}>
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
    </div>
  );
});
