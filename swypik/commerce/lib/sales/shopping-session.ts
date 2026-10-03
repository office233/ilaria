export type FunnelStage = "discover" | "compare" | "consider" | "cart" | "checkout" | "upsell";
export type ObjectionType = "price" | "trust" | "delivery" | "choice" | "none";

export type ShoppingSession = {
  budget?: number;
  budgetLabel?: string;
  recipient?: string;
  style?: string;
  occasion?: string;
  category?: string;
  priceSensitivity?: "low" | "medium" | "high";
  mode?: "gift" | "budget" | "premium" | "fashion" | "home" | "beauty" | "general";
  funnelStage?: FunnelStage;
  objection?: ObjectionType;
  lastIntent?: string;
};

function normalize(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function extractBudget(message: string) {
  const normalized = normalize(message);
  const patterns = [
    /(?:sub|pana la|maxim|buget|in jur de)\s*(\d{2,5})/i,
    /(\d{2,5})\s*(?:lei|ron)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return Number(match[1]);
  }

  return undefined;
}

function detectRecipient(message: string) {
  const m = normalize(message);
  if (m.includes("iubita") || m.includes("sotie") || m.includes("partenera")) return "iubită/parteneră";
  if (m.includes("mama") || m.includes("mamei")) return "mamă";
  if (m.includes("tata") || m.includes("tatalui")) return "tată";
  if (m.includes("barbat") || m.includes("baiat") || m.includes("iubit") || m.includes("sot")) return "bărbat";
  if (m.includes("femeie") || m.includes("fata") || m.includes("prietena")) return "femeie";
  if (m.includes("copil") || m.includes("copii")) return "copil";
  return undefined;
}

function detectStyle(message: string) {
  const m = normalize(message);
  if (m.includes("elegant") || m.includes("lux") || m.includes("premium")) return "elegant / premium";
  if (m.includes("casual") || m.includes("zilnic")) return "casual";
  if (m.includes("sport") || m.includes("fitness")) return "sport";
  if (m.includes("minimal") || m.includes("simplu")) return "minimalist";
  if (m.includes("sexy") || m.includes("atragator")) return "atrăgător";
  return undefined;
}

function detectOccasion(message: string) {
  const m = normalize(message);
  if (m.includes("cadou")) return "cadou";
  if (m.includes("nunta") || m.includes("botez") || m.includes("eveniment")) return "eveniment";
  if (m.includes("birou") || m.includes("office")) return "birou";
  if (m.includes("vacanta") || m.includes("plaja")) return "vacanță";
  if (m.includes("zi de nastere") || m.includes("aniversare")) return "aniversare";
  return undefined;
}

function detectCategory(message: string) {
  const m = normalize(message);
  if (m.includes("rochie") || m.includes("haine") || m.includes("tricou") || m.includes("outfit")) return "fashion";
  if (m.includes("bijuter") || m.includes("colier") || m.includes("bratara") || m.includes("inel")) return "bijuterii";
  if (m.includes("beauty") || m.includes("skincare") || m.includes("machiaj") || m.includes("crema")) return "beauty";
  if (m.includes("casa") || m.includes("bucatarie") || m.includes("decor")) return "casă";
  if (m.includes("telefon") || m.includes("casti") || m.includes("gadget")) return "tech";
  return undefined;
}

function detectMode(session: ShoppingSession): ShoppingSession["mode"] {
  if (session.occasion === "cadou") return "gift";
  if (session.budget && session.budget <= 120) return "budget";
  if (session.style?.includes("premium") || (session.budget && session.budget >= 300)) return "premium";
  if (session.category === "fashion" || session.category === "bijuterii") return "fashion";
  if (session.category === "beauty") return "beauty";
  if (session.category === "casă") return "home";
  return "general";
}

function detectPriceSensitivity(message: string, budget?: number): ShoppingSession["priceSensitivity"] {
  const m = normalize(message);
  if (m.includes("ieftin") || m.includes("buget") || m.includes("sub") || m.includes("scump") || (budget && budget <= 100)) return "high";
  if (m.includes("premium") || m.includes("lux") || (budget && budget >= 300)) return "low";
  return "medium";
}

function detectObjection(message: string): ObjectionType {
  const m = normalize(message);
  if (m.includes("scump") || m.includes("prea mult") || m.includes("ieftin") || m.includes("buget")) return "price";
  if (m.includes("sigur") || m.includes("teapa") || m.includes("incredere") || m.includes("calitate")) return "trust";
  if (m.includes("livrare") || m.includes("ajunge") || m.includes("transport")) return "delivery";
  if (m.includes("nu stiu") || m.includes("nu ma decid") || m.includes("care") || m.includes("aleg")) return "choice";
  return "none";
}

function detectFunnelStage(message: string, previous?: FunnelStage): FunnelStage {
  const m = normalize(message);
  if (m.includes("checkout") || m.includes("finalizeaza") || m.includes("platesc") || m.includes("comanda")) return "checkout";
  if (m.includes("adauga") || m.includes("pune") || m.includes("cos") || m.includes("cumpar") || m.includes("iau")) return "cart";
  if (m.includes("mai ieftin") || m.includes("alternativa") || m.includes("compar") || m.includes("diferenta")) return "compare";
  if (m.includes("imi place") || m.includes("pare bun") || m.includes("asta") || m.includes("merita")) return "consider";
  if (previous === "cart") return "upsell";
  return previous || "discover";
}

export function updateShoppingSession(previous: ShoppingSession = {}, message: string, lastIntent?: string): ShoppingSession {
  const budget = extractBudget(message) ?? previous.budget;
  const objection = detectObjection(message);

  const next: ShoppingSession = {
    ...previous,
    budget,
    recipient: detectRecipient(message) ?? previous.recipient,
    style: detectStyle(message) ?? previous.style,
    occasion: detectOccasion(message) ?? previous.occasion,
    category: detectCategory(message) ?? previous.category,
    priceSensitivity: detectPriceSensitivity(message, budget) ?? previous.priceSensitivity,
    objection: objection !== "none" ? objection : previous.objection,
    lastIntent: lastIntent || previous.lastIntent,
  };

  next.budgetLabel = budget ? `maxim ${budget} lei` : previous.budgetLabel;
  next.mode = detectMode(next);
  next.funnelStage = detectFunnelStage(message, previous.funnelStage);

  return next;
}

export function buildSessionPrompt(session: ShoppingSession) {
  const parts = [
    session.mode ? `mod vânzare: ${session.mode}` : null,
    session.funnelStage ? `etapă funnel: ${session.funnelStage}` : null,
    session.objection && session.objection !== "none" ? `obiecție activă: ${session.objection}` : null,
    session.budgetLabel ? `buget: ${session.budgetLabel}` : null,
    session.recipient ? `pentru: ${session.recipient}` : null,
    session.style ? `stil: ${session.style}` : null,
    session.occasion ? `ocazie: ${session.occasion}` : null,
    session.category ? `categorie: ${session.category}` : null,
    session.priceSensitivity ? `sensibilitate preț: ${session.priceSensitivity}` : null,
  ].filter(Boolean);

  if (parts.length === 0) return "Nu există încă preferințe clare. Pune întrebări scurte pentru a califica intenția.";
  return `Context client: ${parts.join("; ")}. Dacă există obiecție de preț, oferă alternativă sau bundle mai accesibil. Dacă etapa este cart/upsell, recomandă complementar. Folosește acest context pentru recomandări, bundle-uri și CTA-uri.`;
}
