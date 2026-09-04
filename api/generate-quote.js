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
 * PRECEDENCE on group composition: the scalar inputs WIN over `persons` WHEN THE
 * TWO DISAGREE ON HEADCOUNT. A generative caller reliably gets a head count
 * right and reliably gets a hand-written array wrong - observed: a "2 adults + 3
 * children" request arrived as a two-element persons array while group_size said
 * 5, which both shrank the cart and inflated the price by the 5/2 scale ratio.
 *
 * But when the array agrees on how many people there are, it is the BETTER
 * source, because it is the only one that can say who rides what. The scalars
 * carry ONE discipline and ONE level for the whole party, and a family of two
 * snowboarding adults and three beginner children on skis cannot be described
 * that way at all - one of the two groups gets the other's equipment, and the
 * price is wrong for everybody. The ZAF app has always asked per skier; the
 * email path could not, which is the gap this closes.
 *
 * So: same headcount -> merge, taking ages from the scalars (children_ages is
 * authoritative) and discipline, level and accessories from the array.
 * Different headcount -> scalars, exactly as before.
 */

import { fetchLivePricing, countryToCode } from './_alpyPricing.js';
import { resolveDomain, brandLabel, coreBase, hasOwnCore } from './_platform.js';

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

// FALLBACK ONLY. Re-verified 2026-08-21 against
// core.alpy.com/core/cart/products-information across 116 shops; the count in
// each comment is how many of those shops actually stock the id. Two entries
// were wrong before: adult beginner snowboard was 28 (2* Economy, stocked by
// ONE shop out of 116) instead of 29 (3*, 14 shops), and every teen snowboard
// level pointed at 97 (5*) instead of 98 for the lower levels. Child expert
// snowboard pointed at 43, which is the JUNIOR id.
// This table is only used when the live catalogue cannot be read - see
// buildDefinitionResolver, which is what runs normally.
const PRODUCTS = {
      adult:  { ski: { beginner: 2,   intermediate: 3,  expert: 4  }, snowboard: { beginner: 29, intermediate: 30, expert: 31 } },
      //             3*(86)        4*(113)       5*(112)                        3*(14)        4*(106)       5*(81)
      teen:   { ski: { beginner: 129, intermediate: 96, expert: 92 }, snowboard: { beginner: 98, intermediate: 98, expert: 97 } },
      //             3*(15)        4*(32)        5*(36)                         4*(42)        4*(42)        5*(25)
      junior: { ski: { beginner: 15,  intermediate: 15, expert: 16 }, snowboard: { beginner: 42, intermediate: 42, expert: 43 } },
      //             4*(94)        4*(94)        5*(72)                         4*(72)        4*(72)        5*(26)
      child:  { ski: { beginner: 80,  intermediate: 80, expert: 80 }, snowboard: { beginner: 38, intermediate: 38, expert: 38 } }
      //             4*(105) - 81 (5*) exists in 10 shops only                 4*(33) - 39 (5*) in 2 shops only
};

const CAT_SKI = 1, CAT_SNOWBOARD = 3;   // productCategoryId in the live grid
const SHOP_INFO_URL = 'https://core.alpy.com/en/service/ski-rental/shops/';

const ADDON_BOOTS  = 1;
const ADDON_HELMET = 2;
// "Assurance casse & vol" / damage & theft protection. Unlike boots and helmets
// it carries no day table - every entry in its price map is 0 - and is billed
// through priceRelative: 0.15. Measured on shop 1867, 07-12/02/2027, one adult
// 3*: product alone 88,50; +boots 118,50; +boots+helmet 138,75; +boots+helmet
// +protection 159,56. 159,56 - 138,75 = 20,81 = 15% of 138,75. So the rate
// applies to the person's product AND their absolute addons, not to the product
// alone. Adding this id without honouring priceRelative would have added
// exactly nothing and understated every protected quote by 15%.
const ADDON_INSURANCE = 3;
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

/**
 * Two descriptions of the same party, combined into the better one.
 *
 * `base` comes from the scalars: the right number of people with the right ages,
 * but one discipline and one level copied across all of them. `detail` comes from
 * the classifier reading the email: it knows the two adults are on snowboards and
 * the three children are beginners on skis, and it may or may not have got the
 * ages right.
 *
 * Ages come from base, always - children_ages is what the customer typed, and a
 * child priced on a guessed age is the whole reason _slots.js exists. Everything
 * else comes from detail when detail says anything at all.
 *
 * Pairing is by age first, positional only as a fallback. A classifier is free to
 * list the family in whatever order it likes, and pairing a 3-year-old with an
 * adult's snowboard because it happened to be written first is exactly the kind
 * of silent wrongness that surfaces at the till.
 */
function mergePersons(base, detail) {
      const pool = detail.slice();
      const take = (age) => {
              let i = pool.findIndex(p => p && hasValue(p.age) && (parseInt(p.age, 10) === age));
              if (i === -1) i = pool.findIndex(p => p && !hasValue(p.age));
              if (i === -1) return null;
              return pool.splice(i, 1)[0];
      };

      return base.map(b => {
              const d = take(parseInt(b.age, 10)) || {};
              const out = Object.assign({}, d, b);   // b wins on age
              const level = d.skill ?? d.level;
              if (hasValue(level)) out.skill = String(level).trim().toLowerCase();
              if (hasValue(d.equipment)) {
                        out.equipment = String(d.equipment).toLowerCase().includes('snowboard')
                          ? 'snowboard' : 'ski';
              }
              return out;
      });
}

