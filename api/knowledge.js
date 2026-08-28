/**
 * GET  /api/knowledge
 * POST /api/knowledge   { brand?: 'alpy' | 'snowbrainer' | 'lsmc' | ... }
 *
 * The answer book for questions that need knowledge and no action.
 *
 * WHY THIS IS AN ENDPOINT AND NOT A PROMPT
 *
 * The same facts have to be true in four places: the Confluence manual an agent
 * reads, the macros an agent sends, this flow, and eventually the Help Centre
 * article a customer finds on their own. Keeping them in a Zendesk prompt field
 * means the day the cancellation deadline moves, one of the four is wrong and
 * nobody knows which. Keeping them here means they move in a commit, with a
 * diff, and the flow picks them up on the next deploy without anyone opening the
 * Zendesk UI.
 *
 * So this file is the source, and the flow is a reader. Edit the facts here.
 *
 * WHAT THE CALLER DOES WITH IT
 *
 * The flow hands `knowledge` and the customer's message to one Claude step and
 * asks it to answer ONLY from what is written here, or to say HANDOVER. There is
 * no retrieval, no embedding, no ranking: the whole book fits in a prompt, and a
 * model that can see all of it cannot pick the wrong chunk. If it grows past
 * what fits, split it by section and pass the section - do not add a search.
 *
 * THE ONE RULE THAT MATTERS
 *
 * Silence is not an answer, but neither is a guess. Every entry below is a fact
 * we have written down somewhere and can defend. Anything not in here is a
 * handover, and the flow says so plainly rather than improvising - that is the
 * whole reason this is a closed book rather than an open model.
 */

// Product names change per brand. Alpinsafety is the only one that does not.
// Answering a snowbrainer.com customer about "Alpinflexi" tells them, correctly,
// that we did not look at who they are.
const BRAND_PRODUCTS = {
  alpy: {
    label: 'alpy.com',
    cancellation: 'Alpinflexi',
    damage: 'Alpinguaranty',
    accident: 'Alpinsafety',
    accidentPlus: 'Alpinsafety Plus',
    terms: 'https://www.alpy.com/en/terms',
    offers: 'https://www.alpy.com/en/ski-rental/additional-offers',
  },
  snowbrainer: {
    label: 'snowbrainer.com',
    cancellation: 'Snowflexi',
    damage: 'Alpinguaranty',
    accident: 'Alpinsafety',
    accidentPlus: 'Alpinsafety Plus',
    terms: 'https://www.snowbrainer.com/en/terms',
    offers: '',
  },
  // location ski moins cher: Alpinguaranty does not exist on this brand at all.
  lsmc: {
    label: 'location ski moins cher',
    cancellation: 'the cancellation protection',
    damage: null,
    accident: 'Alpinsafety',
    accidentPlus: 'Alpinsafety Plus',
    terms: '',
    offers: '',
  },
};

/**
 * Zendesk brand ids, read from GET /api/v2/brands.json on this instance.
 *
 * The brand is the only reliable signal for who the customer thinks they are
 * writing to. It is not in the Odin booking payload and it cannot be inferred
 * from the shop, so the flow passes the trigger's Brand ID and we resolve it
 * here. Ids are stable; names get edited.
 *
 * Every brand on the instance is listed, including the ones we do not answer
 * for, so that adding one later is a matter of writing its product names rather
 * than rediscovering that it exists:
 *
 *   246961            ALPY.com                    (default)   answered
 *   360000234758      Snowbrainer.com                         answered
 *   360000232817      location-ski-moins-cher.com             answered
 *   10594343447837    Skirent-Simple Booking                  HANDOVER
 *   360000234878      best-price-ski-rental.com               HANDOVER
 *   360000306538      Hervis                                  HANDOVER
 *   360000304717      pistenfuchs.de                          HANDOVER
 *   6898647504797     simply to SKI                           HANDOVER
 *   360000306518      skidiscount.co.uk                       HANDOVER
 *   360000234818      skidiscount.fr                          HANDOVER
 *   360000306598      skimarie.fr                             HANDOVER
 *   360000306498      slopefox.co.uk                          HANDOVER
 *   23016833469597    Swissrent.com                           HANDOVER
 *   6793694668829     ALPINRESORTS.com Bike Rental            HANDOVER
 */
