/**
 * Cheia de oraș insensibilă la diacritice/majuscule: „București”, „Bucuresti”
 * și „ BUCUREȘTI ” → „bucuresti”.
 *
 * Oglinda JS a coloanei generate `local_merchants.city_key`
 * (migrarea 20260926_0033: lower(btrim(translate(location_city, …)))).
 */
export function cityKey(input: string | null | undefined): string {
  return (input ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase();
}
