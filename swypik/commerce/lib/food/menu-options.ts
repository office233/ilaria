/**
 * Validarea opțiunilor alese pentru un articol de meniu — pură, testată.
 * Audit food-go #15: `required` / `max` erau verificate doar în UI.
 *
 * Opțiune: {name, required?, max?, choices:[{id?, name, price_cents?}]}.
 * Id-ul unei alegeri = `id` sau `<opțiune>:<alegere>` (ca în UI); `max` implicit 1.
 */
export type MenuOptionChoice = { id?: string; name: string; price_cents?: number };
export type MenuOption = { name: string; required?: boolean; max?: number; choices?: MenuOptionChoice[] };

export type OptionSelection =
  | { ok: true; extra_cents: number; chosen: { id: string; name: string; price_cents: number }[] }
  | { ok: false; code: "invalid_option" | "option_required" | "option_max"; option?: string };

export function choiceId(option: MenuOption, choice: MenuOptionChoice): string {
  return choice.id ?? `${option.name}:${choice.name}`;
}

export function validateOptionSelection(options: readonly MenuOption[], selectedIds: readonly string[]): OptionSelection {
  if (new Set(selectedIds).size !== selectedIds.length) return { ok: false, code: "invalid_option" };

  const index = new Map<string, { optionIdx: number; choice: MenuOptionChoice; id: string }>();
  // Re-comanda trimite numele alegerii (comenzile vechi nu păstrau id-ul) — acceptat
  // doar dacă numele e unic în meniul articolului.
  const byName = new Map<string, { optionIdx: number; choice: MenuOptionChoice; id: string } | null>();
  options.forEach((o, optionIdx) => {
    for (const c of o.choices ?? []) {
      const id = choiceId(o, c);
      index.set(id, { optionIdx, choice: c, id });
      byName.set(c.name, byName.has(c.name) ? null : { optionIdx, choice: c, id });
    }
  });

  const perOption = new Array<number>(options.length).fill(0);
  const chosen: { id: string; name: string; price_cents: number }[] = [];
  let extra = 0;
  for (const id of selectedIds) {
    const hit = index.get(id) ?? byName.get(id) ?? undefined;
    if (!hit) return { ok: false, code: "invalid_option" };
    perOption[hit.optionIdx] += 1;
    const price = Math.max(0, Math.trunc(hit.choice.price_cents ?? 0));
    extra += price;
    chosen.push({ id: hit.id, name: hit.choice.name, price_cents: price });
  }

  for (let i = 0; i < options.length; i++) {
    const o = options[i];
    if (o.required && (o.choices ?? []).length > 0 && perOption[i] === 0) {
      return { ok: false, code: "option_required", option: o.name };
    }
    const max = o.max ?? 1; // ca în UI (OptionPickerSheet): implicit o singură alegere
    if (perOption[i] > max) return { ok: false, code: "option_max", option: o.name };
  }
  return { ok: true, extra_cents: extra, chosen };
}
