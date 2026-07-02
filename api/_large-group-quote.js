/**
 * POST /api/large-group-quote
 *
 * Generates a pre-filled Alpy cart URL for a large group booking and calculates
 * a recommended coupon value based on the estimated total rental price.
 *
 * Accepts the same body as /api/generate-quote plus:
 *   groupSize  (integer, optional) - total number of people (if > persons.length)
 *
 * Returns:
 *   { cartUrl, shopUrl, shopName, cheapestTotalPrice, pricePerPerson, currency,
 *     rentalDays, pricingAvailable, groupSize, couponValue, couponCurrency,
 *     couponMessage, agentInstructions }
 */

import { fetchLivePricing, countryToCode } from './_alpyPricing.js';

const SHOPS_URL = 'https://raw.githubusercontent.com/benjasom-cyber/alpy-cart-api/main/api/shops_data.json';
let _shopsCache = null;

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Webhook-Secret',
};

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

async function getShops() {
    if (_shopsCache) return _shopsCache;
    const r = await fetch(SHOPS_URL);
    if (!r.ok) throw new Error('Failed to load shops data: ' + r.status);
    _shopsCache = await r.json();
    return _shopsCache;
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

function expandBlob(raw) {
    const b = { ...raw };
    const blob = Object.values(b).find(v => typeof v === 'string' && v.trim().startsWith('{'));
    if (blob) { try { Object.assign(b, JSON.parse(blob)); } catch {} }
    const LC = { startdate: 'startDate', enddate: 'endDate', groupsize: 'groupSize',
                    start_date: 'startDate', end_date: 'endDate', group_size: 'groupSize' };
    for (const [lc, cc] of Object.entries(LC)) if (b[lc] !== undefined && b[cc] === undefined) b[cc] = b[lc];
    return b;
}

export async function handler(req, res) {
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const params = expandBlob(req.body || {});

  const {
        resort,
        shopId: shopIdParam,
        startDate,
        endDate,
        lang = 'en',
        promoCode = '',
        currency = 'EUR',
        groupSize: groupSizeParam,
  } = params;

  let { persons } = params;
    if (typeof persons === 'string') {
          try { persons = JSON.parse(persons); } catch { persons = null; }
    }

  const missing = [];
    if (!resort && !shopIdParam) missing.push('resort (or shopId)');
    if (!startDate) missing.push('startDate');
    if (!endDate) missing.push('endDate');
    if (!persons || !Array.isArray(persons) || persons.length === 0) missing.push('persons');

  if (missing.length) {
        return res.status(400).json({
                error: 'Missing required params: ' + missing.join(', '),
                example: {
                          resort: 'Chamonix', startDate: '2026-03-14', endDate: '2026-03-21',
                          persons: [
                            { age: 35, skill: 'intermediate', equipment: 'ski' },
                            { age: 32, skill: 'beginner', equipment: 'ski' },
                                    ],
                          groupSize: 12,
                },
        });
  }

  try {
        const shops = await getShops();

      let shop = null;
        if (shopIdParam) {
                const id = parseInt(shopIdParam);
                shop = shops.find(s => s.id === id) || {
                          id, slug: 'shop', country: 'france', region: 'region',
                          town: 'Shop ' + id, name: 'Shop ' + id,
                };
        } else {
                shop = findShop(shops, String(resort));
                if (!shop) {
                          return res.status(404).json({
                                      error: 'No shop found for resort: "' + resort + '". Check spelling or use alpy.com.',
                                      hint: 'Examples: "Chamonix", "Morzine", "Zermatt", "Val d Isere", "St Anton"',
                          });
                }
        }

      const cartPersons = persons.map(p => ({
              age: parseInt(p.age) || 35,
              skill: p.skill === 'intermediate' ? 'advanced' : (p.skill || 'advanced'),
              products: [{ definitionId: getDefinitionId(p.age, p.skill, p.equipment), addons: [1] }],
      }));

      const cart = { promotionCode: promoCode || '', persons: cartPersons, insurances: [] };
        const shopUrl = 'https://www.alpy.com/' + lang + '/ski-rental/' + shop.country + '/' + shop.region + '/' + shop.slug + '/' + shop.id;
        const cartUrl = shopUrl + '/products?cart=' + encodeURIComponent(JSON.stringify(cart)) + '&startDate=' + startDate + '&endDate=' + endDate;
        const days = Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000);

      const pricing = await fetchLivePricing({
              shop, startDate, endDate, persons, getDefinitionId,
              currency,
              countryCode: countryToCode(shop.country),
              promoCode,
      });

      const groupSize = groupSizeParam ? parseInt(groupSizeParam) : persons.length;

      let estimatedTotal;
        let pricingAvailable = false;

      if (pricing && pricing.cheapestTotalPrice) {
              const scaleRatio = groupSize / persons.length;
              estimatedTotal = Math.round(pricing.cheapestTotalPrice * scaleRatio * 100) / 100;
              pricingAvailable = true;
      } else {
              estimatedTotal = groupSize * 150;
      }

      const couponValue = calculateCoupon(estimatedTotal);

      const pricePerPerson = persons.length > 0
          ? Math.round((estimatedTotal / groupSize) * 100) / 100
              : estimatedTotal;

      const couponMessage = couponValue > 0
          ? 'For a group of ' + groupSize + ' with an estimated total of ' + estimatedTotal.toLocaleString('en-GB') + ' EUR - recommend a ' + couponValue + ' EUR coupon to help convert.'
              : 'For a group of ' + groupSize + ' with an estimated total of ' + estimatedTotal.toLocaleString('en-GB') + ' EUR - no coupon needed at this price level.';

      const agentInstructions = couponValue > 0
          ? 'Create a ' + couponValue + ' EUR coupon code in Odin Admin and send it to the customer alongside their pre-filled cart link.'
              : 'No coupon required. Share the pre-filled cart link directly with the customer.';

      return res.status(200).json({
              cartUrl,
              shopUrl,
              shopName: shop.name,
              shopId: shop.id,
              resort: shop.town,
              cheapestTotalPrice: estimatedTotal,
              pricePerPerson,
              currency,
              rentalDays: days,
              pricingAvailable,
              groupSize,
              personsInCart: persons.length,
              couponValue,
              couponCurrency: 'EUR',
              couponMessage,
              agentInstructions,
      });
  } catch (err) {
        console.error('[large-group-quote]', err);
        return res.status(500).json({ error: err.message });
  }
}
