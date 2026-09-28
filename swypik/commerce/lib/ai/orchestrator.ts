import type { ShoppingSession } from "@/lib/sales/shopping-session";
import { buildSessionPrompt } from "@/lib/sales/shopping-session";
import { getCategories } from "@/lib/db/product-queries";
import { chatJson, isAzureChatConfigured, type ChatMessage } from "./azure";
import { OrchestratorOutputSchema } from "./orchestrator-schema";
import { logger } from "@/lib/logger";

const log = logger.child({ service: "ai-orchestrator" });


// ─── Dynamic category cache (60s TTL + force refresh) ───
let cachedCategories: { name: string; nameEn: string; count: number }[] = [];
let categoryCacheTime = 0;
const CATEGORY_CACHE_TTL = 60 * 1000; // 60 seconds — picks up new products fast

async function loadCategories(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedCategories.length > 0 && now - categoryCacheTime < CATEGORY_CACHE_TTL) return cachedCategories;
  try {
    const cats = await getCategories();
    cachedCategories = cats.filter((c: any) => c.count > 0).map((c: any) => ({ name: c.name, nameEn: c.nameEn, count: c.count }));
    categoryCacheTime = now;
    log.info({ count: cachedCategories.length }, "categories loaded from DB");
  } catch (e) {
    log.error({ err: e }, "categories failed to load");
  }
  return cachedCategories;
}

// Export for external force-refresh (e.g., after product import)
export async function refreshCategoryCache() {
  return loadCategories(true);
}

// Get list of populated categories (count > 0) for smart routing
function getPopulatedCategoryNames(categories: { nameEn: string; count: number }[]): string[] {
  return categories.filter(c => c.count > 50).map(c => c.nameEn);
}

function buildCategoryPrompt(categories: { name: string; nameEn: string; count: number }[]) {
  // Limit to top 120 by count to stay under model context window (gpt-5-mini = 128k)
  const top = [...categories].sort((a, b) => b.count - a.count).slice(0, 120);
  return top.map((c, i) => `${i + 1}. ${c.nameEn} (${c.count.toLocaleString()} produse)`).join("\n");
}

export type ChatIntent = "search_product" | "explain_product" | "compare_products" | "find_cheaper" | "refine_search" | "add_to_cart" | "checkout" | "track_order" | "general_chat";
export type OrchestratorResult = { intent: ChatIntent; reply: string; searchQuery?: string; category?: string; bundleQueries?: string[]; productId?: string; productTitle?: string; shouldAskFollowUp?: boolean; maxPrice?: number; sort?: "recommended" | "price_asc" | "price_desc" | "popular" | "delivery" | "discount"; excludeIds?: string[] };

const SYSTEM_PROMPT_TEMPLATE = `You are the AI sales agent for Swypik, an online store.

Objective: turn conversations into clear recommendations, smart bundles, and cart additions.

AVAILABLE CATEGORIES FROM DATABASE:
{{CATEGORIES}}

You MUST pick the best matching category from the list above for EVERY search.
If the user asks for something specific (e.g. "setup gaming"), pick the closest category (e.g. "Computer & Office").
If the user asks for something that spans multiple categories, pick the most relevant one.
If unsure, leave category empty and let the search engine handle it.

CRITICAL RULES:
- searchQuery MUST be in ENGLISH (product titles are in English).
- Romanian to English examples:
  * "haine de barbati" -> "men shirt jacket pants hoodie"
  * "rochie" -> "dress women"
  * "bijuterii" -> "necklace ring bracelet earrings"
  * "cadou" -> "gift set"
  * "sub 100 lei" -> add maxPrice: 100
  * "ceas" -> "watch men women"
  * "geanta" -> "handbag bag purse women"
  * "pantofi" -> "shoes heels boots"
  * "decoratiuni casa" -> "home decor decoration"
  * "jucarii copii" -> "toys kids children"
  * "animale" -> "pet dog cat"
  * "cosmetice" -> "makeup skincare beauty"
  * "sport fitness" -> "sportswear gym yoga leggings"
  * "electronice" -> "electronics smart gadget"
  * "husa telefon" -> "phone case cover"
  * "scule unelte" -> "tools hardware"
  * "piese auto" -> "car parts accessories"
  * "laptop" -> "laptop tablet computer accessories"
- reply MUST be in Romanian, warm, direct, like a sales consultant.
- Do NOT mention suppliers, wholesalers, or scraping.
- Do NOT invent exact stock numbers, real reviews, or guaranteed discounts.
- Build bundles: main product + 1-2 complementary products.
- If user says something is too expensive: intent=find_cheaper, sort=price_asc, maxPrice.

Style: 3-5 sentences. Moderate emojis. End with CTA.

IMPORTANT CONVERSATION RULES:
- If user says "nu-mi place", "altceva", "altele", "alte optiuni", "nu asta", "schimba" → intent=refine_search, reuse the SAME searchQuery but different results
- If user says "mai mare", "mai mic", "alta culoare", "alt stil" → intent=refine_search, adjust searchQuery
- If user references previous products ("primul", "al doilea", "ala rosu") → use productContext to identify
- REMEMBER the conversation context — what user liked/disliked, their budget, style preferences
- When refining, acknowledge what they didn't like and explain how the new results are different

Return ONLY valid JSON, no markdown:
{
  "intent": "search_product|explain_product|compare_products|find_cheaper|refine_search|add_to_cart|checkout|track_order|general_chat",
  "reply": "sales response IN ROMANIAN",
  "searchQuery": "ENGLISH search query for products",
  "category": "exact category name from the database list above, or empty string if unknown",
  "bundleQueries": ["complementary English query 1", "complementary English query 2"],
  "productId": "product id if clear",
  "productTitle": "product title/fragment if clear",
  "maxPrice": 100,
  "sort": "price_asc|recommended|price_desc|popular|delivery|discount",
  "shouldAskFollowUp": true
}`;