const BRAND_IDS = {
  '246961': 'alpy',
  '360000234758': 'snowbrainer',
  '360000232817': 'lsmc',
};

function brandBlock(brandKey) {
  const b = BRAND_PRODUCTS[brandKey] || BRAND_PRODUCTS.alpy;
  const lines = [
    'BRAND FOR THIS TICKET: ' + b.label,
    'Cancellation protection is called: ' + b.cancellation,
    b.damage
      ? 'Damage & theft protection is called: ' + b.damage
      : 'This brand does NOT sell a damage & theft protection. Do not mention one.',
    'Accident protections are called: ' + b.accident + ' and ' + b.accidentPlus,
  ];
  if (b.terms) lines.push('Terms link to use: ' + b.terms);
  if (b.offers) lines.push('Additional offers link to use: ' + b.offers);
  lines.push('Sign off as this brand. Never mention a different brand to this customer.');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// The book. Written as the answer, not as a note to self: what is here is close
// to what the customer should read.
// ─────────────────────────────────────────────────────────────────────────────

const VOCABULARY = `HOW WE SPEAK (these are rules, not preferences)
- Say "protection", never "insurance" or "assurance". We are not an insurer and
  are not legally allowed to use that word.
- Say "payment confirmation", never "invoice". Say "coupon", never "voucher for
  money" or "bon d'achat".
- Never open with "Unfortunately", "I'm afraid", "we regret". Lead with what we
  can do. Never say "that is not possible" without immediately giving the path
  that is.
- Never blame the customer, never criticise a shop, never say "we are only an
  intermediary".
- Reply in the customer's language. Never mix two languages in one message.
- Do not quote a discount percentage. This flow does not price anything.`;

const FACTS = `
=== BILLING AND PAPERWORK ===

INVOICE
We issue a payment confirmation, not an invoice. This is not a policy choice: we
act as an agent, and the ski shop is the party that owes VAT on the rental, so
the shop is the only one that can issue a real invoice. A customer who needs one
asks the shop directly, using the contact details on their voucher. The payment
confirmation we send shows the amount paid and the booking reference, and is
accepted for most expense claims.

WHAT THE VOUCHER CONTAINS
Booking reference, shop name, address and opening hours, the hire period, the
equipment per person, the amount paid, the cancellation deadline, and a QR code
where the shop uses one.

=== PAYMENT ===

ACCEPTED PAYMENT METHODS
Visa, Mastercard, Maestro, PayPal, Diners Club, Giropay, ELV, iDeal, Postfinance,
Przelewy24, Sofort.

AMERICAN EXPRESS
Not available as a direct payment method. Two routes that work: choose PayPal at
checkout, then "pay with a bank account or credit card", and select the AMEX
card there; or add the AMEX card to Google Pay and pay with that.

DEPOSIT / PART PAYMENT
Some shops allow paying part online and the remainder at the shop. If we ever
refund, we can only refund the part paid online — the rest is simply never
charged.

CHEQUES VACANCES / ANCV
Depends on the shop. Where accepted, the usual arrangement is a deposit online
and the remainder on site.
Most french shops accept it when paying the deposit part online, you can generally use cheques vacances on spot

A PROMOTION CODE IS REFUSED
By far the commonest cause is a space copied into the field along with the code.
Ask them to retype it. A code cannot be added to a booking that is already
confirmed — the only route is to cancel and rebook, and the cancellation fee
would apply (if alpinflexi not included: usually is)

THE PRODUCT PAGE WILL NOT LOAD
Almost always cache or cookies: a hard refresh, clearing the cache, an incognito
window, or a different browser.

HEIGHT, WEIGHT OR SHOE SIZE REFUSED
The form does not accept decimals. Enter a whole number.

=== WHAT IS INCLUDED ===

SKI POLES
Always included, free, whenever skis are hired.

BOOTS AND HELMETS
Separate paid add-ons, priced per person. They are not included in a ski package
unless the customer selected them.

GOGGLES
Not available to book online.

HELMET TYPE
Our partner shops rent standard helmets, not visor helmets.

HELMET OBLIGATION
Italy: compulsory under 18, fine up to €200. Austria: compulsory under 15, except
in Tyrol and Vorarlberg, where there is no penalty. We recommend a helmet at
every age.

OWN BOOTS
Perfectly fine. The shop adjusts the bindings on site. Tell them to mention it at
the counter.

=== EQUIPMENT ===

A SPECIFIC BRAND OR MODEL
Not bookable. We rent price categories, and the shop selects the actual ski on
the day and fits it to the skier. The models shown on the website are
illustrative. A customer set on one model can ask the shop directly with the
contacts on their voucher. After the online booking, the customer receives the direct contact of the store, it is totally fine to organize a specific brand directly with the store after booking made.

THE CATEGORIES
3-star Blue/Bronze for beginners and careful skiers; 4-star Red/Silver for
beginners, intermediates and returning skiers (the reference category); 5-star
Black/Gold for advanced and ambitious skiers; 6-star Platinum and 7-star Diamond
for experts, in a small number of shops.

LADIES' SKIS
Same price as unisex skis, available in nearly every type and level.

MODELCHANGE
A paid option bought at the time of booking: one change of model during the
rental, generally after two days, within the same price category and subject to
availability.

PRIORITY CHECK-IN
A paid option bought at booking: a separate, faster check-in desk when the rental
starts. It appears on the voucher as an additional product.

=== THE PROTECTIONS ===
Use the brand-correct names given at the top of this document.

DAMAGE AND THEFT (Alpinguaranty on alpy.com)
15% of the online value of the booked equipment. Covers theft and damage or
breakage, up to €450 per adult or teenager item and €250 per child item. It does
NOT cover loss — equipment left behind or simply not returned is not a claim.
Can be taken for one person only.

CANCELLATION (Alpinflexi on alpy.com, Snowflexi on snowbrainer.com)
5% of the online value, and frequently promoted free of charge. Cancel for any
reason, with no fee, up to 08:00 on the day before the first rental day. No
justification and no medical certificate needed. Must be taken for everyone on
the booking.

ACCIDENT (Alpinsafety — same name on every brand)
€1.35 per person per day. Covers search and rescue up to CHF 5,000 per event,
emergency transport to hospital and medically supervised transfer, with a total
ERV benefit of CHF 10,000 per event. It does not cover doctors' fees or pharmacy
bills. Must be taken for everyone on the booking. The insured person is whoever
uses the equipment, not whoever paid.

ACCIDENT PLUS (Alpinsafety Plus)
€2 per person per day. Everything Alpinsafety covers, plus a pro-rata refund of
unused rental days, unused ski school days and lift pass costs in case of
illness, accident, insufficient snow or lift closure. Claims need a medical
certificate, or confirmation from the lift operator for snow.

ADDING A PROTECTION AFTER BOOKING
Not possible. All protections are bought at the moment of booking, because we
cannot charge the card again afterwards. Recommend it for their next booking.

MAKING AN ACCIDENT CLAIM
Handled directly by ERV, not by us. The customer must call the ERV emergency
centre themselves when the incident happens: +41 848 801 803. We cannot file the
claim on their behalf.

=== THE BOOKING ===

CANCELLATION DEADLINE
08:00 on the day before the first rental day. It is printed on the voucher and in
the confirmation email.

CANCELLATION FEES (without the cancellation protection)
More than 10 working days before the start: 25% of the booking total. 9 to 3
working days: 30%. 2 working days until 08:00 the day before: 35%. On or after
the first rental day: 100%. Working days are Monday to Friday, public holidays
excluded. Refunds go to the original payment method within 5 to 10 business days.

CANCELLING WITHIN TWO HOURS OF BOOKING
Free, with no fee at all, whatever the dates and whatever the protections.

WHAT CAN BE CHANGED
Name, date of birth and email address can be corrected. Dates can be changed when
the price is unchanged. The shop can be changed when the new shop's price is the
same or lower. What cannot be done: adding a person, adding equipment, adding a
protection, adding a promotion code, or changing the equipment category in the
system — all of those need a new booking, because the card cannot be charged
again.

PICK-UP THE DAY BEFORE
In almost every shop the customer can collect the equipment free of charge on the
afternoon or the day before the first rental day. A few shops in Austria are an
exception.

BOOKING LIMITS
Maximum 14 days per booking — a longer stay needs two bookings. Maximum 50 people
per booking. Most shops stop accepting bookings at a cut-off before the first
day, often 3pm the day before.

=== WHAT WE DO AND DO NOT SELL ===

WE DO NOT RENT
Clothing, lift passes, ski lessons, goggles, telemark equipment. Sledges are
only occasionally available and not normally bookable online.

SKI LESSONS
We do not sell them. Point the customer to ski-pro.com — the flow must ask an
agent for the correct referral link rather than inventing one.
The link looks like this: https://ski-pro.com/en/ski-lessons/france/savoie/la-plagne?referrer=alpinres


CHILD FOR FREE
A shop-specific offer, mostly in Austria and never in France, with conditions set
by each shop. It appears on the shop selection page. It cannot be added to an
existing booking in the system, but since the price is the same we simply need
the child's age and we tell the shop.

=== NEVER ANSWERED HERE — ALWAYS A HANDOVER ===
Anything about a specific booking's price, dates or status. Any complaint. Any
refund decision. Any injury. Any legal threat. Anything about a specific shop's
storage, switch, opening hours or services — those have their own flow and their
own data, and guessing loses a booking. Any question this document does not
answer outright.
`;

function buildKnowledge(brandKey) {
  return [brandBlock(brandKey), '', VOCABULARY, '', FACTS].join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  let params = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = {}; } }
  if (!params || typeof params !== 'object' || Array.isArray(params)) params = {};

  // Zendesk lowercases custom-action output names, so every key is offered in
  // both spellings. The same reason switch-depot.js does it.
  const raw = String(params.brand ?? params.brandId ?? params.brandid ??
                     params.brandName ?? params.brandname ?? '').trim().toLowerCase();

  let brandKey = null;
  if (BRAND_IDS[raw]) brandKey = BRAND_IDS[raw];
  else if (raw.includes('snowbrain')) brandKey = 'snowbrainer';
  else if (raw.includes('moins cher') || raw.includes('lsmc')) brandKey = 'lsmc';
  else if (raw.includes('alpy')) brandKey = 'alpy';

  // Deliberately closed rather than open.
  //
  // We run fourteen brands and the product names differ on most of them:
  // Snowflexi instead of Alpinflexi, no Alpinguaranty at all on location ski
  // moins cher, a partner's own name on every simple-booking microsite. We have
  // verified names for three of those. Answering the other eleven would mean
  // guessing what our own products are called in front of a customer, which is
  // exactly the mistake this whole flow exists to avoid.
  //
  // So an unrecognised brand is a handover, not a best guess. Widening this is a
  // matter of filling in BRAND_PRODUCTS, one brand at a time, from something
  // that can be checked.
  if (!brandKey) {
    return res.status(200).json({
      brand: raw || '(none)',
      supported: false,
      action: 'HANDOVER',
      knowledge: '',
      agentNote: 'SKIBOT did not answer: this ticket is on a brand whose product names are not ' +
                 'confirmed in the answer book. Answering would have risked naming a protection ' +
                 'this brand does not sell. Over to you.',
      agentnote: 'SKIBOT did not answer: this ticket is on a brand whose product names are not ' +
                 'confirmed in the answer book. Answering would have risked naming a protection ' +
                 'this brand does not sell. Over to you.',
    });
  }

  const knowledge = buildKnowledge(brandKey);

  return res.status(200).json({
    brand: brandKey,
    supported: true,
    action: 'ANSWER',
    knowledge,
    knowledgeChars: knowledge.length,
    // lowercase aliases
    knowledgechars: knowledge.length,
  });
}