/**
 * Boots default to on. All three flags absent keeps the historical default [1].
 *
 * Protection is opt-in and stays opt-in: it is a real charge, and a quote that
 * adds it because nobody said otherwise is a quote the customer did not ask for.
 */
function buildAddons({ withBoots, withHelmets, withInsurance }) {
      if (withBoots === undefined && withHelmets === undefined && withInsurance === undefined) {
              return [ADDON_BOOTS];
      }

      const addons = [];
      if (!isFalsy(withBoots)) addons.push(ADDON_BOOTS);
      if (isTruthy(withHelmets)) addons.push(ADDON_HELMET);
      if (isTruthy(withInsurance)) addons.push(ADDON_INSURANCE);
      return addons.length ? addons : [ADDON_BOOTS];
}

/**
 * Accessories, per person, with the group answer as the fallback.
 *
 * The group used to be treated as one basket: boots and helmets for everybody
 * or for nobody. Real groups are not like that - the teenager brings their own
 * boots, only the children take helmets - and the quote has to be able to say
 * so, because each accessory is billed per person.
 *
 * A person may carry `addons: [1, 2]` directly, or the readable flags
 * `boots` / `helmet` / `helmets` / `insurance` / `protection`. Anything absent
 * falls back to what the group said.
 */
/**
 * THE PRODUCT THE CUSTOMER ACTUALLY HAD, when the caller knows it.
 *
 * Measured on BDKLQJ (shop 1819, four people): the booking held definitionId
 * 110 "Diamant (7*)", 90 "Sort/guld (5*) Lady", 5 "Platinum (6*)" and 16
 * "Champion (5*)". The rebuilt cart held definitionId 4 four times. The round
 * trip is lossy by construction - definitionId is mapped to a (skill, equipment)
 * pair, and that pair is mapped back to a definitionId - so every product
 * outside the small ski/snowboard x beginner/intermediate/expert grid collapses
 * onto the nearest generic one. Seven-star skis, Lady models, Champion and
 * Platinum tiers all disappear, and the customer is quoted equipment they never
 * had, at a price that is not theirs.
 *
 * So when a caller states the definitionId, it wins. Nothing is inferred, and
 * the price and the cart both use the same id.
 */
function statedDefinitionId(person) {
      const raw = person && (person.definitionId != null ? person.definitionId : person.definitionid);
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
}

function addonsForPerson(person, groupAddons) {
      if (!person || typeof person !== 'object') return groupAddons;

      if (Array.isArray(person.addons)) {
              return person.addons.map(a => parseInt(a, 10)).filter(Number.isFinite);
      }

      const has = (...keys) => keys.find(k => person[k] !== undefined && person[k] !== null && String(person[k]).trim() !== '');

      const bootsKey = has('boots', 'with_boots');
      const helmKey  = has('helmet', 'helmets', 'with_helmets');
      const insKey   = has('insurance', 'protection', 'with_insurance');
      if (!bootsKey && !helmKey && !insKey) return groupAddons;

      const out = [];
      if (bootsKey ? !isFalsy(person[bootsKey]) : groupAddons.includes(ADDON_BOOTS))     out.push(ADDON_BOOTS);
      if (helmKey  ? isTruthy(person[helmKey])  : groupAddons.includes(ADDON_HELMET))    out.push(ADDON_HELMET);
      if (insKey   ? isTruthy(person[insKey])   : groupAddons.includes(ADDON_INSURANCE)) out.push(ADDON_INSURANCE);
      return out;
}

// ── Exact cart price ─────────────────────────────────────────────────────────

/**
 * Per-shop catalogue cache, and why it exists.
 *
 * A quote is three network round trips deep and they cannot be collapsed: the
 * shops file resolves the resort to a shopId, the shopId is what the catalogue
 * and age bands are read with, and the definitionIds those two produce are what
 * the pricing call is sent. Measured end to end on 581742 the endpoint answered
 * 200 in 7511 ms - correct, and too late. Zendesk gives an HTTP action about ten
 * seconds, so "correct in 7.5s" is a coin toss dressed up as a working feature,
 * and the second call in a row failed outright.
 *
 * Of those three hops, two are the same bytes every time. The catalogue for a
 * shop is 364 kB and changes when the shop's stock changes - not between two
 * quotes for the same resort ten seconds apart, which is exactly the case when
 * a customer replies and the flow runs again. Holding them for an hour turns
 * the retry, and every subsequent quote for that resort on a warm function,
 * into one round trip instead of three.
 *
 * An hour is chosen to be shorter than a working day: a stock change is picked
 * up the same morning without anyone deploying. On a miss or an expiry the
 * behaviour is exactly what it was before - a live read, and the static
 * PRODUCTS table if that read fails.
 */
const CATALOGUE_TTL_MS = 60 * 60 * 1000;
const _gridCache = new Map();       // shopId -> { at, value }
const _intervalsCache = new Map();  // shopId -> { at, value }

function cacheRead(store, shopId) {
      const hit = store.get(shopId);
      if (!hit) return undefined;
      if (Date.now() - hit.at > CATALOGUE_TTL_MS) {
              store.delete(shopId);
              return undefined;
      }
      return hit.value;
}

