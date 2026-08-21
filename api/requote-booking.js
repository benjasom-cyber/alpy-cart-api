/**
 * POST /api/requote-booking      (GET also accepted, for quick manual tests)
 *
 * Rebuilds an EXISTING booking as a fresh quote, so an agent can re-send it
 * with different dates.
 *
 * Why this exists
 * ───────────────
 * When a customer wants fewer rental days, Odin's own recalculation is not
 * trustworthy: measured on B1AF9J, extending 6 -> 7 days on a shop whose grid
 * charges 7 days at the 6-day price produced basePrice 128,40 -> 181,90 EUR and
 * a 32,10 EUR balance owed by the customer, out of thin air. The reliable path
 * is therefore: cancel, and re-book from a freshly simulated cart. This endpoint
 * produces that cart.
 *
 * Body / query params
 *   bookingReference  required, e.g. "B1AF9J"
 *   startDate         optional YYYY-MM-DD, defaults to the booking's own start
 *   endDate           optional YYYY-MM-DD, defaults to the booking's own end
 *   lang              optional, defaults to "en"
 *
 * Returns everything /api/generate-quote returns, plus:
 *   requote.sourceBooking     reference, status, shop, original period
 *   requote.persons           what we rebuilt, per person
 *   requote.approximations    the places where the quote cannot be exact
 *   requote.internalNote      one ready-to-paste Zendesk internal note
 *
 * ─── THE TWO TRAPS, both handled below ──────────────────────────────────────
 *
 * 1. NEVER derive the product from Odin's skiLevel.
 *    Odin stores skiLevel ADVANCED on B1AF9J, but the products actually booked
 *    are definitionId 3 and 30 — "intermediate" in the alpy.com catalogue.
 *    Passing skill:"expert" asks for definitionId 4 / 31, which are absent from
 *    that shop's price grid, and generate-quote then returns a quote with NO
 *    PRICE AT ALL (cartPriceComplete false, missing ["product:31"]) — measured
 *    live on shop 1867. The booking already carries the definitionId that was
 *    sold; we read the skill back OUT of it instead of guessing it.
 *
 * 2. Addons are per-cart in generate-quote, per-item in Odin.
 *    generate-quote applies the same addon list to every person. A booking can
 *    have boots on person 1 only. Rebuilding B1AF9J therefore gives 366,00 EUR
 *    (boots x2) where the booking holds 321,00 EUR (boots x1). We take the
 *    UNION of addons — never under-quoting, which is the safe direction — and
 *    say so explicitly in requote.approximations so nobody announces the figure
 *    as if it were exact.
 */

const ODIN_BASE = 'https://odin.alpy.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * definitionId -> { equipment, skill }, i.e. the PRODUCTS table of
 * generate-quote.js read backwards. Age still decides the category, so only
 * equipment and skill are needed here.
 * Ids that mean the same product at two skill levels (15, 42, 80, 38) resolve to
 * "intermediate": that is the level generate-quote would map them from anyway.
 */
const DEF_TO_SPEC = {
  2:   { equipment: 'ski',       skill: 'beginner'     },
  3:   { equipment: 'ski',       skill: 'intermediate' },
  4:   { equipment: 'ski',       skill: 'expert'       },
  28:  { equipment: 'snowboard', skill: 'beginner'     },
  30:  { equipment: 'snowboard', skill: 'intermediate' },
  31:  { equipment: 'snowboard', skill: 'expert'       },
  129: { equipment: 'ski',       skill: 'beginner'     },
  96:  { equipment: 'ski',       skill: 'intermediate' },
  92:  { equipment: 'ski',       skill: 'expert'       },
  97:  { equipment: 'snowboard', skill: 'intermediate' },
  15:  { equipment: 'ski',       skill: 'intermediate' },
  16:  { equipment: 'ski',       skill: 'expert'       },
  42:  { equipment: 'snowboard', skill: 'intermediate' },
  43:  { equipment: 'snowboard', skill: 'expert'       },
  80:  { equipment: 'ski',       skill: 'intermediate' },
  81:  { equipment: 'ski',       skill: 'expert'       },
  38:  { equipment: 'snowboard', skill: 'intermediate' },
};

const ADULT_DEFAULT_AGE = 35;

function isCancelled(status) {
  return String(status || '').toUpperCase().indexOf('CANCEL') > -1;
}

