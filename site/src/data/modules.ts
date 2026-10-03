// Single source of truth for every Swypik module shown on the site.
// Facts come from swypik/commerce (lib/nav/modules.ts, lib/feature-flags.ts, lib/config/commerce.ts)
// and ramasite/docs/swypik-commerce. Before changing a claim read ramasite/docs/site/CLAIMS.md.
// Never add: SWYP coin, Swypik Chain, mining/staking, Squad Buy, developer App Store,
// store availability, or user/GMV/catalog metrics.

export type Status = "live" | "beta" | "built" | "dev" | "roadmap";
export type Tone = "violet" | "cyan" | "rose" | "amber" | "ink";
export type CategoryId = "shopping" | "go-food" | "travel" | "entertainment" | "community" | "business" | "account";

export interface Feature { title: string; text: string }

export interface Module {
  slug: string;
  name: string;
  short: string;
  category: CategoryId;
  icon: string;
  tone: Tone;
  status: Status;
  tagline: string;
  summary: string;
  features: Feature[];
  revenue?: string;
  ai?: string;
  screen: string;
}

export const statusMeta: Record<Status, { label: string; hint: string }> = {
  live: { label: "Live on web", hint: "Running in production on swypik.com." },
  beta: { label: "Beta", hint: "Implemented and enabled; flows are being completed and hardened before public launch." },
  built: { label: "Built · launch-gated", hint: "Code complete, held behind a feature flag until its launch gate (partners, providers or review) is met." },
  dev: { label: "In development", hint: "Partially implemented and actively being built." },
  roadmap: { label: "Roadmap", hint: "Designed and specified; implementation has not started." },
};

export const categories: { id: CategoryId; label: string }[] = [
  { id: "shopping", label: "Shopping" },
  { id: "go-food", label: "Go & Food" },
  { id: "travel", label: "Travel" },
  { id: "entertainment", label: "Entertainment" },
  { id: "community", label: "Community" },
  { id: "business", label: "Creators & Business" },
  { id: "account", label: "Money & Account" },
];

