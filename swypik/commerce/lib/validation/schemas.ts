import { z } from "zod";
import { CARRIER_CODES } from "@/lib/fulfillment/carriers";

/**
 * Validation schemas for mutating API routes.
 * Use `Schema.safeParse(body)` and return 400 with `error.issues` on failure.
 */

export const CheckoutItemSchema = z.object({
  productId: z.string().trim().min(1).max(128).optional(),
  pgId: z.string().trim().min(1).max(128).optional(),
  quantity: z.number().int().min(1).max(10).default(1),
  skuId: z.string().trim().max(128).optional(),
  variantId: z.string().trim().max(128).optional(),
  videoId: z.string().trim().max(64).optional(),
}).refine((it) => Boolean(it.productId || it.pgId), {
  message: "productId or pgId required",
  path: ["productId"],
});

export const CheckoutCreateIntentSchema = z.object({
  products: z.array(CheckoutItemSchema).min(1, "Coșul este gol.").max(50, "Maxim 50 produse per comandă."),
  idempotencyKey: z.string().max(128).optional(),
});

export type CheckoutCreateIntentInput = z.infer<typeof CheckoutCreateIntentSchema>;

// Permissive Checkout shape used by /api/checkout/route.ts (legacy clients
// send `items`/`products`/`product` with mixed fields). Server enforces price
// from DB regardless, so we only validate types + caps here.
export const CheckoutRawItemSchema = z.object({
  productId: z.union([z.string(), z.number()]).optional(),
  pgId: z.union([z.string(), z.number()]).optional(),
  quantity: z.union([z.number(), z.string()]).optional(),
  skuId: z.union([z.string(), z.number()]).optional(),
  variantId: z.union([z.string(), z.number()]).optional(),
  videoId: z.union([z.string(), z.number()]).optional(),
}).passthrough();

export const CheckoutPostBodySchema = z.object({
  items: z.array(CheckoutRawItemSchema).max(50).optional(),
  products: z.array(CheckoutRawItemSchema).max(50).optional(),
  product: CheckoutRawItemSchema.optional(),
  customer: z.object({
    email: z.string().email().max(254).optional(),
  }).passthrough().optional(),
}).passthrough();

// Seller auth: action-based body (login/request_otp/verify_otp).
export const SellerAuthBodySchema = z.object({
  action: z.enum(["login", "request_otp", "verify_otp"]),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  token: z.string().trim().regex(/^\d{6}$/, "Cod invalid").optional(),
});
export type SellerAuthBody = z.infer<typeof SellerAuthBodySchema>;

// User profile PATCH.
export const CreatorLinkSchema = z.object({
  label: z.string().trim().min(1).max(30),
  url: z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), {
    message: "Doar linkuri http(s)",
  }),
});

export const UserProfilePatchSchema = z.object({
  display_name: z.string().trim().min(1).max(50).optional(),
  bio: z.string().trim().max(300).nullable().optional(),
  username: z.string().trim().toLowerCase().min(3).max(30).regex(/^[a-z0-9_]+$/, "username invalid").optional(),
  links: z.array(CreatorLinkSchema).max(8).optional(),
  categories: z.array(
    z.string().trim().toLowerCase().min(2).max(40).regex(/^[a-z0-9 _-]+$/, "categorie invalidă")
  ).max(8).optional(),
}).refine((b) =>
  b.display_name !== undefined ||
  b.bio !== undefined ||
  b.username !== undefined ||
  b.links !== undefined ||
  b.categories !== undefined, {
  message: "Nimic de actualizat",
});

// 2FA disable / regenerate-backup: password only.
export const TwoFactorPasswordSchema = z.object({
  password: z.string().min(1, "Parola este obligatorie.").max(256),
});

// 2FA enable: 6-digit token.
export const TwoFactorTokenSchema = z.object({
  token: z.string().trim().regex(/^\d{6}$/, "Codul trebuie să aibă 6 cifre."),
});

// Address PATCH (all fields optional, length-capped).
export const AddressPatchSchema = z.object({
  label: z.string().trim().max(60).nullable().optional(),
  recipient_name: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  line1: z.string().trim().max(200).nullable().optional(),
  line2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  region: z.string().trim().max(120).nullable().optional(),
  postal_code: z.string().trim().max(20).nullable().optional(),
  country_code: z.string().trim().length(2).regex(/^[A-Za-z]{2}$/, "country_code must be ISO-3166-1 alpha-2").nullable().optional(),
  lat: z.coerce.number().min(-90).max(90).nullable().optional(),
  lng: z.coerce.number().min(-180).max(180).nullable().optional(),
  details: z.string().trim().max(500).nullable().optional(),
  set_default: z.boolean().optional(),
}).strict();

