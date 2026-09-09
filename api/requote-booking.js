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
 *   newShop           optional (D-56): the resort, village or shop the customer wants
 *                     INSTEAD of the booking's own shop. Free text, resolved by
 *                     generate-quote exactly like a quote request ("Les Arcs 1950",
 *                     "Intersport Val Thorens"). newShopId (Odin core id) also works.
 *                     A booking cannot be moved between shops: the cart is built at
 *                     the new shop, the customer books it, and the original booking
 *                     is cancelled - the note says what that cancellation costs.
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
 * 2. Addons are per-item in Odin, and per PERSON in the cart.
 *    A booking can have boots on person 1 only. The first version of this file
 *    sent the UNION - boots for everyone - to avoid under-quoting, and on BQTZCJ
 *    that added boots to someone who had never had any: the "identical" cart was
 *    not identical, and the customer would have paid for equipment they never
 *    asked for. So each person now carries their own boots / helmet / protection
 *    flags, which generate-quote reads per person.
 */

import { resolveDomain, brandLabel } from './_platform.js';

const ODIN_BASE = 'https://odin.alpy.com';
// The shop's own catalogue (same source generate-quote prices from) - D-61
// reads the tiers a shop actually stocks out of it.
const PRODUCTS_INFO_URL = 'https://core.alpy.com/core/cart/products-information';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * definitionId -> { equipment, skill }.
 *
 * Rebuilt 2026-08-21 from the live catalogue
 * (core.alpy.com/core/cart/products-information, read across 116 shops) rather
 * than from the PRODUCTS table of generate-quote.js, which had two ids wrong.
 * The mapping is mechanical: productCategoryId 1 = ski, 3 = snowboard, and the
 * star rating gives the level - 3 stars = beginner, 4 = intermediate, 5 and
 * above = expert. Age still decides the category, so only equipment and skill
 * matter here.
 *
 * Where an age band has no 3* tier (junior, child), the 4* entry is the entry
 * level and maps to "intermediate" - that is the level generate-quote maps it
 * back from anyway, so the round trip is stable.
 */
