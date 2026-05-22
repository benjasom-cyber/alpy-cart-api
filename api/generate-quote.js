/**
 * POST /api/generate-quote
 *
 * Generates a direct Alpy.com booking link for a customer quote.
 *
 * Body params:
 *   resort    - resort / town name e.g. "Chamonix", "Val d'Isere", "Zermatt" (required)
 *   shopId    - Odin legacy shop ID (optional, overrides resort lookup)
 *   startDate - YYYY-MM-DD (required)
 *   endDate   - YYYY-MM-DD (required)
 *   persons   - JSON array [{age, skill, equipment}] (required)
 *   lang      - language code (optional, defaults to 'en')
 *   promoCode - promo code (optional)
 *
 * Returns: { cartUrl, shopName, shopId, resort, summary }
 */
const SHOPS_URL = 'https://raw.githubusercontent.com/benjasom-cyber/alpy-cart-api/main/api/shops_data.json';
let _shopsCache = null;
async function getShops() {
  if (_shopsCache) return _shopsCache;
  const r = await fetch(SHOPS_URL);
  if (!r.ok) throw new Error('Failed to load shops: ' + r.status);
  _shopsCache = await r.json();
  return _shopsCache;
}
const PRODUCTS = {
  adult:  { ski: { beginner: 2,   intermediate: 3,  expert: 4  }, snowboard: { beginner: 28, intermediate: 30, expert: 31 } },
  teen:   { ski: { beginner: 129, intermediate: 96, expert: 92 }, snowboard: { beginner: 97, intermediate: 97, expert: 97 } },
  junior: { ski: { beginner: 15,  intermediate: 15, expert: 16 }, snowboard: { beginner: 42, intermediate: 42, expert: 43 } },
  child:  { ski: { beginner: 80,  intermediate: 80, expert: 81 }, snowboard: { beginner: 38, intermediate: 38, expert: 43 } }
};
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Webhook-Secret' };
function getCategory(age) { if (age<=6) return 'child'; if (age<=12) return 'junior'; if (age<=17) return 'teen'; return 'adult'; }
function getDefinitionId(age, skill, equipment) {
  const cat = getCategory(parseInt(age)||35);
  const eq = equipment==='snowboard' ? 'snowboard' : 'ski';
  const sk = ['beginner','intermediate','expert'].includes(skill) ? skill : 'intermediate';
  return PRODUCTS[cat][eq][sk];
}
function norm(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[''`']/g,'').replace(/[.\-_]/g,' ').replace(/\s+/g,' ').trim();
}
function findShop(shops, resort) {
  if (!resort) return null;
  const q = norm(resort), qNS = q.replace(/\s/g,'');
  for (const s of shops) { const t=norm(s.town); if (t===q||t.replace(/\s/g,'')===qNS) return s; }
  for (const s of shops) { const tl=norm(s.town); if (tl.includes(q)||tl.replace(/\s/g,'').includes(qNS)) return s; }
  for (const s of shops) { const nl=norm(s.name); if (nl.includes(q)||nl.replace(/\s/g,'').includes(qNS)) return s; }
  return null;
}
export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k,v));
  if (req.method==='OPTIONS') return res.status(200).end();
  const params = req.method==='POST' ? req.body : req.query;
  const { resort, shopId: shopIdParam, lang='en', startDate, endDate, promoCode='' } = params;
  let persons = params.persons;
  if (typeof persons==='string') { try { persons=JSON.parse(persons); } catch { persons=null; } }
  let shop = null;
  const shops = await getShops();
  if (shopIdParam) {
    const id = parseInt(shopIdParam);
    shop = shops.find(s=>s.id===id) || { id, slug:'shop', country:'france', region:'region', town:'Shop '+id, name:'Shop '+id };
  } else if (resort) {
    shop = findShop(shops, resort);
    if (!shop) return res.status(404).json({ error: 'No shop found for resort: "'+resort+'". Try Chamonix, Morzine, Zermatt, Val d\'Isere, St Anton' });
  } else {
    return res.status(400).json({ error: 'Missing required param: resort (or shopId)', example: { resort:'Chamonix', startDate:'2026-03-21', endDate:'2026-03-28', persons:[{age:35,skill:'intermediate',equipment:'ski'}] } });
  }
  const missing = [];
  if (!startDate) missing.push('startDate');
  if (!endDate) missing.push('endDate');
  if (!persons||!Array.isArray(persons)||persons.length===0) missing.push('persons');
  if (missing.length) return res.status(400).json({ error: 'Missing: '+missing.join(', ') });
  const cartPersons = persons.map(p => ({ age: parseInt(p.age)||35, skill: p.skill==='intermediate'?'advanced':(p.skill||'advanced'), products: [{ definitionId: getDefinitionId(p.age,p.skill,p.equipment), addons:[1] }] }));
  const cart = { promotionCode: promoCode||'', persons: cartPersons, insurances: [] };
  const cartUrl = 'https://www.alpy.com/'+lang+'/ski-rental/'+shop.country+'/'+shop.region+'/'+shop.slug+'/'+shop.id+'/products?cart='+encodeURIComponent(JSON.stringify(cart))+'&startDate='+startDate+'&endDate='+endDate;
  const personsDesc = persons.map(p => p.age+'yr '+(p.skill||'intermediate')+' '+(p.equipment||'ski')).join(', ');
  const days = Math.ceil((new Date(endDate)-new Date(startDate))/86400000);
  return res.status(200).json({ cartUrl, shopName: shop.name, shopId: shop.id, resort: shop.town, summary: { shopId:shop.id, shopName:shop.name, resort:shop.town, country:shop.country, startDate, endDate, days, persons:persons.length, personsDetail:personsDesc, lang } });
}
