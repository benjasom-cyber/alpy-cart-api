/**
 * POST /api/generate-quote
 *
 * Generates a direct Alpy.com booking link for a customer quote.
 * Called from Zendesk Action Flows or SKIBOT.
 *
 * ─── TWO WAYS TO PASS THE REQUEST ───────────────────────────────────────────
 *
 * A) Individual scalar params (SKIBOT / direct callers):
 *      adults, children_ages, skill, equipment, with_boots, with_helmets,
 *      resort, startDate, endDate
 *
 * B) One JSON blob in `claude_json` (Zendesk action flows):
 *      A Zendesk "Send prompt" step returns a single blob, and the variable
 *      picker only ever offers "Entire output" - it never exposes the fields
 *      inside. So the whole object is passed in one input and parsed here.
 *      Recognised keys:
 *        resort, start_date, end_date, adults, children_ages, skill,
 *        equipment, with_boots, with_helmets, language
 *
 * Individual params always win over claude_json, field by field.
 *
 * ─── WHY quoteLine EXISTS ────────────────────────────────────────────────────
 *
 * A Zendesk generative PROCEDURE cannot read a custom action's output: a
 * "Collect parameter" step is an LLM inference slot, not a wire. Observed on
 * 30/07/2026: shopname was filled with "la plagne" (the customer's own words)
 * instead of "Ski Republic Montchavin Village"; a declared quoteline output,
 * visibly populated in the action's Test tab, never appeared in a conversation;
 * and the one price ever displayed did not reconcile with our own coupon table.
 * An ACTION FLOW is different - steps are wired explicitly - which is why the
 * quote now runs as a flow and not from a procedure.
 *
 * quoteLine is one ready-to-send sentence. The `if` that decides whether to
 * state a price lives here, in code, where it cannot be misread.
 *
 * ─── PRICING ────────────────────────────────────────────────────────────────
 *   cartInStorePrice / cartOnlinePrice  EXACT price of the cart we built,
 *     computed the way the alpy.com cart page computes it: sum price[rentalDays]
 *     over every product and every addon, from
 *     core.alpy.com/core/cart/products-information. Verified: 373,00 EUR
 *     computed vs 373,00 EUR displayed by the basket.
 *   cheapestTotalPrice  legacy generic estimate from Odin /offers. Never matches
 *     the cart (103 vs 180 on one measured case). Do not announce it.
 *
 * Two traps in that grid, both handled below:
 *   - addon prices are per product. Boots for 6 days cost 5000 on an adult ski,
 *     4000 on a junior, 3000 on a child. Read them from the person's own
 *     product node, never from a global lookup.
 *   - definitionId is not unique across kinds. Id 2 is BOTH "adult beginner
 *     ski" (a product) and "helmet" (an addon). Products and addons therefore
 *     live in separate namespaces here.
 *
 * PRECEDENCE on group composition: the scalar inputs WIN over `persons`. A
 * generative caller reliably gets a head count right and reliably gets a
 * hand-written array wrong - observed: a "2 adults + 3 children" request arrived
 * as a two-element persons array while group_size said 5, which both shrank the
 * cart and inflated the price by the 5/2 scale ratio.
 */

import { fetchLivePricing, countryToCode } from './_alpyPricing.js';

// Localised "ski rental" URL segment, taken from the hreflang alternates that
// alpy.com publishes on every shop page. Verified 2026-08-01.
const RENTAL_SEGMENT = {
      en: 'ski-rental',
      fr: 'location-ski',
      de: 'skiverleih',
      it: 'noleggio-ski',
      nl: 'skiverhuur',
      es: 'alquiler-de-esquis',
      da: 'skileje',
      cs: 'pujcovna-lyzi',
      pl: 'wypozyczalnia-nart',
      sk: 'pozicovna-lyzi',
};

// alpy.com applies the running campaign to the basket by itself, even when the
// cart URL carries an empty promotionCode. Quoting without it understated the
// discount and the announced price came out ~3% above the basket (941,50 vs
// 913,27 on Val d'Isere, 21-27/02/2027). Send the campaign explicitly so the
// figure we announce is the figure the customer sees.
// When marketing changes the campaign, set ALPY_PROMO_CODE in Vercel. If the
// code is stale the offer endpoint simply falls back to the base rate, so we
// quote slightly high - never lower than the basket.
const ACTIVE_PROMO_CODE = process.env.ALPY_PROMO_CODE || 'SKI26';

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

const ADDON_BOOTS  = 1;
const ADDON_HELMET = 2;
const ADULT_DEFAULT_AGE = 35;

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