// Adult content opt-in toggle.
export const AdultOptInSchema = z.object({
  optIn: z.boolean(),
});

// Arena post vote.
export const PostVoteSchema = z.object({
  optionKey: z.string().trim().min(1).max(64),
});

// Video comment POST.
export const VideoCommentPostSchema = z.object({
  text: z.string().trim().max(2000).optional(),
  body: z.string().trim().max(2000).optional(),
  comment: z.string().trim().max(2000).optional(),
  parent_comment_id: z.string().trim().max(64).nullable().optional(),
}).passthrough();

// Video report (UI-facing endpoint /api/videos/[id]/report).
export const VideoReportPostSchema = z.object({
  category: z.string().trim().toLowerCase().min(1).max(40),
  details: z.string().trim().max(1000).nullable().optional(),
});

// Chat POST.
export const ChatPostSchema = z.object({
  message: z.string().max(4000).optional(),
  sessionId: z.string().max(128).optional(),
  directCjQuery: z.string().max(500).optional(),
  chatHistory: z.array(z.unknown()).max(50).optional(),
  productContext: z.array(z.unknown()).max(50).optional(),
  shoppingSession: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

// Live stream chat message.
export const LiveChatMessageSchema = z.object({
  message: z.string().trim().min(1, "Mesaj gol").max(500),
});

// Live stream poll create.
export const LivePollCreateSchema = z.object({
  question: z.string().trim().min(1).max(280),
  options: z.array(z.string().trim().min(1).max(120)).min(2).max(10),
});

// Feed action.
export const FeedActionSchema = z.object({
  video_id: z.string().trim().min(1).max(64),
  action: z.enum(["more_like_this", "not_interested", "follow_creator", "unfollow"]),
});

// Feed events batch (envelope only — items validated downstream).
export const FeedEventsBatchSchema = z.object({
  events: z.array(z.unknown()).max(50).optional(),
}).passthrough();

// Video feedback.
export const VideoFeedbackSchema = z.object({
  action: z.enum(["more_like_this", "not_interested"]),
});

// Tier 3a — Challenge enter.
export const ChallengeEnterSchema = z.object({
  video_id: z.string().trim().max(64).nullable().optional(),
}).passthrough();

// Tier 3a — Collection create.
export const CollectionCreateSchema = z.object({
  title: z.string().trim().min(1, "Titlu obligatoriu").max(80),
  icon: z.string().trim().max(8).optional(),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Culoare invalidă (#RRGGBB)").optional(),
}).passthrough();

// Tier 3a — Collection patch.
export const CollectionPatchSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  icon: z.string().trim().max(8).optional(),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional(),
}).passthrough();

// Tier 3a — Collection items add.
export const CollectionItemAddSchema = z.object({
  video_id: z.string().trim().min(1).max(64),
  note: z.string().trim().max(500).optional(),
}).passthrough();

// Tier 3a — Product review create.
export const ProductReviewCreateSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().max(200).optional(),
  body: z.string().trim().max(4000).optional(),
}).passthrough();

// Tier 3a — Product review patch.
export const ProductReviewPatchSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  title: z.string().trim().max(200).optional(),
  body: z.string().trim().max(4000).optional(),
}).passthrough();

