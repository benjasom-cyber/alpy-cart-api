/**
 * POST /api/generate-quote
 *
 * Generates a direct Alpy.com booking link for a customer quote.
 * Called from Zendesk Action Flows or SKIBOT.
 *
 * Body params:
 *   resort        - resort / town name (required unless shopId given)
 *   shopId        - Odin legacy shop ID (optional - overrides resort lookup)
 *   startDate     - rental start date YYYY-MM-DD (required)
 *   endDate       - rental end date YYYY-MM-DD (required)
 *   lang          - language code (optional, defaults to 'en')
 *   promoCode     - promo code (optional)
 *
 *   Group composition - EITHER the legacy array:
 *   persons       - JSON array [{age, skill, equipment}]
 *   groupSize     - total people, if larger than persons.length sample (optional)
 *
 *   OR the preferred scalar inputs (the API assembles the array itself, so a
 *   generative caller never has to emit a JSON structure):
 *   adults        - integer count of adults (age defaults to ADULT_DEFAULT_AGE)
 *   children_ages - comma separated ages, e.g. "6,8,12"
 *   skill         - beginner | intermediate | expert, applied to the whole group
 *   equipment     - ski | snowboard, applied to the whole group
 *   with_boots    - true/false (default true)
 *   with_helmets  - true/false (default false)
 *
 * `persons` wins when both are supplied, so existing callers are unaffected.
 *
 * PRICING - two independent figures are returned:
 *
 *   cheapestTotalPrice  the historical estimate, from Odin's /offers endpoint.
 *                       It is the cheapest GENERIC basket for a set of ages in
 *                       the resort, so it never matches the cart the customer
 *                       is sent to. Kept for backward compatibility.
 *
 *   cartInStorePrice    the EXACT price of the cart we just built, computed the
 *   cartOnlinePrice     same way the alpy.com cart page computes it: sum
 *                       price[rentalDays] over every product and every addon,
 *                       from core.alpy.com/core/cart/products-information.
 *                       Announce these, not cheapestTotalPrice.
 *                       Both are null unless cartPriceComplete is true.
 *
 * Returns: { cartUrl, shopName, shopId, resort, cartInStorePrice,
 *            cartOnlinePrice, cartPriceComplete, cheapestTotalPrice, shopPrice,
 *            discountAmount, pricePerPerson, personsCount, couponValue,
 *            couponMessage, summary, pricing? }
 */

import { fetchLivePricing, countryToCode } from './_alpyPricing.js';

const SHOPS_URL = 'https://raw.githubusercontent.com/benjasom-cyber/alpy-cart-api/main/api/shops_data.json';
let _shopsCache = null;

async function getShops() {
      if (_shopsCache) return _shopsCache;
      const r = await fetch(SHOPS_URL);
      if (!r.ok) throw new Error('Failed to load shops data: ' + r.status);
      _shopsCache = await r.json();
      return _shopsCache;
}

const PRODUCTS = {
      adult:  { ski: { beginner: 2,   intermediate: 3,  expert: 4  }, snowboard: { beginner: 28, intermediate: 30, expert: 31 } },
      teen:   { ski: { beginner: 129, intermediate: 96, expert: 92 }, snowboard: { beginner: 97, intermediate: 97, expert: 97 } },
      junior: { ski: { beginner: 15,  intermediate: 15, expert: 16 }, snowboard: { beginner: 42, intermediate: 42, expert: 43 } },
      child:  { ski: { beginner: 80,  intermediate: 80, expert: 81 }, snowboard: { beginner: 38, intermediate: 38, expert: 43 } }
};

// Accessory definition ids, as returned by Odin on a booking item.
const ADDON_BOOTS  = 1;
const ADDON_HELMET = 2;

// Age used for an adult when the customer only gives a head count.
const ADULT_DEFAULT_AGE = 35;

// Price grid used by the alpy.com cart page. No authentication required.
const PRODUCTS_INFO_URL = 'https://core.alpy.com/core/cart/products-information';

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

