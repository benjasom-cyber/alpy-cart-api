/**
 * POST /api/generate-quote
 *
 * Generates a direct Alpy.com booking link for a customer quote.
 * Called from Zendesk Action Flows or SKIBOT.
 *
 * Body params:
 *   resort        - resort / town name (required unless shopId given)
 *                   e.g. "Chamonix", "Val d'Isère", "Zermatt", "St Anton"
 *   shopId        - Odin legacy shop ID (optional — overrides resort lookup)
 *   startDate     - rental start date YYYY-MM-DD (required)
 *   endDate       - rental end date YYYY-MM-DD (required)
 *   persons       - JSON array [{age, skill, equipment}] (required)
 *                   skill: beginner | intermediate | expert
 *                   equipment: ski | snowboard
 *   lang          - language code (optional, defaults to 'en')
 *   promoCode     - promo code (optional)
 *
 * Returns: { cartUrl, shopName, shopId, resort, summary, pricing? }
 *   pricing is added when Odin live pricing is available:
 *   { cheapestTotalPrice, currency, pricePerPerson, shopName, rentalDays }
 */

import { getOdinToken } from './odin-auth.js';

const ODIN_BASE = 'https://odin.alpy.com';

// ── Live pricing from Odin ────────────────────────────────────────────────────
/**
 * Fetch the cheapest offer for a town from Odin's pricing API.
 * Returns a pricing object or null if unavailable (non-blocking).
 */
