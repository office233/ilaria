import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { resolveTaxonomy, resolveTaxonomyV2, loadCategories, loadFullChainCache } from '../lib/aliexpress/taxonomy-resolver.mjs';

const requireFromApp = createRequire('/opt/swypik/app/package.json');
const { Pool } = requireFromApp('pg');

/**
 * Parse simple CLI flags after the positional product_id arg.
 * Supported: --display-name=, --label-hint=, --leaf-cat-id=, --post-cat-ids=a,b,c
 */
function parseFlags(argv) {
  const flags = {};
  for (const a of argv.slice(3)) {
    const m = a.match(/^--([a-z-]+)=(.*)$/);
    if (m) flags[m[1]] = m[2];
  }
  return flags;
}

const envText = fs.readFileSync('/opt/swypik/app/infra/hetzner/.env.production', 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
}

const productId = process.argv[2];
if (!productId) throw new Error('Usage: node ae-import-standalone-clean.mjs <product_id> [--display-name=...] [--label-hint=...] [--leaf-cat-id=...] [--post-cat-ids=a,b,c]');
const cliFlags = parseFlags(process.argv);

const APP_KEY = process.env.ALIEXPRESS_APP_KEY || '';
const APP_SECRET = process.env.ALIEXPRESS_APP_SECRET || '';
const TOKEN = process.env.ALIEXPRESS_ACCESS_TOKEN || '';
if (!APP_KEY || !APP_SECRET || !TOKEN) throw new Error('AliExpress credentials missing');

function hostDatabaseUrl() {
  const url = new URL(process.env.DATABASE_URL);
  if (url.hostname === 'postgres') url.hostname = '127.0.0.1';
  return url.toString();
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function getAdultReason(product) {
  const text = `${product.title} ${product.description || ''}`.toLowerCase();
  const adultTerms = [
    'sex toy','sex toys','sex doll','sex products',
    'vibrator','vibrators','dildo','dildos',
    'masturbator','masturbation','fleshlight',
    'bondage','bdsm','fetish',
    'butt plug','anal plug','anal beads','anal toy',
    'cock ring','penis ring','penis pump','penis sleeve',
    'vibrating egg','love egg',
    'g-spot','g spot',
    'lubricant sex','sex lubricant','personal lubricant',
    'adult only','adult-only','adults only',
    'erotic','porn','pornographic','nsfw',
    'crotchless','pheromone','xxx','18+',
  ];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const term of adultTerms) {
    const r = new RegExp('(^|[^a-z0-9])' + esc(term) + '([^a-z0-9]|$)', 'i');
    if (r.test(text)) return 'matched ' + term;
  }
  return null;
}

function centsRon(ron) {
  const value = Number(ron);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
}

function numberOf(value, fallback = 0) {
  const number = typeof value === 'number' ? value : parseFloat(String(value || ''));
  return Number.isFinite(number) ? number : fallback;
}

function intOf(value, fallback = 0) {
  const number = typeof value === 'number' ? value : parseInt(String(value || ''), 10);
  return Number.isFinite(number) ? number : fallback;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) return child;
  }
  return [];
}

function signParams(params) {
  const signInput = Object.keys(params).sort().map((key) => `${key}${params[key]}`).join('');
  return crypto.createHmac('sha256', APP_SECRET).update(signInput, 'utf8').digest('hex').toUpperCase();
}

function isRetryable(msg) {
  const s = String(msg || '').toLowerCase();
  return s.includes('rate') || s.includes('limit') || s.includes('flow') || s.includes('frequen') || s.includes('timeout') || s.includes('busy') || s.includes('try again');
}