export const modules: Module[] = [
  {
    slug: "video-commerce", name: "Swypik", short: "Discover · Swipe · Buy", category: "shopping", icon: "brand", tone: "violet", status: "live",
    tagline: "Video that doesn’t end at “like”.",
    summary: "A vertical short-video feed where products live inside the clip. Watch, open the product, check out — and keep scrolling. Social discovery built around action.",
    features: [
      { title: "A feed that learns", text: "A For You feed ranked from 30+ interaction signals, with seen-video memory and a topic taxonomy so nothing repeats." },
      { title: "Shoppable clips", text: "Products are tagged in the video. One tap opens the product drawer with the Swypik Score (1–99) and the community “Worth it” vote." },
      { title: "Create in the browser", text: "Record or upload, automatic HLS transcoding, AI-suggested captions and hashtags, scheduled publishing." },
      { title: "Safety before reach", text: "Every upload passes a moderation gate before it can be distributed." },
    ],
    revenue: "10% marketplace commission · 5% creator affiliate share on attributed sales",
    ai: "Ranking, moderation and assistance plug into the same event layer — the place where Ilaria joins the product.",
    screen: "feed",
  },
  {
    slug: "shop", name: "Shop", short: "Catalog, cart, checkout", category: "shopping", icon: "bag", tone: "rose", status: "beta",
    tagline: "Every product, one tap from the clip.",
    summary: "A full marketplace behind the feed: search, categories, brand and seller pages, cart and checkout — designed for European consumer law from day one.",
    features: [
      { title: "Search that understands", text: "Autocomplete across products, #hashtags and @creators, with categories and best-of lists." },
      { title: "Cart that follows you", text: "A guest cart merges into your account at login. Prices are always recalculated server-side." },
      { title: "Seller & brand pages", text: "Every seller gets a storefront; verified companies get a blue badge." },
      { title: "EU-ready", text: "14-day return flows, ANPC and EU ODR links built in. Checkout is being validated before public launch." },
    ],
    revenue: "10% platform commission on marketplace sales",
    screen: "shop",
  },
  {
    slug: "live", name: "Live Shopping", short: "Stream, pin, sell", category: "shopping", icon: "live", tone: "rose", status: "beta",
    tagline: "Go live. Pin the product. Sell in real time.",
    summary: "Creators and sellers stream to their audience with products pinned on screen, live chat and polls — commerce at the speed of conversation.",
    features: [
      { title: "Pinned products", text: "Show a product while you talk about it; viewers buy without leaving the stream." },
      { title: "Chat, polls, moderation", text: "Real-time chat with polls and moderator tools for the host." },
      { title: "Live tips", text: "Viewers can tip creators from their wallet (in development)." },
      { title: "Real-time infrastructure", text: "Built on a WebRTC SFU for low-latency streaming at scale." },
    ],
    revenue: "Commission on live sales · live tips",
    screen: "live",
  },
  {
    slug: "listings", name: "Listings", short: "Homes, cars, services", category: "shopping", icon: "tag", tone: "ink", status: "built",
    tagline: "The classifieds layer, with video.",
    summary: "Real estate, vehicles, services and vacation rentals — listed with video, answered with a message, or booked by the hour.",
    features: [
      { title: "Four verticals", text: "Real estate, vehicles, services and vacation rentals on one shared listing engine." },
      { title: "Leads, not checkout", text: "“Contact the seller” turns interest into a conversation instead of forcing a cart." },
      { title: "Hourly bookings", text: "Barbers, clinics and studios publish slots; customers book a time." },
    ],
    screen: "listings",
  },
  {
    slug: "go", name: "Swypik Go", short: "Rides in the city", category: "go-food", icon: "car", tone: "cyan", status: "beta",
    tagline: "Get a car in seconds.",
    summary: "Ride-hailing inside the same app you shop in: a fixed price before you ride, a verified driver and live tracking you can share.",
    features: [
      { title: "Price before you ride", text: "Upfront fare estimates with zones and demand-aware pricing." },
      { title: "Automatic dispatch", text: "Rides are matched automatically and follow a strict, auditable ride state machine." },
      { title: "Live & shareable", text: "Live tracking in the app plus a public link you can send to family." },
      { title: "Built for drivers", text: "Driver panel with online/offline, offers, documents and earnings; card or cash; two-way ratings." },
      { title: "Fleets & franchise", text: "Fleet partners, franchise onboarding, Founding Driver slots and referral codes." },
    ],
    revenue: "20% platform · 80% to the driver",
    screen: "ride",
  },
  {
    slug: "food", name: "Swypik Food", short: "Local delivery", category: "go-food", icon: "food", tone: "cyan", status: "beta",
    tagline: "See the dish in video. Order in one tap.",
    summary: "Local restaurants and shops, shown the way they deserve — in video — with fast delivery and live order tracking.",
    features: [
      { title: "Menus that move", text: "Restaurants present dishes in video, with full menus and a delivery quote before you order." },
      { title: "Track & reorder", text: "Live order tracking and one-tap reorder of your favourites." },
      { title: "Smart courier dispatch", text: "Offers go out in widening waves — 2 → 5 → 10 km — to the nearest available couriers." },
      { title: "For couriers & merchants", text: "Courier earnings, payouts and referrals; self-serve merchant onboarding." },
    ],
    screen: "food",
  },
  {
    slug: "stays", name: "Swypik Stays", short: "Verified hosts", category: "travel", icon: "bed", tone: "cyan", status: "beta",
    tagline: "Final price upfront. Charged only when the host accepts.",
    summary: "Short stays with verified hosts and honest pricing — your card is only charged once the host confirms.",
    features: [
      { title: "Honest quotes", text: "Search by dates and see the final price — no surprises at checkout." },
      { title: "Clear policies", text: "Bookings with explicit cancellation policies and automatic refunds." },
      { title: "Host tools", text: "Host onboarding, listings, availability calendar and seasonal pricing." },
    ],
    revenue: "10% booking commission",
    screen: "stays",
  },
  {
    slug: "fly", name: "Swypik Fly", short: "Flights, honest price", category: "travel", icon: "plane", tone: "cyan", status: "dev",
    tagline: "Plane tickets with the final price shown upfront.",
    summary: "Flight search across providers with a live price check before payment. The waitlist is open; booking launches once provider contracts and legal review are complete.",
    features: [
      { title: "Multi-provider search", text: "Aggregated results from flight-content providers in a single view." },
      { title: "Live price check", text: "The fare is re-confirmed before you pay." },
      { title: "Price watch", text: "Follow a route and get notified when it moves." },
    ],
    screen: "fly",
  },
  {
    slug: "movies", name: "Swypik Movies", short: "Vertical micro-series", category: "entertainment", icon: "film", tone: "violet", status: "built",
    tagline: "Short vertical series you binge in one breath.",
    summary: "Micro-series made for the phone: 9:16 episodes, the first ones free, the rest unlocked — and you can shop what you see in the scene.",
    features: [
      { title: "Made for 9:16", text: "A full-screen vertical player, series catalog and watchlist." },
      { title: "Free to start", text: "First episodes are free; the rest unlock by card, with season discounts." },
      { title: "Shop the scene", text: "Products from the episode are one tap away." },
      { title: "Charts & studio", text: "“Top 10 in Romania” charts and a publisher studio for producers." },
    ],
    revenue: "70% of unlocks to creators",
    screen: "movies",
  },
  {
    slug: "music", name: "Swypik Music", short: "Independent artists", category: "entertainment", icon: "music", tone: "violet", status: "built",
    tagline: "Free listening. Premium tracks unlocked.",
    summary: "A home for independent artists: free streaming, premium tracks unlocked by fans, and every song ready to soundtrack a reel.",
    features: [
      { title: "Artists, albums, playlists", text: "A complete catalog with a persistent mini-player across the app." },
      { title: "Use it in your reel", text: "Any track can become the soundtrack of a creator’s video." },
      { title: "Swypik Originals", text: "Curated originals and direct fan tips." },
    ],
    revenue: "70% of unlocks to artists",
    screen: "music",
  },
  {
    slug: "news", name: "Swypik News", short: "AI-summarized press", category: "entertainment", icon: "news", tone: "violet", status: "built",
    tagline: "The news, summarized by AI — always linked to the source.",
    summary: "Public press sources, summarized by an AI journalist and checked by an editorial workflow. Every story links back to the original article.",
    features: [
      { title: "Four desks", text: "Tech & AI, Gaming, Business and Science." },
      { title: "AI journalist + editor", text: "Feed ingestion and AI summaries go through an editorial review step before publishing." },
      { title: "Transparent by design", text: "Clear AI disclosure and a link to the original source on every story." },
      { title: "Community", text: "Reactions and moderated comments." },
    ],
    ai: "A natural first surface for Ilaria’s Romanian-first language work.",
    screen: "news",
  },
  {
    slug: "arcade", name: "Arcade", short: "Games, trivia, XP", category: "entertainment", icon: "gamepad", tone: "violet", status: "built",
    tagline: "Mini-games, daily trivia and XP for everything you do.",
    summary: "A light game layer across the whole app: play, answer the daily trivia, earn XP for real actions and show your level on your profile.",
    features: [
      { title: "Mini-games & trivia", text: "Instant browser games and a daily trivia round." },
      { title: "XP for real actions", text: "Watching, a first upload or a first purchase all earn XP, with a daily cap." },
      { title: "Levels on profile", text: "Progress is visible on your public profile." },
    ],
    screen: "arcade",
  },
  {
    slug: "messenger", name: "Swypik Messenger", short: "Messages & calls", category: "community", icon: "chat", tone: "rose", status: "built",
    tagline: "Messages and video calls — no phone number needed.",
    summary: "One inbox for friends, groups, sellers, restaurants and drivers. Chat, share and call without ever handing out your phone number.",
    features: [
      { title: "DMs & groups", text: "Direct messages and group chats with admins and members." },
      { title: "Rich messaging", text: "Image attachments, typing and seen indicators, block and report." },
      { title: "Commerce-aware", text: "Contact a seller, restaurant or buyer straight from a product or order." },
      { title: "Audio & video calls", text: "Real-time calls on WebRTC infrastructure (being configured for launch)." },
    ],
    screen: "chat",
  },
  {
    slug: "community", name: "Community", short: "Profiles, follows, posts", category: "community", icon: "users", tone: "rose", status: "beta",
    tagline: "People first. Products follow.",
    summary: "Follow creators, build a public profile, post to the community and bring friends — the social graph the whole ecosystem stands on.",
    features: [
      { title: "Profiles & follows", text: "Public profiles, follows and suggested creators." },
      { title: "Community posts", text: "Arena posts with community voting." },
      { title: "Notifications & referrals", text: "In-app notifications and personal referral links." },
    ],
    screen: "social",
  },
  {
    slug: "cares", name: "Swypik Cares", short: "0% commission giving", category: "community", icon: "heart", tone: "rose", status: "built",
    tagline: "Romanians donate for Romania.",
    summary: "Help a family or a small business with full transparency — and zero commission. Launches together with a partner NGO.",
    features: [
      { title: "Causes & campaigns", text: "Verified causes with clear goals." },
      { title: "Expense transparency", text: "Donors see how funds are used." },
      { title: "0% commission", text: "Swypik takes nothing from donations." },
    ],
    revenue: "0% — a trust feature, not a revenue line",
    screen: "cares",
  },
  {
    slug: "kids", name: "Swypik Kids", short: "Safe by design", category: "community", icon: "baby", tone: "amber", status: "roadmap",
    tagline: "A safe corner for children. Zero tracking. Zero commerce.",
    summary: "Child profiles under the parent’s account with curated content, parental controls and no ads, tracking or shopping.",
    features: [
      { title: "Parent-owned profiles", text: "Child profiles live under the parent’s account." },
      { title: "Controls that matter", text: "Parental PIN, daily time limits and bedtime." },
      { title: "Privacy by law", text: "Designed for GDPR-K and COPPA: no tracking, no commerce." },
    ],
    screen: "kids",
  },
  {
    slug: "missions", name: "Missions", short: "Paid brand briefs", category: "business", icon: "target", tone: "amber", status: "beta",
    tagline: "Paid briefs from brands. Film it, submit, win.",
    summary: "Brands fund a creative brief, creators answer with a clip, the best ones win the prize. Marketing that pays creators directly.",
    features: [
      { title: "Brand-funded", text: "Brands publish briefs with prize pools in RON." },
      { title: "Open to creators", text: "Any creator can film and submit." },
      { title: "Judging & winners", text: "Built-in judging and payouts to winners." },
    ],
    revenue: "Brand-funded mission budgets",
    screen: "missions",
  },
  {
    slug: "creator-studio", name: "Creator Studio", short: "Create & earn", category: "business", icon: "clapper", tone: "amber", status: "beta",
    tagline: "Everything a creator needs to earn.",
    summary: "Apply, upload, analyse and get paid. Creators earn on every sale they drive — not just on views.",
    features: [
      { title: "Upload & manage", text: "Videos, drafts and scheduling in one place." },
      { title: "Analytics", text: "Performance per clip and per product." },
      { title: "Earn on sales", text: "5% of attributed sales, payouts and a monthly creator fund." },
    ],
    revenue: "Creators earn 5% of attributed sales",
    screen: "studio",
  },
  {
    slug: "seller-portal", name: "Seller Portal", short: "POS, ads, integrations", category: "business", icon: "store", tone: "amber", status: "beta",
    tagline: "Run your shop from a phone, a tablet or the till.",
    summary: "A native back-office for sellers: products, orders, invoices and customers — plus a point-of-sale, an AI ads manager and store integrations.",
    features: [
      { title: "Back-office", text: "Products, orders, returns, payouts, invoices and a customer CRM." },
      { title: "Quick Sale POS", text: "Sell at the counter on any device, with barcode scanning and PDF receipts." },
      { title: "Ads Manager", text: "AI-assisted feed boosts, flash sales and ROAS reporting." },
      { title: "Bring your store", text: "Shopify and WooCommerce import of catalog, customers and orders, with webhooks." },
    ],
    revenue: "Marketplace commission · Swypik Ads",
    screen: "seller",
  },
  {
    slug: "wallet", name: "Swypik Wallet", short: "One ledger", category: "account", icon: "wallet", tone: "ink", status: "dev",
    tagline: "Every leu you earn on Swypik, in one ledger.",
    summary: "One RON ledger across the ecosystem: what you earned selling, driving, delivering or creating, and what you spent.",
    features: [
      { title: "One balance", text: "Money in and out across every module." },
      { title: "Earnings everywhere", text: "Sales, rides, deliveries and creator earnings in one activity feed." },
      { title: "Payouts", text: "Withdrawals in eligible modules." },
    ],
    screen: "wallet",
  },
  {
    slug: "ai-assistant", name: "AI Assistant", short: "Ask, get products", category: "account", icon: "spark", tone: "violet", status: "built",
    tagline: "Ask for what you need. Get products, not links.",
    summary: "A shopping assistant that answers with real items from the catalog — with safety filters on every reply and fair-use quotas.",
    features: [
      { title: "Grounded answers", text: "Structured responses built from the live catalog." },
      { title: "Safe by default", text: "Content-safety filtering on every reply." },
      { title: "EU data zone", text: "Runs on EU-region AI infrastructure today, with Ilaria being prepared as the native model." },
    ],
    ai: "Today: EU-region cloud AI. Tomorrow: Ilaria, through the same assistant interface.",
    screen: "assistant",
  },
  {
    slug: "account", name: "Account & Trust", short: "One identity", category: "account", icon: "shield", tone: "ink", status: "beta",
    tagline: "One account. Four modes. Serious security.",
    summary: "A single identity for buyers, sellers, creators and drivers — with modern sign-in, two-factor security and fraud protection.",
    features: [
      { title: "Modern sign-in", text: "Email one-time codes, Google and Apple sign-in, TOTP two-factor." },
      { title: "Four modes", text: "Switch between Buyer, Seller, Creator and Courier/Driver with one account." },
      { title: "Trust & safety", text: "Age verification, moderation, strikes and fraud scoring." },
      { title: "7 languages", text: "Romanian, English, German, Spanish, French, Italian and Portuguese." },
    ],
    screen: "account",
  },
];

export const mobileApp = {
  name: "Swypik for iOS & Android",
  status: "dev" as Status,
  label: "Native pilot · in preparation",
  summary: "A native React Native / Expo app is being prepared as a private pilot: Discover, Shop, Ilaria and Account. It is not yet published in the app stores.",
  tabs: [
    { name: "Discover", icon: "home", text: "The video feed, natively." },
    { name: "Shop", icon: "bag", text: "The video product catalog." },
    { name: "Ilaria", icon: "spark", text: "Ask Ilaria, with explicit consent for remote inference." },
    { name: "Account", icon: "user", text: "Secure sign-in with rotating sessions." },
  ],
};

export const moduleBySlug = (slug: string) => modules.find((m) => m.slug === slug);
export const modulesIn = (category: CategoryId) => modules.filter((m) => m.category === category);
