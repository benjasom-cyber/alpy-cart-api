export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const {
    shopId, shopSlug,
    country   = 'france',
    region,
    startDate, endDate,
    lang      = 'en',
    nbPersons = '1',
    age       = '35',
    skill     = 'intermediate',
    equipment = 'ski',
    promoCode = ''
  } = req.query;

  const missing = [];
  if (!shopId)    missing.push('shopId');
  if (!shopSlug)  missing.push('shopSlug');
  if (!region)    missing.push('region');
  if (!startDate) missing.push('startDate');
  if (!endDate)   missing.push('endDate');
  if (missing.length) {
    return res.status(400).json({ error: 'Parametres manquants : ' + missing.join(', ') });
  }

  const ageNum = parseInt(age, 10) || 35;
  const category = ageNum <= 6 ? 'child' : ageNum <= 12 ? 'junior' : ageNum <= 17 ? 'teen' : 'adult';

  const PRODUCTS = {
    adult:  { ski: { beginner: 2,   intermediate: 3,  expert: 4  }, snowboard: { beginner: 28, intermediate: 30, expert: 31 } },
    teen:   { ski: { beginner: 129, intermediate: 96, expert: 92 }, snowboard: { beginner: 97, intermediate: 97, expert: 97 } },
    junior: { ski: { beginner: 15,  intermediate: 15, expert: 16 }, snowboard: { beginner: 42, intermediate: 42, expert: 43 } },
    child:  { ski: { beginner: 80,  intermediate: 80, expert: 81 }, snowboard: { beginner: 38, intermediate: 38, expert: 39 } }
  };

  const skillKey = ['beginner', 'intermediate', 'expert'].includes(skill) ? skill : 'intermediate';
  const equipKey = equipment === 'snowboard' ? 'snowboard' : 'ski';
  const defId    = PRODUCTS[category][equipKey][skillKey];
  const skillApi = skill === 'intermediate' ? 'advanced' : skillKey;

  const n = Math.min(Math.max(parseInt(nbPersons, 10) || 1, 1), 8);
  const person = { age: ageNum, skill: skillApi, products: [{ definitionId: defId, addons: [1] }] };
  const persons = Array(n).fill(null).map(() => ({ ...person }));

  const cart = { promotionCode: promoCode || '', persons, insurances: [] };
  const encoded = encodeURIComponent(JSON.stringify(cart));
  const cartUrl = `https://www.alpy.com/${lang}/ski-rental/${country}/${region}/${shopSlug}/${shopId}/products?cart=${encoded}&startDate=${startDate}&endDate=${endDate}`;

  return res.status(200).json({
    cartUrl,
    debug: { shopId, shopSlug, country, region, startDate, endDate, lang, nbPersons: n, age: ageNum, skill: skillApi, equipment: equipKey, category, definitionId: defId }
  });
}