// Tier 3a — Video event tracking.
const VIDEO_EVENT_TYPES = [
  "impression", "view_start", "view_end", "skip_fast", "watch_complete",
  "rewatch", "pause", "resume", "seek", "like", "unlike", "save", "unsave",
  "share", "comment", "follow", "unfollow", "product_click", "add_to_cart",
  "purchase", "more_like_this", "not_interested", "report",
] as const;
export const VideoEventTrackSchema = z.object({
  event_type: z.enum(VIDEO_EVENT_TYPES),
  watch_duration_ms: z.number().int().nonnegative().max(86_400_000).optional(),
  video_duration_ms: z.number().int().nonnegative().max(86_400_000).optional(),
  completion_pct: z.number().min(0).max(100).optional(),
  session_id: z.string().trim().max(64).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const SellerVariantSchema = z.object({
  sku: z.string().trim().max(64).optional(),
  title: z.string().trim().max(120).optional(),
  attributes: z.record(z.string(), z.string().max(80)).optional(),
  price_cents: z.number().int().nonnegative().max(100_000_000).optional(),
  inventory_quantity: z.number().int().nonnegative().max(1_000_000).optional(),
});

export const SellerProductCreateSchema = z.object({
  title: z.string().trim().min(3, "Titlu prea scurt (min 3)").max(200),
  description: z.string().trim().max(5000).optional(),
  brand: z.string().trim().max(120).optional(),
  sku: z.string().trim().max(64).optional(),
  barcode: z.string().trim().max(64).optional(),
  price: z.coerce.number().finite().positive("Preț invalid").max(1_000_000),
  compare_at_price: z.coerce.number().finite().nonnegative().max(1_000_000).optional(),
  supplier_cost: z.coerce.number().finite().nonnegative().max(1_000_000).optional(),
  currency: z.enum(["RON", "EUR", "USD"]).default("RON"),
  stock: z.coerce.number().int().nonnegative().max(1_000_000),
  category: z.string().trim().max(200).optional(),
  taxonomy_node_slug: z.string().trim().max(120).optional(),
  image_urls: z.array(z.string().url().max(2048)).max(8).optional(),
  video_url: z.string().url().max(2048).optional(),
  is_swypik_listed: z.boolean().default(true).optional(),
  swypik_price: z.coerce.number().finite().positive().max(1_000_000).optional(),
  shipping_cost: z.coerce.number().finite().nonnegative().max(10_000).optional(),
  shipping_days_min: z.coerce.number().int().nonnegative().max(180).optional(),
  shipping_days_max: z.coerce.number().int().nonnegative().max(180).optional(),
  courier: z.enum(["dpd", "fan_courier", "sameday", "cargus", "posta_romana", "gls", "other"]).optional(),
  variants: z.array(SellerVariantSchema).max(50).optional(),
});

/**
 * Universal Marketplace — listing (anunț) pentru verticale fără checkout:
 * imobiliare, auto, servicii. Prețul e opțional (ex: "la cerere"), stocul lipsește,
 * iar câmpurile specifice verticalei intră în `vertical_attributes`
 * (validate contra lib/verticals/registry.ts).
 */
export const ListingCreateSchema = z.object({
  title: z.string().trim().min(3, "Titlu prea scurt (min 3)").max(200),
  description: z.string().trim().max(10_000).optional(),
  taxonomy_node_slug: z.string().trim().min(1, "Categorie obligatorie").max(120),
  price: z.coerce.number().finite().nonnegative().max(1_000_000_000).optional(),
  currency: z.enum(["RON", "EUR", "USD"]).default("EUR"),
  image_urls: z.array(z.string().url().max(2048)).max(20).optional(),
  vertical_attributes: z.record(z.string(), z.unknown()).optional(),
  location_country: z.string().trim().length(2).toUpperCase().optional(),
  location_city: z.string().trim().max(120).optional(),
  location_lat: z.coerce.number().min(-90).max(90).optional(),
  location_lng: z.coerce.number().min(-180).max(180).optional(),
  contact_phone: z.string().trim().max(32).optional(),
  contact_email: z.string().trim().email().max(254).optional(),
});

/** Formular de contact pe un anunț (generează lead). */
export const InquiryCreateSchema = z.object({
  product_id: z.string().uuid("product_id invalid"),
  name: z.string().trim().min(2, "Nume prea scurt").max(120),
  email: z.string().trim().email().max(254).optional(),
  phone: z.string().trim().min(5).max(32).optional(),
  message: z.string().trim().min(5, "Mesaj prea scurt").max(2000),
}).refine((d) => Boolean(d.email || d.phone), {
  message: "Trebuie să lași un email sau un telefon",
  path: ["email"],
});

// ────────────────────────────────────────────────────────────────────────────
// Servicii locale: curieri, comenzi food, rezervări cazare
// ────────────────────────────────────────────────────────────────────────────

const VEHICLE_TYPES = ["foot", "bike", "scooter", "motorcycle", "car", "van"] as const;

export const CourierApplySchema = z.object({
  kind: z.enum(["courier", "driver"]).default("courier"),
  full_name: z.string().trim().min(3, "Nume prea scurt").max(120),
  phone: z.string().trim().min(5, "Telefon invalid").max(32),
  email: z.string().trim().email().max(254).optional(),
  vehicle_type: z.enum(VEHICLE_TYPES).default("bike"),
  vehicle_plate: z.string().trim().max(16).optional(),
  city: z.string().trim().min(2, "Orașul e obligatoriu").max(120),
  country: z.string().trim().length(2).toUpperCase().default("RO"),
  documents: z.record(z.string(), z.string().url().max(2048)).optional(),
});

export const CourierUpdateSchema = z.object({
  phone: z.string().trim().min(5).max(32).optional(),
  email: z.string().trim().email().max(254).optional(),
  vehicle_type: z.enum(VEHICLE_TYPES).optional(),
  vehicle_plate: z.string().trim().max(16).optional(),
  city: z.string().trim().min(2).max(120).optional(),
  documents: z.record(z.string(), z.string().url().max(2048)).optional(),
});

export const CourierStatusSchema = z.object({
  online: z.boolean(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  speed_kmh: z.coerce.number().min(0).max(300).optional(),
  heading: z.coerce.number().min(0).lt(360).optional(),
});

const LocalOrderItemSchema = z.object({
  menu_item_id: z.string().uuid(),
  qty: z.number().int().min(1).max(99),
  /** id-urile opțiunilor alese; prețul se recalculează server-side din DB */
  option_ids: z.array(z.string().max(64)).max(30).optional(),
  notes: z.string().trim().max(300).optional(),
});

export const LocalOrderCreateSchema = z.object({
  merchant_id: z.string().uuid("merchant_id invalid"),
  items: z.array(LocalOrderItemSchema).min(1, "Coșul e gol").max(50),
  customer_name: z.string().trim().min(2).max(120),
  customer_phone: z.string().trim().min(5).max(32),
  delivery_address: z.string().trim().min(5, "Adresă prea scurtă").max(500),
  // Coordonatele sunt obligatorii: fără ele raza de livrare nu se putea verifica
  // (audit food-go #8); (0,0) = GPS lipsă, nu o adresă reală (#17).
  delivery_lat: z.number().min(-90).max(90),
  delivery_lng: z.number().min(-180).max(180),
  delivery_notes: z.string().trim().max(500).optional(),
  // card_courier nu avea niciun flux (audit #16) — doar cash sau card online.
  payment_method: z.enum(["cash", "card_online"]).default("cash"),
  tip_cents: z.number().int().min(0).max(100_000).default(0),
});

export const LocalOrderCreateSchemaRefined = LocalOrderCreateSchema.refine(
  (d) => !(d.delivery_lat === 0 && d.delivery_lng === 0),
  { message: "delivery_location_required", path: ["delivery_lat"] },
);

export const LocalOrderStatusSchema = z.object({
  status: z.enum([
    "accepted", "preparing", "ready", "picked_up", "delivering", "delivered", "cancelled", "rejected",
  ]),
  reason: z.string().trim().max(300).optional(),
});

// ── Comercianți locali (restaurante, magazine, farmacii) ────────────────────

const MERCHANT_KINDS = ["restaurant", "grocery", "pharmacy", "flowers", "other"] as const;
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** { "mon": [["09:00","22:00"]], ... } — max 4 intervale/zi */
const OpeningHoursSchema = z
  .record(
    z.enum(DAY_KEYS),
    z.array(z.tuple([z.string().regex(TIME_RE, "Format HH:MM"), z.string().regex(TIME_RE, "Format HH:MM")])).max(4),
  )
  .optional();

export const MerchantCreateSchema = z.object({
  kind: z.enum(MERCHANT_KINDS).default("restaurant"),
  name: z.string().trim().min(2, "Nume prea scurt").max(160),
  description: z.string().trim().max(2000).optional(),
  cuisine_types: z.array(z.string().trim().max(40)).max(10).optional(),
  phone: z.string().trim().min(5, "Telefon invalid").max(32),
  email: z.string().trim().email().max(254).optional(),
  address: z.string().trim().min(5, "Adresă prea scurtă").max(400),
  location_country: z.string().trim().length(2).toUpperCase().default("RO"),
  location_city: z.string().trim().min(2, "Orașul e obligatoriu").max(120),
  location_lat: z.coerce.number().min(-90).max(90).optional(),
  location_lng: z.coerce.number().min(-180).max(180).optional(),
  delivery_radius_km: z.coerce.number().min(0.5).max(100).optional(),
  min_order_cents: z.number().int().min(0).max(1_000_000).optional(),
  delivery_fee_cents: z.number().int().min(0).max(100_000).optional(),
  avg_prep_minutes: z.number().int().min(1).max(240).optional(),
  opening_hours: OpeningHoursSchema,
  image_url: z.string().url().max(2048).optional(),
});

export const MerchantUpdateSchema = z.object({
  merchant_id: z.string().uuid("merchant_id invalid"),
  name: z.string().trim().min(2).max(160).optional(),
  description: z.string().trim().max(2000).optional(),
  cuisine_types: z.array(z.string().trim().max(40)).max(10).optional(),
  phone: z.string().trim().min(5).max(32).optional(),
  address: z.string().trim().min(5).max(400).optional(),
  location_lat: z.coerce.number().min(-90).max(90).optional(),
  location_lng: z.coerce.number().min(-180).max(180).optional(),
  delivery_radius_km: z.coerce.number().min(0.5).max(100).optional(),
  min_order_cents: z.number().int().min(0).max(1_000_000).optional(),
  delivery_fee_cents: z.number().int().min(0).max(100_000).optional(),
  avg_prep_minutes: z.number().int().min(1).max(240).optional(),
  opening_hours: OpeningHoursSchema,
  image_url: z.string().url().max(2048).optional(),
  is_open_override: z.boolean().nullable().optional(),
});

/** Opțiune de meniu: [{name:"Mărime", required:true, max:1, choices:[{name:"Mare", price_cents:500}]}] */
const MenuOptionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  required: z.boolean().optional(),
  max: z.number().int().min(1).max(20).optional(),
  choices: z
    .array(
      z.object({
        id: z.string().trim().max(64).optional(),
        name: z.string().trim().min(1).max(80),
        price_cents: z.number().int().min(0).max(100_000).optional(),
      }),
    )
    .max(30),
});

export const MenuCategoryCreateSchema = z.object({
  merchant_id: z.string().uuid(),
  name: z.string().trim().min(1, "Nume obligatoriu").max(120),
  sort_order: z.number().int().min(0).max(9999).optional(),
});

export const MenuItemCreateSchema = z.object({
  merchant_id: z.string().uuid(),
  category_id: z.string().uuid().optional(),
  name: z.string().trim().min(2, "Nume prea scurt").max(160),
  description: z.string().trim().max(1000).optional(),
  price: z.coerce.number().min(0).max(1_000_000),
  currency: z.enum(["RON", "EUR", "USD"]).default("RON"),
  image_url: z.string().url().max(2048).optional(),
  options: z.array(MenuOptionSchema).max(10).optional(),
  allergens: z.array(z.string().trim().max(40)).max(20).optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
});

export const MenuItemUpdateSchema = z.object({
  item_id: z.string().uuid(),
  category_id: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(2).max(160).optional(),
  description: z.string().trim().max(1000).optional(),
  price: z.coerce.number().min(0).max(1_000_000).optional(),
  image_url: z.string().url().max(2048).optional(),
  options: z.array(MenuOptionSchema).max(10).optional(),
  allergens: z.array(z.string().trim().max(40)).max(20).optional(),
  is_available: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
});

// ── Swypik Cares: donații ────────────────────────────────────────────────────

export const DonationCreateSchema = z.object({
  campaign_id: z.string().uuid("campaign_id invalid"),
  /** suma în unități întregi de monedă (RON), min 1, max 50.000 */
  amount: z.coerce.number().min(1, "Minim 1 leu").max(50_000, "Pentru sume mari, contactează-ne"),
  donor_name: z.string().trim().min(2).max(120).optional(),
  donor_email: z.string().trim().email().max(254).optional(),
  message: z.string().trim().max(500).optional(),
  is_anonymous: z.boolean().optional(),
  source: z.enum(["direct", "checkout_roundup", "recurring"]).optional(),
});

export const SellerProductClassifySchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(2000).optional(),
});