async function callAE(method, params = {}, { retries = 3, baseDelayMs = 2000 } = {}) {
  let attempt = 0;
  while (true) {
    const all = {
      app_key: APP_KEY,
      method,
      session: TOKEN,
      sign_method: 'sha256',
      timestamp: new Date().toISOString().replace(/\.\d+Z/, '+0000').replace('T', ' '),
      v: '2.0',
      format: 'json',
    };
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) all[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    all.sign = signParams(all);
    const url = new URL('https://api-sg.aliexpress.com/sync');
    url.search = new URLSearchParams(all).toString();
    let json;
    try {
      const res = await fetch(url, { method: 'POST' });
      json = await res.json();
    } catch (err) {
      if (attempt < retries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
        attempt += 1;
        continue;
      }
      throw err;
    }
    if (json.error_response) {
      const msg = json.error_response.msg || json.error_response.sub_msg || 'AliExpress API error';
      if (attempt < retries && isRetryable(msg)) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
        attempt += 1;
        continue;
      }
      throw new Error(msg);
    }
    return json;
  }
}

function splitImages(value) {
  return String(value || '')
    .split(/[;,]/)
    .map((url) => url.trim())
    .filter(Boolean)
    .map((url) => (url.startsWith('//') ? `https:${url}` : url));
}

function optionName(value) {
  const raw = String(value || 'option').trim().toLowerCase();
  if (raw === 'colour') return 'color';
  return raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'option';
}

function skuProperties(sku) {
  return asArray(sku?.ae_sku_property_dtos).map((property) => ({
    name: String(property.sku_property_name || '').trim(),
    value: String(property.property_value_definition_name || property.sku_property_value || '').trim(),
    propertyId: property.sku_property_id ?? null,
    valueId: property.property_value_id ?? null,
    image: property.sku_image || null,
  })).filter((property) => property.name || property.value);
}

async function getProductDetail(id) {
  const response = await callAE('aliexpress.ds.product.get', {
    product_id: id,
    ship_to_country: 'RO',
    target_currency: 'USD',
    target_language: 'EN',
  });
  const result = response.aliexpress_ds_product_get_response?.result;
  if (!result) throw new Error('AliExpress product detail missing result');
  return result;
}

function mapProduct(result) {
  const base = result.ae_item_base_info_dto || {};
  const multimedia = result.ae_multimedia_info_dto || {};
  const logistics = result.logistics_info_dto || {};
  const store = result.ae_store_info || {};
  const packageInfo = result.package_info_dto || {};
  const id = String(base.product_id || productId);
  const rawSkus = asArray(result.ae_item_sku_info_dtos);
  const skuList = rawSkus.length ? rawSkus : [{}]; // synthesize single-variant fallback
  const variants = skuList.map((sku) => {
    const props = skuProperties(sku);
    const options = {};
    for (const prop of props) if (prop.name && prop.value) options[optionName(prop.name)] = prop.value;
    const skuId = String(sku.sku_id || sku.id || sku.sku_attr || `${id}-default`);
    const skuAttr = String(sku.sku_attr || sku.id || `default-${id}`);
    const priceUsd = numberOf(sku.offer_sale_price ?? sku.sku_price ?? base.sale_price ?? base.original_price, 0);
    const stock = intOf(sku.sku_available_stock ?? base.sale_count ?? 0, 0);
    return {
      sourceVariantId: skuId,
      title: Object.values(options).filter(Boolean).join(' / ') || 'Standard',
      options,
      priceRon: Math.round(priceUsd * 4.55),
      stock,
      status: stock > 0 ? 'active' : 'out_of_stock',
      metadata: {
        source: 'official_ae_api',
        ae_product_id: id,
        ae_product_url: `https://www.aliexpress.com/item/${id}.html`,
        ae_sku_id: skuId,
        ae_sku_attr: skuAttr,
        ae_sku_properties: props,
        ae_price_usd: priceUsd,
        ae_original_price_usd: numberOf(sku.sku_price, priceUsd),
        ae_currency: sku.currency_code || 'USD',
        ae_stock: stock,
        ae_price_include_tax: sku.price_include_tax ?? null,
      },
    };
  });
  if (!variants.length) throw new Error('Product has no variants');
  const videoDtos = asArray(multimedia?.ae_video_dtos?.ae_video_d_t_o ?? multimedia?.ae_video_dtos);
  const videos = videoDtos
    .filter((v) => v && (v.media_url || v.url))
    .map((v) => ({
      url: String(v.media_url || v.url),
      poster: v.poster_url || v.poster || null,
      mediaId: v.media_id != null ? String(v.media_id) : null,
      type: v.media_type || 'video',
      status: v.media_status || null,
    }));
  return {
    id,
    title: String(base.subject || ''),
    description: String(base.detail || base.subject || ''),
    images: splitImages(multimedia.image_urls),
    videos,
    sourceUrl: `https://www.aliexpress.com/item/${id}.html`,
    rating: numberOf(base.avg_evaluation_rating, 0),
    orders: intOf(base.sales_count, 0),
    deliveryDays: intOf(logistics.delivery_time, 20),
    categoryId: base.category_id ?? null,
    store,
    packageInfo,
    shipToCountry: logistics.ship_to_country || null,
    variants,
  };
}

