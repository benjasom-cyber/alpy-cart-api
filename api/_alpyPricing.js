/**
 * Shared helper: live pricing from Alpy's public core.alpy.com backend.
 *
 * Underscore-prefixed filename on purpose: Vercel does not create a
 * serverless function for files starting with "_" inside /api, so this
 * module doesn't count against the Hobby plan's 12-function limit - it's
 * imported as a plain JS module by generate-quote.js.
 *
 * Why this replaces the old Odin-based pricing:
 *   odin.alpy.com is behind a firewall that blocks Vercel's cloud IPs, so any
 *   call to it from these functions always failed silently (pricingAvailable
 *   stayed false). core.alpy.com is the domain alpy.com's own frontend uses
 *   to price the cart - it has no such restriction and is public/no-auth.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE CORE HOST PER BRAND (581971, 2026-09-04)
 *
 * Every brand's frontend prices on its OWN core host - www.snowbrainer.com
 * calls core.snowbrainer.com - and each host applies the brand's own online
 * discount, a few tenths of a percent below (or above) alpy.com's. A quote
 * priced here on core.alpy.com and sent with a snowbrainer cart link was
 * therefore always slightly off: 389,76 announced, 391,84 in the basket.
 * `fetchLivePricing` now takes `coreBase` (see coreBase() in _platform.js) and
 * prices on the brand's host, so the announced figure is the basket figure.
 * Nothing else about the call changes: same endpoint path, same body.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS A SAMPLING PATH (ticket 581886, group of 150)
 *
 * `dynamic-price-info` prices person by person, and its own response time grows
 * with the group. Measured against shop 1998, 13-20/02/2027, identical adults:
 *
 *     1 pers → 1,8 s     20 pers → 2,7 s     150 pers → 17,1 s
 *
 * At 150 the Vercel function (10 s at the time) died with
 * FUNCTION_INVOCATION_TIMEOUT and the customer got nothing. Raising the
 * function to 60 s makes it answer - in 24 s, which is still long enough to be
 * at the mercy of any caller-side timeout, Zendesk's included.
 *
 * The measurements that make sampling exact rather than approximate:
 *
 *   1. THE GROSS PRICE IS STRICTLY ADDITIVE PER PERSON. `total +
 *      discountAbsolute` is 12 600 for one adult, 12 600 for one child, 25 200
 *      for the two together, and 151 200 for a mixed group of twelve
 *      (8 × 12 600 + 4 × 12 600). No exception found.
 *
 *   2. THE DISCOUNT IS A WHOLE-BASKET PERCENTAGE THAT DEPENDS ONLY ON THE GROUP
 *      SIZE, AND IT SATURATES. Measured ladder on that shop:
 *
 *          1-5 pers → 15 %    6-8 → 20 %    10-12 → 21 %    30 / 60 / 150 → 22 %
 *
 *      Above ~30 the rate stops moving, so the rate observed at 30 is the rate
 *      that applies at 150.
 *
 * So for a large group we price ONE person per distinct profile, probe the
 * discount ladder at 30 and at 40 persons, and rebuild the basket:
 *
 *      gross  = Σ  count(profile) × gross(profile)
 *      total  = gross × (1 - saturated rate)
 *
 * Checked against the real 150-person answer: 12 600 × 150 = 1 890 000, minus
 * 22 % = 1 474 200 - to the cent what the full call returns, in about 3 s
 * instead of 17.
 *
 * AND IT VERIFIES ITSELF. If the two probes disagree, the ladder has not
 * saturated at this size on this shop and the shortcut is not valid, so the
 * code falls back to the honest full call. Same on any error. The fast path can
 * only ever be taken when it has just been proven correct for that shop, that
 * period and that group size.
 */

const CORE_BASE = 'https://core.alpy.com';

/** At or below this, one plain call is fast enough - don't get clever. */
const SAMPLE_THRESHOLD = 40;
/** The two probe sizes. 30 is where the ladder was seen to saturate; 40 confirms. */
const PROBE_A = 30;
const PROBE_B = 40;
/** Beyond this many distinct profiles, one call per profile stops being a win. */
const MAX_PROFILES = 12;

function personEntry(p, getDefinitionId) {
  return {
    age: parseInt(p.age) || 35,
    equipment: { '0': { definitionId: getDefinitionId(p.age, p.skill, p.equipment), accessories: {} } },
  };
}