function hasValue(v) {
      return v !== undefined && v !== null && String(v).trim() !== '' && String(v).trim().toLowerCase() !== 'null';
}

/** "6,8,12" | "6; 8 / 12" | [6,8,12] -> [6, 8, 12] */
function parseAgeList(raw) {
      if (raw === undefined || raw === null || raw === '') return [];
      if (Array.isArray(raw)) raw = raw.join(',');
      return String(raw)
        .split(/[^0-9]+/)
        .map(s => parseInt(s, 10))
        .filter(n => Number.isFinite(n) && n >= 0 && n < 100);
}

/** A head count cannot lose an entry the way a hand-written JSON array can. */
function buildPersonsFromScalars({ adults, childrenAges, skill, equipment }) {
      const nAdults = Math.max(0, parseInt(adults, 10) || 0);
      const ages    = parseAgeList(childrenAges);
      const sk      = ['beginner', 'intermediate', 'expert'].includes(String(skill || '').trim().toLowerCase())
                        ? String(skill).trim().toLowerCase()
                        : 'intermediate';
      const eq      = String(equipment || '').trim().toLowerCase().includes('snowboard') ? 'snowboard' : 'ski';

      const out = [];
      for (let i = 0; i < nAdults; i++) out.push({ age: ADULT_DEFAULT_AGE, skill: sk, equipment: eq });
      for (const a of ages) out.push({ age: a, skill: sk, equipment: eq });
      return out;
}

/** Boots default to on. Both flags absent keeps the historical default [1]. */
function buildAddons({ withBoots, withHelmets }) {
      if (withBoots === undefined && withHelmets === undefined) return [ADDON_BOOTS];

      const addons = [];
      if (!isFalsy(withBoots)) addons.push(ADDON_BOOTS);
      if (isTruthy(withHelmets)) addons.push(ADDON_HELMET);
      return addons.length ? addons : [ADDON_BOOTS];
}

// ── Exact cart price ─────────────────────────────────────────────────────────

async function fetchPriceGrid(shopId) {
      try {
              const r = await fetch(PRODUCTS_INFO_URL + '?shopId=' + shopId, { headers: { Accept: 'application/json' } });
              if (!r.ok) {
                        console.error('generate-quote: price grid HTTP ' + r.status + ' for shop ' + shopId);
                        return null;
              }
              return await r.json();
      } catch (e) {
              console.error('generate-quote: price grid fetch failed for shop ' + shopId, e);
              return null;
      }
}

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

/** Products only. Addons are NOT indexed here - definitionId collides. */
function indexProducts(grid) {
      const map = new Map();
      for (const cat of (grid && grid.products) || []) {
              for (const p of (cat && cat.products) || []) {
                        if (p && p.definitionId != null && p.price && !map.has(p.definitionId)) map.set(p.definitionId, p);
              }
      }
      return map;
}

function computeCartPrice({ grid, persons, addons, days }) {
      const products = indexProducts(grid);
      if (!products.size) return null;

      let minor = 0;
      let currency = 'EUR';
      const missing = [];

      for (const person of persons) {
              const defId = getDefinitionId(person.age, person.skill, person.equipment);
              const node  = products.get(defId);
              if (!node) { missing.push('product:' + defId); continue; }

              currency = node.priceCurrencyCode || currency;

              const base = priceForDays(node.price, days);
              if (base == null) missing.push('product:' + defId); else minor += base;

              for (const addonId of addons) {
                        const a  = ((node.addons) || []).find(x => x && x.definitionId === addonId);
                        const av = a ? priceForDays(a.price, days) : null;
                        if (av == null) missing.push('addon:' + addonId + '@product:' + defId); else minor += av;
              }
      }

      return {
              inStore: Math.round(minor) / 100,
              currency,
              missing: Array.from(new Set(missing)),
              complete: missing.length === 0,
      };
}

// ── The ready-to-send sentence ───────────────────────────────────────────────

function formatMoney(amount, currency) {
      return amount.toFixed(2).replace('.', ',') + ' ' + (currency || 'EUR');
}

function formatDate(iso) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
      return m ? m[3] + '/' + m[2] + '/' + m[1] : String(iso || '');
}

function describeGroup(persons) {
      const adults = persons.filter(p => getCategory(parseInt(p.age) || 35) === 'adult').length;
      const kids   = persons.filter(p => getCategory(parseInt(p.age) || 35) !== 'adult')
                            .map(p => parseInt(p.age))
                            .filter(n => Number.isFinite(n))
                            .sort((a, b) => a - b);

      const bits = [];
      if (adults) bits.push(adults + (adults > 1 ? ' adults' : ' adult'));
      if (kids.length) bits.push(kids.length + (kids.length > 1 ? ' children' : ' child') + ' (' + kids.join(', ') + ' years old)');
      return bits.join(' and ') || persons.length + ' people';
}