const detail = await getProductDetail(productId);
const product = mapProduct(detail);
const adultReason = getAdultReason(product);

const pool = new Pool({ connectionString: hostDatabaseUrl() });
// Resolve taxonomy via ae_categories chain walk + display_name + gender hint.
// CLI flags override the AE response defaults so the same product can be re-imported
// with the correct hints discovered during catalog audit.
const aeCategories = await loadCategories(pool);
const chainCache = await loadFullChainCache(pool);
const taxonomyInput = {
  displayName: cliFlags['display-name'] || product.title,
  labelHint: cliFlags['label-hint'] || '',
  postCatIds: cliFlags['post-cat-ids']
    ? cliFlags['post-cat-ids'].split(',').map((s) => s.trim()).filter(Boolean)
    : (product.categoryId ? [product.categoryId] : []),
  leafCatId: cliFlags['leaf-cat-id'] || product.categoryId || null,
  aeCategoryId: product.categoryId || null,
};
const resolved = resolveTaxonomyV2(taxonomyInput, aeCategories, chainCache);
const taxonomy = {
  department: resolved.department,
  category: resolved.category,
  subcategory: resolved.subcategory,
  leaf: resolved.leaf,
};
const canonicalCategory = resolved.canonical;
const taxonomySlug = resolved.slug;
const classification = {
  confidence: resolved.confidence,
  reason: `ae_resolver_${resolved.reason}${adultReason ? '_adult_checked' : ''}`,
};
const totalStock = product.variants.reduce((sum, variant) => sum + variant.stock, 0);
const activePrices = product.variants.filter((variant) => variant.status === 'active').map((variant) => centsRon(variant.priceRon)).filter(Number.isFinite);
const priceCents = activePrices.length ? Math.min(...activePrices) : centsRon(product.variants[0].priceRon);
const slug = `${slugify(product.title) || 'aliexpress-product'}-${product.id}`;
const metadata = {
  imported_from_official_ae_api: true,
  ae_product_id: product.id,
  ae_category_id: resolved.aeCategoryId ?? product.categoryId,
  ae_root_category_id: resolved.aeRootCategoryId,
  ae_root_category_name: resolved.aeRootCategoryName,
  ae_ship_to_country: product.shipToCountry,
  ae_package: product.packageInfo,
  ae_store: product.store,
  product_type: taxonomy.leaf,
  ae_category_name: taxonomy.leaf,
  taxonomy_resolver_version: 2,
  ae_chain_ids: resolved.chainIds || [],
  ae_chain_names_ro: resolved.chainNamesRo || [],
  taxonomy_unresolved: Boolean(resolved.unresolved),
  taxonomy_unresolved_reason: resolved.unresolvedReason || null,
  images: product.images,
  videos: product.videos,
  ae_video_url: product.videos[0]?.url || null,
  ae_video_poster: product.videos[0]?.poster || null,
  rating: product.rating,
  orders_count: product.orders,
  delivery_days: product.deliveryDays,
};

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const inserted = await client.query(
    `
      INSERT INTO marketplace_products (
        external_product_id, slug, title, description, category, product_url,
        image_url, status, currency, price_cents, compare_at_price_cents,
        inventory_status, metadata, source_type, supplier, supplier_product_id,
        supplier_url, supplier_cost_cents, canonical_category, canonical_category_slug,
        classification_confidence, classification_reason, taxonomy_department,
        taxonomy_category, taxonomy_subcategory, taxonomy_leaf, taxonomy_slug,
        taxonomy_confidence, taxonomy_reason, is_adult, adult_reason, taxonomy_unresolved, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $21, 'RON', $8, NULL,
        $9, $10::jsonb, 'aliexpress', 'aliexpress', $1,
        $6, NULL, $11, $12,
        $13, $14, $15,
        $16, $17, $18, $12,
        $13, $14, $19, $20, $22, now(), now()
      )
      ON CONFLICT (source_type, supplier, supplier_product_id)
      WHERE supplier_product_id IS NOT NULL
      DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        category = EXCLUDED.category,
        product_url = EXCLUDED.product_url,
        image_url = EXCLUDED.image_url,
        status = EXCLUDED.status,
        currency = EXCLUDED.currency,
        price_cents = EXCLUDED.price_cents,
        inventory_status = EXCLUDED.inventory_status,
        metadata = EXCLUDED.metadata,
        canonical_category = EXCLUDED.canonical_category,
        canonical_category_slug = EXCLUDED.canonical_category_slug,
        taxonomy_department = EXCLUDED.taxonomy_department,
        taxonomy_category = EXCLUDED.taxonomy_category,
        taxonomy_subcategory = EXCLUDED.taxonomy_subcategory,
        taxonomy_leaf = EXCLUDED.taxonomy_leaf,
        taxonomy_slug = EXCLUDED.taxonomy_slug,
        taxonomy_confidence = EXCLUDED.taxonomy_confidence,
        taxonomy_reason = EXCLUDED.taxonomy_reason,
        is_adult = EXCLUDED.is_adult,
        adult_reason = EXCLUDED.adult_reason,
        taxonomy_unresolved = EXCLUDED.taxonomy_unresolved,
        updated_at = now()
      RETURNING id::text AS id, slug
    `,
    [
      product.id,
      slug,
      product.title,
      product.description,
      canonicalCategory,
      product.sourceUrl,
      product.images[0] || null,
      priceCents,
      totalStock > 0 ? 'in_stock' : 'out_of_stock',
      JSON.stringify(metadata),
      canonicalCategory,
      taxonomySlug,
      classification.confidence,
      classification.reason,
      taxonomy.department,
      taxonomy.category,
      taxonomy.subcategory,
      taxonomy.leaf,
      Boolean(adultReason),
      adultReason,
      resolved.unresolved ? 'draft' : 'active',
      Boolean(resolved.unresolved),
    ],
  );
  const productDbId = inserted.rows[0].id;
  for (const variant of product.variants) {
    const image = variant.metadata.ae_sku_properties.find((prop) => prop.image)?.image || null;
    await client.query(
      `
        INSERT INTO marketplace_product_variants (
          product_id, external_variant_id, sku, title, attributes,
          currency, price_cents, inventory_quantity, status, metadata, created_at, updated_at
        ) VALUES (
          $1, $2, $2, $3, $4::jsonb,
          'RON', $5, $6, $7, $8::jsonb, now(), now()
        )
        ON CONFLICT (product_id, external_variant_id)
        WHERE external_variant_id IS NOT NULL
        DO UPDATE SET
          sku = EXCLUDED.sku,
          title = EXCLUDED.title,
          attributes = EXCLUDED.attributes,
          price_cents = EXCLUDED.price_cents,
          inventory_quantity = EXCLUDED.inventory_quantity,
          status = EXCLUDED.status,
          metadata = EXCLUDED.metadata,
          updated_at = now()
      `,
      [productDbId, variant.sourceVariantId, variant.title, JSON.stringify({ ...variant.options, image_url: image }), centsRon(variant.priceRon), variant.stock, variant.status, JSON.stringify(variant.metadata)],
    );
  }
  await client.query('COMMIT');
  console.log(JSON.stringify({ imported: true, productId: product.id, productDbId, slug: inserted.rows[0].slug, variants: product.variants.length, totalStock, taxonomy }, null, 2));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
