// Alpy Cart URL Generator API
// Called with: GET /api/cart?shopId=1484&startDate=2026-03-21&endDate=2026-03-28&nbPersons=2&skill=intermediate&equipment=ski&age=35
// Note: shopSlug and region are optional - alpy.com routes on shopId alone

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const {
    shopId,
    shopSlug  = 'shop',
    country   = 'france',
    region    = 'region',
    startDate,
    endDate,
    lang      = 'en',
    nbPersons = '1',
    age       = '35',
    skill     = 'intermediate',
    equipment = 'ski',
    promoCode = ''
  } = req.query;

  // ── Validation ────────────────────────────────────────────────────────────
  const missing = [];
  if (!shopId)    missing.push('shopId');
  if (!startDate) missing.push('startDate');
  if (!endDate)   missing.push('endDate');

  if (missing.length) {
    return res.status(400).json({
      error: `Paramètres manquants : ${missing.join(', ')}`,
      example: '/api/cart?shopId=1484&startDate=2026-03-21&endDate=2026-03-28&nbPersons=2&age=35&skill=intermediate&equipment=ski&lang=en'
    });
  }

  // ── Category from age ─────────────────────────────────────────────────────
  const ageNum = parseInt(age, 10) || 35;
  let category;
  if      (ageNum <= 6)  category = 'child';
  else if (ageNum <= 12) category = 'junior';
  else if (ageNum <= 17) category = 'teen';
  else                   category = 'adult';

  // ── Product ID mapping ────────────────────────────────────────────────────
  const PRODUCTS = {
    adult:  { ski: { beginner: 2,   intermediate: 3,  expert: 4  }, snowboard: { beginner: 28, intermediate: 30, expert: 31 } },
    teen:   { ski: { beginner: 129, intermediate: 96, expert: 92 }, snowboard: { beginner: 97, intermediate: 97, expert: 97 } },
    junior: { ski: { beginner: 15,  intermediate: 15, expert: 16 }, snowboard: { beginner: 42, intermediate: 42, expert: 43 } },
    child:  { ski: { beginner: 80,  intermediate: 80, expert: 81 }, snowboard: { beginner: 38, intermediate: 38, expert: 39 } }
  };

  const skillKey  = ['beginner', 'intermediate', 'expert'].includes(skill) ? skill : 'intermediate';
  const equipKey  = equipment === 'snowboard' ? 'snowboard' : 'ski';
  const defId     = PRODUCTS[category][equipKey][skillKey];
  const skillApi  = skill === 'intermediate' ? 'advanced' : skillKey;

  // ── Build persons array ───────────────────────────────────────────────────
  const n = Math.min(Math.max(parseInt(nbPersons, 10) || 1, 1), 8);
  const person = {
    age:      ageNum,
    skill:    skillApi,
    products: [{ definitionId: defId, addons: [1] }]
  };
  const persons = Array(n).fill(null).map(() => ({ ...person }));

  // ── Build & encode cart JSON ──────────────────────────────────────────────
  const cart = {
    promotionCode: promoCode || '',
    persons,
    insurances: []
  };
  const encoded = encodeURIComponent(JSON.stringify(cart));

  // ── Final URL ─────────────────────────────────────────────────────────────
  const cartUrl = `https://www.alpy.com/${lang}/ski-rental/${country}/${region}/${shopSlug}/${shopId}/products?cart=${encoded}&startDate=${startDate}&endDate=${endDate}`;

  return res.status(200).json({
    cartUrl,
    debug: {
      shopId, country, region, shopSlug, startDate, endDate,
      lang, nbPersons: n, age: ageNum, skill: skillApi,
      equipment: equipKey, category, definitionId: defId
    }
  });
}