function describeEquipment(addons, persons) {
      const eq = (persons[0] && persons[0].equipment === 'snowboard') ? 'snowboard' : 'skis';
      const bits = [eq];
      if (addons.includes(ADDON_BOOTS))  bits.push('boots');
      if (addons.includes(ADDON_HELMET)) bits.push('helmets');
      return bits.join(' + ');
}

function buildQuoteLine({ shop, persons, addons, startDate, endDate, days, price, currency, cartUrl, couponValue }) {
      const head = 'Selected partner shop: ' + shop.name + ', in ' + shop.town + '. ' +
                   'Group of ' + persons.length + ' (' + describeGroup(persons) + '), ' +
                   'from ' + formatDate(startDate) + ' to ' + formatDate(endDate) +
                   ' (' + days + (days > 1 ? ' days' : ' day') + '), ' +
                   describeEquipment(addons, persons) + '.';

      const priceBit = price != null
        ? ' Online price for the whole group: ' + formatMoney(price, currency) + '.'
              : ' The exact price is shown in the basket at the link below.';

      const couponBit = (price != null && couponValue > 0)
        ? ' A coupon worth ' + couponValue + ' EUR can be applied just before payment.'
              : '';

      return head + priceBit + couponBit + ' Book directly here: ' + cartUrl;
}

// Source of truth: "calculation-coupon-code-size-for-groups.xlsx".
// That sheet is indexed on the NUMBER OF PEOPLE and starts at 8. The euro
// column is only an indication (average basket of 70 EUR per person), to be
// used when the exact basket is known and yields a HIGHER coupon. A group of
// fewer than 8 gets nothing, whatever the amount.
const COUPON_MIN_GROUP_SIZE = 8;
const COUPON_AVG_BASKET_PER_PERSON = 70;

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
    { min: 910, coupon: 40 },
    { min: 840, coupon: 35 },
    { min: 770, coupon: 30 },
    { min: 700, coupon: 25 },
    { min: 560, coupon: 20 },
    { min: 0, coupon: 0 },
    ];