function isTruthy(v) {
      return v === true || v === 1 || v === '1' ||
             (typeof v === 'string' && ['true', 'yes', 'y', 'oui'].includes(v.trim().toLowerCase()));
}

function isFalsy(v) {
      return v === false || v === 0 || v === '0' ||
             (typeof v === 'string' && ['false', 'no', 'n', 'non'].includes(v.trim().toLowerCase()));
}

/** "6,8,12" | "6; 8 / 12" -> [6, 8, 12] */
function parseAgeList(raw) {
      if (raw === undefined || raw === null || raw === '') return [];
      if (Array.isArray(raw)) raw = raw.join(',');
      return String(raw)
        .split(/[^0-9]+/)
        .map(s => parseInt(s, 10))
        .filter(n => Number.isFinite(n) && n >= 0 && n < 100);
}

/**
 * Build the persons array from scalar inputs.
 * A head count cannot lose an entry the way a hand-written JSON array can.
 */
function buildPersonsFromScalars({ adults, childrenAges, skill, equipment }) {
      const nAdults = Math.max(0, parseInt(adults, 10) || 0);
      const ages    = parseAgeList(childrenAges);
      const sk      = ['beginner', 'intermediate', 'expert'].includes(String(skill || '').trim().toLowerCase())
                        ? String(skill).trim().toLowerCase()
                        : 'intermediate';
      const eq      = String(equipment || '').trim().toLowerCase() === 'snowboard' ? 'snowboard' : 'ski';

      const out = [];
      for (let i = 0; i < nAdults; i++) out.push({ age: ADULT_DEFAULT_AGE, skill: sk, equipment: eq });
      for (const a of ages) out.push({ age: a, skill: sk, equipment: eq });
      return out;
}

/**
 * Resolve which accessories go on every product.
 * When neither flag is supplied we keep the historical default (boots only),
 * so existing callers see no change.
 */
function buildAddons({ withBoots, withHelmets }) {
      if (withBoots === undefined && withHelmets === undefined) return [ADDON_BOOTS];

      const addons = [];
      if (!isFalsy(withBoots)) addons.push(ADDON_BOOTS);   // boots default to on
      if (isTruthy(withHelmets)) addons.push(ADDON_HELMET);
      return addons.length ? addons : [ADDON_BOOTS];
}

// ── Exact cart price ─────────────────────────────────────────────────────────
// The alpy.com cart page does not ask a server for its total: it downloads a
// price grid once and adds it up in the browser. We do the same arithmetic here
// so the quote can announce the figure the customer will actually see.

async function fetchPriceGrid(shopId) {
      try {
              const r = await fetch(PRODUCTS_INFO_URL + '?shopId=' + shopId, { headers: { Accept: 'application/json' } });
              if (!r.ok) return null;
              return await r.json();
      } catch (e) {
              console.error('generate-quote: price grid fetch failed for shop ' + shopId, e);
              return null;
      }
}

/** Flatten the grid into definitionId -> { price, currency }, products and addons alike. */
function indexPriceGrid(grid) {
      const map = new Map();
      const visit = (node) => {
              if (!node || typeof node !== 'object') return;
              if (Array.isArray(node)) { node.forEach(visit); return; }
              if (node.definitionId != null && node.price && typeof node.price === 'object' && !map.has(node.definitionId)) {
                        map.set(node.definitionId, { price: node.price, currency: node.priceCurrencyCode || 'EUR' });
              }
              if (node.products) visit(node.products);
              if (node.addons)   visit(node.addons);
      };
      visit(grid && grid.products);
      return map;
}

