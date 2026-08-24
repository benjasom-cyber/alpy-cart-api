/**
 * GET /api/switch-depot
 * GET /api/switch-depot?shopId=1867
 *
 * Serves the per-shop status of the two services customers pick a shop on:
 *   - switch  : swapping ski <-> snowboard during the stay
 *   - depot   : overnight storage at the shop ("depot" / "consigne")
 *
 * Two rules are baked in here rather than left to the caller, because getting
 * either of them wrong loses a booking or invents an answer:
 *
 * 1. THE PER-SHOP ENTRY IS AUTHORITATIVE. chainSwitchRules is returned as
 *    context for a human agent, never as a fallback. A Precision Ski shop whose
 *    own entry says the switch is not possible does not become possible because
 *    the chain generally allows it.
 *
 * 2. NO DATA IS NOT "NO". A shopId absent from the table, or a TO CHECK status,
 *    means nobody has asked the shop yet. The answer is a handover to a human
 *    who contacts the shop - never a guess, and never silence, because silence
 *    reads as "no" to the customer and they book elsewhere.
 *
 * depotBookableOnline is separate from the status: true means the storage option
 * can be bought directly on alpy.com. It is rare, and it has nothing to do with
 * the modelchange option - the two are unrelated products.
 */

// Loaded the same way generate-quote.js loads shops_data.json: over the raw
// GitHub URL, cached for the life of the warm function. A bundled JSON import
// would be tidier, but that change is unpushed and unproven on this deployment,
// and this pattern is already running in production here.
const RAW = 'https://raw.githubusercontent.com/benjasom-cyber/alpy-cart-api/main/api/';
const DATA_URL = RAW + 'switch_depot.json';
const SHOPS_URL = RAW + 'shops_data.json';
let _cache = null;
let _shopsCache = null;

async function getData() {
      if (_cache) return _cache;
      const r = await fetch(DATA_URL);
      if (!r.ok) throw new Error('Failed to load switch_depot.json: ' + r.status);
      _cache = await r.json();
      return _cache;
}

async function getShops() {
      if (_shopsCache) return _shopsCache;
      const r = await fetch(SHOPS_URL);
      if (!r.ok) throw new Error('Failed to load shops_data.json: ' + r.status);
      _shopsCache = await r.json();
      return _shopsCache;
}

// ── Resolving what the customer named ───────────────────────────────────────
// Customers write "Ski Republic Morzine", "morzine", "Val d'Isere", "the shop at
// Les Gets". Matching lives here rather than in a prompt: a model asked to pick
// a shop from 931 will invent one, and inventing a shop means inventing its
// storage status.