// ── FRONT 8 ────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_HHMM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** POST /api/causes — înregistrare beneficiar/ONG. */
export const CauseRegisterSchema = z.object({
  kind: z.enum(["ngo", "family", "small_business", "community", "emergency"]).default("ngo"),
  name: z.string().trim().min(3, "Nume prea scurt").max(200),
  description: z.string().trim().max(4000).optional(),
  legal_id: z.string().trim().max(64).optional(),
  documents: z.record(z.string(), z.string().url().max(2048)).optional(),
  contact_name: z.string().trim().min(2).max(120),
  contact_email: z.string().trim().email().max(254),
  contact_phone: z.string().trim().min(5).max(32).optional(),
  location_country: z.string().trim().length(2).toUpperCase().default("RO"),
  location_city: z.string().trim().max(120).optional(),
  image_url: z.string().url().max(2048).optional(),
});

const BudgetLineSchema = z.object({
  label: z.string().trim().min(2).max(200),
  amount_cents: z.number().int().min(0).max(1_000_000_000),
});

/** POST /api/campaigns/manage — creare campanie (cauză verificată). */
export const CampaignCreateSchema = z.object({
  cause_id: z.string().uuid(),
  title: z.string().trim().min(5, "Titlu prea scurt").max(200),
  story: z.string().trim().max(10_000).optional(),
  goal_cents: z.number().int().min(100, "Țintă minimă 1 RON").max(1_000_000_000),
  currency: z.string().trim().length(3).toUpperCase().default("RON"),
  budget_breakdown: z.array(BudgetLineSchema).max(50).optional(),
  ends_at: z.string().datetime({ offset: true }).optional(),
  image_url: z.string().url().max(2048).optional(),
  video_id: z.string().uuid().optional(),
});

