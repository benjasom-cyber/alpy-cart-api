/**
 * POST /api/generate-quote
 *
 * Generates a direct Alpy.com booking link for a customer quote.
 * Called from Zendesk Action Flows or SKIBOT.
 *
 * Body params:
 *   resort        - resort / town name (required unless shopId given)
 *                   e.g. "Chamonix", "Val d'Isere", "Zermatt", "St Anton"
 *   shopId        - Odin legacy shop ID (optional — overrides resort lookup)
 *   startDate     - rental start date YYYY-MM-DD (required)
 *   endDate       - rental end date YYYY-MM-DD (required)
 *   persons       - JSON array [{age, skill, equipment}] (required)
 *                   skill: beginner | intermediate | expert
 *                   equipment: ski | snowboard
 *   lang          - language code (optional, defaults to 'en')
 *   promoCode     - promo code (optional)
 *   claude_json   - full Claude JSON output from Zendesk flow (optional shorthand)
 *                   replaces resort/startDate/endDate/persons when provided
 *                   also auto-detected when resolved_resort_town_name starts with {
 *
 * Returns: { cartUrl, shopUrl, shopName, shopId, resort, summary }
 */

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

function norm(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[''\u0060\u2019]/g, '')
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

/**
 * Try to parse a Claude "Detect quote intent" JSON output.
 * Strips markdown code fences if present.
 * Only accepts objects that have a 'resort' field (quote-intent shape).
 */
function tryParseClaudeJson(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed === 'object' && parsed !== null && 'resort' in parsed) return parsed;
  } catch { /* ignore */ }
  return null;
}

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  const params = req.method === 'POST' ? req.body : req.query;

  // ── Detect Claude JSON shorthand ─────────────────────────────────────────────
  // Supports three entry points:
  //   1. params.claude_json          — explicit single-param mode
  //   2. params.resolved_resort_town_name starting with "{"  — all 4 fields set to content
  //   3. params.resort starting with "{"                     — fallback
  let claudeParsed = null;
  if (params.claude_json) {
    claudeParsed = tryParseClaudeJson(params.claude_json);
  }
  if (!claudeParsed && params.resolved_resort_town_name) {
    const v = String(params.resolved_resort_town_name).trim();
    if (v.startsWith('{')) claudeParsed = tryParseClaudeJson(v);
  }
  if (!claudeParsed && params.resort) {
    const v = String(params.resort).trim();
    if (v.startsWith('{')) claudeParsed = tryParseClaudeJson(v);
  }

  const { shopId: shopIdParam, lang = 'en', promoCode = '' } = params;

  // When claudeParsed is set, use ONLY its values so raw JSON strings don't
  // leak into individual fields (start_date / end_date / persons would otherwise
  // contain the full JSON blob when all 4 Zendesk fields are mapped to content).
  let resort, startDate, endDate, persons;
  if (claudeParsed) {
    resort    = claudeParsed.resort     || null;
    startDate = claudeParsed.start_date || null;
    endDate   = claudeParsed.end_date   || null;
    persons   = claudeParsed.persons    || null;
  } else {
    resort    = params.resort || params.resolved_resort_town_name || null;
    startDate = params.startDate || params.start_date || null;
    endDate   = params.endDate   || params.end_date   || null;
    persons   = params.persons || null;
  }

  if (typeof persons === 'string') {
    try { persons = JSON.parse(persons); } catch { persons = null; }
  }

  // ── Resolve shop ──────────────────────────────────────────────────────────────
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
        error: 'No shop found for resort: "' + resort + '". Check spelling or use alpy.com.',
        hint: 'Examples: "Chamonix", "Morzine", "Zermatt", "Val d'Isere", "Les Deux Alpes", "St Anton"'
      });
    }
  } else {
    return res.status(400).json({
      error: 'Missing required param: resort (or shopId)',
      example: { resort: 'Chamonix', startDate: '2026-03-21', endDate: '2026-03-28',
                 persons: [{ age: 35, skill: 'intermediate', equipment: 'ski' }] }
    });
  }

  // ── Validate ──────────────────────────────────────────────────────────────────
  const missing = [];
  if (!startDate) missing.push('startDate');
  if (!endDate)   missing.push('endDate');
  if (!persons || !Array.isArray(persons) || persons.length === 0) missing.push('persons');

  if (missing.length) {
    return res.status(400).json({
      error: 'Missing required params: ' + missing.join(', '),
      example: { resort: 'Chamonix', startDate: '2026-03-21', endDate: '2026-03-28',
                 persons: [{ age: 35, skill: 'intermediate', equipment: 'ski' }] }
    });
  }

  // ── Build cart URL ────────────────────────────────────────────────────────────
  const cartPersons = persons.map(p => ({
    age:      parseInt(p.age) || 35,
    skill:    p.skill === 'intermediate' ? 'advanced' : (p.skill || 'advanced'),
    products: [{ definitionId: getDefinitionId(p.age, p.skill, p.equipment), addons: [1] }]
  }));

  const cart    = { promotionCode: promoCode || '', persons: cartPersons, insurances: [] };
  const shopUrl = 'https://www.alpy.com/' + lang + '/ski-rental/' + shop.country + '/' + shop.region + '/' + shop.slug + '/' + shop.id;
  const cartUrl = shopUrl + '/products?cart=' + encodeURIComponent(JSON.stringify(cart)) + '&startDate=' + startDate + '&endDate=' + endDate;

  const personsDesc = persons.map(p =>
    (p.age || 35) + 'yr ' + (p.skill || 'intermediate') + ' ' + (p.equipment || 'ski')
  ).join(', ');

  const days = Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000);

  return res.status(200).json({
    cartUrl,
    shopUrl,
    shopName: shop.name,
    shopId:   shop.id,
    resort:   shop.town,
    summary: {
      shopId: shop.id, shopName: shop.name, resort: shop.town, country: shop.country,
      startDate, endDate, days, persons: persons.length, personsDetail: personsDesc, lang
    }
  });
      }