function toDay(value) {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  if (m) return m[1];
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function isDay(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

function money(minorAmount) {
  return minorAmount == null ? null : Math.round(minorAmount) / 100;
}

/** Fallback when a definitionId is not in the table: read the product name. */
function specFromName(name) {
  return {
    equipment: /snowboard|board/i.test(String(name || '')) ? 'snowboard' : 'ski',
    skill: 'intermediate',
  };
}

function buildPersons(equipment) {
  const persons = [];
  const wantBoots = [];
  const wantHelmet = [];

  for (const item of equipment || []) {
    if (isCancelled(item && item.status)) continue;

    const known = DEF_TO_SPEC[item.definitionId];
    const spec = known || specFromName(item.name);
    const age = (item.personalInfo && parseInt(item.personalInfo.age, 10)) || ADULT_DEFAULT_AGE;

    persons.push({
      age,
      skill: spec.skill,
      equipment: spec.equipment,
      sourceName: item.name || null,
      sourceDefinitionId: item.definitionId != null ? item.definitionId : null,
      skillResolvedFrom: known ? 'definitionId' : 'product name (definitionId unknown)',
    });

    const accessories = (item.accessories || []).filter(a => !isCancelled(a && a.status));
    wantBoots.push(accessories.some(a => a.definitionId === 1 || /boot/i.test(String(a.name || ''))));
    wantHelmet.push(accessories.some(a => a.definitionId === 2 || /helmet|casque/i.test(String(a.name || ''))));
  }

  return { persons, wantBoots, wantHelmet };
}

function buildInternalNote(o) {
  const lines = [];
  lines.push('QUOTE REBUILT FROM BOOKING ' + o.reference + '.');
  lines.push('');
  lines.push('Shop: ' + o.shopName + ' (' + o.resort + ')');
  lines.push('Original period: ' + o.originalFrom + ' to ' + o.originalTo);
  lines.push('Quoted period:   ' + o.startDate + ' to ' + o.endDate + ' (' + o.days + ' day(s))');
  lines.push('Group: ' + o.personsCount + ' person(s), ' + o.equipmentSummary);
  lines.push('');
  if (o.cartOnlinePrice != null) {
    lines.push('Simulated online price: ' + o.cartOnlinePrice.toFixed(2) + ' ' + o.currency);
    lines.push('Simulated in-store price: ' + o.cartInStorePrice.toFixed(2) + ' ' + o.currency);
  } else if (o.cartInStorePrice != null) {
    // The in-store figure comes from the shop price grid, the online figure needs
    // the discount rate from Odin /offers. That second call fails occasionally
    // (measured once in a run of twelve). Saying "no price" when we do hold the
    // in-store price would send an agent hunting for nothing.
    lines.push('Simulated in-store price: ' + o.cartInStorePrice.toFixed(2) + ' ' + o.currency);
    lines.push('The ONLINE price could not be computed on this run. Open the cart link below to read it.');
  } else {
    lines.push('Price could NOT be simulated for this basket. Open the cart link and read the basket.');
  }
  if (o.originalTotalDue != null) {
    lines.push('Balance still due on the original booking: ' + o.originalTotalDue.toFixed(2) + ' ' + o.currency);
  }
  lines.push('');
  lines.push('Cart ready to adjust and send:');
  lines.push(o.cartUrl);
  lines.push('');
  if (o.approximations.length) {
    lines.push('READ BEFORE QUOTING A PRICE:');
    for (const a of o.approximations) lines.push('- ' + a);
    lines.push('');
  }
  lines.push('Open the link, correct the dates if needed, then send it to the customer.');
  return lines.join('\n');
}

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  const params = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const ref = String(params.bookingReference || '').trim().toUpperCase();
  const lang = String(params.lang || 'en').slice(0, 2).toLowerCase();

  if (!ref) {
    return res.status(400).json({
      error: 'Missing required param: bookingReference',
      example: { bookingReference: 'B1AF9J', startDate: '2027-03-15', endDate: '2027-03-20' },
    });
  }

  try {
    // ── 1. Read the booking. This route is public: no Odin token needed. ─────
    const r = await fetch(ODIN_BASE + '/api/v2/booking/' + encodeURIComponent(ref), {
      headers: { Accept: 'application/json' },
    });
    if (r.status === 404) {
      return res.status(404).json({ found: false, error: 'No booking found for reference ' + ref });
    }
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return res.status(502).json({ error: 'Odin booking lookup failed (' + r.status + ')', details: body.slice(0, 300) });
    }
    const booking = await r.json();

    const shopId = (booking.shop && (booking.shop.coreId != null ? booking.shop.coreId : booking.shop.id)) || null;
    if (!shopId) {
      return res.status(422).json({ error: 'Booking ' + ref + ' has no shop id; cannot build a cart.' });
    }

    const originalFrom = toDay(booking.rentalPeriod && booking.rentalPeriod.from);
    const originalTo = toDay(booking.rentalPeriod && booking.rentalPeriod.to);

    const startDate = isDay(params.startDate) ? params.startDate : originalFrom;
    const endDate = isDay(params.endDate) ? params.endDate : originalTo;
    if (!isDay(startDate) || !isDay(endDate)) {
      return res.status(422).json({ error: 'Could not determine a rental period. Pass startDate and endDate explicitly.' });
    }
    if (new Date(startDate) > new Date(endDate)) {
      return res.status(400).json({ error: 'startDate must not be after endDate.' });
    }

    // ── 2. Rebuild the group from what was actually sold. ────────────────────
    const { persons, wantBoots, wantHelmet } = buildPersons(booking.equipment);
    if (!persons.length) {
      return res.status(422).json({
        error: 'Booking ' + ref + ' has no active equipment to rebuild.',
        hint: 'Every item is cancelled, or the booking holds services only.',
      });
    }

    const anyBoots = wantBoots.some(Boolean);
    const anyHelmet = wantHelmet.some(Boolean);
    const bootsUniform = wantBoots.every(v => v === anyBoots);
    const helmetUniform = wantHelmet.every(v => v === anyHelmet);

    const approximations = [];
    if (!bootsUniform) {
      approximations.push(
        'The booking has boots on ' + wantBoots.filter(Boolean).length + ' of ' + persons.length +
        ' person(s). The quote puts boots on everyone, so the simulated price is HIGHER than a like-for-like rebuild.'
      );
    }
    if (!helmetUniform) {
      approximations.push(
        'The booking has helmets on ' + wantHelmet.filter(Boolean).length + ' of ' + persons.length +
        ' person(s). The quote puts helmets on everyone, so the simulated price is HIGHER than a like-for-like rebuild.'
      );
    }
    const unknownDefs = persons.filter(p => p.skillResolvedFrom !== 'definitionId');
    if (unknownDefs.length) {
      approximations.push(
        unknownDefs.length + ' item(s) had a definitionId absent from the catalogue table; their level was' +
        ' assumed intermediate from the product name. Check the cart before quoting.'
      );
    }
    if ((booking.services || []).length || (booking.insurance || []).length) {
      approximations.push('The booking carries services or insurance, which the quote does not rebuild.');
    }
    if ((booking.coupons || []).length) {
      approximations.push('The original booking used a coupon. Any new coupon is sized by the quote itself and may differ.');
    }

    // ── 3. Price it with the one and only pricing implementation we trust. ───
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const quoteBody = JSON.stringify({
      shopId,
      startDate,
      endDate,
      lang,
      // persons ONLY: adults / children_ages would take precedence over it and
      // flatten a mixed ski + snowboard group into one single equipment type.
      persons: persons.map(p => ({ age: p.age, skill: p.skill, equipment: p.equipment })),
      with_boots: anyBoots,
      with_helmets: anyHelmet,
    });

    // Pricing is a pure read, so retrying once is safe. Worth it: a cold start on
    // the pricing chain produced one empty response in a run of twelve.
    let quoteRes = null;
    let quote = null;
    for (let attempt = 0; attempt < 2 && !quote; attempt++) {
      quoteRes = await fetch(proto + '://' + host + '/api/generate-quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: quoteBody,
      });
      const parsed = await quoteRes.json().catch(() => null);
      if (quoteRes.ok && parsed && parsed.cartUrl) quote = parsed;
      else if (attempt === 0) console.warn('[requote-booking] generate-quote attempt 1 unusable, retrying', quoteRes.status);
    }
    if (!quote) {
      return res.status(502).json({ error: 'generate-quote failed (' + (quoteRes && quoteRes.status) + ') after 2 attempts' });
    }

    const days = Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1;
    const equipmentSummary = persons.map(p => p.age + 'yr ' + p.skill + ' ' + p.equipment).join(', ') +
      (anyBoots ? ' + boots' : '') + (anyHelmet ? ' + helmets' : '');

    const internalNote = buildInternalNote({
      reference: ref,
      shopName: quote.shopName,
      resort: quote.resort,
      originalFrom,
      originalTo,
      startDate,
      endDate,
      days,
      personsCount: persons.length,
      equipmentSummary,
      cartOnlinePrice: quote.cartOnlinePrice,
      cartInStorePrice: quote.cartInStorePrice,
      currency: quote.cartPriceCurrency || 'EUR',
      originalTotalDue: money(booking.total && booking.total.amount),
      cartUrl: quote.cartUrl,
      approximations,
    });

    return res.status(200).json({
      ...quote,
      requote: {
        sourceBooking: {
          bookingReference: booking.bookingReference || ref,
          bookingId: booking.id || null,
          status: booking.bookingStatus || null,
          shopId,
          shopName: quote.shopName,
          resort: quote.resort,
          originalFrom,
          originalTo,
          originalDurationInDays: (booking.rentalPeriod && booking.rentalPeriod.durationInDays) || null,
          originalTotalDue: money(booking.total && booking.total.amount),
          currency: (booking.total && booking.total.currency) || 'EUR',
          customerName: (booking.customer && booking.customer.name) || null,
          customerEmail: (booking.customer && booking.customer.email) || null,
        },
        quotedPeriod: { startDate, endDate, days },
        datesSource: (isDay(params.startDate) && isDay(params.endDate)) ? 'caller' : 'booking',
        persons,
        addons: { boots: anyBoots, helmets: anyHelmet, bootsUniform, helmetUniform },
        approximations,
        internalNote,
      },
    });
  } catch (err) {
    console.error('[requote-booking] Error:', err);
    return res.status(500).json({ error: 'Internal server error.', details: err.message });
  }
}