async function fetchCheapestPrice({ townPath, startDate, endDate, persons, currency = 'EUR', countryCode = 'FR', promoCode }) {
  try {
    const token = await getOdinToken();
    const rentalDays = Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000);
    const ages = persons.map(p => parseInt(p.age) || 35);
    const startDateISO = new Date(startDate).toISOString();

    const offerParams = new URLSearchParams({ currency, startDate: startDateISO, rentalDays, countryCode });
    ages.forEach(a => offerParams.append('ages[]', a));
    if (promoCode) offerParams.set('promoCode', promoCode);

    const res = await fetch(
      `${ODIN_BASE}/api/v2/location/town/${encodeURIComponent(townPath)}/offers?${offerParams}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );
    if (!res.ok) return null;

    const data = await res.json();
    const offerList = Array.isArray(data) ? data : data.data || data.offers || [];
    if (!offerList.length) return null;

    // Find cheapest total offer across all shops
    let best = null;
    let bestTotal = Infinity;
    for (const offer of offerList) {
      const total = offer.totalPrice ?? offer.price ?? offer.total ?? offer.amount;
      if (typeof total === 'number' && total < bestTotal) {
        bestTotal = total;
        best = offer;
      }
    }
    if (!best) return null;

    return {
      cheapestTotalPrice: bestTotal,
      pricePerPerson: persons.length > 0 ? Math.round((bestTotal / persons.length) * 100) / 100 : bestTotal,
      currency,
      rentalDays,
      shopName: best.shopName || best.shop?.name || null,
    };
  } catch {
    return null; // Pricing is optional — never break the cart URL generation
  }
}

// ── Shops dataset (1008 shops, 7 countries) ──────────────────────────────────
// Loaded once per process instance and cached in memory.
// Source: SKIBOT app shops_data.js (same dataset, same first-result logic)
const SHOPS_URL = 'https://raw.githubusercontent.com/benjasom-cyber/alpy-cart-api/main/api/shops_data.json';
let _shopsCache = null;

async function getShops() {
  if (_shopsCache) return _shopsCache;
  const r = await fetch(SHOPS_URL);
  if (!r.ok) throw new Error(`Failed to load shops data: ${r.status}`);
  _shopsCache = await r.json();
  return _shopsCache;
}

// ── Product definition IDs ────────────────────────────────────────────────────
const PRODUCTS = {
  adult:  { ski: { beginner: 2,   intermediate: 3,  expert: 4  }, snowboard: { beginner: 28, intermediate: 30, expert: 31 } },
  teen:   { ski: { beginner: 129, intermediate: 96, expert: 92 }, snowboard: { beginner: 97, intermediate: 97, expert: 97 } },
  junior: { ski: { beginner: 15,  intermediate: 15, expert: 16 }, snowboard: { beginner: 42, intermediate: 42, expert: 43 } },
  child:  { ski: { beginner: 80,  intermediate: 80, expert: 81 }, snowboard: { beginner: 38, intermediate: 38, expert: 43 } }
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Webhook-Secret',
};

function getCategory(age) {
  if (age <= 6)  return 'child';
  if (age <= 12) return 'junior';
  if (age <= 17) return 'teen';
  return 'adult';
}

function getDefinitionId(age, skill, equipment) {
  const cat   = getCategory(parseInt(age) || 35);
  const equip = equipment === 'snowboard' ? 'snowboard' : 'ski';
  const sk    = ['beginner', 'intermediate', 'expert'].includes(skill) ? skill : 'intermediate';
  return PRODUCTS[cat][equip][sk];
}

/** Normalize: lowercase + strip diacritics + strip apostrophes/dots/hyphens */
function norm(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[''`']/g, '')
    .replace(/[.\-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find first shop matching a resort/town name.
 * Same logic as SKIBOT: town match first, then shop name match.
 * Returns the first result in dataset order (= default shown in SKIBOT).
 */
function findShop(shops, resort) {
  if (!resort) return null;
  const q   = norm(resort);
  const qNS = q.replace(/\s/g, '');

  // 1. Exact town
  for (const s of shops) {
    const t = norm(s.town);
    if (t === q || t.replace(/\s/g, '') === qNS) return s;
  }
  // 2. Partial town
  for (const s of shops) {
    const tl = norm(s.town);
    if (tl.includes(q) || tl.replace(/\s/g, '').includes(qNS)) return s;
  }
  // 3. Partial shop name
  for (const s of shops) {
    const nl = norm(s.name);
    if (nl.includes(q) || nl.replace(/\s/g, '').includes(qNS)) return s;
  }
  return null;
}

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  const params = req.method === 'POST' ? req.body : req.query;

  // ── Support claude_json shorthand (single-param input from Zendesk flow) ────
  // When the Claude "Detect quote intent" step output is passed directly,
  // parse it and extract individual fields.
  // Supports two patterns:
  //   1. params.claude_json = full JSON string
  //   2. params.resort / params.resolved_resort_town_name starts with "{" (JSON blob)
  let claudeParsed = null;
  function tryParseClaudeJson(raw) {
    if (!raw) return null;
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
      const parsed = JSON.parse(cleaned);
      // Only accept if it looks like a Claude quote-intent response
      if (typeof parsed === 'object' && parsed !== null && 'resort' in parsed) return parsed;
    } catch { /* ignore */ }
    return null;
  }

  if (params.claude_json) {
    claudeParsed = tryParseClaudeJson(params.claude_json);
  }
  // Fallback: resort field passed as full JSON blob
  if (!claudeParsed && params.resolved_resort_town_name) {
    const v = params.resolved_resort_town_name.trim();
    if (v.startsWith('{')) claudeParsed = tryParseClaudeJson(v);
  }
  if (!claudeParsed && params.resort) {
    const v = params.resort.trim();
    if (v.startsWith('{')) claudeParsed = tryParseClaudeJson(v);
  }

  const {
    resort:                       resortParam,
    resolved_resort_town_name:    resortAlt,   // Zendesk Custom Action field name
    shopId:                       shopIdParam,
    lang                        = 'en',
    startDate:                    startDateParam,
    start_date:                   startDateAlt,  // snake_case alias
    endDate:                      endDateParam,
    end_date:                     endDateAlt,    // snake_case alias
    promoCode = '',
  } = params;

  // Merge: explicit params win over claude_json
  const resort    = resortParam    || resortAlt    || (claudeParsed && claudeParsed.resort)     || null;
  const startDate = startDateParam || startDateAlt || (claudeParsed && claudeParsed.start_date) || null;
  const endDate   = endDateParam   || endDateAlt   || (claudeParsed && claudeParsed.end_date)   || null;

  let persons = params.persons || (claudeParsed && claudeParsed.persons) || null;
  if (typeof persons === 'string') {
    try { persons = JSON.parse(persons); } catch { persons = null; }
  }

  // ── Resolve shop ──────────────────────────────────────────────────────────
  let shop = null;
  const shops = await getShops();

  if (shopIdParam) {
    const id = parseInt(shopIdParam);
    shop = shops.find(s => s.id === id) || {
      id, slug: 'shop', country: 'france', region: 'region',
      town: `Shop ${id}`, name: `Shop ${id}`
    };
  } else if (resort) {
    shop = findShop(shops, String(resort));
    if (!shop) {
      return res.status(404).json({
        error: `No shop found for resort: "${resort}". Check spelling or use alpy.com to find a valid resort name.`,
        hint: 'Examples: "Chamonix", "Morzine", "Zermatt", "Val d\'Isère", "Les Deux Alpes", "St Anton"'
      });
    }
  } else {
    return res.status(400).json({
      error: 'Missing required param: resort (or shopId)',
      example: {
        resort: 'Chamonix',
        startDate: '2026-03-21',
        endDate: '2026-03-28',
        persons: [{ age: 35, skill: 'intermediate', equipment: 'ski' }]
      }
    });
  }

  // ── Validate ──────────────────────────────────────────────────────────────
  const missing = [];
  if (!startDate) missing.push('startDate');
  if (!endDate)   missing.push('endDate');
  if (!persons || !Array.isArray(persons) || persons.length === 0) missing.push('persons');

  if (missing.length) {
    return res.status(400).json({
      error: `Missing required params: ${missing.join(', ')}`,
      example: { resort: 'Chamonix', startDate: '2026-03-21', endDate: '2026-03-28',
                 persons: [{ age: 35, skill: 'intermediate', equipment: 'ski' }] }
    });
  }

  // ── Build cart ────────────────────────────────────────────────────────────
  const cartPersons = persons.map(p => ({
    age:      parseInt(p.age) || 35,
    skill:    p.skill === 'intermediate' ? 'advanced' : (p.skill || 'advanced'),
    products: [{ definitionId: getDefinitionId(p.age, p.skill, p.equipment), addons: [1] }]
  }));

  const cart = { promotionCode: promoCode || '', persons: cartPersons, insurances: [] };
  const shopUrl  = `https://www.alpy.com/${lang}/ski-rental/${shop.country}/${shop.region}/${shop.slug}/${shop.id}`;
  const cartUrl  = `${shopUrl}/products?cart=${encodeURIComponent(JSON.stringify(cart))}&startDate=${startDate}&endDate=${endDate}`;

  const personsDesc = persons.map(p =>
    `${p.age}yr ${p.skill || 'intermediate'} ${p.equipment || 'ski'}`
  ).join(', ');

  const days = Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000);

  // ── Fetch live pricing from Odin (non-blocking) ──────────────────────────
  const townPath = `${shop.country}/${shop.region}/${shop.slug}`;
  const pricing = await fetchCheapestPrice({
    townPath, startDate, endDate, persons,
    currency: params.currency || 'EUR',
    countryCode: shop.country === 'france' ? 'FR'
               : shop.country === 'austria' ? 'AT'
               : shop.country === 'switzerland' ? 'CH'
               : shop.country === 'italy' ? 'IT'
               : shop.country === 'germany' ? 'DE'
               : 'FR',
    promoCode,
  });

  // Expose pricing fields at top level so Zendesk Action Flow variables can reference them directly
  // (Zendesk flattens top-level JSON keys into step variables, e.g. step_3.cheapesttotalprice)
  const topLevelPricing = pricing ? {
    cheapestTotalPrice: pricing.cheapestTotalPrice,
    pricePerPerson:     pricing.pricePerPerson,
    currency:           pricing.currency,
    rentalDays:         pricing.rentalDays,
    pricingAvailable:   true,
  } : {
    cheapestTotalPrice: null,
    pricePerPerson:     null,
    currency:           'EUR',
    rentalDays:         days,
    pricingAvailable:   false,
  };

  return res.status(200).json({
    cartUrl,
    shopUrl,
    shopName: shop.name,
    shopId:   shop.id,
    resort:   shop.town,
    // Flat pricing fields for Zendesk variable access
    ...topLevelPricing,
    // Full nested pricing object (for direct API callers)
    pricing:  pricing || null,
    summary: {
      shopId: shop.id, shopName: shop.name, resort: shop.town, country: shop.country,
      startDate, endDate, days, persons: persons.length, personsDetail: personsDesc, lang,
      ...(pricing && {
        cheapestTotalPrice: pricing.cheapestTotalPrice,
        pricePerPerson: pricing.pricePerPerson,
        currency: pricing.currency,
      }),
    }
  });
}
