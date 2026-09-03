/**
 * GET  /api/knowledge   (served through /api/support?action=knowledge)
 *
 * The filename starts with an underscore on purpose: Vercel counts every file
 * in api/ that does NOT start with "_" as its own serverless function, and the
 * Hobby plan allows twelve. This project was already at twelve. So knowledge is
 * a module the support router calls, not a function of its own, and a rewrite in
 * vercel.json keeps the clean /api/knowledge URL working for the flow.
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
  // Read off each brand's own terms page. Alpinsafety and Alpinsafety Plus keep
  // their name everywhere; the cancellation cover and the damage/theft cover are
  // renamed on every single brand, which is why answering with the wrong one is
  // both easy to do and obvious to the customer.
  alpy: { label: 'alpy.com', cancellation: 'Alpinflexi', damage: 'Alpinguaranty',
    terms: 'https://www.alpy.com/en/terms',
    offers: 'https://www.alpy.com/en/ski-rental/additional-offers' },

  snowbrainer: { label: 'snowbrainer.com', cancellation: 'SNOWFLEX', damage: 'SNOWGUARANTY',
    terms: 'https://www.snowbrainer.com/en/terms', offers: '' },

  lsmc: { label: 'location-ski-moins-cher.com', cancellation: 'SKIFLEXI', damage: 'SKIGUARANTY',
    terms: 'https://www.location-ski-moins-cher.com/fr/conditions', offers: '' },

  bestprice: { label: 'best-price-ski-rental.com', cancellation: 'SKIFLEXI', damage: 'SKIGUARANTY',
    terms: 'https://www.best-price-ski-rental.com/en/terms', offers: '' },

  skidiscountfr: { label: 'skidiscount.fr', cancellation: 'SKIFLEXI', damage: 'SKIGUARANTY',
    terms: 'https://www.skidiscount.fr/fr/conditions', offers: '' },

  skidiscountuk: { label: 'skidiscount.co.uk', cancellation: 'SKIFLEXI', damage: 'SKIGUARANTY',
    terms: 'https://www.skidiscount.co.uk/en/terms', offers: '' },

  skimarie: { label: 'skimarie.fr', cancellation: 'marieANNULATION', damage: 'marieASSURANCE',
    terms: 'https://www.skimarie.fr/fr/conditions', offers: '' },

  simplytoski: { label: 'simply to SKI (simplytoski.fr)', cancellation: 'simplyANNULATION',
    damage: 'simplyGARANTIE', terms: 'https://www.simplytoski.fr/fr/conditions', offers: '' },

  slopefox: { label: 'slopefox.co.uk', cancellation: 'SLOPEFLEX', damage: 'SLOPEGUARANTY',
    terms: 'https://www.slopefox.co.uk/en/terms', offers: '' },
};

/**
 * Zendesk brand ids, from GET /api/v2/brands.json on this instance.
 *
 * The brand is the only reliable signal for who the customer thinks they are
 * writing to. It is not in the Odin booking payload and cannot be inferred from
 * the shop, so the flow passes the trigger's Brand ID and we resolve it here.
 * Ids are stable; names get edited.
 *
 * The brands NOT listed are handovers, deliberately:
 *   360000304717    pistenfuchs.de           terms page does not render
 *   23016833469597  Swissrent.com            runs on a different platform
 *   10594343447837  Skirent - Simple Booking we are the shop; names are the
 *   360000306538    Hervis                   partner's own
 *   6793694668829   ALPINRESORTS Bike Rental dead brand, old name of Alpy
 */
const BRAND_IDS = {
  '246961':         'alpy',
  '360000234758':   'snowbrainer',
  '360000232817':   'lsmc',
  '360000234878':   'bestprice',
  '360000234818':   'skidiscountfr',
  '360000306518':   'skidiscountuk',
  '360000306598':   'skimarie',
  '6898647504797':  'simplytoski',
  '360000306498':   'slopefox',
};