function detectCheaperIntent(message: string, hasProductContext: boolean) {
  const msg = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // Strong cheaper signals — always trigger
  if (/scump|prea mult|mai ieftin|ieftin|alternativa|alternative/.test(msg)) return true;
  // Budget signals (sub X, maxim X) — only trigger if user already has product context
  // BUT NOT if user is clearly switching to a new category/topic
  const categorySwitch = /gaming|setup|monitor|tastatura|laptop|bijuterii|ceas|geanta|pantofi|copii|jucarii|animale|caine|pisica|sport|fitness|auto|cosmetice|telefon|birou|scule|electronice|apartament|kit/.test(msg);
  if (hasProductContext && !categorySwitch && /buget|sub\s*\d+|maxim\s*\d+|pana la\s*\d+/.test(msg)) return true;
  return false;
}

function detectCompareIntent(message: string) {
  const msg = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return /compar|compara|versus|vs|diferenta|diferente|asta sau|care e mai|primele 2|top 2/.test(msg);
}

function detectRefineIntent(message: string) {
  const msg = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return /nu-mi place|nu imi place|altceva|altele|alte optiuni|nu asta|schimba|diferit|mai mare|mai mic|alta culoare|alt stil|alt model|nu vreau|arata altele|mai arata|alte variante|nu e ce cautam/.test(msg);
}

function extractMaxPrice(message: string, productContext: any[] = []) {
  const msg = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const explicit = msg.match(/(?:sub|maxim|pana la)\s*(\d{2,5})/) || msg.match(/(\d{2,5})\s*(?:lei|ron)/);
  if (explicit?.[1]) return Number(explicit[1]);
  const prices = productContext.map((p) => Number(p.price)).filter((n) => Number.isFinite(n) && n > 0);
  if (prices.length) return Math.max(50, Math.floor(Math.min(...prices) * 0.8));
  return undefined;
}

