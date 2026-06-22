/**
 * POST /api/find-nearest-shop
 *
 * Finds the nearest Alpy ski rental shops to a customer's accommodation or resort.
 * Returns up to 3 matching shops with direct shop URLs and optional pre-filled cart URLs.
 *
 * Body params:
 *   resort | accommodationAddress  - where the client is staying (required)
 *                                    e.g. "Les Gets", "Chamonix Les Praz", "Morzine"
 *   startDate  (YYYY-MM-DD, optional) - rental start; required for cartUrl generation
 *   endDate    (YYYY-MM-DD, optional) - rental end; required for cartUrl generation
 *   persons    (JSON array, optional) - [{age, skill, equipment}] — for cart URL
 *   lang       (string, optional, default 'en')
 *
 * Returns:
 *   { found, query, nearestShops: [{ shopName, town, country, shopUrl, cartUrl?, matchScore }], message }
 */

const SHOPS_URL = 'https://raw.githubusercontent.com/benjasom-cyber/alpy-cart-api/main/api/shops_data.json';
let _shopsCache = null;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Webhook-Secret',
};

// ── Product definition IDs (mirrors generate-quote.js) ───────────────────────
const PRODUCTS = {
  adult:  { ski: { beginner: 2,   intermediate: 3,  expert: 4  }, snowboard: { beginner: 28, intermediate: 30, expert: 31 } },
  teen:   { ski: { beginner: 129, intermediate: 96, expert: 92 }, snowboard: { beginner: 97, intermediate: 97, expert: 97 } },
  junior: { ski: { beginner: 15,  intermediate: 15, expert: 16 }, snowboard: { beginner: 42, intermediate: 42, expert: 43 } },
  child:  { ski: { beginner: 80,  intermediate: 80, expert: 81 }, snowboard: { beginner: 38, intermediate: 38, expert: 43 } },
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

// ── Normalisation ─────────────────────────────────────────────────────────────
/**
 * Normalise a string for fuzzy comparison:
 * lowercase + strip diacritics + strip apostrophes + collapse whitespace.
 */
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

// ── Shops loader ──────────────────────────────────────────────────────────────
async function getShops() {
  if (_shopsCache) return _shopsCache;
  const r = await fetch(SHOPS_URL);
  if (!r.ok) throw new Error(`Failed to load shops data: ${r.status}`);
  _shopsCache = await r.json();
  return _shopsCache;
}

// ── Scoring + dedup ───────────────────────────────────────────────────────────
/**
 * Score a shop against the normalised query.
 * Score 3: exact match on town  Score 2: prefix match  Score 1: substring match
 * Town matches take priority; shop-name matches are tried with the same scale.
 */
function scoreShop(shop, query) {
  const townNorm = norm(shop.town);
  const nameNorm = norm(shop.name);

  if (townNorm === query) return 3;
  if (townNorm.startsWith(query) || query.startsWith(townNorm)) return 2;
  if (townNorm.includes(query) || query.includes(townNorm)) return 1;

  // Try against shop name (lower priority — only if town didn't match)
  if (nameNorm === query) return 2;
  if (nameNorm.startsWith(query) || query.startsWith(nameNorm)) return 1;
  if (nameNorm.includes(query) || query.includes(nameNorm)) return 1;

  return 0;
}

/**
 * Find up to `maxResults` shops, deduplicated by town name, sorted by score desc.
 */
function findNearestShops(shops, resort, maxResults = 3) {
  const query = norm(resort);

  const scored = shops
    .map(shop => ({ shop, score: scoreShop(shop, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  // Deduplicate by normalised town — keep best-scoring shop per town
  const seenTowns = new Set();
  const results = [];
  for (const { shop, score } of scored) {
    const townKey = norm(shop.town);
    if (seenTowns.has(townKey)) continue;
    seenTowns.add(townKey);
    results.push({ shop, score });
    if (results.length >= maxResults) break;
  }

  return results;
}

// ── Cart URL builder ──────────────────────────────────────────────────────────
/**
 * Build a pre-filled Alpy cart URL for a given shop, date range, and persons.
 * Returns null if startDate or endDate is missing.
 */
function buildCartUrl(shopUrl, persons, startDate, endDate) {
  if (!startDate || !endDate || !Array.isArray(persons) || persons.length === 0) return null;

  const cartPersons = persons.map(p => ({
    age:      parseInt(p.age) || 35,
    skill:    p.skill === 'intermediate' ? 'advanced' : (p.skill || 'advanced'),
    products: [{ definitionId: getDefinitionId(p.age, p.skill, p.equipment), addons: [1] }],
  }));

  const cart = { promotionCode: '', persons: cartPersons, insurances: [] };
  return `${shopUrl}/products?cart=${encodeURIComponent(JSON.stringify(cart))}&startDate=${startDate}&endDate=${endDate}`;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const body = req.body || {};
  const {
    resort,
    accommodationAddress,
    startDate,
    endDate,
    lang = 'en',
  } = body;

  let { persons } = body;
  if (typeof persons === 'string') {
    try { persons = JSON.parse(persons); } catch { persons = null; }
  }

  const locationInput = resort || accommodationAddress;
  if (!locationInput) {
    return res.status(400).json({
      error: 'Provide resort or accommodationAddress (e.g. "Les Gets", "Chamonix").',
    });
  }

  try {
    const shops = await getShops();
    const matches = findNearestShops(shops, locationInput, 3);

    if (matches.length === 0) {
      return res.status(200).json({
        found: false,
        query: locationInput,
        nearestShops: [],
        message: `No Alpy shops found near "${locationInput}". Try a different resort name or check alpy.com.`,
      });
    }

    const nearestShops = matches.map(({ shop, score }) => {
      const shopUrl = `https://www.alpy.com/${lang}/ski-rental/${shop.country}/${shop.region}/${shop.slug}/${shop.id}`;
      const cartUrl = buildCartUrl(shopUrl, persons, startDate, endDate);
      return {
        shopName:   shop.name,
        town:       shop.town,
        country:    shop.country,
        region:     shop.region,
        shopId:     shop.id,
        shopUrl,
        ...(cartUrl && { cartUrl }),
        matchScore: score,
      };
    });

    const townNames = [...new Set(nearestShops.map(s => s.town))].join(', ');

    return res.status(200).json({
      found: true,
      query: locationInput,
      nearestShops,
      message: `Found ${nearestShops.length} Alpy shop${nearestShops.length > 1 ? 's' : ''} near ${townNames}.`,
    });
  } catch (err) {
    console.error('[find-nearest-shop]', err);
    return res.status(500).json({ error: err.message });
  }
}
