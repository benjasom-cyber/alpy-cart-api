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
 *   persons       - JSON array [{age, skill, equipment}] (required)
 *   groupSize     - total people, if larger than persons.length sample (optional)
 *   lang          - language code (optional, defaults to 'en')
 *   promoCode     - promo code (optional)
 *
 * Returns: { cartUrl, shopName, shopId, resort, cheapestTotalPrice, shopPrice,
 *            discountAmount, pricePerPerson, couponValue, couponMessage, summary, pricing? }
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
  } = params;

  const resort    = resortParam    || resortAlt    || (claudeParsed && claudeParsed.resort)     || null;
      const startDate = startDateParam || startDateAlt || (claudeParsed && claudeParsed.start_date) || null;
      const endDate   = endDateParam   || endDateAlt   || (claudeParsed && claudeParsed.end_date)   || null;

  let persons = params.persons || (claudeParsed && claudeParsed.persons) || null;
      if (typeof persons === 'string') {
              try { persons = JSON.parse(persons); } catch { persons = null; }
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
                                persons: [{ age: 35, skill: 'intermediate', equipment: 'ski' }]
                    }
          });
  }

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

  const cartPersons = persons.map(p => ({
          age: parseInt(p.age) || 35,
          skill: p.skill === 'intermediate' ? 'advanced' : (p.skill || 'advanced'),
          products: [{ definitionId: getDefinitionId(p.age, p.skill, p.equipment), addons: [1] }]
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

  const groupSize = groupSizeParam ? parseInt(groupSizeParam) : persons.length;
      const scaleRatio = groupSize / persons.length;

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
          cheapestTotalPrice: estimatedTotal,
          shopPrice,
          discountAmount,
          pricePerPerson,
          currency: pricing ? pricing.currency : 'EUR',
          rentalDays: pricing ? pricing.rentalDays : days,
          pricingAvailable,
          groupSize,
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
                    cheapestTotalPrice: estimatedTotal,
                    shopPrice,
                    pricePerPerson,
                    currency: pricing ? pricing.currency : 'EUR',
                    couponValue,
          }
  });
}