const DEF_TO_SPEC = {
  // ── adult ski (ageCategoryId 1, productCategoryId 1)
  1:   { equipment: 'ski',       skill: 'beginner'     }, // 2* Economy
  2:   { equipment: 'ski',       skill: 'beginner'     }, // 3*
  131: { equipment: 'ski',       skill: 'beginner'     }, // 3* Initiation Woman
  3:   { equipment: 'ski',       skill: 'intermediate' }, // 4*
  56:  { equipment: 'ski',       skill: 'intermediate' }, // 4* Mini
  86:  { equipment: 'ski',       skill: 'intermediate' }, // 4* Lady
  4:   { equipment: 'ski',       skill: 'expert'       }, // 5*
  90:  { equipment: 'ski',       skill: 'expert'       }, // 5* Lady
  5:   { equipment: 'ski',       skill: 'expert'       }, // 6* Diamond
  95:  { equipment: 'ski',       skill: 'expert'       }, // 6* Diamond Lady
  110: { equipment: 'ski',       skill: 'expert'       }, // 7* Diamond
  111: { equipment: 'ski',       skill: 'expert'       }, // 7* Diamond Lady
  // ── teen ski (4)
  129: { equipment: 'ski',       skill: 'beginner'     }, // 3* Novice
  96:  { equipment: 'ski',       skill: 'intermediate' }, // 4*
  92:  { equipment: 'ski',       skill: 'expert'       }, // 5*
  130: { equipment: 'ski',       skill: 'expert'       }, // 6*
  // ── junior ski (2)
  15:  { equipment: 'ski',       skill: 'intermediate' }, // 4* Rookie
  16:  { equipment: 'ski',       skill: 'expert'       }, // 5*
  132: { equipment: 'ski',       skill: 'expert'       }, // 6* Performance
  // ── child ski (3)
  80:  { equipment: 'ski',       skill: 'intermediate' }, // 4* Rookie
  81:  { equipment: 'ski',       skill: 'expert'       }, // 5* Champion
  // ── adult snowboard (productCategoryId 3)
  28:  { equipment: 'snowboard', skill: 'beginner'     }, // 2* Economy
  29:  { equipment: 'snowboard', skill: 'beginner'     }, // 3*
  30:  { equipment: 'snowboard', skill: 'intermediate' }, // 4*
  31:  { equipment: 'snowboard', skill: 'expert'       }, // 5*
  32:  { equipment: 'snowboard', skill: 'expert'       }, // 6* Platinum
  // ── teen snowboard
  98:  { equipment: 'snowboard', skill: 'intermediate' }, // 4*
  97:  { equipment: 'snowboard', skill: 'expert'       }, // 5*  (was "intermediate" here - wrong)
  // ── junior snowboard
  42:  { equipment: 'snowboard', skill: 'intermediate' }, // 4* Rookie
  43:  { equipment: 'snowboard', skill: 'expert'       }, // 5* Champion
  // ── child snowboard
  38:  { equipment: 'snowboard', skill: 'intermediate' }, // 4* Rookie
  39:  { equipment: 'snowboard', skill: 'expert'       }, // 5* Champion
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
/**
 * Last resort for a definitionId absent from DEF_TO_SPEC. Odin's product names
 * carry the star rating - "Red/Silver (4*) Ski", "Champion (5*) Snowboard" - so
 * read the level from there rather than defaulting everyone to intermediate.
 */
function specFromName(name) {
  const s = String(name || '');
  const m = /\((\d)\s*\*\)/.exec(s) || /(\d)\s*\*/.exec(s);
  const stars = m ? parseInt(m[1], 10) : 0;
  return {
    equipment: /snowboard|board/i.test(s) ? 'snowboard' : 'ski',
    skill: stars >= 5 ? 'expert' : stars === 3 || stars === 2 ? 'beginner' : 'intermediate',
  };
}

/**
 * The group, rebuilt from what the booking holds.
 *
 * `includeCancelled` is the whole point of the second pass. By default we
 * rebuild only what is still live, because that is what "re-quote this booking"
 * means on a booking that still exists. But a cancelled booking has no live
 * item at all, and refusing there was wrong: re-quoting a cancelled booking is
 * one of the most useful things an agent can do - the customer cancelled, then
 * came back, and the whole basket they had chosen is sitting right there.
 * Making the agent retype four skiers, four levels and four ages, when Odin
 * still holds every one of them, is work we invented for ourselves.
 *
 * So when nothing is active we run again over everything, cancelled included,
 * and say so loudly in the note. The two passes are the same code precisely so
 * a rebuilt-from-cancelled quote cannot drift from a normal one.
 */
function buildPersons(equipment, includeCancelled) {
  const persons = [];
  const wantBoots = [];
  const wantHelmet = [];
  const itemServices = [];

  const live = (equipment || []).filter(item => includeCancelled || !isCancelled(item && item.status));

  // BOOTS OR A HELMET SOLD AS A PRODUCT, ON A PERSON WHO ALREADY HAS SKIS.
  //
  // BTFBV6 (581957): Till, personIndex 1, holds two items - "Rookie (4*) Ski"
  // (definitionId 15) and "Rookie (4*) Skischuh" (definitionId 26). The boots
  // are not an accessory of the ski item; Odin sells them as a product of their
  // own, with the same personIndex. Rebuilding one person per item turned the
  // boots into a second 12-year-old skier: four skis for three people, and a
  // wrong price presented as the customer's own basket. An accessory-shaped
  // item (boots / helmet by name, unknown to DEF_TO_SPEC) whose personIndex
  // already carries a real ski or snowboard product is that person's addon.
  // The accessory-ONLY person (581942, a helmet and nothing else) keeps its own
  // line, and is handled further down.
  const isAccessoryProduct = item => !DEF_TO_SPEC[item.definitionId] &&
    /boots?\b|skischuh|schuh|chaussure|scarpon|botas|helmet|casque|helm\b|casco|kask/i.test(String(item.name || ''));
  const personIdx = item => (item.personalInfo && item.personalInfo.personIndex != null)
    ? String(item.personalInfo.personIndex) : null;
  const realProductIdx = new Set(live.filter(i => !isAccessoryProduct(i)).map(personIdx).filter(x => x != null));
  const foldedInto = new Map(); // personIndex -> index in persons[]

  for (const item of live) {
    const idx = personIdx(item);
    if (isAccessoryProduct(item) && idx != null && realProductIdx.has(idx)) {
      // Folded onto the same person's real product, once that line exists.
      const target = foldedInto.get(idx);
      const isBoots = /boots?\b|skischuh|schuh|chaussure|scarpon|botas/i.test(String(item.name || ''));
      if (target != null) {
        if (isBoots) wantBoots[target] = true; else wantHelmet[target] = true;
        persons[target].foldedAccessories = (persons[target].foldedAccessories || []).concat(item.name || (isBoots ? 'boots' : 'helmet'));
      } else {
        // The accessory item came before the ski item in Odin's list: park it.
        foldedInto.set(idx + ':pending', (foldedInto.get(idx + ':pending') || []).concat(isBoots ? 'boots' : 'helmet'));
      }
      continue;
    }

    const known = DEF_TO_SPEC[item.definitionId];
    const spec = known || specFromName(item.name);
    const age = (item.personalInfo && parseInt(item.personalInfo.age, 10)) || ADULT_DEFAULT_AGE;

    persons.push({
      age,
      skill: spec.skill,
      equipment: spec.equipment,
      sourceName: item.name || null,
      sourceDefinitionId: item.definitionId != null ? item.definitionId : null,
      // D-61: the name the customer typed on the booking form, so "upgrade
      // Paul's skis" can be pinned to one person.
      sourcePersonName: (item.personalInfo && item.personalInfo.name) || null,
      skillResolvedFrom: known ? 'definitionId' : 'product name (definitionId unknown)',
    });
    const me = persons.length - 1;

    const accessories = (item.accessories || [])
      .filter(a => includeCancelled || !isCancelled(a && a.status));
    let boots = accessories.some(a => a.definitionId === 1 || /boot/i.test(String(a.name || '')));
    let helmet = accessories.some(a => a.definitionId === 2 || /helmet|casque/i.test(String(a.name || '')));
    if (idx != null && !isAccessoryProduct(item)) {
      const pending = foldedInto.get(idx + ':pending') || [];
      if (pending.includes('boots')) boots = true;
      if (pending.includes('helmet')) helmet = true;
      if (pending.length) persons[me].foldedAccessories = pending.slice();
      foldedInto.delete(idx + ':pending');
      foldedInto.set(idx, me);
    }
    wantBoots.push(boots);
    wantHelmet.push(helmet);

    // SERVICES ARE ADDONS TOO.
    //
    // Odin hangs Modelchange and the damage & theft protection off the item as
    // `services`, with the same definitionId the cart uses as an addon id -
    // measured: protection is 3 on both sides, Modelchange is 5. Reading only
    // `accessories` therefore rebuilt BDKLQJ without the Modelchange the four
    // skiers had paid for, and previous rebuilds dropped an existing protection
    // while an approximation politely mentioned it. Both belong in the cart.
    const serviceIds = (item.services || [])
      .filter(x => includeCancelled || !isCancelled(x && x.status))
      .map(x => parseInt(x && x.definitionId, 10))
      .filter(n => Number.isFinite(n) && n > 0);
    itemServices.push(serviceIds);
  }

  return { persons, wantBoots, wantHelmet, itemServices };
}

function buildInternalNote(o) {
  const lines = [];
  // The heading is the one thing an agent reads for certain, so the distinction
  // that matters most lives there: is this a price for a booking that exists, or
  // a fresh basket copied from one that no longer does.
  lines.push(o.rebuiltFromCancelled
    ? 'NEW BOOKING REBUILT FROM CANCELLED BOOKING ' + o.reference + '.'
    : 'QUOTE REBUILT FROM BOOKING ' + o.reference + '.');
  if (o.rebuiltFromCancelled) {
    lines.push('The original booking is cancelled and STAYS cancelled. This is a re-book, not a re-price.');
  }
  lines.push('');
  if (o.shopChangeFrom) {
    lines.push('SHOP CHANGE: from ' + o.shopChangeFrom + ' to ' + o.shopName + ' (' + o.resort + ').');
  }
  if (o.upgrade) {
    // D-61: the line the General questions prompt keys its UPGRADE section on.
    // One line, the persons and the from -> to products, nothing else.
    lines.push('UPGRADE: ' + o.upgrade.applied.join('; ') + '.');
    if (o.upgrade.everyone) lines.push('UPGRADE APPLIED TO EVERYONE: the message names no person.');
    if (o.upgrade.impossible.length) lines.push('UPGRADE NOT APPLIED TO: ' + o.upgrade.impossible.join('; ') + '.');
  }
  lines.push('Shop: ' + o.shopName + ' (' + o.resort + ')');
  if (o.siteLabel) lines.push('Brand / site the link opens on: ' + o.siteLabel);
  lines.push('Original period: ' + o.originalFrom + ' to ' + o.originalTo);
  lines.push('Quoted period:   ' + o.startDate + ' to ' + o.endDate + ' (' + o.days + ' day(s))');
  lines.push('Group: ' + o.personsCount + ' person(s), ' + o.equipmentSummary);
  // Read off Odin, not off the customer's message: a theft claim depends on it.
  if (o.hadDamageCover != null) {
    lines.push('Damage & theft protection on the original booking: ' + (o.hadDamageCover ? 'YES' : 'NO'));
  }
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
  if (o.addedOnRequest && o.addedOnRequest.length) {
    lines.push('ADDED AT THE CUSTOMER\'S REQUEST, and NOT on the original booking: ' +
               o.addedOnRequest.join(', ') + '.');
    lines.push('');
  }
  if (o.cancellationFeeText) {
    // The customer's first question when they have to re-book is what leaving
    // the old booking costs. It is computed here, so nobody has to ask them to
    // look it up - see cancellationCost().
    lines.push('COST OF CANCELLING THE CURRENT BOOKING:');
    lines.push(o.cancellationFeeText);
    lines.push('');
  }
  lines.push('Open the link, correct the dates if needed, then send it to the customer.');
  return lines.join('\n');
}

/**
 * WHAT LEAVING THE CURRENT BOOKING COSTS
 *
 * A requote exists because the customer has to re-book: to change dates, or -
 * since 581843 - to get an extra the booking cannot receive. Either way the old
 * booking has to go, and the first question the customer asks is what that
 * costs. We already have the booking in hand here, so answering it needs no
 * second endpoint and no second custom action: the fee table below is the one
 * printed on the voucher.
 *
 * Public holidays are NOT deducted from the working-day count - they differ by
 * country and by shop. Where the count lands within a day of a band edge the
 * text says the figure needs confirming rather than quietly under-quoting.
 */
function workingDaysUntil(startDay, todayDay) {
  const start = new Date(startDay + 'T00:00:00Z');
  const now = new Date(todayDay + 'T00:00:00Z');
  if (isNaN(start) || isNaN(now) || start <= now) return 0;
  let n = 0;
  const cur = new Date(now);
  while (cur < start) {
    const wd = cur.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return n;
}

function feeBand(startDay, todayDay) {
  if (!startDay || !todayDay) return null;
  if (todayDay >= startDay) return { percent: 100, band: 'on or after the first rental day', workingDays: 0 };
  const wd = workingDaysUntil(startDay, todayDay);
  if (wd > 10) return { percent: 25, band: 'more than 10 working days before the start', workingDays: wd };
  if (wd >= 3)  return { percent: 30, band: '9 to 3 working days before the start', workingDays: wd };
  return { percent: 35, band: '2 working days until 08:00 the day before', workingDays: wd };
}

/**
 * NO CANCELLATION FEES ARE CHARGED AT THE MOMENT.
 *
 * 581942 (3 Sept 2026): the reply told a customer that cancelling B6DYZR would
 * cost "25% of the amount paid online — €7.78 kept". Nothing of the sort is
 * charged today: the flexi cover is free and applied to every booking, so every
 * cancellation before the deadline is free of charge. Benjamin, 3 Sept 2026:
 * "nous n'appliquons aucun fees en ce moment, Alpinflexi est gratuite".
 *
 * The fee table below (feeBand) is kept intact for the day fees come back; this
 * one switch decides whether it is consulted at all. While it is false the
 * customer is told the cancellation is free, full stop.
 */
const CANCELLATION_FEES_ACTIVE = false;

function hasCancellationCover(booking) {
  const items = [].concat(booking.insurance || [], booking.services || []);
  // The cover is sold under one name per brand: ALPINFLEXI on alpy.com,
  // SLOPEFLEX on slopefox.co.uk, SNOWFLEX elsewhere. The previous test looked for
  // "flexi" and therefore missed SLOPEFLEX on B6DYZR - a booking that DID carry
  // the cover was quoted a 25% fee. Match the stem, not one brand's spelling.
  return items.some(x => /flex|annul|cancel|storno/i.test(String((x && (x.name || x.type)) || '')));
}

function cancellationCost(booking, ref, startDay) {
  const today = new Date().toISOString().slice(0, 10);
  const paid = money(booking.total && booking.total.amount);
  const currency = (booking.total && booking.total.currency) || 'EUR';
  // `realCover` is what the booking actually carries - flows read it, so it must
  // stay truthful. `cover` decides the fee: while fees are switched off, every
  // booking is treated as covered.
  const realCover = hasCancellationCover(booking);
  const cover = !CANCELLATION_FEES_ACTIVE || realCover;
  const band = feeBand(startDay, today);
  const out = {
    has_cancellation_cover: realCover,
    cancellation_free: cover,
    cancellation_fee_percent: band ? band.percent : null,
    cancellation_fee_amount: null,
    cancellation_refund_amount: null,
    cancellation_deadline: startDay ? '08:00 on the day before ' + startDay : '',
    cancellation_fee_text: '',
  };

  if (/CANCEL/i.test(String(booking.bookingStatus || booking.status || ''))) {
    out.cancellation_fee_text = 'Booking ' + ref + ' is already cancelled.';
    out.cancellation_fee_percent = null;
    return out;
  }
  if (cover) {
    out.cancellation_fee_percent = 0;
    out.cancellation_fee_amount = 0;
    out.cancellation_refund_amount = paid;
    // Two wordings for one fact. When fees are switched off account-wide the
    // customer must not be told they "carry a protection" they may never have
    // heard of - the plain truth is that cancelling is free.
    out.cancellation_fee_text = (CANCELLATION_FEES_ACTIVE
      ? 'This booking carries the cancellation protection, so it can be cancelled free of charge'
      : 'Booking ' + ref + ' can be cancelled free of charge - no fee is charged') +
      ' until 08:00 on the day before the first rental day' +
      (startDay ? ' (' + startDay + ')' : '') +
      (paid != null && paid > 0 ? '; the ' + paid.toFixed(2) + ' ' + currency + ' paid online would be refunded in full.' : '.');
    return out;
  }
  // Measured on BQTZCJ, whose coupon left a NEGATIVE total: 25% of a negative
  // number is a negative fee, and a reply quoting it would promise the customer
  // money. No figure at all is the honest answer.
  if (paid == null || paid <= 0 || !band) {
    // NOTHING, deliberately.
    //
    // 581858 said "the exact amount is being checked by a colleague, who will
    // confirm it before any action". That sentence is worse than silence: it
    // announces a human who is not coming, and it turns a clean answer into a
    // wait. When we cannot compute the fee we simply do not raise the subject -
    // the customer asked how to get the protection, not what cancelling costs.
    // The reason stays here for the agent, with an explicit ban on echoing it.
    out.cancellation_fee_percent = null;
    out.cancellation_fee_text = '';
    out.cancellation_fee_internal = 'Cancellation fee NOT computable for ' + ref +
      ' (the booking total is not a positive amount). Do not quote any figure to the ' +
      'customer, and do not announce a check or a colleague: say nothing about the fee.';
    return out;
  }
  const fee = Math.round(paid * band.percent) / 100;
  out.cancellation_fee_amount = fee;
  out.cancellation_refund_amount = Math.round((paid - fee) * 100) / 100;
  out.cancellation_fee_text = 'Cancelling ' + ref + ' today falls in the "' + band.band + '" band: ' +
    band.percent + '% of ' + paid.toFixed(2) + ' ' + currency + ', i.e. ' + fee.toFixed(2) + ' ' +
    currency + ' kept and ' + out.cancellation_refund_amount.toFixed(2) + ' ' + currency + ' refunded.';
  if (Math.abs(band.workingDays - 10) <= 1 || Math.abs(band.workingDays - 3) <= 1) {
    out.cancellation_fee_text += ' The count sits close to a band edge and public holidays are not ' +
      'deducted here, so confirm the exact figure before quoting it as final.';
  }
  return out;
}

/**
 * A REFUSAL IS AN ANSWER, NOT A CRASH.
 *
 * This endpoint is now called from a flow that answers ordinary customer
 * questions, and a Zendesk step that receives a 4xx stops its flow: one dead
 * booking reference in a message would mean the customer gets no reply at all.
 * So every refusal comes back 200, with an empty cart URL and an internal note
 * that says why. Callers test `found` / `carturl`, never the HTTP status.
 */
/**
 * D-56 - A SHOP CHANGE WRITTEN IN PROSE.
 *
 * "Could we move our booking to Arcs 1950", "wir mochten lieber in Solden
 * abholen", "changer de magasin pour Intersport Val Thorens", "een winkel dichter
 * bij ons hotel in Saalbach". Returns the place named after the request, or
 * null when the message is not about changing shop. The place is resolved (and,
 * when ambiguous or unknown, turned into a question) by generate-quote, exactly
 * as for a quote request - so a rough cut is enough here.
 */
const SHOP_CHANGE_RE = new RegExp(
  '(?:' +
  // en
  '(?:change|switch|move|transfer|swap)\\s+(?:the\\s+|my\\s+|our\\s+|this\\s+)?(?:booking|reservation|rental|hire|pick[- ]?up|collection)?\\s*(?:to\\s+(?:a|the|another|a different)\\s+)?(?:shop|store|location|resort|village|rental shop)?\\s*(?:in|at|to|near|closer to)\\s+' +
  '|(?:a\\s+)?(?:different|another|other|new)\\s+(?:shop|store|rental shop|pick[- ]?up (?:point|location))\\s*(?:in|at|near|closer to)?\\s+' +
  '|(?:pick(?:ing)?\\s*up|collect(?:ing)?)\\s+(?:the\\s+|our\\s+|my\\s+)?(?:skis?|equipment|gear)?\\s*(?:in|at|from)\\s+(?:a\\s+)?(?:different|another|other)\\s+(?:shop|store|place|resort)\\s*(?:in|at|near)?\\s+' +
  // de
  '|(?:anderen|anderes|andere)\\s+(?:shop|geschaft|laden|verleih|station|abholort)\\s+(?:in|bei|nahe)\\s+' +
  '|(?:shop|geschaft|laden|verleih|abholort|buchung)\\s+(?:nach|auf|in)\\s+(?:einen?\\s+)?(?:anderen?\\s+)?(?:shop\\s+in\\s+)?' +
  '|lieber\\s+in\\s+' +
  // fr
  '|(?:changer|transferer|deplacer)\\s+(?:de\\s+|la\\s+|ma\\s+|notre\\s+)?(?:magasin|reservation|boutique)?\\s*(?:pour|vers|a|au|aux|sur)\\s+(?:un\\s+autre\\s+magasin\\s+(?:a|de)\\s+)?' +
  '|(?:un\\s+)?autre\\s+magasin\\s+(?:a|de|au|aux|sur|pres de)\\s+' +
  // nl
  '|(?:andere|verkeerde)\\s+(?:winkel|verhuurder|shop|locatie|afhaalpunt)\\s+(?:in|bij|te)\\s+' +
  '|(?:winkel|boeking|reservering)\\s+(?:verplaatsen|wijzigen|veranderen)\\s+naar\\s+' +
  ')([A-Za-z][A-Za-z0-9\'’ .\\-]{2,60}?)(?=[,.;:!?\\n)]|\\s+(?:because|as|since|so|which|where|instead|please|thanks|da|weil|denn|parce|car|omdat|want)\\b|$)',
  'i');

function detectShopChange(text) {
  const t = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const m = SHOP_CHANGE_RE.exec(t);
  if (!m || !m[1]) return null;
  const place = m[1].replace(/\s+/g, ' ').replace(/^(?:the|le|la|les|der|die|das|de|het)\s+/i, '')
    .replace(/\s+(?:abholen|abzuholen|ausleihen|mieten|ophalen|afhalen|huren|instead|please|bitte|svp)\b.*$/i, '').trim();
  // A place name, not a sentence: at most five words and no booking word in it.
  if (!place || place.split(' ').length > 5) return null;
  if (/\b(?:booking|reservation|buchung|reservering|hotel|apartment|appartement|accommodation|unterkunft|hebergement)\b/i.test(place)) return null;
  return place;
}

/**
 * D-61 — UPGRADE ("montée en gamme").
 *
 * A booked item cannot be swapped for a higher tier in place: Odin has no
 * "change product" on a paid booking. Benjamin's rule: requote the same basket
 * with the requested tier, then offer the customer to cancel EITHER only that
 * person's current item (partial) OR the whole booking, and wait for the
 * answer. This block does the requote part; the General questions prompt
 * writes the offer from the UPGRADE line in the internal note.
 *
 * The tier is read out of the customer's own words (the tier names our shops
 * use, a star count, or a bare "upgrade" = one star up), the person out of the
 * names on the booking when one is written, and the target definitionId out
 * of the SHOP'S OWN catalogue (same discipline, same age band, requested
 * stars; Lady stays Lady). The catalogue names differ per shop ("PLATIN" is
 * 6* at Sestriere, "Black/Gold" 5* elsewhere), so stars are the only common
 * scale, and the target is looked up, never assumed.
 */
const TIER_WORDS = [
  [/\b(?:economy|[ée]conomi\w*|\beco)\b/i, 2],
  [/\b(?:blue|bleu\w?|blau\w*|bronze|basic|initiation|novice)\b/i, 3],
  [/\b(?:red|rouge\w?|rot\w?|silver|argent|silber|intermediate|interm[ée]diaire)\b/i, 4],
  [/\b(?:black|noir\w?|schwarz\w*|nero|gold|advanced|avanc[ée]\w?|expert\w*|champion)\b/i, 5],
  [/\b(?:diamond|diamant\w*|diamante|platin(?:um|e|o)?)\b/i, 6],
  [/\b(?:performance|top of the range|top[- ]range)\b/i, 6],
];
const STARS_RE = /\b([2-7])\s*(?:\*|★|stars?|[ée]toiles?|sterne?|stelle|estrellas?|sterren)\b/i;
const UPGRADE_VERB = /\bupgrad\w*|\bh[öo]herwertig\w*|\bh[öo]here[sn]?\s+(?:kategorie|modell|niveau|klasse|stufe)|mont(?:er|[ée]e?)\s+en\s+gamme|\bhaut\s+de\s+gamme|\bmeilleur\w*\s+(?:ski|snowboard|mod[èe]le|cat[ée]gorie|gamme|qualit)|\bbesser\w*\s+(?:ski|snowboard|modell|kategorie|qualit)|\bbetter\s+(?:skis?|snowboard|model|category|level|range|tier|quality|pair)|\b(?:higher|superior|upper)\s+(?:category|level|range|tier|class|model|quality|end)|\bnext\s+(?:level|tier|category)\s+up|\bun\s+cran\s+au[- ]dessus|\bcat[ée]gorie\s+sup[ée]rieure|\bgamme\s+sup[ée]rieure|\bmiglior\w*\s+(?:sci|snowboard|modello|categoria)|\bmejor\w*\s+(?:esqu[íi]s?|snowboard|modelo|categor[íi]a)|\bbeter\w*\s+(?:ski|snowboard|model|categorie)/i;
const CHANGE_VERB = /\b(?:change|switch|swap|replace|exchange|modif\w*|changer|remplacer|passer|wechseln|tauschen|umtauschen|[äa]ndern|cambiar|cambiare|sostituire|wijzigen|omruilen|veranderen|upgrade|upgraden|move|go)\w*|\binstead\b|\brather\b|\b[àa] la place\b|\bplut[ôo]t\b|\bstatt\b|\banstelle\b|\bstattdessen\b|\binvece\b|\ben lugar\b/i;
const TO_TIER_RE = /\b(?:to|into|onto|for|zu|zum|zur|auf|in|en|au|aux|vers|à|a|per|al|alla|naar)\s+(?:the\s+|a\s+|an\s+|des\s+|du\s+|le\s+|la\s+|les\s+|den\s+|die\s+|das\s+|dem\s+|der\s+|el\s+|los\s+|il\s+|i\s+|de\s+|het\s+)?(?:(?:ski|snowboard|board|model|modell|mod[èe]le|category|kategorie|cat[ée]gorie|gamme|tier|level|niveau|classe|class)\s+)?/i;

function tierAt(text, from) {
  const s = String(text || '').slice(from);
  let best = null;
  const st = STARS_RE.exec(s);
  if (st) best = { stars: parseInt(st[1], 10), index: from + st.index, word: st[0] };
  for (const [re, stars] of TIER_WORDS) {
    const m = re.exec(s);
    if (m && (!best || m.index < best.index)) best = { stars, index: from + m.index, word: m[0] };
  }
  return best;
}

function detectUpgrade(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  const verb = UPGRADE_VERB.test(t);
  const change = CHANGE_VERB.test(t);
  // The tier the customer is moving TO: the one written after "to / en / zu /
  // auf ...", else the first tier word in the text.
  let target = null;
  const re = new RegExp(TO_TIER_RE.source, 'gi');
  let m;
  while ((m = re.exec(t)) && !target) {
    const cand = tierAt(t, m.index + m[0].length);
    if (cand && cand.index === m.index + m[0].length) target = cand;
  }
  const anyTier = tierAt(t, 0);
  if (!target && anyTier && (verb || change)) target = anyTier;
  if (!target && !verb) return null;                 // no tier, no upgrade word: not an upgrade
  if (!target && verb) return { relative: 1, word: (UPGRADE_VERB.exec(t) || [''])[0] };
  return { stars: target.stars, word: target.word, relative: 0 };
}

async function fetchShopCatalogue(shopId) {
  try {
    const r = await fetch(PRODUCTS_INFO_URL + '?shopId=' + encodeURIComponent(shopId), { headers: { Accept: 'application/json' } });
    if (!r.ok) return [];
    const grid = await r.json();
    const out = [];
    for (const g of (grid && grid.products) || []) {
      for (const p of (g && g.products) || []) {
        if (!p || p.definitionId == null) continue;
        const name = (p.nameWithMerchantForAcceptedLanguages && p.nameWithMerchantForAcceptedLanguages.en) || '';
        out.push({
          def: p.definitionId,
          cat: p.productCategoryId,
          age: p.ageCategoryId,
          stars: parseInt(String(p.qualityCategoryAbbreviation || '').replace('*', ''), 10) || 0,
          name,
          lady: /\b(?:lady|ladies|woman|women|femme|damen|donna)\b/i.test(name),
          mini: /\bmini\b/i.test(name),
        });
      }
    }
    return out;
  } catch (e) {
    console.error('[requote-booking] catalogue fetch failed for shop ' + shopId, e);
    return [];
  }
}

// The product at `stars` in the same discipline and age band as `src`, Lady
// staying Lady and Mini staying Mini. When the shop stocks nothing at exactly
// that level, the nearest HIGHER tier it does stock; null when nothing higher.
function pickTier(catalogue, src, stars, word) {
  const same = catalogue.filter(e => e.cat === src.cat && e.age === src.age && e.def !== src.def &&
                                     (e.cat === 1 || e.cat === 3));
  const pref = list => list.find(e => e.lady === src.lady && e.mini === src.mini) ||
                       list.find(e => e.lady === src.lady && !e.mini) ||
                       list.find(e => !e.lady && !e.mini) || list[0] || null;
  // The customer's word IS a product name at this shop ("Diamond" at a shop
  // whose 7* is called Diamond while its 6* is PLATIN): the name wins over the
  // star table, as long as it is a step up.
  const w = String(word || '').trim();
  if (w && !/^\d/.test(w)) {
    const byName = same.filter(e => e.stars > (src.stars || 0) && new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(e.name));
    if (byName.length) return { hit: pref(byName), exact: true };
  }
  const exact = same.filter(e => e.stars === stars);
  if (exact.length) return { hit: pref(exact), exact: true };
  const higher = same.filter(e => e.stars > stars).sort((a, b) => a.stars - b.stars);
  if (!higher.length) return { hit: null, exact: false };
  const top = higher.filter(e => e.stars === higher[0].stars);
  return { hit: pref(top), exact: false };
}

function firstNameOf(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[0] : '';
}

function refuse(res, ref, why) {
  return res.status(200).json({
    found: false,
    error: why,
    reason: why,
    cartUrl: '', carturl: '',
    cartOnlinePrice: null, cartonlineprice: null,
    internalNote: 'REQUOTE NOT POSSIBLE' + (ref ? ' for ' + ref : '') + ': ' + why,
    internalnote: 'REQUOTE NOT POSSIBLE' + (ref ? ' for ' + ref : '') + ': ' + why,
  });
}

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Vercel only parses req.body into an object when the caller sends
  // Content-Type: application/json. A Zendesk custom action cannot declare that
  // header by hand — the Name field rejects hyphens — so accept a raw string too
  // rather than depend on a header we do not control.
  let body = req.method === 'POST' ? (req.body || {}) : {};
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
  // Query string AND body, always, with the body winning. The Zendesk custom
  // action's JSON body is a chip field that is awkward to extend, while its
  // query parameters are plain key/value rows - so a new optional parameter can
  // arrive either way and this endpoint does not care which.
  const params = Object.assign({}, req.query || {}, body);
  // The reference, or the sentence that contains it.
  //
  // The general-questions flow has no step that parses the customer's email, so
  // it hands us the message itself. Rather than add a parsing step to that flow
  // - and a second place where the reference format lives - we accept prose and
  // find the code in it. A caller that already holds a clean reference (the
  // Requote flow does) is unaffected: the shape test matches and nothing else
  // runs.
  const REF_SHAPE_ONE = /^B[123456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/;
  const REF_IN_TEXT = /\bB[123456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}\b/;
  const refRaw = String(params.bookingReference || params.bookingreference || '').trim().toUpperCase();
  const refFound = REF_SHAPE_ONE.test(refRaw) ? refRaw
                 : (refRaw.match(REF_IN_TEXT) || [''])[0];
  const ref = refFound;
  const lang = String(params.lang || 'en').slice(0, 2).toLowerCase();
  // D-56: a shop change is a requote at another shop.
  const newShopText = String(params.newShop || params.new_shop || params.newshop ||
                             params.newResort || params.new_resort || params.newresort || '').trim();
  const newShopId = parseInt(params.newShopId || params.new_shop_id || params.newshopid, 10);

  // Rebuild the cart WITH the damage & theft protection.
  //
  // 581843: the customer had forgotten AlpinGuaranty and asked to add it. A
  // protection cannot be attached to a paid booking, so the only answer is a
  // new booking that already contains it - and that answer is worth nothing
  // without the cart. Passing insurance:true here is what turns "you would have
  // to re-book" into a link the customer can click.
  // Generalised on Benjamin's instruction: not "insurance", but "whatever extra
  // the customer wants that the booking does not have". One text parameter, so
  // the Zendesk custom action needs ONE new field and never a second action:
  //   addons = "alpinguaranty"  |  "helmet, boots"  |  "protection"
  const ADDON_WORDS = {
    insurance: /alpin\s*guaranty|snow\s*guaranty|ski\s*guaranty|slope\s*guaranty|guaranty|alpin\s*flexi|snow\s*flexi|ski\s*flexi|slope\s*flex|flexi|insurance|protection|assurance|versicherung|assicurazione|seguro/i,
    helmets:   /helmets?|casques?|helm\w*|casco|kask/i,
    boots:     /boots?|chaussures?|schuhe|scarponi|botas/i,
    // Not addons at all - the main product. A customer who booked a helmet only
    // and asks for "skis" is asking for a different basket, not for an extra.
    // See the helmet-only handling further down (581942).
    skis:      /\bskis?\b|\bskies\b|\bskier\b|\bski\s*set|\bschi\b|\bski\b/i,
    snowboard: /snow\s*boards?|\bboards?\b/i,
  };
  // THE CUSTOMER'S OWN WORDS, NOT THE EMAIL THEY QUOTED.
  //
  // The general-questions flow hands us the whole message. A reply from a phone
  // drags the entire booking confirmation along underneath it - and every
  // confirmation mentions "damage & theft protection", "insurance" and
  // "helmet". On 581942 the customer wrote one line asking for skis; the quoted
  // confirmation below it matched three addon words she had never typed. Cut
  // the message at the first quote marker, in the languages our customers write.
  const QUOTE_MARKERS = [
    /\bOn\s.{3,80}?\bwrote\s*:/i,            // On Wed, 2 Sept 2026 at 22:59, X wrote:
    /\bLe\s.{3,80}?a\s+écrit\s*:/i,          // Le mer. 2 sept. 2026 à 15:17, X a écrit :
    /\bAm\s.{3,80}?schrieb\s.{0,60}?:/i,     // Am 02.09.2026 um 22:59 schrieb X:
    /\bIl\s.{3,80}?ha\s+scritto\s*:/i,       // Il giorno ... ha scritto:
    /\bEl\s.{3,80}?escribió\s*:/i,           // El mié., 2 sept. 2026 ... escribió:
    /\bOp\s.{3,80}?schreef\s.{0,60}?:/i,     // Op wo 2 sep. 2026 ... schreef X:
    /-{2,}\s*(Original|Forwarded|Ursprüngliche|Message d'origine)/i,
    /\bFrom\s*:\s.{0,80}\bSent\s*:/is,        // Outlook header block
  ];
  const ownWords = (text) => {
    // Lines quoted with ">" are dropped wherever they sit; the block markers
    // above cut everything that follows them.
    let s = String(text || '').split(/\r?\n/).filter(l => !/^\s*>/.test(l)).join('\n');
    let cut = s.length;
    for (const rx of QUOTE_MARKERS) {
      const m = rx.exec(s);
      if (m && m.index < cut) cut = m.index;
    }
    return s.slice(0, cut);
  };
  // The general-questions flow cannot name the new shop for us: its only free
  // input is the customer's message (it arrives as `addons`). So when no explicit
  // newShop is given, read a shop-change request out of the prose itself.
  const shopFromProse = (!newShopText && !Number.isFinite(newShopId))
    ? detectShopChange(ownWords([].concat(params.addons || params.addonsText || params.addonstext || params.message || [])
                                 .map(x => String(x || '')).join(' ')))
    : null;
  const newShopEff = newShopText || shopFromProse || '';
  const shopChangeRequested = !!newShopEff || Number.isFinite(newShopId);
  const addonsRaw = ownWords([].concat(params.addons || params.addon || params.extras || [])
                      .concat(params.addonsText || params.addonstext || [])
                      .map(x => String(x || '')).join(' '));
  const wantAddon = {
    insurance: ADDON_WORDS.insurance.test(addonsRaw),
    helmets:   ADDON_WORDS.helmets.test(addonsRaw),
    boots:     ADDON_WORDS.boots.test(addonsRaw),
    skis:      ADDON_WORDS.skis.test(addonsRaw),
    snowboard: ADDON_WORDS.snowboard.test(addonsRaw),
  };
  const withInsurance = wantAddon.insurance ||
                        params.insurance === true || params.with_insurance === true ||
                        String(params.insurance || params.with_insurance || '')
                          .toLowerCase() === 'true';

  if (!ref) {
    return refuse(res, '', 'no booking reference was supplied, so there is nothing to rebuild');
  }

  try {
    // ── 1. Read the booking. This route is public: no Odin token needed. ─────
    const r = await fetch(ODIN_BASE + '/api/v2/booking/' + encodeURIComponent(ref), {
      headers: { Accept: 'application/json' },
    });
    if (r.status === 404) {
      return refuse(res, ref, 'no booking exists with this reference');
    }
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return refuse(res, ref, 'Odin could not be read (' + r.status + ')');
    }
    const booking = await r.json();

    const shopId = (booking.shop && (booking.shop.coreId != null ? booking.shop.coreId : booking.shop.id)) || null;
    if (!shopId) {
      return refuse(res, ref, 'the booking carries no shop id, so no cart can be built');
    }

    const originalFrom = toDay(booking.rentalPeriod && booking.rentalPeriod.from);
    const originalTo = toDay(booking.rentalPeriod && booking.rentalPeriod.to);

    const startDate = isDay(params.startDate) ? params.startDate : originalFrom;
    const endDate = isDay(params.endDate) ? params.endDate : originalTo;
    if (!isDay(startDate) || !isDay(endDate)) {
      return refuse(res, ref, 'the rental period could not be determined');
    }
    if (new Date(startDate) > new Date(endDate)) {
      return refuse(res, ref, 'the start date is after the end date');
    }

    // A finished stay must not produce a quote. The price grid is not
    // date-indexed, so a past period still returns an in-store figure and a
    // perfectly formatted cart link carrying dates nobody can book — which is
    // worse than no answer: it puts a dead link in front of an agent. Refuse,
    // and let the caller pass explicit future dates when a re-quote is wanted.
    const todayUTC = new Date().toISOString().slice(0, 10);
    if (endDate < todayUTC) {
      return refuse(res, ref, 'the rental period has already ended (' + startDate + ' to ' +
                    endDate + '), so no cart can be built for it. Pass future dates to re-quote.');
    }

    // ── 1b. Which brand the customer bought from (581942). ─────────────────
    // The Zendesk brand of the ticket when the flow passes it (`platform`), else
    // the brand written into the booking's own service names (SLOPEFLEX ...),
    // else alpy.com. The cart link and the brand name in the note follow it.
    const siteDomain = resolveDomain(params.platform || params.brand_id || params.brandId || params.domain, booking);
    const siteLabel = brandLabel(siteDomain);

    // ── 2. Rebuild the group from what was actually sold. ────────────────────
    let { persons, wantBoots, wantHelmet, itemServices } = buildPersons(booking.equipment, false);

    // Nothing live left - so rebuild from everything, cancelled included.
    // See buildPersons: this is the case an agent hits most often, not an edge.
    let rebuiltFromCancelled = false;
    if (!persons.length) {
      ({ persons, wantBoots, wantHelmet, itemServices } = buildPersons(booking.equipment, true));
      rebuiltFromCancelled = persons.length > 0;
    }

    if (!persons.length) {
      return refuse(res, ref, 'this booking is services or insurance only, so there is no basket to rebuild');
    }

    // "I DON'T THINK I ADDED SKIS" - the accessory-only booking (581942).
    //
    // B6DYZR was one line: definitionId 84, " Helmet", for a 13-year-old. Odin
    // sells a helmet or a pair of boots as a product in its own right, so a
    // customer can book the helmet and forget the skis entirely. Rebuilding that
    // booking "faithfully" produced a helmet-only cart, and the reply then
    // claimed skis were included - because the cart was called a re-book with
    // "skis added" while nothing had been added at all.
    //
    // Skis are not an addon; they are the product. So when the customer asks for
    // skis (or a snowboard) and a person on the booking has no ski or snowboard
    // product - only an accessory sold as a product - that person is rebuilt
    // around the equipment they asked for, at the entry level for their age
    // (generate-quote picks the definitionId from age + skill), and the accessory
    // they already had rides along as the addon it is in the cart. The level is
    // an assumption and is flagged as one; the cart is adjustable.
    const wantsEquipment = wantAddon.snowboard ? 'snowboard' : (wantAddon.skis ? 'ski' : '');
    const equipmentAddedFor = [];
    if (wantsEquipment) {
      persons.forEach((p, i) => {
        const isRealProduct = !!DEF_TO_SPEC[p.sourceDefinitionId];
        if (isRealProduct) return;
        const name = String(p.sourceName || '');
        const helmetOnly = /helmet|casque|helm\b|casco|kask/i.test(name);
        const bootsOnly = /boots?\b|chaussure|schuh|scarpon|botas/i.test(name);
        if (!helmetOnly && !bootsOnly) return;
        p.equipment = wantsEquipment;
        p.skill = 'intermediate';
        p.sourceDefinitionId = null;                 // let generate-quote choose by age + skill
        p.skillResolvedFrom = 'assumed intermediate - the booking had no ' + wantsEquipment;
        if (helmetOnly) wantHelmet[i] = true;
        if (bootsOnly) wantBoots[i] = true;
        equipmentAddedFor.push(p.age + 'yr');
      });
    }
    // ── 2b. D-61 UPGRADE: the same basket, one tier (or the named tier) up. ──
    //
    // 582185-type tickets: "can I upgrade my skis to the Diamond range?". The
    // item cannot be changed on the booking, so the answer is a new cart with
    // the higher product for the person(s) concerned, and the choice - cancel
    // just that item, or the whole booking - put to the customer. Everything
    // else in the basket travels unchanged, so the price difference IS the
    // upgrade.
    const upgradeAsk = shopChangeRequested ? null : detectUpgrade(addonsRaw);
    const upgrade = { requested: !!upgradeAsk, applied: [], impossible: [], persons: [], everyone: false, word: upgradeAsk ? upgradeAsk.word : '' };
    if (upgradeAsk) {
      const catalogue = await fetchShopCatalogue(shopId);
      const eligible = persons.map((p, i) => ({ p, i })).filter(({ p }) => !!DEF_TO_SPEC[p.sourceDefinitionId]);
      // Who: the persons whose first name is written in the message; nobody
      // named means everybody who has skis or a snowboard.
      const named = eligible.filter(({ p }) => {
        const fn = firstNameOf(p.sourcePersonName);
        return fn.length >= 3 && new RegExp('(^|[^\\p{L}\\p{N}])' + fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'iu').test(addonsRaw);
      });
      const targets = named.length ? named : eligible;
      upgrade.everyone = !named.length && eligible.length > 1;
      for (const { p, i } of targets) {
        const srcEntry = catalogue.find(e => e.def === p.sourceDefinitionId) || null;
        const srcStars = srcEntry ? srcEntry.stars : (parseInt((String(p.sourceName || '').match(/([2-7])\s*\*/) || [])[1], 10) || 0);
        const src = srcEntry || {
          def: p.sourceDefinitionId, cat: p.equipment === 'snowboard' ? 3 : 1, age: null, stars: srcStars,
          name: p.sourceName || '', lady: /lady|woman|femme|damen|donna/i.test(String(p.sourceName || '')), mini: /\bmini\b/i.test(String(p.sourceName || '')),
        };
        const wanted = upgradeAsk.relative ? srcStars + upgradeAsk.relative : upgradeAsk.stars;
        const label = (p.sourcePersonName || (p.age + 'yr')) + ': ' + (p.sourceName || ('definitionId ' + p.sourceDefinitionId)).trim();
        if (!catalogue.length || src.age == null) {
          upgrade.impossible.push(label + ' - the shop catalogue could not be read, so the higher product cannot be identified');
          continue;
        }
        if (srcStars && wanted <= srcStars) {
          upgrade.impossible.push(label + ' - the requested level (' + wanted + '*) is not above the current one (' + srcStars + '*); this is not an upgrade');
          continue;
        }
        const pick = pickTier(catalogue, src, wanted, upgradeAsk.relative ? '' : upgradeAsk.word);
        if (!pick.hit) {
          upgrade.impossible.push(label + ' - the shop stocks nothing above ' + srcStars + '* in this discipline and age band' +
                                  (wanted !== srcStars + 1 ? ' (asked: ' + wanted + '*)' : ''));
          continue;
        }
        const to = pick.hit;
        p.sourceDefinitionId = to.def;
        p.skill = (DEF_TO_SPEC[to.def] && DEF_TO_SPEC[to.def].skill) || 'expert';
        p.upgradedFrom = { definitionId: src.def, name: src.name, stars: srcStars };
        p.upgradedTo = { definitionId: to.def, name: to.name, stars: to.stars, exactTier: pick.exact };
        upgrade.applied.push(label + ' -> ' + to.name.trim() + ' (' + to.stars + '*)' +
                             (pick.exact ? '' : ' [the shop has no ' + wanted + '* here; ' + to.stars + '* is the next level it stocks]'));
        upgrade.persons.push(p.sourcePersonName || (p.age + 'yr'));
      }
      if (!upgrade.applied.length) {
        return refuse(res, ref, 'UPGRADE NOT POSSIBLE. ' + (upgrade.impossible.join('; ') || 'no ski or snowboard item to upgrade') +
                      '. Answer the customer yourself.');
      }
    }

    const anyBoots = wantBoots.some(Boolean);
    const anyHelmet = wantHelmet.some(Boolean);
    const bootsUniform = wantBoots.every(v => v === anyBoots);
    const helmetUniform = wantHelmet.every(v => v === anyHelmet);

    const approximations = [];
    if (rebuiltFromCancelled) {
      approximations.push(
        'EVERY item on this booking is cancelled. The basket below was rebuilt from the ' +
        'CANCELLED items, so it is a NEW booking to be made, not a re-pricing of a live one. ' +
        'Nothing has been reinstated in Odin - sending this link books afresh, at today\'s rates, ' +
        'and the original booking stays cancelled.'
      );
    }
    // The boots/helmet spread used to be an approximation to warn about, because
    // the quote put them on everyone. It is now reproduced person by person, so
    // there is nothing to warn about - only something to state, so an agent can
    // check the basket against the booking at a glance.
    if (!bootsUniform || !helmetUniform) {
      approximations.push(
        'Rebuilt person by person: boots on ' + wantBoots.filter(Boolean).length + ' of ' +
        persons.length + ', helmets on ' + wantHelmet.filter(Boolean).length + ' of ' +
        persons.length + ' - the same spread as the booking, not the same for everyone.'
      );
    }
    // Only the items whose definitionId we could NOT carry over are approximate
    // now: everything else is rebuilt with the exact product that was sold.
    const unknownDefs = persons.filter(p => !p.sourceDefinitionId && !/^assumed/.test(String(p.skillResolvedFrom || '')));
    if (equipmentAddedFor.length) {
      approximations.push(
        (wantsEquipment === 'snowboard' ? 'A snowboard' : 'Skis') + ' were ADDED for ' +
        equipmentAddedFor.join(', ') + ': the original booking held only a helmet or boots for ' +
        (equipmentAddedFor.length > 1 ? 'these persons' : 'this person') + ', with no ' + wantsEquipment +
        ' at all. The level is ASSUMED intermediate - confirm it with the customer or adjust it in the cart.'
      );
    }
    const folded = persons.filter(p => p.foldedAccessories && p.foldedAccessories.length);
    if (folded.length) {
      approximations.push(
        folded.map(p => p.age + 'yr: ' + p.foldedAccessories.join(' + ')).join('; ') +
        ' were booked as separate product lines on the same person and are rebuilt as that ' +
        'person\'s addon (boots / helmet), not as an extra skier.'
      );
    }
    if (unknownDefs.length) {
      approximations.push(
        unknownDefs.length + ' item(s) carry no definitionId in Odin, so their product was guessed ' +
        'from the product name. Every other line is the exact product that was sold. ' +
        'Check those lines in the cart before quoting.'
      );
    }
    if ((booking.services || []).length || (booking.insurance || []).length) {
      approximations.push('The booking carries services or insurance, which the quote does not rebuild.');
    }
    // THE PROTECTION THE BOOKING ALREADY HAS IS NOT "ADDED AT THE CUSTOMER'S
    // REQUEST". On 581954 (theft claim, "I purchased the Alpinguaranty") the
    // word matched the addon regex, and the note told the agent the original
    // booking did NOT carry the protection - while Odin showed it on the item
    // (services definitionId 3). Read it off the booking before deciding.
    const hadDamageCover = (itemServices || []).some(ids => (ids || []).includes(3)) ||
      [].concat(booking.insurance || [], booking.services || [])
        .some(s => /damage|theft|guaranty|garantie|casse|vol\b/i.test(String((s && (s.name || s.type)) || '')));
    const addedOnRequest = [
      equipmentAddedFor.length ? (wantsEquipment === 'snowboard' ? 'a snowboard' : 'skis') +
        ' (intermediate level assumed)' : '',
      (withInsurance && !hadDamageCover) ? 'the damage & theft protection' : '',
      (wantAddon.helmets && !anyHelmet) ? 'helmets' : '',
      (wantAddon.boots && !anyBoots) ? 'boots' : '',
    ].filter(Boolean);
    if (addedOnRequest.length) {
      approximations.push('The rebuilt cart INCLUDES ' + addedOnRequest.join(' and ') +
                          ', which the original booking does not carry. The two totals are ' +
                          'therefore not comparable line for line - the difference is what was added.');
    }
    if (shopChangeRequested) {
      approximations.push('THIS CART IS AT A DIFFERENT SHOP than the booking (' +
                          String((booking.shop && booking.shop.name) || 'original shop') +
                          '). A booking cannot be moved from one shop to another: the customer books this ' +
                          'cart at the new shop, then the original booking is cancelled - see the cancellation ' +
                          'cost below. Prices differ between shops, so the two totals are not comparable.');
    }
    if (upgrade.applied.length) {
      approximations.push('UPGRADE: this cart holds a HIGHER product for ' + upgrade.persons.join(', ') +
                          ' (' + upgrade.applied.join('; ') + '). Everything else is the booking as it stands, so the ' +
                          'difference between the two totals is the upgrade itself.' +
                          (upgrade.everyone ? ' The message names nobody, so the upgrade was applied to EVERY skier - confirm with the customer who it concerns.' : '') +
                          (upgrade.impossible.length ? ' Not upgraded: ' + upgrade.impossible.join('; ') + '.' : ''));
    }
    if ((booking.coupons || []).length) {
      approximations.push('The original booking used a coupon. Any new coupon is sized by the quote itself and may differ.');
    }

    // ── 3. Price it with the one and only pricing implementation we trust. ───
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    // D-56: at the customer's new shop when they asked for one, else at the booking's.
    // generate-quote resolves the resort text itself and, when the name is
    // ambiguous ("Courchevel" is three resorts) or unknown, answers with the ONE
    // question to put to the customer - which we pass on below instead of a cart.
    const shopTarget = shopChangeRequested
      ? (Number.isFinite(newShopId) ? { shopId: newShopId } : { resort: newShopEff })
      : { shopId };
    const quoteBody = JSON.stringify({
      ...shopTarget,
      startDate,
      endDate,
      lang,
      platform: siteDomain,
      // persons ONLY: adults / children_ages would take precedence over it and
      // flatten a mixed ski + snowboard group into one single equipment type.
      // PER PERSON, not the union.
      //
      // The union was a deliberate under-quoting guard, and on BQTZCJ it added
      // boots to a person who had never had any: the rebuilt cart no longer
      // matched the booking it claims to reproduce, and the customer would have
      // paid for equipment they had not asked for. generate-quote reads
      // boots / helmet / insurance per person and falls back to the group flags
      // only when a person carries none of them, so the exact basket travels.
      persons: persons.map((p, i) => ({
        age: p.age,
        skill: p.skill,
        equipment: p.equipment,
        // The product that was actually sold, stated outright.
        //
        // skill and equipment stay as a fallback for the rare item whose
        // definitionId the catalogue does not know, but they must never be the
        // primary route: on BDKLQJ four distinct products (110, 90, 5, 16)
        // came back as definitionId 4 four times, because the pair
        // (skill, equipment) cannot express a 7-star ski, a Lady model or a
        // Champion tier. See statedDefinitionId() in generate-quote.js.
        definitionId: p.sourceDefinitionId || undefined,
        // The exact addon list for THIS person: what they had (boots, helmet,
        // Modelchange, an existing protection) plus what they are asking for.
        // An explicit list is taken verbatim by generate-quote, so nothing is
        // inferred and nothing is silently dropped.
        addons: [...new Set([].concat(
          wantBoots[i] || wantAddon.boots ? [1] : [],
          wantHelmet[i] || wantAddon.helmets ? [2] : [],
          (itemServices && itemServices[i]) || [],
          withInsurance ? [3] : []
        ))],
      })),
      // The group flags stay as the fallback for anything the per-person map
      // cannot answer.
      with_boots: anyBoots || wantAddon.boots,
      with_helmets: anyHelmet || wantAddon.helmets,
      with_insurance: withInsurance,
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
      if (shopChangeRequested && parsed && parsed.action === 'ASK' && parsed.question) {
        // The new shop could not be pinned down. Not a failure: a question.
        const q = String(parsed.question);
        return res.status(200).json({
          found: false,
          ask: true,
          shopChange: true,
          question: q,
          candidates: parsed.candidates || [],
          cartUrl: '', carturl: '',
          cartOnlinePrice: null, cartonlineprice: null,
          internalNote: 'SHOP CHANGE FOR ' + ref + ' - QUESTION FOR THE CUSTOMER, no cart yet: ' + q,
          internalnote: 'SHOP CHANGE FOR ' + ref + ' - QUESTION FOR THE CUSTOMER, no cart yet: ' + q,
        });
      }
      if (quoteRes.ok && parsed && parsed.cartUrl) quote = parsed;
      else if (attempt === 0) console.warn('[requote-booking] generate-quote attempt 1 unusable, retrying', quoteRes.status);
    }
    if (!quote) {
      return refuse(res, ref, 'the pricing chain did not answer after two attempts');
    }

    const days = Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1;
    const equipmentSummary = persons.map(p => p.age + 'yr ' + p.skill + ' ' + p.equipment).join(', ') +
      (anyBoots ? ' + boots' : '') + (anyHelmet ? ' + helmets' : '');

    const internalNote = buildInternalNote({
      reference: ref,
      shopName: quote.shopName,
      shopChangeFrom: shopChangeRequested ? String((booking.shop && booking.shop.name) || 'original shop') : null,
      upgrade: upgrade.applied.length ? upgrade : null,
      siteLabel,
      resort: quote.resort,
      originalFrom,
      originalTo,
      startDate,
      endDate,
      days,
      personsCount: persons.length,
      equipmentSummary,
      rebuiltFromCancelled,
      cartOnlinePrice: quote.cartOnlinePrice,
      cartInStorePrice: quote.cartInStorePrice,
      currency: quote.cartPriceCurrency || 'EUR',
      originalTotalDue: money(booking.total && booking.total.amount),
      cartUrl: quote.cartUrl,
      approximations,
      addedOnRequest,
      hadDamageCover,
      cancellationFeeText: (function () {
        const c = cancellationCost(booking, ref, originalFrom);
        return c.cancellation_fee_text || c.cancellation_fee_internal || '';
      })(),
    });

    return res.status(200).json({
      ...quote,
      // Flat copies: a Zendesk custom action maps top-level fields in one click,
      // whereas a nested path has to be declared by hand and is easy to mistype.
      //
      // Both spellings on purpose. A Zendesk custom action forces output names to
      // lowercase, and JSON keys are case-sensitive, so a camelCase-only response
      // hands the flow an empty string. generate-quote.js already carries the same
      // pairs (quoteline, cartinstoreprice, ...) for exactly this reason.
      internalNote,
      internalnote: internalNote,
      approximations,
      quotedStartDate: startDate,
      quotedstartdate: startDate,
      quotedEndDate: endDate,
      quotedenddate: endDate,
      quotedDays: days,
      quoteddays: days,
      // Flat, both spellings: the ZAF and any Zendesk action can branch on it
      // without declaring a nested path.
      rebuiltFromCancelled,
      rebuiltfromcancelled: rebuiltFromCancelled,
      sourceBookingReference: booking.bookingReference || ref,
      sourcebookingreference: booking.bookingReference || ref,
      sourceBalanceDue: money(booking.total && booking.total.amount),
      sourcebalancedue: money(booking.total && booking.total.amount),
      // What cancelling the source booking costs today. Flat and lowercase so a
      // Zendesk custom action binds them in one click - see cancellationCost().
      ...cancellationCost(booking, ref, originalFrom),
      // Underscore-free aliases. Zendesk custom-action output names are
      // lowercase and the existing ones on this action (carturl, internalnote)
      // carry no separator, so these are the spellings the flow can bind.
      ...(() => { const c = cancellationCost(booking, ref, originalFrom); return {
        cancellationfeetext: c.cancellation_fee_text,
        cancellationfeepercent: c.cancellation_fee_percent,
        cancellationfeeamount: c.cancellation_fee_amount,
        cancellationrefundamount: c.cancellation_refund_amount,
        cancellationdeadline: c.cancellation_deadline,
        cancellationfeeinternal: c.cancellation_fee_internal || '',
        hascancellationcover: c.has_cancellation_cover,
        cancellationfree: c.cancellation_free,
      }; })(),
      // Same reason: the online price of the rebuilt cart, flat and lowercase.
      cartonlineprice: quote.cartOnlinePrice,
      cartinstoreprice: quote.cartInStorePrice,
      addedonrequest: addedOnRequest.join(', '),
      // D-61: flat and lowercase, so the flow can branch on it in one click.
      upgradeRequested: upgrade.requested,
      upgraderequested: upgrade.requested,
      upgradeApplied: upgrade.applied.join('; '),
      upgradeapplied: upgrade.applied.join('; '),
      // Whether the ORIGINAL booking carries the damage & theft protection, read
      // off Odin. General questions uses it for a claim; the customer's own claim
      // to have bought it is not evidence.
      hasDamageCover: hadDamageCover,
      hasdamagecover: hadDamageCover,
      carturl: quote.cartUrl,
      shopname: quote.shopName,
      platformDomain: siteDomain,
      platformdomain: siteDomain,
      platformLabel: siteLabel,
      platformlabel: siteLabel,
      requote: {
        shopChange: shopChangeRequested
          ? { requested: newShopEff || String(newShopId), fromProse: !!shopFromProse, from: (booking.shop && booking.shop.name) || null, to: quote.shopName }
          : null,
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
        upgrade: upgrade.requested ? upgrade : null,
        quotedPeriod: { startDate, endDate, days },
        datesSource: (isDay(params.startDate) && isDay(params.endDate)) ? 'caller' : 'booking',
        insuranceIncluded: withInsurance,
        addedOnRequest,
        persons,
        addons: { boots: anyBoots, helmets: anyHelmet, bootsUniform, helmetUniform },
        rebuiltFromCancelled,
        approximations,
        internalNote,
      },
    });
  } catch (err) {
    console.error('[requote-booking] Error:', err);
    return refuse(res, '', String(err && err.message || err).slice(0, 200));
  }
}