/** PATCH /api/campaigns/manage — editare campanie. */
export const CampaignUpdateSchema = z.object({
  campaign_id: z.string().uuid(),
  title: z.string().trim().min(5).max(200).optional(),
  story: z.string().trim().max(10_000).optional(),
  goal_cents: z.number().int().min(100).max(1_000_000_000).optional(),
  budget_breakdown: z.array(BudgetLineSchema).max(50).optional(),
  ends_at: z.string().datetime({ offset: true }).nullable().optional(),
  image_url: z.string().url().max(2048).nullable().optional(),
  video_id: z.string().uuid().nullable().optional(),
  status: z.enum(["draft", "active", "closed"]).optional(),
});

/** POST /api/bookings/slots — rezervare pe ore. */
export const BookingSlotCreateSchema = z.object({
  product_id: z.string().uuid(),
  slot_date: z.string().regex(DATE_RE, "Dată invalidă (YYYY-MM-DD)"),
  start_time: z.string().regex(TIME_HHMM_RE, "Oră invalidă (HH:MM)"),
  end_time: z.string().regex(TIME_HHMM_RE, "Oră invalidă (HH:MM)"),
  customer_name: z.string().trim().min(2).max(120),
  customer_phone: z.string().trim().min(5).max(32).optional(),
  customer_email: z.string().trim().email().max(254).optional(),
  notes: z.string().trim().max(1000).optional(),
}).refine((d) => d.end_time > d.start_time, {
  message: "Ora de final trebuie să fie după cea de start",
  path: ["end_time"],
}).refine((d) => Boolean(d.customer_phone || d.customer_email), {
  message: "Trebuie să lași un telefon sau un email",
  path: ["customer_phone"],
});