// Map Romanian search terms to English for PostgreSQL search
const RO_TO_EN: Record<string, string> = {
  "haine": "clothing",
  "rochie": "dress",
  "rochii": "dress",
  "pantaloni": "pants trousers",
  "tricou": "t-shirt tee",
  "camasa": "shirt",
  "jacheta": "jacket",
  "geaca": "jacket coat",
  "pulover": "sweater pullover",
  "hanorac": "hoodie sweatshirt",
  "fusta": "skirt",
  "bluza": "blouse top",
  "palton": "coat overcoat",
  "ceas": "watch",
  "bratara": "bracelet",
  "colier": "necklace",
  "cercei": "earrings",
  "inel": "ring",
  "incaltaminte": "shoes",
  "pantofi": "shoes heels",
  "adidasi": "sneakers sports shoes",
  "ghiozdan": "backpack bag",
  "geanta": "handbag bag purse",
  "portofel": "wallet",
  "cadou": "gift set",
  "jucarie": "toy",
  "jucarii": "toys",
  "decoratiuni": "decoration home decor",
  "lampa": "lamp light",
  "perna": "pillow cushion",
  "cana": "mug cup",
  "telefon": "phone case cover",
  "casti": "headphones earbuds",
  "cablu": "cable charger",
  "sport": "sports fitness gym",
  "yoga": "yoga leggings sports",
  "barbati": "men",
  "femei": "women",
  "copii": "kids children",
  // Gaming & Tech
  "gaming": "gaming",
  "setup": "keyboard",
  "tastatura": "keyboard",
  "monitor": "monitor",
  "mouse": "mouse",
  "birou": "desk",
  "lumini": "led light",
  "pc": "computer",
  "calculator": "computer",
  "consola": "gamepad",
};

function translateQuery(query: string): string {
  const words = query.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/\s+/);
  const translated = words.map(w => RO_TO_EN[w] || w);
  return translated.join(" ");
}

function cleanCheaperQuery(message: string) {
  const cleaned = message
    .replace(/prea scump/gi, "")
    .replace(/mai ieftin/gi, "")
    .replace(/ieftin/gi, "")
    .replace(/buget/gi, "")
    .replace(/alternative?/gi, "")
    .replace(/sub\s*\d{2,5}/gi, "")
    .replace(/maxim\s*\d{2,5}/gi, "")
    .replace(/pana la\s*\d{2,5}/gi, "")
    .replace(/\d{2,5}\s*(lei|ron)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return translateQuery(cleaned);
}

export async function orchestrate(userMessage: string, chatHistory: { role: "user" | "assistant"; content: string }[] = [], productContext: any[] = [], shoppingSession: ShoppingSession = {}): Promise<OrchestratorResult> {
  const hasProductContext = productContext.length > 0;
  const hardCheaper = detectCheaperIntent(userMessage, hasProductContext);
  const hardMaxPrice = extractMaxPrice(userMessage, productContext);

  // ─── COMPARE DETECTION ───
  const hardCompare = detectCompareIntent(userMessage);
  if (hardCompare && hasProductContext && productContext.length >= 2) {
    const p1 = productContext[0];
    const p2 = productContext[1];
    const winner = (p1.rating || 0) > (p2.rating || 0) ? p1 : (p1.price || 999) < (p2.price || 999) ? p1 : p2;
    return {
      intent: "compare_products",
      reply: `⚖️ **Comparație rapidă:**\n\n` +
        `**1. ${p1.title?.slice(0, 50)}**\n` +
        `   💰 ${p1.price} lei | ⭐ ${p1.rating || '?'} | 📦 ${p1.orders || 0}+ comenzi\n\n` +
        `**2. ${p2.title?.slice(0, 50)}**\n` +
        `   💰 ${p2.price} lei | ⭐ ${p2.rating || '?'} | 📦 ${p2.orders || 0}+ comenzi\n\n` +
        `🏆 **Recomandare AI:** ${winner.title?.slice(0, 40)} — ${winner === p1 ? 'preț/calitate mai bun' : 'raport calitate-preț superior'}. Vrei să-l adaugi în coș?`,
      productId: winner.id,
      productTitle: winner.title,
      shouldAskFollowUp: true,
    };
  }

  if (hardCheaper) {
    const baseQuery = cleanCheaperQuery(userMessage) || productContext[0]?.category || translateQuery(userMessage);
    return {
      intent: "find_cheaper",
      reply: `Da, schimb strategia pe variante mai accesibile. ${hardMaxPrice ? `Ma tin de maxim ${hardMaxPrice} lei.` : "Iti arat alternative cu pret mai bun."} 🔥`,
      searchQuery: baseQuery,
      bundleQueries: [`${baseQuery} accessories`, `${baseQuery} gift`, `${baseQuery} set`],
      maxPrice: hardMaxPrice,
      sort: "price_asc",
      shouldAskFollowUp: false,
    };
  }

  // ─── REFINE DETECTION ("nu-mi place", "altceva", etc.) ───
  const hardRefine = detectRefineIntent(userMessage);
  if (hardRefine && productContext.length > 0) {
    const lastCategory = productContext[0]?.category;
    const lastQuery = productContext[0]?.title?.split(" ").slice(0, 3).join(" ") || lastCategory || "";
    const translatedLastQuery = translateQuery(lastQuery);
    return {
      intent: "refine_search",
      reply: `Am înțeles, îți arăt variante diferite! 🔄 Caut alte opțiuni care s-ar potrivi mai bine gusturilor tale.`,
      searchQuery: translatedLastQuery || translateQuery(userMessage),
      excludeIds: productContext.map((p: any) => String(p.id)),
      shouldAskFollowUp: true,
    };
  }

  const categories = await loadCategories();
  if (!isAzureChatConfigured()) return fallbackOrchestrate(userMessage, productContext, shoppingSession, categories);

  try {
    const contextSummary = productContext.slice(0, 10).map((p) => ({ id: p.id, title: p.title, price: p.price, category: p.category, rating: p.rating, orders: p.orders }));
    const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace("{{CATEGORIES}}", buildCategoryPrompt(categories));
    const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }, { role: "system", content: buildSessionPrompt(shoppingSession) }, ...chatHistory.slice(-10)];
    if (contextSummary.length) messages.push({ role: "system", content: `Products in context: ${JSON.stringify(contextSummary)}` });
    messages.push({ role: "user", content: userMessage });
    const { data: result } = await chatJson(messages, {
      feature: "shop-chat",
      schema: OrchestratorOutputSchema,
      schemaName: "shop_assistant_reply",
      maxCompletionTokens: 1500,
    });
    return { intent: result.intent || "general_chat", reply: result.reply || "Spune-mi ce cauti si iti aleg rapid varianta potrivita.", searchQuery: result.searchQuery, category: result.category || undefined, bundleQueries: (result.bundleQueries ?? []).slice(0, 3), productId: result.productId, productTitle: result.productTitle, maxPrice: result.maxPrice, sort: result.sort, shouldAskFollowUp: Boolean(result.shouldAskFollowUp), excludeIds: result.intent === "refine_search" ? productContext.map((p: any) => String(p.id)) : undefined };
  } catch (error) {
    logger.error({ err: error }, "[AI Orchestrator] Error");
    return fallbackOrchestrate(userMessage, productContext, shoppingSession, categories);
  }
}