// Only a successful read is cached. Caching a null would pin a shop to the
// static table for an hour because core.alpy.com blinked once.
function cacheWrite(store, shopId, value) {
      if (value != null) store.set(shopId, { at: Date.now(), value });
      return value;
}

async function fetchPriceGrid(shopId) {
      const cached = cacheRead(_gridCache, shopId);
      if (cached !== undefined) return cached;
      return cacheWrite(_gridCache, shopId, await fetchPriceGridLive(shopId));
}

async function fetchPriceGridLive(shopId) {
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

// A definitionId is not a global constant: every shop imports its own slice of
// the catalogue, and the age bands are per shop too. Flaine (1867) runs adult
// 13-99 with no teen tier at all; shop 2145 runs child 0-8 / junior 9-15 /
// adult 16+. Asking for a tier the shop does not stock produced a cart with no
// price - measured on 116 shops, the static table missed on roughly half the
// (age, discipline, level) combinations. So resolve against the shop's own
// catalogue and keep PRODUCTS only for when these two reads fail.
async function fetchAgeIntervals(shopId) {
      const cached = cacheRead(_intervalsCache, shopId);
      if (cached !== undefined) return cached;
      return cacheWrite(_intervalsCache, shopId, await fetchAgeIntervalsLive(shopId));
}

async function fetchAgeIntervalsLive(shopId) {
      try {
              const r = await fetch(SHOP_INFO_URL + shopId + '?currencyCode=EUR', { headers: { Accept: 'application/json' } });
              if (!r.ok) return null;
              const j = await r.json();
              return Array.isArray(j.ageIntervals) ? j.ageIntervals : null;
      } catch (e) {
              console.error('generate-quote: age intervals fetch failed for shop ' + shopId, e);
              return null;
      }
}

function flattenGrid(grid) {
      const out = [];
      for (const g of (grid && grid.products) || []) {
              for (const p of (g && g.products) || []) {
                        if (!p || p.definitionId == null) continue;
                        out.push({
                                  def: p.definitionId,
                                  cat: p.productCategoryId,
                                  age: p.ageCategoryId,
                                  stars: parseInt(String(p.qualityCategoryAbbreviation || '').replace('*', ''), 10) || 0,
                                  name: (p.nameWithMerchantForAcceptedLanguages && p.nameWithMerchantForAcceptedLanguages.en) || '',
                                  addons: ((p.addons) || []).filter(a => a && a.classname !== 'insurance').map(a => a.definitionId),
                        });
              }
      }
      return out;
}

function ageCategoryIdFor(age, intervals) {
      let dflt = null;
      for (const iv of intervals) {
              if (iv.is_default) dflt = iv.age_category_id;
              if (age >= iv.start && age <= iv.end) return iv.age_category_id;
      }
      return dflt;
}

const SKILL_STARS = { beginner: 3, intermediate: 4, expert: 5 };

/**
 * Returns { resolve, misses } where resolve(age, skill, equipment) has exactly
 * the signature of getDefinitionId, so it drops into fetchLivePricing and
 * computeCartPrice unchanged. Ties in star distance resolve downwards: we never
 * silently quote a tier above what was asked for. "Lady"/"Woman"/"Mini"
 * variants are skipped because we do not collect gender and the unisex line is
 * stocked just as widely.
 */
function buildDefinitionResolver(grid, intervals) {
      const products = (grid && intervals) ? flattenGrid(grid) : [];
      const misses = [];
      if (!products.length || !intervals || !intervals.length) {
              return { resolve: getDefinitionId, addonsFor: () => null, misses, live: false };
      }
      const cache = new Map();
      function pick(age, skill, equipment) {
              const sk    = SKILL_STARS[skill] ? skill : 'intermediate';
              const equip = equipment === 'snowboard' ? 'snowboard' : 'ski';
              const a     = parseInt(age, 10) || ADULT_DEFAULT_AGE;
              const key   = a + '|' + sk + '|' + equip;
              if (cache.has(key)) return cache.get(key);

              const ageId   = ageCategoryIdFor(a, intervals);
              const wantCat = equip === 'snowboard' ? CAT_SNOWBOARD : CAT_SKI;
              const want    = SKILL_STARS[sk];
              let pool = products.filter(p => p.cat === wantCat && p.age === ageId && p.stars > 0 &&
                                              !/lady|woman|mini/i.test(p.name));
              let hit = null;
              if (pool.length) {
                        pool = pool.slice().sort((x, y) =>
                                  Math.abs(x.stars - want) - Math.abs(y.stars - want) || x.stars - y.stars);
                        hit = pool[0];
              } else {
                        misses.push(a + 'yr ' + sk + ' ' + equip);
              }
              cache.set(key, hit);
              return hit;
      }
      return {
              live: true,
              misses,
              resolve: (age, skill, equipment) => {
                        const hit = pick(age, skill, equipment);
                        return hit ? hit.def : getDefinitionId(age, skill, equipment);
              },
              addonsFor: (age, skill, equipment) => {
                        const hit = pick(age, skill, equipment);
                        return hit && hit.addons.length ? hit.addons : null;
              },
      };
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

function computeCartPrice({ grid, persons, addons, days, resolveDefId }) {
      const products = indexProducts(grid);
      if (!products.size) return null;
      const defIdOf = resolveDefId || getDefinitionId;

      let minor = 0;
      let currency = 'EUR';
      const missing = [];

      for (const person of persons) {
              const defId = statedDefinitionId(person) ||
                            defIdOf(person.age, person.skill, person.equipment);
              const node  = products.get(defId);
              if (!node) { missing.push('product:' + defId); continue; }

              currency = node.priceCurrencyCode || currency;

              // This person's own accessories, not the group's.
              const wanted = addonsForPerson(person, addons);

              // Absolute addons first, then the relative ones on top of the
              // subtotal they produce - that is the order core.alpy.com uses.
              let personMinor = 0;
              const base = priceForDays(node.price, days);
              if (base == null) missing.push('product:' + defId); else personMinor += base;

              const relative = [];
              for (const addonId of wanted) {
                        const a = ((node.addons) || []).find(x => x && x.definitionId === addonId);
                        if (!a) { missing.push('addon:' + addonId + '@product:' + defId); continue; }

                        const rate = Number(a.priceRelative) || 0;
                        if (rate > 0) { relative.push(rate); continue; }

                        const av = priceForDays(a.price, days);
                        if (av == null) missing.push('addon:' + addonId + '@product:' + defId); else personMinor += av;
              }
              for (const rate of relative) personMinor += personMinor * rate;

              minor += personMinor;
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
      // The first person is not the group.
      //
      // This read persons[0].equipment and called it the answer, which was
      // harmless while every quote carried one discipline for everybody. Now that
      // the classifier reports each skier, a family of two snowboarders and three
      // children on skis was being described as "snowboard" - the price was right
      // and the sentence was wrong, which is the worse of the two failures because
      // it is the part the customer reads.
      const boards = persons.filter(p => String(p && p.equipment).toLowerCase() === 'snowboard').length;
      const eq = boards === 0 ? 'skis'
               : boards === persons.length ? 'snowboards'
               : boards + ' snowboards and ' + (persons.length - boards) + ' pairs of skis';
      const bits = [eq];
      // Count who actually has each accessory instead of reading the group
      // flag. "boots and helmets" on a quote where only the children took a
      // helmet is the kind of small untruth that gets discovered at the counter.
      const per = persons.map(p => addonsForPerson(p, addons));
      const n = id => per.filter(a => a.includes(id)).length;
      const label = (id, all, some) => {
              const c = n(id);
              if (!c) return null;
              return c === persons.length ? all : (c + ' ' + some);
      };
      const boots  = label(ADDON_BOOTS,  'boots',   'pairs of boots');
      const helmet = label(ADDON_HELMET, 'helmets', 'helmets');
      if (boots)  bits.push(boots);
      if (helmet) bits.push(helmet);
      const prot = n(ADDON_INSURANCE);
      if (prot) bits.push(prot === persons.length ? 'damage & theft protection'
                                                 : 'damage & theft protection for ' + prot);
      return bits.join(' + ');
}

/**
 * The saving is the argument, and it was missing from the sentence.
 *
 * The quote line carried the online price alone, so the reply could say what the
 * rental costs but not why booking it here is worth anything. The counter price
 * at the shop is the comparison the whole offer rests on - 844,10 against 624,67
 * on the measured La Tania basket - and the composing prompt is forbidden to
 * invent a figure that is not in this line. So the figure has to be in this line.
 *
 * Only stated when the in-store price is genuinely higher: a "saving" of zero, or
 * a negative one, is worse than silence.
 */
function buildSavingBit(online, inStore, currency) {
      if (online == null || inStore == null) return '';
      const saving = Math.round((inStore - online) * 100) / 100;
      if (!(saving > 0)) return '';
      const pct = Math.round((saving / inStore) * 100);
      return ' Same equipment at the shop counter: ' + formatMoney(inStore, currency) +
             ', so booking online with us saves ' + formatMoney(saving, currency) +
             (pct > 0 ? ' (' + pct + '%)' : '') + '.';
}

function buildQuoteLine({ shop, persons, addons, startDate, endDate, days, price, inStorePrice, currency, cartUrl, couponValue }) {
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

      const savingBit = price != null ? buildSavingBit(price, inStorePrice, currency) : '';

      const body = head + priceBit + savingBit + couponBit;

      // LE LIEN SUR SA PROPRE LIGNE, ET PAS AU MILIEU DE LA PHRASE.
      //
      // L'URL de panier fait 400 caracteres. Collee derriere un ":" dans un
      // paragraphe, elle noie la phrase qui la precede et le message arrive
      // chez l'agent comme un pave. Deux sauts de ligne suffisent a le rendre
      // lisible, et une URL seule sur sa ligne est aussi la seule forme que
      // l'editeur de Zendesk transforme encore en lien tout seul.
      return {
              text: body + '\n\nBook directly here:\n' + cartUrl,

              // La meme chose en HTML, avec un vrai lien porte par un libelle
              // court. C'est cette sortie qu'un flow doit inserer dans une
              // reponse client : personne n'a envie de lire quatre cents
              // caracteres d'URL encodee, et le lien reste cliquable meme si
              // Zendesk cesse de linkifier les URL nues.
              html: escapeHtml(body) +
                    '<br><br><a href="' + cartUrl + '">Book your equipment here</a>',
      };
}

/** Le strict necessaire : ce texte est du notre, mais il porte des noms de boutique. */
function escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

// Resort resolution, in order of decreasing certainty.
//
// Observed on 581658: the customer wrote "arriving in Val on 7 Feb 27". The old
// resolver fell through to a plain substring test, "valmalenco" contains "val",
// and we quoted him a shop in Italy - a different country from the one he was
// going to. He rated us badly.
//
// "Val" is not a resort, it is the beginning of a dozen of them. So instead of
// returning the first town that happens to contain the letters, we collect every
// town that could be meant and, when there is more than one, we refuse. A refusal
// becomes a question to the customer, which is what a human would have asked.
//
// Returns { shop } | { ambiguous: true, candidates: [town, ...] } | {}.
function resolveShop(shops, resort) {
      if (!resort) return {};
      const q   = norm(resort);
      const qNS = q.replace(/\s/g, '');
      if (!q) return {};

      // 1. Exact town name. Never ambiguous, even if several shops share the town.
      const exact = shops.filter(s => {
              const t = norm(s.town);
              return t === q || t.replace(/\s/g, '') === qNS;
      });
      if (exact.length) return { shop: exact[0] };

      const distinctTowns = list => {
              const seen = [];
              for (const s of list) { const t = norm(s.town); if (seen.indexOf(t) === -1) seen.push(t); }
              return seen;
      };
      const decide = list => {
              if (!list.length) return null;
              const towns = distinctTowns(list);
              if (towns.length > 1) {
                        return { ambiguous: true, candidates: list.map(s => s.town).filter((t, i, a) => a.indexOf(t) === i) };
              }
              return { shop: list[0] };
      };

      // 2. The town begins with what was written, on a word boundary:
      //    "val d isere" for "Val d Isere", "val thorens" and "val cenis" for "Val".
      //    Several distinct towns here means the customer has to tell us which.
      const prefix = shops.filter(s => {
              const t = norm(s.town);
              return t.startsWith(q + ' ') || t.replace(/\s/g, '').startsWith(qNS + ' ');
      });
      const byPrefix = decide(prefix);
      if (byPrefix) return byPrefix;

      // 3. Substring anywhere in the town - only for a token long enough to mean
      //    something. Below four characters a substring match is noise: that is
      //    exactly how "Val" reached Valmalenco.
      if (qNS.length >= 4) {
              const inside = shops.filter(s => {
                        const t = norm(s.town);
                        return t.includes(q) || t.replace(/\s/g, '').includes(qNS);
              });
              const bySub = decide(inside);
              if (bySub) return bySub;

              // 4. Last resort: the shop's own name.
              const byName = decide(shops.filter(s => {
                        const n = norm(s.name);
                        return n.includes(q) || n.replace(/\s/g, '').includes(qNS);
              }));
              if (byName) return byName;
      }

      return {};
}

// Kept for callers that only want a shop or nothing.
function findShop(shops, resort) {
      const r = resolveShop(shops, resort);
      return r.shop || null;
}

/**
 * ASK THE CUSTOMER INSTEAD OF FAILING.
 *
 * The Quote Generator flow builds its letter from `quoteLine` and nothing else,
 * and a custom-action step that receives a 4xx stops the flow (581984: a
 * "Courchevel" group got "generate quote reply failed" for want of a "1650").
 * So when the request is readable but one fact is missing, this answers 200
 * with a question in the quote line, marked so the prompt writes the question
 * and no price, and with every price field empty so nothing downstream can
 * mistake it for a quote.
 */
function askCustomer(res, o) {
  const line = 'QUESTION FOR THE CUSTOMER - this is NOT a quote, no price exists yet. Reply with this ' +
               'single question, in the customer\'s language, and nothing else: ' + o.question;
  return res.status(200).json({
    action: 'ASK',
    needsClarification: true,
    needsclarification: true,
    reason: o.reason,
    resort: o.resort || null,
    candidates: o.candidates || [],
    question: o.question,
    quoteLine: line,
    quoteline: line,
    quoteLineHtml: line,
    quotelinehtml: line,
    quoteHasPrice: false,
    quotehasprice: false,
    cartUrl: '', carturl: '',
    shopUrl: '', shopurl: '',
    cartOnlinePrice: null, cartonlineprice: null,
    cartInStorePrice: null, cartinstoreprice: null,
    cartPriceComplete: false, cartpricecomplete: false,
    pricingAvailable: false,
    couponValue: null, couponMessage: '',
  });
}

export default async function handler(req, res) {
      Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
      if (req.method === 'OPTIONS') return res.status(200).end();

  // Query string AND body, body winning. A Zendesk custom action's JSON body is
  // a chip field that is awkward to extend; its query parameters are plain rows.
  // `platform` arrives as a query parameter for exactly that reason (581942), so
  // a POST must read both - it used to read the body alone.
  let bodyIn = req.method === 'POST' ? (req.body || {}) : {};
  if (typeof bodyIn === 'string') { try { bodyIn = JSON.parse(bodyIn); } catch { bodyIn = {}; } }
  if (!bodyIn || typeof bodyIn !== 'object' || Array.isArray(bodyIn)) bodyIn = {};
  const params = Object.assign({}, req.query || {}, bodyIn);

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
          with_insurance: withInsuranceParam,
  } = params;

  // Individual params win field by field; claude_json fills the gaps.
      const pick  = (direct, fromCj) => hasValue(direct) ? direct : (hasValue(fromCj) ? fromCj : undefined);
      const pickB = (direct, fromCj) => (direct !== undefined && direct !== null && String(direct).trim() !== '')
                                          ? direct
                                          : (fromCj !== undefined && fromCj !== null ? fromCj : undefined);

  const resortRaw = pick(resortParam, undefined) || pick(resortAlt, undefined) || pick(undefined, cj.resort) || null;
      const resort  = (resortRaw && !String(resortRaw).trim().startsWith('{')) ? resortRaw : (hasValue(cj.resort) ? cj.resort : null);

      // Both spellings, inside claude_json as well as outside it.
      //
      // Every other field here accepts either case - cj.resort, cj.language -
      // but the dates only ever read cj.start_date. A claude_json carrying
      // startDate/endDate therefore lost them silently and the endpoint answered
      // "Missing required params: startDate, endDate" while holding a blob that
      // contained both. Found while adding an output to the Zendesk custom
      // action, whose test call sends exactly that shape; a detector prompt
      // reworded to camelCase would have broken every quote the same way, with
      // an error message pointing at the caller instead of at us.
      const startDate = pick(startDateParam, undefined) || pick(startDateAlt, undefined)
                              || pick(undefined, cj.start_date) || pick(undefined, cj.startDate) || null;
      const endDate   = pick(endDateParam,   undefined) || pick(endDateAlt,   undefined)
                              || pick(undefined, cj.end_date)   || pick(undefined, cj.endDate)   || null;

      const lang = pick(langParam, cj.language) || 'en';

      const adultsEff       = pick(adultsParam,       cj.adults);
      const childrenAgesEff = pick(childrenAgesParam, cj.children_ages);
      const skillEff        = pick(skillParam,        cj.skill);
      const equipmentEff    = pick(equipmentParam,    cj.equipment);
      const withBootsEff    = pickB(withBootsParam,   cj.with_boots);
      const withHelmetsEff  = pickB(withHelmetsParam, cj.with_helmets);
      // Accept the three spellings a classifier is likely to produce.
      const withInsuranceEff = pickB(withInsuranceParam,
                               pickB(params.insurance, pickB(cj.with_insurance, cj.insurance)));

  // ── Group composition: scalars win over any persons array ─────────────────
      let persons = null;
      let personsSource = 'none';

      const scalarPersons = buildPersonsFromScalars({
              adults: adultsEff,
              childrenAges: childrenAgesEff,
              skill: skillEff,
              equipment: equipmentEff,
      });

      let detailed = params.persons || cj.persons || null;
      if (typeof detailed === 'string') {
              try { detailed = JSON.parse(detailed); } catch { detailed = null; }
      }
      if (!Array.isArray(detailed) || !detailed.length) detailed = null;

      if (scalarPersons.length && (hasValue(adultsEff) || hasValue(childrenAgesEff))) {
              if (detailed && detailed.length === scalarPersons.length) {
                        persons = mergePersons(scalarPersons, detailed);
                        personsSource = 'scalars+array';
              } else {
                        persons = scalarPersons;
                        personsSource = 'scalars';
              }
      } else if (detailed) {
              persons = detailed;
              personsSource = 'array';
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
          const resolved = resolveShop(shops, String(resort));
          if (resolved.ambiguous) {
                    // A QUESTION IS AN ANSWER, NOT A CRASH (581984).
                    //
                    // "Courchevel" is three resorts (1300, 1650, 1850). Answering 409
                    // stopped the Quote Generator's custom-action step, the flow took
                    // its error branch, and a fifteen-person group got "generate quote
                    // reply failed" and a human. The right reply is one question. The
                    // flow composes its letter from `quoteLine`, so the question
                    // travels there, marked so the prompt knows it is not a quote.
                    const shortlist = resolved.candidates.slice(0, 8);
                    return askCustomer(res, {
                              reason: 'AMBIGUOUS_RESORT',
                              resort, candidates: shortlist, candidateCount: resolved.candidates.length,
                              question: 'Which "' + resort + '" do you mean? We have partner shops in ' +
                                        shortlist.join(', ') + '. Tell us the exact resort (or the name of your ' +
                                        'accommodation or the shop you have in mind) and we will send the quote right away.',
                    });
          }
          shop = resolved.shop;
          if (!shop) {
                    return askCustomer(res, {
                              reason: 'RESORT_NOT_FOUND',
                              resort,
                              question: 'We could not find a partner shop for "' + resort + '". Could you tell us ' +
                                        'the exact name of the resort (and the village or the shop, if you have one ' +
                                        'in mind)? We will send the quote as soon as we have it.',
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

      // A period that has already happened is not a quote, it is a broken link.
      //
      // Observed on 581710: the classifier resolved "fin décembre" to 2024 - it is
      // never told what today is - and everything downstream degraded quietly.
      // The live pricing had nothing to return for a past season, so the quote went
      // out with no price at all and a cart URL alpy.com had to rewrite to the next
      // bookable week. The customer received a plausible letter about the wrong
      // dates for an unknown amount.
      //
      // Failing here is the honest outcome: the flow's error branch puts it in
      // front of a human, who can see in one look that the year is wrong.
      if (startDate && !missing.length) {
              const today = new Date(); today.setUTCHours(0, 0, 0, 0);
              if (new Date(startDate) < today) {
                        return res.status(400).json({
                                  error: 'Start date is in the past: ' + startDate +
                                         '. A past period cannot be priced or booked - the year is ' +
                                         'almost certainly wrong. Today is ' +
                                         today.toISOString().slice(0, 10) + '.',
                                  startDate, endDate,
                        });
              }
      }

      // A rental period nobody would ever book is not a quote either.
      //
      // Observed on 581658: the customer wrote "arriving in Val on 7 Feb 27, need
      // to hire from Sunday 8 Feb. The shop has an online offer until 31 Aug".
      // "until 31 Aug" is the deadline of a promotion, not the end of the rental,
      // and the classifier took it as endDate. We priced 205 days - 3,436.50 EUR -
      // and sent it to the customer with a straight face. He rated us badly and
      // said we had passed him to a robot that could not answer.
      //
      // Ski rentals run a week, two at the outside. Benjamin's rule: past 14 days
      // we do not quote automatically. Beyond that it is either a parsing failure
      // or a genuinely unusual request, and both belong to a human - so we refuse
      // to price it and the flow's error branch hands it over.
      const MAX_RENTAL_DAYS = 14;
      if (startDate && endDate && !missing.length) {
              const d0 = new Date(startDate);
              const d1 = new Date(endDate);
              const spanDays = Math.round((d1 - d0) / 86400000) + 1;

              if (spanDays < 1) {
                        return res.status(400).json({
                                  error: 'End date ' + endDate + ' is before start date ' + startDate +
                                         '. The period could not be read reliably.',
                                  startDate, endDate,
                        });
              }
              if (spanDays > MAX_RENTAL_DAYS) {
                        return res.status(400).json({
                                  error: 'Rental period is ' + spanDays + ' days (' + startDate + ' to ' +
                                         endDate + '), which exceeds the ' + MAX_RENTAL_DAYS + '-day maximum. ' +
                                         'A date this far out is almost always a promotion deadline or a ' +
                                         'booking-window date read as the end of the rental. Ask the customer ' +
                                         'for the return date instead of pricing this.',
                                  startDate, endDate, days: spanDays,
                                  reason: 'PERIOD_TOO_LONG',
                        });
              }
      }

  if (missing.length) {
          return res.status(400).json({
                    error: 'Missing required params: ' + missing.join(', '),
                    receivedClaudeJson: !!claudeParsed,
                    example: { resort: 'Chamonix', startDate: '2027-03-21', endDate: '2027-03-28',
                                               adults: 2, children_ages: '6,8,12', skill: 'intermediate', equipment: 'ski' }
          });
  }

  const cartAddons = buildAddons({ withBoots: withBootsEff, withHelmets: withHelmetsEff, withInsurance: withInsuranceEff });

      // Read the shop's real catalogue and age bands BEFORE building the cart:
      // the definitionIds we put in the URL have to be ids this shop stocks, or
      // the basket opens with no price at all.
      const [grid, ageIntervals] = await Promise.all([
              fetchPriceGrid(shop.id),
              fetchAgeIntervals(shop.id),
      ]);
      const defs = buildDefinitionResolver(grid, ageIntervals);
      if (!defs.live) {
              console.error('generate-quote: live catalogue unavailable for shop ' + shop.id + ' - using static PRODUCTS table');
      }

  const cartPersons = persons.map(p => ({
          age: parseInt(p.age) || 35,
          skill: p.skill === 'intermediate' ? 'advanced' : (p.skill || 'advanced'),
          products: [{
                    definitionId: statedDefinitionId(p) || defs.resolve(p.age, p.skill, p.equipment),
                    // Keep the agent's boots/helmet choice, but only ask for
                    // addons this particular product actually offers.
                    addons: (function () {
                              const wanted = addonsForPerson(p, cartAddons);
                              // A caller that states the list has counted the
                              // lines on the booking itself - Modelchange, an
                              // existing protection, boots on one person only.
                              // Filtering that against a catalogue view would
                              // silently drop what the customer already owns, so
                              // an explicit list is taken as it is.
                              if (Array.isArray(p.addons)) return wanted;
                              const avail  = defs.addonsFor(p.age, p.skill, p.equipment);
                              if (!avail) return wanted;
                              // The protection is never dropped by this filter.
                              //
                              // Measured on BQTZCJ, shop 4350: the PRICE GRID carries
                              // addon 3 on both products (cartPriceComplete true, the
                              // 15% applied), while products-information lists only
                              // [1,2] for them. The cart builder trusted the second
                              // list, so the link came out with boots+helmet and
                              // "insurances":[] - a quote that charged for a protection
                              // the basket did not contain. A price and a cart link that
                              // disagree is the worst of the three possible outcomes:
                              // the customer clicks, sees a smaller total, and books
                              // without the cover they asked for.
                              const kept = wanted.filter(a => a === ADDON_INSURANCE || avail.includes(a));
                              // An empty list is a legitimate answer here - the
                              // person brings their own boots. Only fall back to
                              // the group when this shop stocks none of what was
                              // asked for, which is a catalogue gap, not a choice.
                              return (kept.length || !wanted.length) ? kept : cartAddons;
                    })(),
          }]
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
      // THE CUSTOMER'S OWN BRAND, not ours (581942).
      //
      // Every brand on the platform - slopefox.co.uk, pistenfuchs.de, skidiscount.fr
      // ... - serves this exact URL shape and redirects it to its own localised
      // shop page. Minting every link on alpy.com sent a Slopefox customer to a
      // site she did not know, under a logo she had never seen, to pay. The
      // caller says which brand (`platform`: a Zendesk brand id, a domain or a
      // brand word); without it the default stays alpy.com. See _platform.js.
      const siteDomain = resolveDomain(params.platform || params.brand_id || params.brandId || params.domain, null);
      const shopUrl = 'https://' + siteDomain + '/' + urlLang + '/' + RENTAL_SEGMENT[urlLang] + '/products?shopId=' + shop.id;
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

  // PRICE ON THE BRAND'S OWN CORE HOST (581971).
  //
  // Each brand's frontend prices its basket on its own core - snowbrainer.com
  // on core.snowbrainer.com - and each core applies the brand's own online
  // discount, a few tenths of a percent away from alpy.com's. Priced here on
  // core.alpy.com and sent with a snowbrainer link, the quote said 389,76 and
  // the basket said 391,84. Same host as the link, same figure as the basket.
  // Brands without a core of their own (swissrent.com) keep alpy.com's figure,
  // and say so in `pricedOn`.
  const pricingBase = coreBase(siteDomain);
  const pricing = await fetchLivePricing({
          shop, startDate, endDate, persons, getDefinitionId: defs.resolve,
          currency: params.currency || 'EUR',
          countryCode: countryToCode(shop.country),
          promoCode: effectivePromoCode,
          coreBase: pricingBase,
  });

      const cartPrice = grid
        ? computeCartPrice({ grid, persons, addons: cartAddons, days, resolveDefId: defs.resolve })
        : null;
      if (defs.misses.length) {
              console.error('generate-quote: shop ' + shop.id + ' stocks nothing for ' + defs.misses.join(', '));
      }

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
                    // NEVER SHOW shopPrice TO A CUSTOMER.
                    //
                    // It comes from the cheapest-shop search, not from this cart,
                    // and on the measured La Tania basket it read 438 while the
                    // cart cost 624,67 online and 1039,60 at the counter. A shop
                    // price BELOW our own price is not a shop price - whatever it
                    // is (our net cost to the shop is the likely answer), it is an
                    // internal figure and quoting it would advertise a discount
                    // that does not exist, or worse, our margin.
                    //
                    // The customer-facing comparison is cartInStorePrice against
                    // cartOnlinePrice, and only those two. So when this number
                    // breaks the invariant "the counter is never cheaper than us",
                    // drop it rather than pass a trap downstream.
                    if (cartOnlinePrice != null && shopPrice < cartOnlinePrice) shopPrice = null;
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
              price: cartOnlinePrice, inStorePrice: cartInStorePrice,
              currency: cartPriceCurrency, cartUrl, couponValue,
      });

  const topLevelPricing = {
          // `quoteline` reste du texte, comme avant, pour ne casser aucun flow
          // qui l'utilise deja - simplement avec l'URL sur sa propre ligne.
          // `quotelinehtml` est la version a inserer dans une reponse client.
          quoteLine: quoteLine.text,
          quoteline: quoteLine.text,
          quoteLineHtml: quoteLine.html,
          quotelinehtml: quoteLine.html,
          quoteHasPrice,
          quotehasprice: quoteHasPrice,
          detectedLanguage: lang,          
          cartInStorePrice,
          cartinstoreprice: cartInStorePrice,
          cartOnlinePrice,
          cartonlineprice: cartOnlinePrice,
          cartPriceCurrency,
          cartPriceComplete,
          cartpricecomplete: cartPriceComplete,
          cartPriceMissingDefinitionIds: cartPrice ? cartPrice.missing : null,
          // definitionIds came from the shop's live catalogue (normal case) or
          // from the static fallback table.
          // What the price actually includes, per person, so the reply can
          // never claim an accessory the basket does not carry.
          accessoriesPerPerson: persons.map(p => addonsForPerson(p, cartAddons)),
          accessoriesperperson: persons.map(p => addonsForPerson(p, cartAddons)),
          insuranceIncluded: persons.some(p => addonsForPerson(p, cartAddons).includes(ADDON_INSURANCE)),
          insuranceincluded: persons.some(p => addonsForPerson(p, cartAddons).includes(ADDON_INSURANCE)),
          definitionIdsFromLiveCatalogue: defs.live,
          definitionidsfromlivecatalogue: defs.live,
          // Group members this shop stocks nothing for, e.g. a 4-year-old
          // snowboarder in a shop with no child snowboards. Their line will
          // carry no price - say so instead of sending a silent gap.
          unavailableForGroup: defs.misses.length ? defs.misses : null,
          unavailableforgroup: defs.misses.length ? defs.misses : null,
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
          // The brand the links were built on - flat and lowercase too, so a
          // Zendesk custom action can bind it and a reply can name the site.
          platformDomain: siteDomain,
          platformdomain: siteDomain,
          platformLabel: brandLabel(siteDomain),
          platformlabel: brandLabel(siteDomain),
          // Where the online price was computed. Equal to the brand's own core
          // when it has one; "core.alpy.com (approximation)" for a brand that
          // prices elsewhere (swissrent.com).
          pricedOn: pricingBase.replace(/^https?:\/\//, '') + (hasOwnCore(siteDomain) ? '' : ' (approximation: this brand has no core of its own)'),
          pricedon: pricingBase.replace(/^https?:\/\//, '') + (hasOwnCore(siteDomain) ? '' : ' (approximation: this brand has no core of its own)'),
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