function brandBlock(brandKey) {
  const b = BRAND_PRODUCTS[brandKey] || BRAND_PRODUCTS.alpy;
  const lines = [
    'BRAND FOR THIS TICKET: ' + b.label,
    'Cancellation protection is called: ' + b.cancellation,
    'Damage & theft protection is called: ' + b.damage,
    // The one pair that never changes name, on any brand.
    'Accident protections are called: Alpinsafety and Alpinsafety Plus',
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

// Le code promo vit dans generate-quote.js (ALPY_PROMO_CODE, SKI26 par defaut).
// Il est lu de la meme variable ici pour qu'un changement de code n'ait pas a
// etre repercute a deux endroits - une reponse client qui annonce un code perime
// est pire qu'une reponse qui n'en annonce aucun.
const ACTIVE_PROMO_CODE = process.env.ALPY_PROMO_CODE || 'SKI26';

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
and the remainder on site. Most French shops accept them: pay the deposit part
online, and the cheques vacances can generally be used on the spot.

THE CUSTOMER ASKS IF WE HAVE A DISCOUNT CODE
Yes, and the answer is never "we cannot advise on that". There is a current
promotion code, ${ACTIVE_PROMO_CODE}, and every quote this system builds already has it
applied — the price in the cart link is the discounted price, not one to negotiate
down afterwards. So the useful sentence is: we have a code running, it is already
included in the quote we are preparing for you, and the total you will see is the
one you pay.

Never answer a request for a code with a refusal or a deflection. A customer
asking for a discount is a customer about to book. If a quote is being built,
say the code is in it. If no quote is being built yet, give the code and offer
to build one.

From EIGHT people the group discount applies on top of the code: a voucher whose
value follows the size of the basket, from 20 EUR on a small group up to 160 EUR
on a large one. It is calculated automatically in the quote, so do not compute
it by hand and do not promise a figure — say that a group of this size gets a
voucher on top, and let the quote state the amount. Below eight people there is
no group voucher; if the group is close to eight, it is fair and useful to
mention that one more person tips it over.

Never invent a percentage, and never offer a discount that does not exist in
this section.

A PROMOTION CODE IS REFUSED
By far the commonest cause is a space copied into the field along with the code.
Ask them to retype it. A code cannot be added to a booking that is already
confirmed — the only route is to cancel and rebook. A cancellation fee would
apply if the cancellation protection is not on the booking; it usually is, in
which case rebooking costs nothing.

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
contacts on their voucher. After booking, the customer receives the shop's direct
contact details, and arranging a specific brand with the shop afterwards is
perfectly fine — say so rather than closing the subject.

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

=== HOW SHOPS DIFFER, AND DELIVERY ===

SHOP TYPES ON THE SITE
Top-Shop: close to the lifts, better equipment, short waiting times. Best Offer
(or discount shop): usually the cheapest in town, sometimes further from the
lift. Virtual shop: a partner with no shop in the town shown, which either
delivers to the accommodation or shuttles the customer to its real shop and
back. The "i" next to each shop lists that shop's own advantages.

DELIVERY TO THE ACCOMMODATION
Sold by shops that offer it, and the customer fills in the mandatory
measurements when booking: name, height, weight, shoe size and level. The
customer must contact the shop before arriving to agree a meeting point and a
time - delivery is not automatic. The lead time required is written on the
voucher, and 36 hours is typical. Where a price applies it is small, around 5
euros per set with three days' notice. Whether a given shop delivers, and what
it charges, is shop-specific: do not guess it here.

DROP-OFF AND COLLECTION - NOT THE SAME THING
The shop leaves or collects the equipment at the hotel without meeting the
customer. None of the delivery instructions above apply: there is no meeting
point to agree and nothing to arrange on arrival. The two are often confused,
including by us.

MODELCHANGE AND SWITCH
Modelchange is a paid option bought when booking: one change of model during the
rental, generally after two days, within the same price category and subject to
availability. A switch between skis and a snowboard is an extended modelchange -
every switch is a modelchange, not every modelchange is a switch. The shop does
not charge for the switch itself, it charges for the option. Whether a
particular shop or chain allows it is shop-specific and has its own flow.

CHANGING CATEGORY AT THE COUNTER
Only if the shop agrees. To a higher category the customer pays the difference
on the spot; to a lower one there is no refund. This is in the terms.

=== THE PROTECTIONS ===
Use the brand-correct names given at the top of this document.

DAMAGE AND THEFT — use the name given at the top of this document
15% of the online value of the booked equipment. Covers theft and damage or
breakage, up to €450 per adult or teenager item and €250 per child item. It does
NOT cover loss — equipment left behind or simply not returned is not a claim.
Can be taken for one person only.

CANCELLATION — use the name given at the top of this document
5% of the online value, and frequently promoted free of charge. Cancel for any
reason, with no fee, up to 08:00 on the day before the first rental day. No
justification and no medical certificate needed. Must be taken for everyone on
the booking.

ACCIDENT — Alpinsafety, the one name that is the same on every brand
€1.35 per person per day. Covers search and rescue up to CHF 5,000 per event,
emergency transport to hospital and medically supervised transfer, with a total
ERV benefit of CHF 10,000 per event. It does not cover doctors' fees or pharmacy
bills. Must be taken for everyone on the booking. The insured person is whoever
uses the equipment, not whoever paid.

ACCIDENT PLUS — Alpinsafety Plus, also the same on every brand
€2 per person per day. Everything Alpinsafety covers, plus a pro-rata refund of
unused rental days, unused ski school days and lift pass costs in case of
illness, accident, insufficient snow or lift closure. Claims need a medical
certificate, or confirmation from the lift operator for snow.

ADDING A PROTECTION OR A PAID OPTION AFTER BOOKING
It cannot be added to the existing booking. All protections and paid options are
bought at the moment of booking, because we cannot charge the card again
afterwards. Never leave the customer with a bare "no": there is one route and we
walk it FOR them.

The route is a NEW booking that already includes the protection, and a
cancellation of the current one. What the reply contains, in this order:
1. The protection cannot be attached to an existing booking - said plainly, once.
2. The way to get it: re-book with the protection included, then cancel the
   current booking.
3. THE READY CART. We rebuild their exact booking - same shop, same dates, same
   equipment - with the protection included, and we put the link in the reply
   with the new total. They click and confirm; they do not rebuild anything.
4. What cancelling the current booking would cost, computed by us from its dates
   and its protections.
5. One question, and only one: do they want us to go ahead.

WE DO THE CHECKING, NOT THE CUSTOMER
The reply NEVER says "we recommend you check", "please verify", "you can look at
your booking conditions" or anything else that hands our work back to the person
who wrote to us. If a figure needs looking up, we look it up before replying. If
we truly cannot compute it, we say we are checking it and an agent comes back
with the number - we do not delegate it to the customer.

NEVER promise that the cancellation is free. The fee depends on the dates and on
the protections already on the booking (see CANCELLATION FEES and CANCELLING
WITHIN TWO HOURS OF BOOKING). Give the real figure, and if the fee makes the
exchange pointless, say so honestly - the customer may prefer to keep the
booking as it is. Nothing is ever cancelled before they say yes.

MAKING AN ACCIDENT CLAIM
Handled directly by ERV, not by us. The customer must call the ERV emergency
centre themselves when the incident happens: +41 848 801 803. We cannot file the
claim on their behalf.

MAKING A DAMAGE OR THEFT CLAIM (stolen skis, stolen boots, broken equipment)
Not answered here: return HANDOVER. The claim needs documents and a decision
that a colleague makes, and this document does not hold the procedure, so do not
improvise one - no document list, no deadline, no amount, and never ERV (ERV is
for accidents to people, not for equipment). A theft "from the locker" or "at the
hotel" is a claim, not a question about the shop's storage.
For the colleague, the booking itself says whether the damage & theft protection
was bought: it appears as a service named "damage & theft protection" on the
item. When it is there, the cover is theft and damage or breakage up to EUR 450
per adult or teenager item and EUR 250 per child item; loss is not covered.

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

=== CANCELLATION AFTER THE RENTAL HAS STARTED ===

The answer is no. How we say it is the whole point, and it follows a fixed order.
Skipping a step is what turns a correct answer into a bad rating.

1. THANK THEM AND NAME THE FEELING, WITHOUT CONCEDING THE POINT.
   "We can totally understand your frustration", "we cannot be satisfied that the
   service did not match your expectations". We are not indifferent, and we say so
   before we say no.

2. POINT TO THE RULE THEY ALREADY MET.
   No cancellation or change is possible after 08:00 on the day before the first
   rental day. They accepted the terms when booking, and the deadline is printed
   IN CAPITAL LETTERS on the voucher and in the confirmation email. We say this to
   show the process is transparent, not to win an argument: the rule was visible
   before they needed it.

3. GIVE THE ANALOGY.
   You cannot cancel a hotel night once the date has passed, or a flight once the
   plane has left. Our industry works the same way. The equipment was reserved for
   them for the whole period: what they paid for is the availability of that
   equipment over those dates, and it was held for them.

4. EXPLAIN WHY THE RULE EXISTS, WITHOUT HIDING BEHIND IT.
   We are an intermediary. We can offer very competitive prices because we respect
   a small number of partner rules, and one of them is that a booking cannot be
   cancelled after the first rental day. We have to respect our customers and our
   shop partners equally. Never write "we are only an intermediary" and stop there.

5. NAME THE PROTECTION THAT WOULD HAVE COVERED IT.
   Alpinsafety Plus exists precisely because skiing is a dangerous sport and plans
   change: it refunds the days not used. It was not on this booking. State it as
   the reason the answer is what it is - never as a reproach, never "you should
   have".

6. SAY THE NO PLAINLY, ONCE.
   We are unable to process this claim on this booking. One sentence. Do not
   repeat it, do not decorate it.

7. OPEN THE NEXT DOOR, AND MEAN IT.
   This is the part that must never be dropped. Not being able to do anything on
   THIS booking does not mean we are unwilling to help. Invite them to contact us
   before their next booking and we will organise a special price or a credit for
   them. Our exchanges are stored, so we will remember them. That offer is real:
   it is what turns a refusal into a customer we keep.

AND THE MEDICAL DOOR
Where injury or illness is involved, the no is not the end of the conversation.
Ask for BOTH documents: a medical certificate dated inside the rental period, and
the shop's written confirmation of the early return. With Alpinsafety Plus the
claim then goes to ERV on +41 848 801 803 - we cannot file it for them. Without a
protection, those two documents are what allows a goodwill gesture on the unused
days of the affected person only, decided by a human, never by this flow.

Open that door while laying the ground for the no, in the same message. A customer
told only "no" argues; a customer told "no, and here is the route that does exist"
sends the certificate.

WHAT NEVER APPEARS IN THIS ANSWER
No blame. No "you should have read". No promise of an amount. No refund figure
that has not been simulated in Odin. And never a gesture covering the whole party
when one person was injured - that one causes real problems with the shop.

=== WHAT WE DO AND DO NOT SELL ===

WE DO NOT RENT
Clothing, lift passes, ski lessons, goggles, telemark equipment. Sledges are
only occasionally available and not normally bookable online.

SKI LESSONS
We do not sell them. Point the customer to ski-pro.com, using a link that carries
our referral parameter — we are paid per booking, and a link without it earns us
nothing. The shape is:
  https://ski-pro.com/en/ski-lessons/france/savoie/la-plagne?referrer=alpinres
Keep ?referrer=alpinres and swap the country / region / resort for the customer's
destination. If you cannot build the resort path with confidence, hand over
rather than send a broken link.

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

/**
 * The same brand resolution the HTTP handler does, pulled out so other modules
 * can reuse it without an HTTP round trip.
 *
 * _review.js needs the exact book the flow was allowed to use, because judging a
 * reply against a DIFFERENT book is worse than not judging it at all: it would
 * fail correct answers for facts the flow never had, and pass wrong ones the
 * flow invented. One function, one source, both callers.
 */
export function resolveBrand(raw) {
  const r = String(raw ?? '').trim().toLowerCase();
  if (BRAND_IDS[r]) return BRAND_IDS[r];
  if (r.includes('snowbrain')) return 'snowbrainer';
  if (r.includes('moins cher') || r.includes('lsmc')) return 'lsmc';
  if (r.includes('alpy')) return 'alpy';
  return null;
}

/** The book for a brand id or name, or '' when the brand is not supported. */
export function knowledgeFor(raw) {
  const key = resolveBrand(raw);
  return key ? buildKnowledge(key) : '';
}

export async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  let params = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = {}; } }
  if (!params || typeof params !== 'object' || Array.isArray(params)) params = {};

  // Zendesk lowercases custom-action output names, so every key is offered in
  // both spellings. The same reason switch-depot.js does it.
  const raw = String(params.brand ?? params.brandId ?? params.brandid ??
                     params.brandName ?? params.brandname ?? '').trim().toLowerCase();

  const brandKey = resolveBrand(raw);

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

export default handler;