/** price is a table keyed by rental days, in minor units, plus a plusDay rate. */
function priceForDays(table, days) {
      if (!table) return null;
      const d = Math.max(1, parseInt(days, 10) || 1);
      if (table[d] != null) return Number(table[d]);
      if (table[String(d)] != null) return Number(table[String(d)]);

      const keys = Object.keys(table).filter(k => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
      if (!keys.length) return null;
      const maxK = keys[keys.length - 1];
      const base = Number(table[maxK] != null ? table[maxK] : table[String(maxK)]);
      const plus = Number(table.plusDay || 0);
      return d > maxK ? base + (d - maxK) * plus : base;
}

/**
 * Sum price[days] over every product and every addon of the cart.
 * Returns amounts in major units. `complete` is false as soon as one
 * definitionId is absent from the grid - in that case the caller must not
 * announce a figure rather than announce a wrong one.
 */
function computeCartPrice({ grid, persons, addons, days }) {
      const idx = indexPriceGrid(grid);
      if (!idx.size) return null;

      let minor = 0;
      const missing = [];

      for (const p of persons) {
              const defId = getDefinitionId(p.age, p.skill, p.equipment);
              const entry = idx.get(defId);
              const v     = entry ? priceForDays(entry.price, days) : null;
              if (v == null) missing.push(defId); else minor += v;

              for (const a of addons) {
                        const ae = idx.get(a);
                        const av = ae ? priceForDays(ae.price, days) : null;
                        if (av == null) missing.push(a); else minor += av;
              }
      }

      const first = idx.values().next().value;
      return {
              inStore: Math.round(minor) / 100,
              currency: (first && first.currency) || 'EUR',
              missing: Array.from(new Set(missing)),
              complete: missing.length === 0,
      };
}

const COUPON_TIERS = [
    { min: 4700, coupon: 160 },
    { min: 4270, coupon: 130 },
    { min: 4060, coupon: 125 },
    { min: 3850, coupon: 120 },
    { min: 3640, coupon: 115 },
    { min: 3430, coupon: 110 },
    { min: 3220, coupon: 105 },
    { min: 3010, coupon: 100 },
    { min: 2800, coupon: 95 },
    { min: 2590, coupon: 90 },
    { min: 2380, coupon: 85 },
    { min: 2170, coupon: 80 },
    { min: 1960, coupon: 75 },
    { min: 1750, coupon: 70 },
    { min: 1540, coupon: 65 },
     { min: 1400, coupon: 60 },
    { min: 1260, coupon: 55 },
    { min: 1120, coupon: 50 },
    { min: 980, coupon: 45 },
    { min: 840, coupon: 35 },
    { min: 770, coupon: 30 },
    { min: 700, coupon: 25 },
    { min: 560, coupon: 20 },
    { min: 0, coupon: 0 },
    ];

function calculateCoupon(estimatedTotal) {
      const tier = COUPON_TIERS.find(t => estimatedTotal >= t.min);
      return tier ? tier.coupon : 0;
}

function norm(s) {
      return String(s)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/['‘’`´]/g, '')
        .replace(/[.\-_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function findShop(shops, resort) {
      if (!resort) return null;
      const q   = norm(resort);
      const qNS = q.replace(/\s/g, '');

  for (const s of shops) {
          const t = norm(s.town);
          if (t === q || t.replace(/\s/g, '') === qNS) return s;
  }
      for (const s of shops) {
              const tl = norm(s.town);
              if (tl.includes(q) || tl.replace(/\s/g, '').includes(qNS)) return s;
      }
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

  let claudeParsed = null;
      function tryParseClaudeJson(raw) {
              if (!raw) return null;
              const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
              try {
                        const parsed = JSON.parse(cleaned);
                        if (typeof parsed === 'object' && parsed !== null && 'resort' in parsed) return parsed;
              } catch { /* ignore */ }
              return null;
      }

  if (params.claude_json) {
          claudeParsed = tryParseClaudeJson(params.claude_json);
  }
      if (!claudeParsed && params.resolved_resort_town_name) {
              const v = params.resolved_resort_town_name.trim();
              if (v.startsWith('{')) claudeParsed = tryParseClaudeJson(v);
      }
      if (!claudeParsed && params.resort) {
              const v = params.resort.trim();
              if (v.startsWith('{')) claudeParsed = tryParseClaudeJson(v);
      }

  const {
          resort: resortParam,
          resolved_resort_town_name: resortAlt,
          shopId: shopIdParam,
          lang = 'en',
          startDate: startDateParam,
          start_date: startDateAlt,
          endDate: endDateParam,
          end_date: endDateAlt,
          promoCode = '',
          groupSize: groupSizeParam,
          adults: adultsParam,
          children_ages: childrenAgesParam,
          skill: skillParam,
          equipment: equipmentParam,
          with_boots: withBootsParam,
          with_helmets: withHelmetsParam,
  } = params;

  const resort    = resortParam    || resortAlt    || (claudeParsed && claudeParsed.resort)     || null;
      const startDate = startDateParam || startDateAlt || (claudeParsed && claudeParsed.start_date) || null;
      const endDate   = endDateParam   || endDateAlt   || (claudeParsed && claudeParsed.end_date)   || null;

  let persons = params.persons || (claudeParsed && claudeParsed.persons) || null;
      if (typeof persons === 'string') {
              try { persons = JSON.parse(persons); } catch { persons = null; }
      }

  // No usable array supplied: assemble it here from the scalar inputs.
      let personsBuiltFromScalars = false;
      if (!persons || !Array.isArray(persons) || persons.length === 0) {
              const built = buildPersonsFromScalars({
                        adults: adultsParam,
                        childrenAges: childrenAgesParam,
                        skill: skillParam,
                        equipment: equipmentParam,
              });
              if (built.length) {
                        persons = built;
                        personsBuiltFromScalars = true;
              }
      }

  let shop = null;
      const shops = await getShops();

  if (shopIdParam) {
          const id = parseInt(shopIdParam);
          shop = shops.find(s => s.id === id) || {
                    id, slug: 'shop', country: 'france', region: 'region',
                    town: 'Shop ' + id, name: 'Shop ' + id
          };
  } else if (resort) {
          shop = findShop(shops, String(resort));
          if (!shop) {
                    return res.status(404).json({
                                error: 'No shop found for resort: "' + resort + '". Check spelling or use alpy.com to find a valid resort name.',
                                hint: 'Examples: "Chamonix", "Morzine", "Zermatt", "Val d Isere", "Les Deux Alpes", "St Anton"'
                    });
          }
  } else {
          return res.status(400).json({
                    error: 'Missing required param: resort (or shopId)',
                    example: {
                                resort: 'Chamonix',
                                startDate: '2026-03-21',
                                endDate: '2026-03-28',
                                adults: 2,
                                children_ages: '6,8,12',
                                skill: 'intermediate',
                                equipment: 'ski'
                    }
          });
  }

  const missing = [];
      if (!startDate) missing.push('startDate');
      if (!endDate)   missing.push('endDate');
      if (!persons || !Array.isArray(persons) || persons.length === 0) missing.push('persons (or adults / children_ages)');

  if (missing.length) {
          return res.status(400).json({
                    error: 'Missing required params: ' + missing.join(', '),
                    example: { resort: 'Chamonix', startDate: '2026-03-21', endDate: '2026-03-28',
                                               adults: 2, children_ages: '6,8,12', skill: 'intermediate', equipment: 'ski' }
          });
  }

  const cartAddons = buildAddons({ withBoots: withBootsParam, withHelmets: withHelmetsParam });

  const cartPersons = persons.map(p => ({
          age: parseInt(p.age) || 35,
          skill: p.skill === 'intermediate' ? 'advanced' : (p.skill || 'advanced'),
          products: [{ definitionId: getDefinitionId(p.age, p.skill, p.equipment), addons: cartAddons }]
  }));

  const cart = { promotionCode: promoCode || '', persons: cartPersons, insurances: [] };
      const shopUrl = 'https://www.alpy.com/' + lang + '/ski-rental/' + shop.country + '/' + shop.region + '/' + shop.slug + '/' + shop.id;
      const cartUrl = shopUrl + '/products?cart=' + encodeURIComponent(JSON.stringify(cart)) + '&startDate=' + startDate + '&endDate=' + endDate;

  const personsDesc = persons.map(p =>
          p.age + 'yr ' + (p.skill || 'intermediate') + ' ' + (p.equipment || 'ski')
                                    ).join(', ');

  const days = Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000);

  const pricing = await fetchLivePricing({
          shop, startDate, endDate, persons, getDefinitionId,
          currency: params.currency || 'EUR',
          countryCode: countryToCode(shop.country),
          promoCode,
  });

  // ── Exact cart price, from the same grid the cart page uses ───────────────
      const grid = await fetchPriceGrid(shop.id);
      const cartPrice = grid ? computeCartPrice({ grid, persons, addons: cartAddons, days }) : null;

  // Online discount rate, derived from the live pricing block when present.
      let onlineDiscountRate = null;
      if (pricing && pricing.discountAmount != null && pricing.cheapestTotalPrice) {
              const gross = pricing.cheapestTotalPrice + pricing.discountAmount;
              if (gross > 0) onlineDiscountRate = pricing.discountAmount / gross;
      }

  const cartPriceComplete = !!(cartPrice && cartPrice.complete);
      const cartInStorePrice = cartPriceComplete ? cartPrice.inStore : null;
      const cartOnlinePrice  = (cartInStorePrice != null && onlineDiscountRate != null)
        ? Math.round(cartInStorePrice * (1 - onlineDiscountRate) * 100) / 100
              : null;

      if (cartPrice && !cartPrice.complete) {
              console.error('generate-quote: definitionIds absent from price grid for shop ' + shop.id, cartPrice.missing);
      }

  // When we assembled the array ourselves it is exhaustive, so never scale it:
      // scaling only exists for the legacy case where `persons` was a sample.
      const groupSize = personsBuiltFromScalars
        ? persons.length
              : (groupSizeParam ? parseInt(groupSizeParam) : persons.length);
      const scaleRatio = persons.length > 0 ? groupSize / persons.length : 1;

  let estimatedTotal = null;
      let shopPrice = null;
      let discountAmount = null;
      let pricePerPerson = null;
      let pricingAvailable = false;

  if (pricing && pricing.cheapestTotalPrice) {
          estimatedTotal = Math.round(pricing.cheapestTotalPrice * scaleRatio * 100) / 100;
          pricePerPerson = Math.round((estimatedTotal / groupSize) * 100) / 100;
          pricingAvailable = true;
          if (pricing.discountAmount != null) {
                    discountAmount = Math.round(pricing.discountAmount * scaleRatio * 100) / 100;
                    shopPrice = Math.round((estimatedTotal + discountAmount) * 100) / 100;
          }
  }

  const couponValue = pricingAvailable ? calculateCoupon(estimatedTotal) : 0;
      const couponMessage = couponValue > 0
        ? 'For this basket amount, we can offer a coupon code worth ' + couponValue + ' EUR, to be entered just before payment.'
              : null;

  const topLevelPricing = {
          // Announce these two.
          cartInStorePrice,
          cartOnlinePrice,
          cartPriceCurrency: cartPrice ? cartPrice.currency : null,
          cartPriceComplete,
          cartPriceMissingDefinitionIds: cartPrice ? cartPrice.missing : null,
          // Legacy generic estimate - does not match the cart.
          cheapestTotalPrice: estimatedTotal,
          shopPrice,
          discountAmount,
          pricePerPerson,
          currency: pricing ? pricing.currency : 'EUR',
          rentalDays: pricing ? pricing.rentalDays : days,
          pricingAvailable,
          groupSize,
          personsCount: persons.length,
          couponValue,
          couponCurrency: 'EUR',
          couponMessage,
  };

  return res.status(200).json({
          cartUrl,
          shopUrl,
          shopName: shop.name,
          shopId: shop.id,
          resort: shop.town,
          ...topLevelPricing,
          pricing: pricing || null,
          summary: {
                    shopId: shop.id, shopName: shop.name, resort: shop.town, country: shop.country,
                    startDate, endDate, days, persons: persons.length, personsDetail: personsDesc, lang,
                    addons: cartAddons,
                    cartInStorePrice,
                    cartOnlinePrice,
                    cheapestTotalPrice: estimatedTotal,
                    shopPrice,
                    pricePerPerson,
                    currency: pricing ? pricing.currency : 'EUR',
                    couponValue,
          }
  });
}