function fallbackOrchestrate(message: string, productContext: any[] = [], shoppingSession: ShoppingSession = {}, categories: { name: string; nameEn: string; count: number }[] = []): OrchestratorResult {
  const msg = message.toLowerCase().trim();
  const msgNorm = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const firstProduct = productContext[0];

  // ─── Intent keywords ───
  const cartKeywords = ["adauga", "adaugă", "pune", "cos", "coș", "cumpar", "cumpăr", "iau", "vreau asta"];
  const checkoutKeywords = ["checkout", "finalizeaza", "finalizează", "platesc", "plătesc", "comanda", "comandă"];
  const greetKeywords = ["salut", "buna", "bună", "hello", "hey", "servus"];

  if (cartKeywords.some((k) => msg.includes(k))) return { intent: "add_to_cart", reply: firstProduct ? `Perfect 🛒 Iti pun ${firstProduct.title} in cos. Iti recomand sa il iei cu inca un produs complementar.` : "Sigur 🛒 Alege produsul dorit si il punem imediat in cos.", productId: firstProduct?.id, productTitle: firstProduct?.title };
  if (checkoutKeywords.some((k) => msg.includes(k))) return { intent: "checkout", reply: "Perfect. Hai sa finalizam comanda cat mai simplu 🛒" };
  if (greetKeywords.some((k) => msg.includes(k))) {
    const topCats = getPopulatedCategoryNames(categories).slice(0, 3).join(", ") || "haine, accesorii";
    return { intent: "general_chat", reply: `Salut! ✨ Sunt asistentul tău de shopping. Avem produse în: ${topCats}. Spune-mi ce cauți și îți găsesc cele mai bune oferte!`, shouldAskFollowUp: true };
  }

  // ─── Smart category detection from DB categories ───
  const RO_CAT_HINTS: Record<string, string[]> = {
    "gaming": ["Computer"], "setup": ["Computer"], "pc": ["Computer"], "laptop": ["Computer"],
    "tastatura": ["Computer"], "mouse": ["Computer"], "monitor": ["Computer"],
    "rochie": ["Women"], "fusta": ["Women"], "bluza": ["Women"], "haine": ["Women", "Men"],
    "barbati": ["Men"], "camasa": ["Men"],
    "bijuterii": ["Jewelry"], "ceas": ["Jewelry", "Watch"],
    "geanta": ["Bag"], "pantofi": ["Shoe", "Bag"],
    "casa": ["Home", "Garden"], "bucatarie": ["Home"],
    "copii": ["Toy", "Kid", "Bab"], "jucarii": ["Toy"],
    "animale": ["Pet"], "pisica": ["Pet"], "caine": ["Pet"],
    "sport": ["Sport"], "fitness": ["Sport"],
    "masina": ["Automobile"], "auto": ["Automobile"],
    "telefon": ["Phone"], "husa": ["Phone"],
    "electronice": ["Electronic", "Consumer"],
    "cosmetice": ["Beauty", "Health"],
    "scule": ["Improvement"], "unelte": ["Improvement"],
  };
  let matchedCategory: string | undefined;
  for (const [keyword, hints] of Object.entries(RO_CAT_HINTS)) {
    if (msgNorm.includes(keyword)) {
      const dbCat = categories.find(c => hints.some(h => c.nameEn.includes(h)));
      if (dbCat) { matchedCategory = dbCat.nameEn; break; }
    }
  }

  // ─── Handle ambiguous queries ("vreau ceva frumos", "ce imi recomanzi") ───
  const isVague = /ceva|frumos|bun|recomanzi|recomanda|popular|trending|ce ai|ce aveti|orice|surprinde/.test(msgNorm);
  const hasSpecificKeyword = Object.keys(RO_CAT_HINTS).some(k => msgNorm.includes(k));

  if (isVague && !hasSpecificKeyword && !matchedCategory) {
    const topCat = categories.length > 0 ? categories[0] : null;
    const topCatNames = getPopulatedCategoryNames(categories).slice(0, 4).join(", ");
    return {
      intent: "search_product",
      reply: `Am înțeles! 🔥 Îți arăt cele mai populare produse ale noastre. Avem categorii ca: ${topCatNames}. Spune-mi dacă vrei ceva anume!`,
      searchQuery: "",
      category: topCat?.nameEn,
      sort: "popular",
      shouldAskFollowUp: true,
    };
  }

  // ─── Translate & build search query ───
  const cleanedMsg = message
    .replace(/sub\s*\d{2,5}/gi, "").replace(/maxim\s*\d{2,5}/gi, "")
    .replace(/pana la\s*\d{2,5}/gi, "").replace(/\d{2,5}\s*(lei|ron)/gi, "")
    .replace(/complet/gi, "").replace(/vreau|caut|arat|arata/gi, "")
    .replace(/\s+/g, " ").trim();
  const translatedQuery = translateQuery(cleanedMsg || message);
  const maxPriceMatch = message.match(/(?:sub|maxim|pana la)\s*(\d{2,5})/i);
  const maxPrice = maxPriceMatch ? Number(maxPriceMatch[1]) : undefined;
  const budgetText = maxPrice ? ` in bugetul tau de maxim ${maxPrice} lei` : (shoppingSession.budgetLabel ? ` in bugetul tau de ${shoppingSession.budgetLabel}` : "");

  // Smart category-aware reply
  const populated = getPopulatedCategoryNames(categories);
  const categoryIsPopulated = matchedCategory ? populated.includes(matchedCategory) : true;
  let catText = "";
  if (matchedCategory && categoryIsPopulated) {
    catText = ` din categoria ${matchedCategory}`;
  } else if (matchedCategory && !categoryIsPopulated) {
    catText = `. Categoria ${matchedCategory} este în curs de populare`;
  }

  // Smart bundle queries — if category is empty, bundle from populated categories
  let bundleQs: string[];
  if (matchedCategory && categoryIsPopulated) {
    bundleQs = [translatedQuery + " accessories", translatedQuery + " set"];
  } else {
    bundleQs = ["trending popular best seller", "gift set accessories"];
  }

  return {
    intent: "search_product",
    reply: `Perfect, caut variante potrivite${budgetText}${catText} si iti pregatesc idei de bundle. 🔥`,
    searchQuery: translatedQuery,
    category: matchedCategory,
    bundleQueries: bundleQs,
    maxPrice,
    shouldAskFollowUp: true,
  };
}