/**
 * Helper: parse a request body with a zod schema. Returns either the parsed
 * data or a NextResponse-friendly error payload (use it as { error, status: 400 }).
 *
 * `error` stays a human-readable zod message (kept for back-compat — some
 * routes/clients already rely on its exact shape) but is often in Romanian
 * (schema `.refine`/field messages are mostly written in Romanian, and default
 * zod messages are English) — never render it directly to a non-`ro` viewer.
 * `code` is additive (audit 2026-09-24, wave2-misc): always the stable string
 * `"validation_error"`, safe to use as a client-side i18n lookup key, with
 * `issues` (unchanged, already present) for anything that needs the raw
 * per-field detail.
 */
export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown):
  | { ok: true; data: z.infer<T> }
  | { ok: false; error: string; code: "validation_error"; issues: z.ZodIssue[] } {
  const result = schema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    error: result.error.issues[0]?.message ?? "Invalid request body",
    code: "validation_error",
    issues: result.error.issues,
  };
}

// Allowed values mirror commerce_orders_status_check enum.
export const OrderStatusEnum = z.enum([
  "pending", "authorized", "paid", "fulfilled", "delivered",
  "return_requested", "cancelled", "refunded", "failed", "disputed",
]);

export const AdminOrderPatchSchema = z.object({
  orderId: z.string().uuid("orderId must be a valid UUID"),
  status: OrderStatusEnum.optional(),
  trackingNumber: z.string().trim().min(1).max(128).optional(),
  trackingUrl: z.string().url("trackingUrl must be a valid URL").max(512).optional(),
  fulfillmentStatus: z.enum([
    "pending", "processing", "shipped", "fulfilled", "delivered", "failed",
  ]).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export type AdminOrderPatchInput = z.infer<typeof AdminOrderPatchSchema>;

export const SellerOrderTrackingSchema = z.object({
  order_id: z.string().uuid("order_id must be a valid UUID"),
  tracking_number: z.string().trim().min(3, "tracking_number too short").max(120, "tracking_number too long"),
  tracking_url: z.string().url("tracking_url must be a valid URL").max(512).optional(),
});
export type SellerOrderTrackingInput = z.infer<typeof SellerOrderTrackingSchema>;

export const SellerGenerateAwbSchema = z.object({
  courier: z.enum(CARRIER_CODES).default("sameday_easybox"),
  parcels_count: z.coerce.number().int().min(1).max(50).default(1),
  weight_kg: z.coerce.number().min(0.1).max(100).default(1.0),
  manual_tracking_number: z.string().trim().min(3).max(120).optional(),
  notes: z.string().trim().max(500).optional(),
  locker_name: z.string().trim().max(200).optional(),
});
export type SellerGenerateAwbInput = z.infer<typeof SellerGenerateAwbSchema>;


export const SellerApplicationSchema = z.object({
  companyName: z.string().trim().min(2, "companyName is required").max(160),
  cui: z.string().trim().min(2, "cui is required").max(64),
  email: z.string().trim().email("email must be valid").max(254),
  phone: z.string().trim().min(6, "phone is required").max(32),
  productType: z.string().trim().min(2, "productType is required").max(120),
});
export type SellerApplicationInput = z.infer<typeof SellerApplicationSchema>;

// IBAN: 2 letter country code + 2 check digits + up to 30 alphanumeric (loose format check).
const IbanSchema = z.string().trim().toUpperCase().regex(/^[A-Z]{2}[0-9]{2}[A-Z0-9]{4,30}$/, "iban must be a valid IBAN").max(34);

export const SellerSettingsUpdateSchema = z.object({
  name: z.string().trim().max(160).optional(),
  username: z.string().trim().min(3, "username must be at least 3 characters").max(30),
  bio: z.string().trim().max(500).optional(),
  avatarUrl: z.string().trim().url("avatarUrl must be a valid URL").max(500).optional().or(z.literal("")),
  cui: z.string().trim().max(64).optional(),
  phone: z.string().trim().max(32).optional(),
  iban: z.union([IbanSchema, z.literal("")]).optional(),
  invoiceSeries: z.string().trim().max(20).optional(),
  // Profilul fiscal (furnizorul de pe factură / e-Factura CIUS-RO, expeditorul AWB).
  legalName: z.string().trim().max(200).optional(),
  tradeRegister: z.string().trim().max(40).optional(),
  street: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  county: z.string().trim().max(64).optional(),
  postalCode: z.string().trim().max(16).optional(),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional().or(z.literal("")),
  vatExemptionReason: z.string().trim().max(300).optional(),
});
export type SellerSettingsUpdateInput = z.infer<typeof SellerSettingsUpdateSchema>;

export const VideoProductVoteSchema = z.object({
  productId: z.string().uuid("productId must be a valid UUID"),
  vote: z.enum(["worth_it", "not_worth_it"]),
  sessionId: z.string().trim().min(8).max(80).optional(),
});
export type VideoProductVoteInput = z.infer<typeof VideoProductVoteSchema>;

/* ===========================================================================
 * Public mutating endpoints (added 2026-05-26)
 * Centralized schemas — keep route handlers thin.
 * =========================================================================== */

export const VideoCommentCreateSchema = z.object({
  body: z.string().trim().min(1, "Comentariul nu poate fi gol").max(2000, "Maxim 2000 caractere"),
  parent_id: z.string().uuid().nullable().optional(),
  reply_to_user_id: z.string().uuid().nullable().optional(),
});
export type VideoCommentCreateInput = z.infer<typeof VideoCommentCreateSchema>;

export const VideoReportSchema = z.object({
  reason: z.enum([
    "spam", "harassment", "hate_speech", "violence", "nudity",
    "self_harm", "misinformation", "copyright", "scam", "underage", "other",
  ]),
  description: z.string().trim().max(2000).optional(),
});
export type VideoReportInput = z.infer<typeof VideoReportSchema>;

export const VideoShareSchema = z.object({
  channel: z.enum([
    "copy_link", "native_share", "email", "sms", "whatsapp",
    "facebook", "instagram", "tiktok", "x", "other",
  ]).default("other"),
  referrer_url: z.string().url().max(500).optional().nullable(),
  destination_url: z.string().url().max(500).optional().nullable(),
});
export type VideoShareInput = z.infer<typeof VideoShareSchema>;

export const CartItemAddSchema = z.object({
  productId: z.string().trim().min(1, "productId required").max(128),
  variantId: z.string().trim().max(128).optional().nullable(),
  quantity: z.coerce.number().int().min(1).max(99).default(1),
  title: z.string().max(300).optional(),
  image: z.string().url().max(1024).optional(),
  priceCents: z.coerce.number().int().min(0).max(100_000_000).optional(),
  currency: z.string().trim().length(3).optional(),
});
export type CartItemAddInput = z.infer<typeof CartItemAddSchema>;

export const CartItemPatchSchema = z.object({
  quantity: z.coerce.number().int().min(0).max(99),
});
export type CartItemPatchInput = z.infer<typeof CartItemPatchSchema>;

export const DmConversationCreateSchema = z.object({
  peer_user_id: z.string().uuid("peer_user_id must be a valid UUID"),
});
export type DmConversationCreateInput = z.infer<typeof DmConversationCreateSchema>;

export const DmMessageCreateSchema = z.object({
  body: z.string().trim().min(1, "Mesajul nu poate fi gol").max(4000, "Maxim 4000 caractere"),
  media_url: z.string().url().max(1024).optional().nullable(),
  reply_to_message_id: z.string().uuid().optional().nullable(),
});
export type DmMessageCreateInput = z.infer<typeof DmMessageCreateSchema>;

export const NotificationsMarkReadSchema = z.union([
  z.object({ markAll: z.literal(true) }),
  z.object({ ids: z.array(z.string().regex(/^\d+$/, "id must be numeric")).min(1).max(100) }),
]);
export type NotificationsMarkReadInput = z.infer<typeof NotificationsMarkReadSchema>;

// 2026-08-11 (audit): unica sursă de adevăr pentru țările suportate la livrare
// (exportată — folosită și în app/api/users/me/addresses).
export const ALLOWED_COUNTRY_CODES = [
  "RO", "MD", "BG", "HU", "DE", "FR", "IT", "ES", "NL", "BE", "AT", "PL", "GB",
] as const;

export const UserAddressCreateSchema = z.object({
  label: z.string().trim().max(80).nullable().optional(),
  recipient_name: z.string().trim().min(1, "Numele destinatarului este obligatoriu").max(160),
  phone: z.string().trim().min(6).max(32).nullable().optional(),
  line1: z.string().trim().min(1, "Strada (linia 1) este obligatorie").max(200),
  line2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().min(1, "Orașul este obligatoriu").max(120),
  region: z.string().trim().max(120).nullable().optional(),
  postal_code: z.string().trim().min(2, "Codul poștal este obligatoriu").max(20),
  country_code: z.enum(ALLOWED_COUNTRY_CODES).default("RO"),
  is_default: z.coerce.boolean().optional(),
  lat: z.coerce.number().min(-90).max(90).nullable().optional(),
  lng: z.coerce.number().min(-180).max(180).nullable().optional(),
  details: z.string().trim().max(500).nullable().optional(),
});
export type UserAddressCreateInput = z.infer<typeof UserAddressCreateSchema>;

export const UserAddressPatchSchema = UserAddressCreateSchema.partial();
export type UserAddressPatchInput = z.infer<typeof UserAddressPatchSchema>;

export const VideoEventSchema = z.object({
  event_type: z.enum([
    "impression", "view_start", "view_end", "skip_fast", "watch_complete",
    "rewatch", "pause", "resume", "seek", "like", "unlike", "save", "unsave",
    "share", "comment", "follow", "unfollow", "product_click", "add_to_cart",
    "purchase", "more_like_this", "not_interested", "report",
  ]),
  watch_duration_ms: z.coerce.number().int().min(0).max(86_400_000).optional().nullable(),
  video_duration_ms: z.coerce.number().int().min(0).max(86_400_000).optional().nullable(),
  completion_pct: z.coerce.number().min(0).max(100).optional().nullable(),
  session_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type VideoEventInput = z.infer<typeof VideoEventSchema>;

export const OrderReturnRequestSchema = z.object({
  reason: z.string().trim().min(5, "Motivul returului este obligatoriu (minim 5 caractere)").max(2000),
  token: z.string().trim().min(8, "Token de autentificare lipsă").max(256),
  evidenceUrls: z.array(z.string().url().max(1024)).max(4).optional(),
});
export type OrderReturnRequestInput = z.infer<typeof OrderReturnRequestSchema>;

export const ApplySellerSchema = SellerApplicationSchema;