function calculateCoupon({ groupSize, basketAmount }) {
      const n = parseInt(groupSize, 10) || 0;
      if (n < COUPON_MIN_GROUP_SIZE) return 0;

      // Headcount sets the baseline; a known basket can only raise it.
      const byHeadcount = n * COUPON_AVG_BASKET_PER_PERSON;
      const basis = Math.max(byHeadcount, Number(basketAmount) || 0);

      const tier = COUPON_TIERS.find(t => basis >= t.min);
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

  // ── claude_json: one blob from a Send prompt step ─────────────────────────
      let claudeParsed = null;
      function tryParseClaudeJson(raw) {
              if (!raw) return null;
              let cleaned = String(raw).trim()
                .replace(/^```(?:json)?\s*/i, '')
                .replace(/\s*```$/, '')
                .trim();
              // A model sometimes wraps the object in prose: take the outermost braces.
              const first = cleaned.indexOf('{');
              const last  = cleaned.lastIndexOf('}');
              if (first > 0 || (last > -1 && last < cleaned.length - 1)) {
                        if (first > -1 && last > first) cleaned = cleaned.slice(first, last + 1);
              }
              try {
                        const parsed = JSON.parse(cleaned);
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
              } catch { /* ignore */ }
              return null;
      }

  if (params.claude_json) claudeParsed = tryParseClaudeJson(params.claude_json);
      if (!claudeParsed && params.resolved_resort_town_name && String(params.resolved_resort_town_name).trim().startsWith('{')) {
              claudeParsed = tryParseClaudeJson(params.resolved_resort_town_name);
      }
      if (!claudeParsed && params.resort && String(params.resort).trim().startsWith('{')) {
              claudeParsed = tryParseClaudeJson(params.resort);
      }

  const cj = claudeParsed || {};

  const {
          resort: resortParam,
          resolved_resort_town_name: resortAlt,
          shopId: shopIdParam,
          lang: langParam,
          startDate: startDateParam,
          start_date: startDateAlt,
          endDate: endDateParam,
          end_date: endDateAlt,
          promoCode = '',
          groupSize: groupSizeParam,
          group_size: groupSizeAlt,
          adults: adultsParam,
          children_ages: childrenAgesParam,
          skill: skillParam,
          equipment: equipmentParam,
          with_boots: withBootsParam,
          with_helmets: withHelmetsParam,
  } = params;

  // Individual params win field by field; claude_json fills the gaps.
      const pick  = (direct, fromCj) => hasValue(direct) ? direct : (hasValue(fromCj) ? fromCj : undefined);
      const pickB = (direct, fromCj) => (direct !== undefined && direct !== null && String(direct).trim() !== '')
                                          ? direct
                                          : (fromCj !== undefined && fromCj !== null ? fromCj : undefined);

  const resortRaw = pick(resortParam, undefined) || pick(resortAlt, undefined) || pick(undefined, cj.resort) || null;
      const resort  = (resortRaw && !String(resortRaw).trim().startsWith('{')) ? resortRaw : (hasValue(cj.resort) ? cj.resort : null);

      const startDate = pick(startDateParam, undefined) || pick(startDateAlt, undefined) || pick(undefined, cj.start_date) || null;
      const endDate   = pick(endDateParam,   undefined) || pick(endDateAlt,   undefined) || pick(undefined, cj.end_date)   || null;

      const lang = pick(langParam, cj.language) || 'en';

      const adultsEff       = pick(adultsParam,       cj.adults);
      const childrenAgesEff = pick(childrenAgesParam, cj.children_ages);
      const skillEff        = pick(skillParam,        cj.skill);
      const equipmentEff    = pick(equipmentParam,    cj.equipment);
      const withBootsEff    = pickB(withBootsParam,   cj.with_boots);
      const withHelmetsEff  = pickB(withHelmetsParam, cj.with_helmets);

  // ── Group composition: scalars win over any persons array ─────────────────
      let persons = null;
      let personsSource = 'none';

      const scalarPersons = buildPersonsFromScalars({
              adults: adultsEff,
              childrenAges: childrenAgesEff,
              skill: skillEff,
              equipment: equipmentEff,
      });

      if (scalarPersons.length && (hasValue(adultsEff) || hasValue(childrenAgesEff))) {
              persons = scalarPersons;
              personsSource = 'scalars';
      } else {
              let legacy = params.persons || cj.persons || null;
              if (typeof legacy === 'string') {
                        try { legacy = JSON.parse(legacy); } catch { legacy = null; }
              }
              if (Array.isArray(legacy) && legacy.length) {
                        persons = legacy;
                        personsSource = 'array';
              }
      }

      const personsBuiltFromScalars = personsSource === 'scalars';

  let shop = null;
      const shops = await getShops();

  if (hasValue(shopIdParam)) {
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
                    error: 'Missing required param: resort (or shopId, or resort inside claude_json)',
                    example: {
                                resort: 'Chamonix', startDate: '2027-03-21', endDate: '2027-03-28',
                                adults: 2, children_ages: '6,8,12', skill: 'intermediate', equipment: 'ski'
                    }
          });
  }

  const missing = [];
      if (!startDate) missing.push('startDate');
      if (!endDate)   missing.push('endDate');
      if (!persons || !Array.isArray(persons) || persons.length === 0) missing.push('adults / children_ages (or persons)');

  if (missing.length) {
          return res.status(400).json({
                    error: 'Missing required params: ' + missing.join(', '),
                    receivedClaudeJson: !!claudeParsed,
                    example: { resort: 'Chamonix', startDate: '2027-03-21', endDate: '2027-03-28',
                                               adults: 2, children_ages: '6,8,12', skill: 'intermediate', equipment: 'ski' }
          });
  }

  const cartAddons = buildAddons({ withBoots: withBootsEff, withHelmets: withHelmetsEff });

  const cartPersons = persons.map(p => ({
          age: parseInt(p.age) || 35,
          skill: p.skill === 'intermediate' ? 'advanced' : (p.skill || 'advanced'),
          products: [{ definitionId: getDefinitionId(p.age, p.skill, p.equipment), addons: cartAddons }]
  }));

  const effectivePromoCode = promoCode || ACTIVE_PROMO_CODE;

  const cart = { promotionCode: effectivePromoCode, persons: cartPersons, insurances: [] };
      // The "ski-rental" path segment is localised, and the country/region/town
      // segments are localised too (de: frankreich, es: francia/rodano-alpes).
      // Rebuilding that path by hand produced 404s. The site exposes a short
      // canonical form in its own JSON-LD - /{lang}/{segment}/products?shopId=N -
      // which server-redirects to the correct localised path. Use that instead.
      // Only emit a locale the site actually serves - anything else 404s.
      const urlLang = RENTAL_SEGMENT[String(lang).slice(0, 2).toLowerCase()] ? String(lang).slice(0, 2).toLowerCase() : 'en';
      const shopUrl = 'https://www.alpy.com/' + urlLang + '/' + RENTAL_SEGMENT[urlLang] + '/products?shopId=' + shop.id;
      const cartUrl = shopUrl + '&cart=' + encodeURIComponent(JSON.stringify(cart)) + '&startDate=' + startDate + '&endDate=' + endDate;

  const personsDesc = persons.map(p =>
          p.age + 'yr ' + (p.skill || 'intermediate') + ' ' + (p.equipment || 'ski')
                                    ).join(', ');

  // alpy.com counts the end date as a rented day: 24/01 to 31/01 is 8
  // days, not 7. Odin agrees - B16YRC runs 07/03 to 13/03 with
  // durationInDays 7. Measured on shop 461, 24-31/01/2027: basket
  // 236,00 EUR in store for 8 days, 213,00 EUR for 7. The old count
  // understated every quote by a full rental day, always in the
  // direction the customer discovers at payment.
  const days = Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1;

  const pricing = await fetchLivePricing({
          shop, startDate, endDate, persons, getDefinitionId,
          currency: params.currency || 'EUR',
          countryCode: countryToCode(shop.country),
          promoCode: effectivePromoCode,
  });

  const grid = await fetchPriceGrid(shop.id);
      const cartPrice = grid ? computeCartPrice({ grid, persons, addons: cartAddons, days }) : null;

      let onlineDiscountRate = null;
      if (pricing && pricing.discountAmount != null && pricing.cheapestTotalPrice) {
              const gross = pricing.cheapestTotalPrice + pricing.discountAmount;
              if (gross > 0) onlineDiscountRate = pricing.discountAmount / gross;
      }

  const cartPriceComplete = !!(cartPrice && cartPrice.complete);
      const cartPriceCurrency = cartPrice ? cartPrice.currency : 'EUR';
      const cartInStorePrice = cartPriceComplete ? cartPrice.inStore : null;
      const cartOnlinePrice  = (cartInStorePrice != null && onlineDiscountRate != null)
        ? Math.round(cartInStorePrice * (1 - onlineDiscountRate) * 100) / 100
              : null;

      if (cartPrice && !cartPrice.complete) {
              console.error('generate-quote: price grid lookups failed for shop ' + shop.id, cartPrice.missing);
      }

  const declaredGroupSize = hasValue(groupSizeParam) ? parseInt(groupSizeParam, 10)
                          : hasValue(groupSizeAlt)   ? parseInt(groupSizeAlt, 10)
                          : null;

      const groupSize  = personsBuiltFromScalars ? persons.length : (declaredGroupSize || persons.length);
      const scaleRatio = personsBuiltFromScalars ? 1 : (persons.length > 0 ? groupSize / persons.length : 1);

      const groupSizeMismatch = declaredGroupSize != null && declaredGroupSize !== persons.length;
      if (groupSizeMismatch) {
              console.error('generate-quote: declared group size ' + declaredGroupSize +
                            ' but built ' + persons.length + ' persons (source: ' + personsSource + ')');
      }

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

  // The coupon is entered at payment, so it must be sized on what the customer
  // actually pays online - not on the in-store rate, which is materially higher
  // and was pushing small baskets over the tier thresholds.
  const couponBasis = cartOnlinePrice != null ? cartOnlinePrice
                    : (cartInStorePrice != null ? cartInStorePrice : estimatedTotal);
      const couponValue = calculateCoupon({ groupSize: persons.length, basketAmount: couponBasis });
      const couponMessage = couponValue > 0
        ? 'For this basket amount, we can offer a coupon code worth ' + couponValue + ' EUR, to be entered just before payment.'
              : null;

  const quoteHasPrice = cartOnlinePrice != null;
      const quoteLine = buildQuoteLine({
              shop, persons, addons: cartAddons, startDate, endDate, days,
              price: cartOnlinePrice, currency: cartPriceCurrency, cartUrl, couponValue,
      });

  const topLevelPricing = {
          quoteLine,
          quoteline: quoteLine,
          quoteHasPrice,
          quotehasprice: quoteHasPrice,
          detectedLanguage: lang,
          cartInStorePrice,
          cartOnlinePrice,
          cartPriceCurrency,
          cartPriceComplete,
          cartPriceMissingDefinitionIds: cartPrice ? cartPrice.missing : null,
          cheapestTotalPrice: estimatedTotal,
          shopPrice,
          discountAmount,
          pricePerPerson,
          currency: pricing ? pricing.currency : 'EUR',
          rentalDays: pricing ? pricing.rentalDays : days,
          pricingAvailable,
          groupSize,
          personsCount: persons.length,
          personsSource,
          groupSizeMismatch,
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
                    personsSource,
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
