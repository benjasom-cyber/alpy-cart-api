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
const DATA_URL = 'https://raw.githubusercontent.com/benjasom-cyber/alpy-cart-api/main/api/switch_depot.json';
let _cache = null;

async function getData() {
      if (_cache) return _cache;
      const r = await fetch(DATA_URL);
      if (!r.ok) throw new Error('Failed to load switch_depot.json: ' + r.status);
      _cache = await r.json();
      return _cache;
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

      const params = req.method === 'POST' ? (req.body || {}) : (req.query || {});
      const shopId = params.shopId ?? params.shopid ?? params.shop_id;

      if (shopId !== undefined && shopId !== null && String(shopId).trim() !== '') {
              const out = answerFor(data, shopId);
              return res.status(200).json({ ...out, chainSwitchRules: data.chainSwitchRules });
      }

      // Whole table - this is what the SKIBOT sidebar loads once per session.
      return res.status(200).json(data);
}
