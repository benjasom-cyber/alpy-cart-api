/**
 * POST /api/find-nearest-shop
 *
 * "Which of your shops is closest to Chalet Belle Vue in Méribel?"
 *
 * Customers assume we are on site and know which shop is next to their
 * accommodation. Until 2026-09-04 this endpoint answered with a fuzzy match on
 * the TOWN name only: it could tell "Méribel" from "Morzine", never one Méribel
 * shop from another. This version does the actual job in two halves:
 *
 *   mode=resolve  the resort the customer named -> our town (slug, country,
 *                 region), the shops we list there, the resort centre
 *                 coordinates. Ambiguity ("Courchevel" x3) comes back as a
 *                 QUESTION to ask, never as an error.
 *
 *   mode=rank     the accommodation (hotel, chalet, résidence, street address)
 *                 -> coordinates, then the distance to every shop of the town.
 *                 Shop coordinates, addresses and delivery options come from
 *                 Odin, which the caller (an action flow) reads with the Odin
 *                 MCP tool `location_town_shop_list` and passes in `shops`
 *                 (trimmed: id, legacyId, name, address, coordinates,
 *                 deliveryOptions, isInTown, distanceToCenter, hasDepot).
 *                 Vercel cannot reach the Odin admin itself.
 *
 *   mode=auto     both, when the caller has no shops to pass: resolve, then
 *                 rank against shops_data.json (no coordinates -> ranked by
 *                 town match only, as before). Kept for the ZAF and old callers.
 *
 * GEOCODING. The accommodation is located with, in order:
 *   1. Google Places Text Search, when GOOGLE_MAPS_API_KEY is set in Vercel -
 *      by far the best source for hotels, chalets and résidences by name;
 *   2. Photon (komoot, OpenStreetMap) then Nominatim, both restricted to the
 *      resort's surroundings - a "Chalet Belle Vue" in Bastia is not the one;
 *   3. nothing: `located=false`, the shops are ranked by distance to the resort
 *      centre, and `question` carries the one thing to ask (a street address or
 *      the accommodation's full name).
 * A geocoding hit farther than MAX_KM from the resort centre is rejected.
 *
 * Every answer is HTTP 200. A flow step that receives a 4xx dies; a question is
 * an answer.
 */

const SHOPS_URL = 'https://raw.githubusercontent.com/benjasom-cyber/alpy-cart-api/main/api/shops_data.json';
let _shopsCache = null;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Webhook-Secret',
};

/** Beyond this distance from the resort centre a geocoding hit is another place with the same name. */
const MAX_KM = 15;
/** Walking pace used for the "about 10 minutes on foot" line: 4.5 km/h, plus snow. */
const WALK_M_PER_MIN = 70;
const UA = 'alpy-cart-api/nearest-shop (support@alpy.com)';
/** Geocoder result types that mean "the town itself", never an accommodation. */
const PLACE_TYPES = /^(city|town|village|hamlet|suburb|locality|municipality|administrative|county|state|country|region|district|quarter|neighbourhood|island)$/i;

// ── Product definition IDs (mirrors generate-quote.js) ───────────────────────
const PRODUCTS = {
  adult:  { ski: { beginner: 2,   intermediate: 3,  expert: 4  }, snowboard: { beginner: 28, intermediate: 30, expert: 31 } },
  teen:   { ski: { beginner: 129, intermediate: 96, expert: 92 }, snowboard: { beginner: 97, intermediate: 97, expert: 97 } },
  junior: { ski: { beginner: 15,  intermediate: 15, expert: 16 }, snowboard: { beginner: 42, intermediate: 42, expert: 43 } },
  child:  { ski: { beginner: 80,  intermediate: 80, expert: 81 }, snowboard: { beginner: 38, intermediate: 38, expert: 43 } },
};
function getCategory(age) { if (age <= 6) return 'child'; if (age <= 12) return 'junior'; if (age <= 17) return 'teen'; return 'adult'; }
function getDefinitionId(age, skill, equipment) {
  const cat = getCategory(parseInt(age) || 35);
  const equip = equipment === 'snowboard' ? 'snowboard' : 'ski';
  const sk = ['beginner', 'intermediate', 'expert'].includes(skill) ? skill : 'intermediate';
  return PRODUCTS[cat][equip][sk];
}