function norm(s) {
      return String(s || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/['’`]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/** Shops whose town matches what the customer called the resort. */
function shopsInResort(shops, resortName) {
      const q = norm(resortName);
      if (!q || q.length < 3) return [];
      let hit = shops.filter(s => norm(s.town) === q);
      if (hit.length) return hit;
      hit = shops.filter(s => norm(s.town).startsWith(q) || q.startsWith(norm(s.town)));
      if (hit.length) return hit;
      return shops.filter(s => norm(s.town).includes(q) || q.includes(norm(s.town)));
}

/**
 * One shop, or null. Deliberately strict: an ambiguous name resolves to nothing
 * and the caller falls back to the resort list, which is honest. Guessing
 * between "Ski Republic Les Coches Centre" and "Ski Republic Les Coches-Wengen"
 * would hand the customer the wrong shop's answer.
 */
function resolveShop(shops, shopName, resortName) {
      const q = norm(shopName);
      if (!q || q.length < 3) return null;
      const scope = resortName ? (shopsInResort(shops, resortName) || []) : [];
      const pools = scope.length ? [scope, shops] : [shops];

      for (const pool of pools) {
              let hit = pool.filter(s => norm(s.name) === q);
              if (hit.length === 1) return hit[0];
              hit = pool.filter(s => norm(s.name).includes(q) || q.includes(norm(s.name)));
              if (hit.length === 1) return hit[0];
              // Token overlap, for "ski republic morzine" vs "Ski Republic Centre
              // Station Morz'na Sport". Only accepted when one shop clearly wins.
              const qt = q.split(' ').filter(t => t.length > 2);
              if (qt.length) {
                        const scored = pool.map(s => {
                                  const st = norm(s.name).split(' ');
                                  return { s, n: qt.filter(t => st.includes(t)).length };
                        }).filter(x => x.n >= 2).sort((a, b) => b.n - a.n);
                        if (scored.length === 1) return scored[0].s;
                        if (scored.length > 1 && scored[0].n > scored[1].n) return scored[0].s;
              }
      }
      return null;
}

function statusOf(data, shopId) {
      const hit = data.shops && data.shops[String(shopId)];
      return hit ? { switch: hit.switch, depot: hit.depot, depotBookableOnline: !!hit.depotBookableOnline }
                 : { ...UNKNOWN };
}

const KNOWN = v => v === 'YES' || v === 'NO';

/**
 * Turns the resolution into facts a reply can be built from, and decides ANSWER
 * vs HANDOVER. The rule is the one that matters commercially: when the shop the
 * customer named has no storage, name a shop in the same resort that does -
 * otherwise they go and look for it somewhere that is not us.
 */
function buildAnswer({ data, shops, topic, shopName, resortName }) {
      const wantDepot  = topic === 'DEPOT'  || topic === 'BOTH' || !topic;
      const wantSwitch = topic === 'SWITCH' || topic === 'BOTH' || !topic;

      const shop = resolveShop(shops, shopName, resortName);

      if (shop) {
              const st = statusOf(data, shop.id);
              const facts = [];
              if (wantSwitch) {
                        facts.push(KNOWN(st.switch)
                          ? `Equipment switch at ${shop.name}: ${st.switch === 'YES' ? 'possible' : 'not possible'}.`
                          : `Equipment switch at ${shop.name}: unknown.`);
              }
              if (wantDepot) {
                        facts.push(KNOWN(st.depot)
                          ? `Overnight storage at ${shop.name}: ${st.depot === 'YES' ? 'yes, offered by the shop' : 'not offered'}.`
                          : `Overnight storage at ${shop.name}: unknown.`);
                        if (st.depot === 'YES' && st.depotBookableOnline) {
                                  facts.push('That storage option can be booked directly on alpy.com.');
                        }
              }

              // Storage refused -> offer a neighbour that has it.
              let alternatives = [];
              if (wantDepot && st.depot === 'NO') {
                        alternatives = shopsInResort(shops, shop.town)
                          .filter(s => s.id !== shop.id && statusOf(data, s.id).depot === 'YES')
                          .slice(0, 3)
                          .map(s => ({ shopId: s.id, name: s.name }));
                        if (alternatives.length) {
                                  facts.push('Other shops in ' + shop.town + ' that do offer overnight storage: ' +
                                             alternatives.map(a => a.name).join(', ') + '.');
                        }
              }

              const unknowns = [];
              if (wantSwitch && !KNOWN(st.switch)) unknowns.push('switch');
              if (wantDepot  && !KNOWN(st.depot))  unknowns.push('storage');

              return {
                        mode: 'shop',
                        matchedShop: { shopId: shop.id, name: shop.name, town: shop.town },
                        ...st,
                        alternatives,
                        unknown: unknowns,
                        action: unknowns.length ? 'HANDOVER' : 'ANSWER',
                        factsForReply: facts.join(' '),
                        agentNote: unknowns.length
                          ? 'Unknown for this shop: ' + unknowns.join(' and ') +
                            '. Call the shop, answer the customer, then add the status to switch_depot.json.'
                          : null,
              };
      }

      // No single shop - answer at resort level, which is what the customer
      // actually needs when they are still choosing.
      const inResort = shopsInResort(shops, resortName || shopName);
      if (!inResort.length) {
              return {
                        mode: 'none', action: 'HANDOVER', factsForReply: '',
                        agentNote: 'Could not identify the shop or the resort from the message. Read it and answer manually.',
              };
      }

      const rows = inResort.map(s => ({ shopId: s.id, name: s.name, ...statusOf(data, s.id) }));
      const town = inResort[0].town;
      const withDepot  = rows.filter(r => r.depot === 'YES');
      const withSwitch = rows.filter(r => r.switch === 'YES');
      const noData     = rows.filter(r => !KNOWN(r.depot) && !KNOWN(r.switch));

      // "None of them offers it" is only true when we actually checked. With
      // every shop unknown it is a fabrication, and the worst kind: it sends the
      // customer to a competitor over a service the shop may well provide.
      const facts = [];
      if (wantDepot) {
              if (withDepot.length) {
                        facts.push(`In ${town}, these shops offer overnight storage: ` +
                          withDepot.map(r => r.name + (r.depotBookableOnline ? ' (bookable on alpy.com)' : '')).join(', ') + '.');
              } else if (rows.some(r => r.depot === 'NO')) {
                        facts.push(`In ${town}, none of the shops we have confirmed offers overnight storage.`);
              } else {
                        facts.push(`Overnight storage in ${town}: no confirmed information.`);
              }
      }
      if (wantSwitch) {
              if (withSwitch.length) {
                        facts.push(`In ${town}, these shops allow an equipment switch during the stay: ` +
                          withSwitch.map(r => r.name).join(', ') + '.');
              } else if (rows.some(r => r.switch === 'NO')) {
                        facts.push(`In ${town}, none of the shops we have confirmed allows an equipment switch.`);
              } else {
                        facts.push(`Equipment switch in ${town}: no confirmed information.`);
              }
      }

      // Something definite to say is enough to answer. Nothing definite, or
      // every shop unknown, is a handover - silence reads as "no".
      const anythingDefinite = (wantDepot && withDepot.length) || (wantSwitch && withSwitch.length);
      return {
              mode: 'resort',
              town,
              shopsInResort: rows.length,
              shops: rows,
              withDepot: withDepot.map(r => r.name),
              withSwitch: withSwitch.map(r => r.name),
              shopsWithoutData: noData.length,
              action: anythingDefinite ? 'ANSWER' : 'HANDOVER',
              factsForReply: facts.join(' '),
              agentNote: anythingDefinite
                ? (noData.length ? noData.length + ' shop(s) in ' + town + ' have no data - not mentioned to the customer.' : null)
                : 'No confirmed status for any shop in ' + town + '. Call the shops, answer the customer, then fill switch_depot.json.',
      };
}

const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const UNKNOWN = {
      switch: 'TO CHECK',
      depot: 'TO CHECK',
      depotBookableOnline: false,
};

function answerFor(data, shopId) {
      const key = String(parseInt(shopId, 10));
      const hit = data.shops && data.shops[key];
      if (!hit) {
              return {
                        found: false,
                        shopId: Number(key),
                        ...UNKNOWN,
                        action: 'HANDOVER',
                        agentNote: 'We have no switch/storage data for this shop. Contact the shop, answer the customer, then add the status.',
              };
      }
      const needsCheck = hit.switch === 'TO CHECK' || hit.depot === 'TO CHECK';
      return {
              found: true,
              shopId: Number(key),
              switch: hit.switch,
              depot: hit.depot,
              depotBookableOnline: !!hit.depotBookableOnline,
              action: needsCheck ? 'HANDOVER' : 'ANSWER',
              agentNote: needsCheck
                ? 'At least one status is unknown. Contact the shop for that one instead of guessing.'
                : null,
      };
}

export default async function handler(req, res) {
      Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
      if (req.method === 'OPTIONS') return res.status(200).end();

      // The table changes a few times a season, so a long edge cache is safe and
      // keeps the sidebar instant.
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');

      let data;
      try {
              data = await getData();
      } catch (e) {
              console.error('switch-depot: ' + e.message);
              // Never answer the customer from a failed lookup.
              return res.status(503).json({
                        error: 'Switch/storage table unavailable.',
                        action: 'HANDOVER',
                        agentNote: 'Could not read the table. Contact the shop rather than answering.',
              });
      }

      let params = req.method === 'POST' ? (req.body || {}) : (req.query || {});
      if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = {}; } }
      if (!params || typeof params !== 'object' || Array.isArray(params)) params = {};

      const shopId = params.shopId ?? params.shopid ?? params.shop_id;
      const shopName = params.shopName ?? params.shopname ?? params.shop_name ?? '';
      const resortName = params.resortName ?? params.resortname ?? params.resort ?? params.resort_name ?? '';
      const topicRaw = String(params.topic ?? params.topicname ?? '').trim().toUpperCase();
      const topic = ['DEPOT', 'SWITCH', 'BOTH'].includes(topicRaw) ? topicRaw : 'BOTH';

      // A name-based lookup: this is what the action flow calls.
      if (String(shopName).trim() || String(resortName).trim()) {
              let shops;
              try {
                        shops = await getShops();
              } catch (e) {
                        console.error('switch-depot: ' + e.message);
                        return res.status(503).json({ error: 'Shop list unavailable.', action: 'HANDOVER',
                                  agentNote: 'Could not read the shop list. Answer manually.' });
              }
              const out = buildAnswer({ data, shops, topic, shopName, resortName });
              return res.status(200).json({
                        ...out,
                        // Lowercase aliases: Zendesk forces custom-action output
                        // names to lowercase and JSON keys are case-sensitive.
                        factsforreply: out.factsForReply,
                        agentnote: out.agentNote,
                        topic,
              });
      }

      if (shopId !== undefined && shopId !== null && String(shopId).trim() !== '') {
              const out = answerFor(data, shopId);
              return res.status(200).json({ ...out, chainSwitchRules: data.chainSwitchRules });
      }

      // Whole table - this is what the SKIBOT sidebar loads once per session.
      return res.status(200).json(data);
}
