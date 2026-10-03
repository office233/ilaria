import { redirect } from "next/navigation";

/**
 * Calendarul vechi de seller pentru cazări a fost retras (model unic de gazdă,
 * migrarea 20260926_0051). Gazdele își gestionează listările în /stays/manage.
 */
export default function StaysCalendarPage(): never {
  redirect("/stays/manage");
}