// ── Normalisation ─────────────────────────────────────────────────────────────
function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`´]/g, '')
    .replace(/[.\-_,/]/g, ' ')
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

// ── Town resolution ───────────────────────────────────────────────────────────
/**
 * The towns whose name matches the customer's word. Exact match first; a word
 * that is the prefix of several towns ("Courchevel" -> 1300/1650/1850, "Val" ->
 * everything) is AMBIGUOUS and comes back as candidates, not as a guess.
 */
function resolveTown(shops, query) {
  const q = norm(query);
  if (!q) return { towns: [], ambiguous: false };
  const byTown = new Map();
  for (const s of shops) {
    const key = s.country + '/' + s.region + '/' + s.slug;
    if (!byTown.has(key)) byTown.set(key, { slug: key, town: s.town, country: s.country, region: s.region, shops: [] });
    byTown.get(key).shops.push(s);
  }
  const towns = [...byTown.values()];
  const exact = towns.filter(t => norm(t.town) === q || norm(t.slug.split('/').pop()) === q);
  if (exact.length === 1) return { towns: exact, ambiguous: false };
  if (exact.length > 1) return { towns: exact, ambiguous: true };
  const prefix = towns.filter(t => norm(t.town).startsWith(q + ' ') || norm(t.town).startsWith(q));
  if (prefix.length === 1) return { towns: prefix, ambiguous: false };
  if (prefix.length > 1) return { towns: prefix, ambiguous: true };
  const contains = towns.filter(t => norm(t.town).includes(q) || q.includes(norm(t.town)));
  if (contains.length === 1) return { towns: contains, ambiguous: false };
  if (contains.length > 1) return { towns: contains, ambiguous: true };
  // A shop name typed instead of a town ("Sport 2000 Chamonix").
  const byShop = towns.filter(t => t.shops.some(s => norm(s.name).includes(q)));
  if (byShop.length === 1) return { towns: byShop, ambiguous: false };
  return { towns: [], ambiguous: false };
}

// ── Geometry ──────────────────────────────────────────────────────────────────
function haversineM(a, b) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
function fmtDist(m) {
  if (m == null) return '';
  if (m < 950) return m + ' m';
  return (Math.round(m / 100) / 10).toFixed(1).replace(/\.0$/, '') + ' km';
}
function walkMin(m) { return Math.max(1, Math.round(m / WALK_M_PER_MIN)); }

// ── Geocoders ─────────────────────────────────────────────────────────────────
async function fetchJson(url, opts) {
  const r = await fetch(url, Object.assign({ headers: { 'Accept': 'application/json', 'User-Agent': UA } }, opts || {}));
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

/** Resort centre: Photon, then Nominatim, on "<town>, <country>". */
async function geocodeCentre(town, country) {
  const q = town + ', ' + country;
  const p = await fetchJson('https://photon.komoot.io/api/?limit=5&q=' + encodeURIComponent(q));
  const feats = (p && p.features) || [];
  const place = feats.find(f => /city|town|village|hamlet|suburb|locality|municipality/.test(String(f.properties && (f.properties.osm_value || f.properties.type))))
             || feats[0];
  if (place && place.geometry) return { lat: place.geometry.coordinates[1], lng: place.geometry.coordinates[0], source: 'photon' };
  const n = await fetchJson('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(q));
  if (n && n[0]) return { lat: parseFloat(n[0].lat), lng: parseFloat(n[0].lon), source: 'nominatim' };
  return null;
}

async function geocodeGoogle(text, centre) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  const params = new URLSearchParams({ query: text, key });
  if (centre) { params.set('location', centre.lat + ',' + centre.lng); params.set('radius', String(MAX_KM * 1000)); }
  const j = await fetchJson('https://maps.googleapis.com/maps/api/place/textsearch/json?' + params.toString());
  const r = j && j.results && j.results.find(x => !(x.types || []).some(t => /^(locality|political|administrative_area|country|postal_code|sublocality|neighborhood|route)/.test(t)));
  if (!r || !r.geometry) return null;
  return { lat: r.geometry.location.lat, lng: r.geometry.location.lng, label: r.name + (r.formatted_address ? ', ' + r.formatted_address : ''), source: 'google' };
}

async function geocodePhoton(text, centre) {
  let url = 'https://photon.komoot.io/api/?limit=5&q=' + encodeURIComponent(text);
  if (centre) url += '&lat=' + centre.lat + '&lon=' + centre.lng + '&location_bias_scale=0.8&zoom=14';
  const j = await fetchJson(url);
  const feats = (j && j.features) || [];
  for (const f of feats) {
    const p = f.properties || {};
    // A geocoder that cannot find the chalet answers with the village itself.
    // That is not the accommodation, and treating it as one would rank the
    // shops from the church square while telling the customer "81 m from you".
    if (PLACE_TYPES.test(String(p.osm_value || p.type || ''))) continue;
    const c = { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
    if (!centre || haversineM(c, centre) <= MAX_KM * 1000) {
      return Object.assign(c, { label: [p.name, p.street, p.city].filter(Boolean).join(', '), source: 'photon' });
    }
  }
  return null;
}

async function geocodeNominatim(text, centre) {
  let url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=' + encodeURIComponent(text);
  if (centre) {
    const d = 0.15; // ~15 km box
    url += '&bounded=1&viewbox=' + (centre.lng - d) + ',' + (centre.lat + d) + ',' + (centre.lng + d) + ',' + (centre.lat - d);
  }
  const j = await fetchJson(url);
  const r = (j || []).find(x => !PLACE_TYPES.test(String(x.type || '')) && !/^(place|boundary)$/.test(String(x.category || x.class || '')));
  if (!r) return null;
  return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), label: String(r.display_name || '').split(',').slice(0, 3).join(','), source: 'nominatim' };
}

/**
 * Locate the accommodation. Tries the text as written, then with the town
 * appended, on each geocoder in order. Returns null when nothing plausible.
 */
async function geocodeAccommodation(text, town, country, centre) {
  const variants = [...new Set([text, text + ', ' + town, text + ', ' + town + ', ' + country].map(s => s.trim()))];
  for (const v of variants) {
    const g = await geocodeGoogle(v, centre);
    if (g && (!centre || haversineM(g, centre) <= MAX_KM * 1000)) return g;
  }
  for (const v of variants) {
    const p = await geocodePhoton(v, centre);
    if (p) return p;
  }
  for (const v of variants) {
    const n = await geocodeNominatim(v, centre);
    if (n && (!centre || haversineM(n, centre) <= MAX_KM * 1000)) return n;
  }
  return null;
}

// ── Shops from Odin (passed by the caller) ────────────────────────────────────
function parseShopsParam(v) {
  if (!v) return [];
  let arr = v;
  if (typeof v === 'string') { try { arr = JSON.parse(v); } catch { return []; } }
  if (arr && !Array.isArray(arr) && Array.isArray(arr.shops)) arr = arr.shops;
  if (!Array.isArray(arr)) return [];
  return arr.map(s => {
    const c = s.coordinates || {};
    const lat = parseFloat(c.latitude != null ? c.latitude : s.lat), lng = parseFloat(c.longitude != null ? c.longitude : s.lng);
    return {
      id: s.legacyId != null ? s.legacyId : (s.coreId != null ? s.coreId : s.id),
      odinId: s.id,
      name: s.name,
      address: s.address || '',
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      deliveryOptions: s.deliveryOptions || [],
      isInTown: s.isInTown !== false,
      distanceToCenterKm: typeof s.distanceToCenter === 'number' ? s.distanceToCenter : null,
      hasDepot: !!s.hasDepot,
      hasGuaranty: !!s.hasGuaranty,
      isTopShop: !!s.isTopShop,
    };
  }).filter(s => s.name);
}

function deliveryText(opts) {
  const o = (opts || []).map(String);
  const out = [];
  if (o.includes('ACCOMMODATION_SHUTTLE')) out.push('free shuttle to the accommodation');
  if (o.includes('ACCOMMODATION_IN_PERSON_DELIVERY')) out.push('delivers and fits the equipment at the accommodation');
  if (o.includes('ACCOMMODATION_DROP_OFF')) out.push('drops the equipment off at the accommodation');
  return out.join(', ');
}

// ── Cart URL (kept for the ZAF caller) ────────────────────────────────────────
function buildCartUrl(shopUrl, persons, startDate, endDate) {
  if (!startDate || !endDate || !Array.isArray(persons) || persons.length === 0) return null;
  const cartPersons = persons.map(p => ({
    age: parseInt(p.age) || 35,
    skill: p.skill === 'intermediate' ? 'advanced' : (p.skill || 'advanced'),
    products: [{ definitionId: getDefinitionId(p.age, p.skill, p.equipment), addons: [1] }],
  }));
  const cart = { promotionCode: '', persons: cartPersons, insurances: [] };
  return shopUrl + '/products?cart=' + encodeURIComponent(JSON.stringify(cart)) + '&startDate=' + startDate + '&endDate=' + endDate;
}

function expandBlob(raw) {
  const b = Object.assign({}, raw);
  // A caller may pass one JSON object blob (e.g. the extraction step's JSON) in any field:
  // merge every object-shaped blob, without overwriting keys given explicitly.
  for (const v of Object.values(raw)) {
    if (typeof v !== 'string' || !v.trim().startsWith('{')) continue;
    try {
      const o = JSON.parse(v);
      if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, val] of Object.entries(o)) if (b[k] === undefined || b[k] === '') b[k] = val;
    } catch {}
  }
  const LC = { startdate: 'startDate', enddate: 'endDate', accommodationaddress: 'accommodationAddress' };
  for (const [lc, cc] of Object.entries(LC)) if (b[lc] !== undefined && b[cc] === undefined) b[cc] = b[lc];
  return b;
}

/** Flat, lowercase-aliased response: a Zendesk custom action binds these in one click. */
function reply(res, o) {
  const flat = {};
  for (const [k, v] of Object.entries(o)) { flat[k] = v; flat[k.toLowerCase()] = v; }
  return res.status(200).json(flat);
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  let raw = req.body || {};
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = {}; } }
  const body = expandBlob(Object.assign({}, req.query || {}, raw));
  const mode = String(body.mode || 'auto').toLowerCase();
  const resort = String(body.resort || '').trim();
  const accommodation = String(body.accommodation || body.accommodationAddress || '').trim();
  const lang = String(body.lang || 'en').slice(0, 2);
  let persons = body.persons;
  if (typeof persons === 'string') { try { persons = JSON.parse(persons); } catch { persons = null; } }

  const locationInput = resort || accommodation;
  if (!locationInput) {
    return reply(res, { found: false, located: false, needsQuestion: true,
      question: 'Which resort (or which accommodation, with the resort) will you be staying in?',
      message: 'No resort or accommodation was given.' });
  }

  try {
    const shopsData = await getShops();

    // ── Resolve the town ─────────────────────────────────────────────────────
    let resolved = resolveTown(shopsData, resort || accommodation);
    if (!resolved.towns.length && accommodation && resort) resolved = resolveTown(shopsData, accommodation);
    if (resolved.ambiguous) {
      const names = resolved.towns.map(t => t.town).slice(0, 8);
      return reply(res, { found: false, located: false, needsQuestion: true, reason: 'AMBIGUOUS_RESORT',
        candidates: names,
        question: 'Which "' + (resort || accommodation) + '" do you mean? We have partner shops in ' + names.join(', ') +
                  '. Tell us the exact resort or village and we will find the closest shop.',
        message: 'Ambiguous resort.' });
    }
    if (!resolved.towns.length) {
      return reply(res, { found: false, located: false, needsQuestion: true, reason: 'RESORT_NOT_FOUND',
        question: 'We could not find a partner shop for "' + locationInput + '". Could you tell us the exact name of the resort or village?',
        message: 'No town matched.' });
    }
    const town = resolved.towns[0];
    const shopUrlFor = s => 'https://www.alpy.com/' + lang + '/ski-rental/' + town.country + '/' + town.region + '/' + town.slug.split('/').pop() + '/' + s.id;

    // The resort centre: needed for both the geocoding fence and the fallback ranking.
    const centre = (mode === 'resolve' || accommodation) ? await geocodeCentre(town.town, town.country).catch(() => null) : null;

    if (mode === 'resolve') {
      return reply(res, {
        found: true, located: false, needsQuestion: false, reason: 'RESOLVED',
        slug: town.slug, town: town.town, country: town.country, region: town.region,
        shopCount: town.shops.length,
        shopIds: town.shops.map(s => s.id).join(','),
        centreLat: centre ? centre.lat : null, centreLng: centre ? centre.lng : null,
        message: town.town + ' resolved: ' + town.shops.length + ' shops.',
      });
    }

    // ── Rank ─────────────────────────────────────────────────────────────────
    let odinShops = parseShopsParam(body.shops);
    const withCoords = odinShops.filter(s => s.lat != null && s.lng != null);
    let acc = null;
    if (accommodation && norm(accommodation) !== norm(town.town)) {
      acc = await geocodeAccommodation(accommodation, town.town, town.country, centre).catch(() => null);
    }

    let ranked;
    let basis;
    if (withCoords.length && acc) {
      ranked = withCoords.map(s => Object.assign({}, s, { distanceM: haversineM(acc, s) })).sort((a, b) => a.distanceM - b.distanceM);
      basis = 'distance from the accommodation';
    } else if (withCoords.length && centre) {
      ranked = withCoords.map(s => Object.assign({}, s, { distanceM: haversineM(centre, s) })).sort((a, b) => a.distanceM - b.distanceM);
      basis = 'distance from the resort centre';
    } else if (odinShops.length) {
      ranked = odinShops.slice().sort((a, b) => (a.distanceToCenterKm || 99) - (b.distanceToCenterKm || 99)).map(s => Object.assign({}, s, { distanceM: s.distanceToCenterKm != null ? Math.round(s.distanceToCenterKm * 1000) : null }));
      basis = 'distance from the resort centre (Odin)';
    } else {
      // No Odin shops passed (old callers): the town's shops, unranked.
      ranked = town.shops.map(s => ({ id: s.id, name: s.name, address: '', distanceM: null, deliveryOptions: [], isInTown: true }));
      basis = 'town match only - no coordinates available to this caller';
    }

    const top = ranked.slice(0, 3);
    const lines = top.map((s, i) => {
      const parts = [(i + 1) + '. ' + s.name];
      if (s.address) parts.push(s.address.replace(/\s+/g, ' ').trim());
      if (s.distanceM != null) parts.push('about ' + fmtDist(s.distanceM) + (acc ? ' from the accommodation (~' + walkMin(s.distanceM) + ' min on foot)' : ' from the resort centre'));
      const d = deliveryText(s.deliveryOptions); if (d) parts.push(d);
      if (s.hasDepot) parts.push('ski depot');
      return parts.join(' - ');
    });

    const nearest = top[0] || null;
    // A map of the walk: Google Maps directions, on foot, from the accommodation
    // (or the resort centre) to the shop. A plain URL, so it survives a text email.
    const origin = acc || centre;
    const mapUrlFor = s => (origin && s.lat != null && s.lng != null)
      ? 'https://www.google.com/maps/dir/?api=1&origin=' + origin.lat + ',' + origin.lng + '&destination=' + s.lat + ',' + s.lng + '&travelmode=walking'
      : '';
    const nearestShops = top.map(s => ({
      shopId: s.id, odinId: s.odinId || null, shopName: s.name, address: s.address || '', distanceM: s.distanceM,
      distanceText: s.distanceM != null ? fmtDist(s.distanceM) : '', walkMinutes: s.distanceM != null ? walkMin(s.distanceM) : null,
      deliveryOptions: s.deliveryOptions || [], delivery: deliveryText(s.deliveryOptions), isInTown: s.isInTown,
      shopUrl: shopUrlFor(s),
      mapUrl: mapUrlFor(s),
      cartUrl: buildCartUrl(shopUrlFor(s), persons, body.startDate, body.endDate),
    }));

    const deliveryShops = ranked.filter(s => deliveryText(s.deliveryOptions)).slice(0, 3).map(s => s.name + ' (' + deliveryText(s.deliveryOptions) + ')');

    const located = !!acc;
    const question = located || !accommodation ? '' :
      'We could not place "' + accommodation + '" on the map of ' + town.town + '. Could you give us the street address, or the exact name of the hotel or résidence? ' +
      'In the meantime the shops below are the closest to the centre of ' + town.town + '.';

    return reply(res, {
      found: true,
      located,
      needsQuestion: !located && !!accommodation,
      question,
      reason: located ? 'LOCATED' : (accommodation ? 'ACCOMMODATION_NOT_LOCATED' : 'RESORT_CENTRE'),
      slug: town.slug, town: town.town, country: town.country, region: town.region,
      accommodation, accommodationLabel: acc ? (acc.label || accommodation) : '',
      accommodationLat: acc ? acc.lat : null, accommodationLng: acc ? acc.lng : null, geocoder: acc ? acc.source : '',
      centreLat: centre ? centre.lat : null, centreLng: centre ? centre.lng : null,
      rankingBasis: basis,
      nearestShopId: nearest ? nearest.id : null,
      nearestShopName: nearest ? nearest.name : '',
      nearestShopAddress: nearest ? (nearest.address || '') : '',
      nearestDistanceM: nearest ? nearest.distanceM : null,
      nearestDistanceText: nearest && nearest.distanceM != null ? fmtDist(nearest.distanceM) : '',
      nearestWalkMinutes: nearest && nearest.distanceM != null ? walkMin(nearest.distanceM) : null,
      nearestDelivery: nearest ? deliveryText(nearest.deliveryOptions) : '',
      nearestShopUrl: nearest ? shopUrlFor(nearest) : '',
      nearestMapUrl: nearest ? mapUrlFor(nearest) : '',
      nearestShopLat: nearest ? nearest.lat : null, nearestShopLng: nearest ? nearest.lng : null,
      nearestShopsText: lines.join('\n'),
      deliveryShopsText: deliveryShops.join('; '),
      nearestShops,
      shopsRanked: ranked.length,
      message: located
        ? 'Closest shop to ' + (acc.label || accommodation) + ': ' + nearest.name + ', ' + fmtDist(nearest.distanceM) + '.'
        : (accommodation ? 'Accommodation not located; shops ranked by ' + basis + '.' : 'Shops of ' + town.town + ' ranked by ' + basis + '.'),
    });
  } catch (err) {
    console.error('[find-nearest-shop]', err);
    return reply(res, { found: false, located: false, needsQuestion: false, error: String(err && err.message || err), message: 'Internal error.' });
  }
}

export default handler;