function baseBody({ shop, startDate, endDate, currency, countryCode, promoCode }) {
  const body = {
    shopId: shop.id,
    locale: 'en',
    customerCountry: countryCode,
    currency,
    rentalPeriod: { from: startDate, to: endDate },
    person: {},
    coupons: {},
    insurance: [],
    partnerPrefix: null,
  };
  if (promoCode) body.promoCodes = { '1': { code: promoCode } };
  return body;
}

async function priceCall(ctx, entries) {
  const body = baseBody(ctx);
  entries.forEach((e, i) => { body.person[String(i)] = e; });
  // The brand's own core host, alpy.com's by default - see the header note.
  const base = ctx.coreBase || CORE_BASE;
  const res = await fetch(base + '/core/cart/dynamic-price-info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const total = data && data.total && data.total.amount;
  if (typeof total !== 'number') return null;
  const disc = data && data.discountAbsolute && data.discountAbsolute.amount;
  const discount = typeof disc === 'number' ? disc : 0;
  const gross = total + discount;
  return {
    total,
    discount,
    gross,
    // The ratio, not the label: "22%" is a display string, this is the number
    // the two probes are compared on.
    ratio: gross > 0 ? Math.round((discount / gross) * 100000) / 100000 : 0,
    percentage: data.discountPercentage || null,
  };
}

/** Distinct person profiles, with how many people share each. */
function profilesOf(persons, getDefinitionId) {
  const map = new Map();
  for (const p of persons) {
    const e = personEntry(p, getDefinitionId);
    const key = e.age + '|' + e.equipment['0'].definitionId;
    const hit = map.get(key);
    if (hit) hit.count++;
    else map.set(key, { entry: e, count: 1 });
  }
  return [...map.values()];
}

export async function fetchLivePricing({
  shop,
  startDate,
  endDate,
  persons,
  getDefinitionId,
  currency = 'EUR',
  countryCode = 'FR',
  promoCode,
  coreBase,
}) {
  const ctx = { shop, startDate, endDate, currency, countryCode, promoCode, coreBase: coreBase || CORE_BASE };
  const rentalDays = Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1;

  const shape = (priced) => {
    if (!priced) return null;
    const totalEur = priced.total / 100;
    const discountEur = priced.discount / 100;
    return {
      cheapestTotalPrice: totalEur,
      shopPrice: Math.round((totalEur + discountEur) * 100) / 100,
      discountAmount: discountEur,
      pricePerPerson: persons.length > 0 ? Math.round((totalEur / persons.length) * 100) / 100 : totalEur,
      currency,
      rentalDays,
      shopName: shop.name,
      discountPercentage: priced.percentage,
      // Which host produced these figures - the brand's own, or alpy.com's.
      pricedOn: ctx.coreBase.replace(/^https?:\/\//, ''),
    };
  };

  try {
    const entries = persons.map(p => personEntry(p, getDefinitionId));

    // ── Small and medium groups: nothing to optimise ──────────────────────
    if (entries.length <= SAMPLE_THRESHOLD) {
      return shape(await priceCall(ctx, entries));
    }

    const profiles = profilesOf(persons, getDefinitionId);
    if (profiles.length > MAX_PROFILES) {
      return shape(await priceCall(ctx, entries));
    }

    // ── Large group: one call per profile + two ladder probes, in parallel ─
    const probeEntry = profiles[0].entry;
    const [probeA, probeB, ...unit] = await Promise.all([
      priceCall(ctx, Array.from({ length: PROBE_A }, () => probeEntry)),
      priceCall(ctx, Array.from({ length: PROBE_B }, () => probeEntry)),
      ...profiles.map(pr => priceCall(ctx, [pr.entry])),
    ]);

    const laddered = probeA && probeB && probeA.ratio === probeB.ratio;
    const allUnits = unit.every(u => u && u.gross > 0);

    if (!laddered || !allUnits) {
      // The shortcut has not proven itself here. Pay the full price in seconds
      // rather than answer with a number we cannot vouch for.
      return shape(await priceCall(ctx, entries));
    }

    let gross = 0;
    profiles.forEach((pr, i) => { gross += pr.count * unit[i].gross; });
    const discount = Math.round(gross * probeA.ratio);

    return shape({
      total: gross - discount,
      discount,
      gross,
      ratio: probeA.ratio,
      percentage: probeA.percentage,
    });
  } catch {
    return null;
  }
}

export function countryToCode(country) {
  const map = { france: 'FR', austria: 'AT', switzerland: 'CH', italy: 'IT', germany: 'DE', spain: 'ES', andorra: 'AD' };
  return map[String(country).toLowerCase()] || 'FR';
}
