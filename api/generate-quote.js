const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Webhook-Secret',
};

const PRODUCTS = {
  adult:  { ski: { beginner: 2, intermediate: 3, expert: 4 }, snowboard: { beginner: 28, intermediate: 30, expert: 31 } },
  teen:   { ski: { beginner: 129, intermediate: 96, expert: 92 }, snowboard: { beginner: 97, intermediate: 97, expert: 97 } },
  junior: { ski: { beginner: 15, intermediate: 15, expert: 16 }, snowboard: { beginner: 42, intermediate: 42, expert: 43 } },
  child:  { ski: { beginner: 80, intermediate: 80, expert: 81 }, snowboard: { beginner: 38, intermediate: 38, expert: 43 } }
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

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  const params = req.method === 'POST' ? req.body : req.query;

  const {
    shopId,
    shopSlug  = 'shop',
    country   = 'france',
    region    = 'region',
    startDate,
    endDate,
    lang      = 'en',
    promoCode = '',
  } = params;

  let persons = params.persons;
  if (typeof persons === 'string') {
    try { persons = JSON.parse(persons); } catch { persons = null; }
  }

  const missing = [];
  if (!shopId)    missing.push('shopId');
  if (!startDate) missing.push('startDate');
  if (!endDate)   missing.push('endDate');
  if (!persons || !Array.isArray(persons) || persons.length === 0) missing.push('persons');

  if (missing.length) {
    return res.status(400).json({
      error: `Missing required params: ${missing.join(', ')}`,
      example: {
        shopId: '1484',
        startDate: '2026-03-21',
        endDate: '2026-03-28',
        persons: [{ age: 35, skill: 'intermediate', equipment: 'ski' }]
      }
    });
  }

  const cartPersons = persons.map(p => ({
    age:      parseInt(p.age) || 35,
    skill:    p.skill === 'intermediate' ? 'advanced' : (p.skill || 'advanced'),
    products: [{ definitionId: getDefinitionId(p.age, p.skill, p.equipment), addons: [1] }]
  }));

  const cart = {
    promotionCode: promoCode || '',
    persons: cartPersons,
    insurances: []
  };

  const cartUrl = `https://www.alpy.com/${lang}/ski-rental/${country}/${region}/${shopSlug}/${shopId}/products?cart=${encodeURIComponent(JSON.stringify(cart))}&startDate=${startDate}&endDate=${endDate}`;

  const personsDesc = persons.map(p =>
    `${p.age}yr ${p.skill || 'intermediate'} ${p.equipment || 'ski'}`
  ).join(', ');

  const days = Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000);

  return res.status(200).json({
    cartUrl,
    summary: { shopId, startDate, endDate, days, persons: persons.length, personsDetail: personsDesc, lang }
  });
}
