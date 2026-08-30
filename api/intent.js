/**
 * POST /api/intent
 *
 * One place that answers two questions for every action flow:
 *   1. what does this customer actually want (a topic we can finish, or OTHER)
 *   2. what do we still need before the flow may run, and what do we ask next
 *
 * ─── WHY THE LLM IS THE LAST LAYER, NOT THE FIRST ───────────────────────────
 *
 * Three layers, in decreasing order of trust:
 *
 *   1. NATIVE ZENDESK INTENT TAGS. Zendesk's own triage already tags tickets,
 *      and on the two incidents that prompted this file it was right both times:
 *      581663 carried intent__misc__job_application__new (high confidence) and
 *      581628 carried intent__sell__update__price. Our flows ignored them and
 *      answered anyway. Free, already computed, and it decides first.
 *
 *   2. ALPY VOCABULARY. "depot", "consigne", "modelchange", "changement
 *      d'equipement" - the business words. A generic taxonomy has no label for
 *      the two services our customers pick a shop on, and a plain keyword hit
 *      needs no model.
 *
 *   3. THE MODEL, only when 1 and 2 are silent. The caller runs the prompt (it
 *      is cheap inside a flow) and passes the result in as llm_topic/llm_slots.
 *      This endpoint decides whether to trust it. Keeping the model outside
 *      means one prompt, versioned in git, testable offline - not eight prompts
 *      scattered across eight flows, each free to drift.
 *
 * ─── THE RULE THAT MUST SURVIVE ─────────────────────────────────────────────
 *
 * The model classifies and extracts. This file decides. A flow never asks the
 * model "what should I do" - it asks this endpoint "may I run, and what is
 * missing". next_question is a SUGGESTION: the flow still has to pass its own
 * gate before it may put a question in front of a customer. That gate is what
 * was missing when a booking-reference request went out publicly on a forwarded
 * internal price list.
 */

import { SLOTS, ROUTES, TOPICS, checkSlots } from './_slots.js';

const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Native intent tags we trust to decide on their own. Anything not listed is
// not evidence - absence of a tag says nothing.
const TAG_TO_TOPIC = {
      'intent__travel__booking_cancellation__cancel': 'CANCELLATION',
      'intent__travel__booking_cancellation__undo_cancel': 'OTHER',
      'intent__travel__booking_cancellation__policy': 'OTHER',
      'intent__order__new__quote_request': 'QUOTE',
};

// Tags that mean "no customer request here at all". These end the conversation
// before any topic is considered: 411 tickets on this instance carry one.
const NEVER_ANSWER = [
      'intent__misc__unsolicited__partnership',
      'intent__misc__unsolicited__marketing_or_newsletter',
      'intent__misc__unsolicited__spam',
      'intent__misc__unsolicited__event_invitation',
      'intent__misc__job_application__new',
];

// Alpy's own vocabulary. Order matters: the first match wins, so the most
// specific patterns come first.
const KEYWORDS = [
      { topic: 'DEPOT_SWITCH', re: /\b(d[eé]p[oô]t|consigne|overnight storage|locker|garde\s+du\s+mat[eé]riel|store\s+(my|the)\s+(skis|equipment)|laisser\s+(les|mes)\s+skis)\b/i },
      { topic: 'DEPOT_SWITCH', re: /\b(modelchange|model\s+change|changement\s+d.?[eé]quipement|switch\s+(my|the|from)?\s?(skis?|snowboard)|[eé]changer\s+(les|mes)\s+skis|swap\s+(my|the)\s+(skis?|snowboard))\b/i },
      { topic: 'VOUCHER_RESEND', re: /\b(voucher|bon\s+de\s+r[eé]servation|renvoyer\s+le\s+voucher|resend\s+(the\s+)?voucher|confirmation\s+email\s+again)\b/i },
      // The rental has started and something went wrong with the person, not
      // with the booking. This sits ABOVE CANCELLATION on purpose: "I want to
      // cancel, I broke my leg" is not a cancellation we can process, it is a
      // 100% case that needs two documents and a human decision, and routing it
      // to the cancellation handler would offer the customer a fee table that
      // does not apply to them.
      //
      // Both halves are required. An injury word alone matches "what does
      // Alpinsafety cover in case of an accident?", which is a pre-booking
      // question and must not land here; a cancel or refund word alone is an
      // ordinary cancellation. Only the two together mean what this route means.
      { topic: 'CANCELLATION_AFTER',
        re: /(?=[\s\S]*\b(injur\w*|blessur\w*|bless[ée]\w*|accident\w*|malad\w*|sick|illness|ill\b|krank\w*|verletz\w*|unfall\w*|broke\s+(?:my|his|her)\s+\w+|cass[ée]\s+(?:ma|mon|sa)\s+\w+|medical\s+certificate|certificat\s+m[eé]dical|arztlich\w*))(?=[\s\S]*\b(cancel\w*|annul\w*|refund\w*|rembours\w*|storno\w*|stornier\w*|r[uü]ckerstattung\w*|remaining\s+days?|jours?\s+restants?|returned?\s+(?:it\s+|them\s+|the\s+equipment\s+)?early|rendu\s+(?:le\s+)?mat[eé]riel|rentr[ée]s?\s+plus\s+t[oô]t|unused\s+days?|jours?\s+(?:non\s+)?utilis[eé]s?))/i },
      // The article is optional on purpose. "Cancel booking BT4WSA" is the way
      // customers actually write it, and requiring "my" or "the" meant the
      // keyword layer missed it and the whole decision fell to the model.
      { topic: 'CANCELLATION',  re: /\b(cancel(?:l?ing|lation)?\s+(?:of\s+)?(?:my|the|our|this)?\s*(booking|reservation|order|rental)|annul(?:er|ation)\s+(?:de\s+)?(?:ma|la|notre|cette)?\s*r[eé]servation|storno)\b/i },
      { topic: 'DATE_CHANGE',   re: /\b(change\s+(my|the)\s+dates?|move\s+(my|the)\s+booking|postpone|d[eé]caler|changer\s+(mes|les)\s+dates?|different\s+dates?)\b/i },
      // REQUOTE is re-pricing a booking that already exists, so it sits AFTER
      // DATE_CHANGE: a customer moving their dates wants the date-change flow,
      // not a new price. What lands here is adding days, adding people or
      // adding equipment - the cases where the basket changes and the total has
      // to be recalculated.
      //
      // No reference is required to match. ROUTES.REQUOTE demands booking_ref
      // before the flow may run, so a customer who asks without one is asked
      // for it instead of being handed over - which is the behaviour we want.
      { topic: 'REQUOTE',       re: /\b(add\s+(?:\d+\s+)?(?:more\s+)?(?:days?|nights?)|extend\s+(?:my|the|our)\s+(?:booking|reservation|rental|stay)|prolonger\s+(?:ma|la|notre)\s+(?:r[eé]servation|location)|ajouter\s+(?:\d+\s+)?(?:jours?|nuits?)|add\s+(?:a\s+|an\s+|the\s+|another\s+|\d+\s+)?(?:helmets?|boots?|skis?|snowboards?|person|people|adults?|child(?:ren)?)\s+to\s+(?:my|the|our)\s+(?:booking|reservation|rental)|re-?quote|nouveau\s+devis)\b/i },
      // ABOVE 'QUOTE' deliberately: "combien coute Alpinguaranty ?" contains
      // the quote trigger word, but naming a protection makes it a question
      // about a product, not a request for a price on a rental.
      // Two shapes a single word list cannot catch: a question about what a
      // protection covers, and the day-before pick-up, where the words are
      // always separated by whatever the customer is collecting.
      { topic: 'GENERAL_QUESTION',
        re: /\b(alpinflexi|snowflexi|alpinguaranty|alpinsafety(\s+plus)?)\b[\s\S]{0,60}\b(cover\w*|include\w*|couvre|comprend|inclut|what\s+is|c.est\s+quoi|price|prix|co[uû]te|cost)\b|\b(cover\w*|couvre|price|prix|co[uû]te|cost|what\s+is)\b[\s\S]{0,60}\b(alpinflexi|snowflexi|alpinguaranty|alpinsafety(\s+plus)?)\b/i },
      { topic: 'QUOTE',         re: /\b(quote|devis|how\s+much\s+would|combien\s+co[uû]te|price\s+for\s+\d|offre\s+de\s+prix)\b/i },
      // LAST, always. Everything above is a request that changes something; what
      // is left is a question, and a question has an answer written down.
      //
      // These patterns are the ones the training set shows over and over. They
      // are deliberately narrow - a wrong match here sends a real request to a
      // flow that only knows how to talk, which is the one failure mode that
      // matters. When none of them matches, the topic stays OTHER and a human
      // gets the ticket, exactly as today.
      { topic: 'GENERAL_QUESTION',
        re: /\b(invoice|facture|rechnung|receipt\s+for\s+(?:my|the)\s+(?:booking|rental)|ski\s+poles?|b[aâ]tons?\s+de\s+ski|poles?\s+(?:are\s+)?included|american\s+express|amex|payment\s+methods?|moyens?\s+de\s+paiement|zahlungsarten|child(?:ren)?\s+for\s+free|enfant\s+gratuit|kind\s+gratis|opening\s+hours|horaires?\s+d.ouverture|[oö]ffnungszeiten|what\s+is\s+included|qu.est[- ]ce\s+qui\s+est\s+inclus|own\s+(?:ski\s+)?boots|mes\s+propres\s+chaussures|specific\s+model|mod[eè]le\s+(?:pr[eé]cis|particulier)|add\s+(?:the\s+)?(?:insurance|protection|alpinflexi|snowflexi|alpinguaranty|alpinsafety)|ajouter\s+(?:l.)?(?:assurance|protection)|ski\s+(?:lessons?|school)|cours\s+de\s+ski|skikurs|rent\s+(?:ski\s+)?clothing|location\s+de\s+v[eê]tements|lift\s+pass|forfait\s+de\s+ski|skipass|priority\s+check.?in|modelchange\s+option)\b/i },
      { topic: 'GENERAL_QUESTION',
        re: /\b(pick\s*.?up|collect|r[eé]cup[eé]rer|abhol\w*)\b[\s\S]{0,40}\b(day\s+before|evening\s+before|la\s+veille|vortag|tag\s+davor)\b/i },
      { topic: 'GENERAL_QUESTION',
        re: /\b(helmets?|casques?|helm\w*)\b[\s\S]{0,40}\b(compulsory|mandatory|obligatoire|obligatorisch|pflicht|required\s+by\s+law)\b|\bhelmpflicht\b/i },
      { topic: 'GENERAL_QUESTION',
        re: /\b(promo(?:tion)?\s+code|code\s+promo|gutschein\s?code|discount\s+code)\b[\s\S]{0,40}\b(does\s+not|doesn.t|not\s+work\w*|invalid|refus\w*|ne\s+(?:fonctionne|marche)\s+pas|funktioniert\s+nicht)\b/i },
      // Delivery, and how the shop types differ.
      //
      // Added once the answer book learned to answer them. Before that these
      // landed as "no capability" and a human wrote the same paragraph again:
      // the router has to know a question is answerable, or the answer might as
      // well not exist. The delivery words are paired with an equipment or
      // accommodation word on purpose - "livraison" alone also means the parcel
      // a shop is waiting for, and that is not this.
      { topic: 'GENERAL_QUESTION',
        re: /\b(deliver\w*|livr\w*|liefer\w*|zustell\w*|drop.?off|d[eé]pose\w*)\b[\s\S]{0,60}\b(accommodation|apartment|appartement|apart\w*|hotel|h[oô]tel|chalet|residence|r[eé]sidence|unterkunft|ferienwohnung|lodging|equipment|mat[eé]riel|skis?|ski\s+set|ausr[uü]stung)\b|\b(accommodation|apartment|appartement|hotel|h[oô]tel|chalet|unterkunft)\b[\s\S]{0,60}\b(deliver\w*|livr\w*|liefer\w*)\b/i },
      { topic: 'GENERAL_QUESTION',
        re: /\b(top.?shop|best\s+offer|virtual\s+shop|magasin\s+virtuel)\b|\b(difference|diff[eé]rence|unterschied)\b[\s\S]{0,50}\b(shops?|magasins?|gesch[aä]ft\w*|l[aä]den)\b/i },
];

/**
 * Layer 0 - who is writing.
 *
 * Added after this file was first tested: on the 581628 fixture (a colleague
 * forwarding "WG: Verleihpreise FW 26/27") the tag layer was silent, the
 * keyword layer was silent, and the model's guess of DATE_CHANGE was trusted -
 * so the endpoint would have had a flow ask a Sales rep for their booking
 * reference. Exactly the bug it exists to prevent.
 *
 * The reliable discriminator is not the subject, it is the sender: internal and
 * partner mail carries its own signature in the body. No topic, no matter how
 * confident, survives this check - a colleague sending a price list is not a
 * customer request, whatever it looks like.
 */
/**
 * Our own domains. Matched against WHO SENT the message, never against what the
 * message contains.
 *
 * This distinction cost us ticket 581697. The markers below used to be tested
 * against the body, and the body of every reply to one of our emails quotes our
 * own footer - "bd@alpy.com", "Powered by 2beGROUP". So a customer answering
 * "please cancel my booking" was read as internal mail, the endpoint returned
 * STOP, and the gatekeeper stayed silent instead of asking for the booking
 * reference. The customer got nothing.
 *
 * The rule that survives: a sender is internal because of their address, not
 * because our address appears somewhere in their email.
 */
const INTERNAL_DOMAINS = [
      /@alpy\.com\s*$/i,
      /@2begroup/i,
      /@alpinresorts/i,
      /@skirent-booking/i,
];

/**
 * Body markers that a quoted signature can NOT produce.
 *
 * "WG:" and "TR:" are forward prefixes: they belong to the very start of a
 * subject line, so they are anchored. Anything found deeper in the text is a
 * quotation of an older message and proves nothing about this sender.
 */
const FORWARD_PREFIX = /^\s*(WG|TR|FW|FWD)\s*:/i;

function detectInternalSender(message, senderEmail, subject) {
      const from = String(senderEmail || '').trim();
      if (from && INTERNAL_DOMAINS.some(re => re.test(from))) {
              return { topic: 'OTHER', source: 'internal_sender', blocked: true };
      }

      // The subject carries the forward prefix far more often than the body.
      //
      // Found on 581757: a partner shop forwarded "FW: Alpy.com: Neue Buchung
      // eingegangen!" and wrote "bitte buchungen stoppen" underneath. The body's
      // first line was "Hallo", so this check passed it through, the flow read a
      // cancellation, and we replied to the SHOP offering to cancel a CUSTOMER's
      // booking by name. The booking was not theirs to cancel.
      //
      // The subject is the one place a forward always announces itself.
      if (FORWARD_PREFIX.test(String(subject || ''))) {
              return { topic: 'OTHER', source: 'forwarded_mail', blocked: true };
      }

      // Only the first line of the body is eligible - a forward prefix lives
      // there or nowhere. Scanning the whole body would match every quoted thread.
      const firstLine = String(message || '').split(/\r?\n/).find(l => l.trim() !== '') || '';
      if (FORWARD_PREFIX.test(firstLine)) {
              return { topic: 'OTHER', source: 'forwarded_mail', blocked: true };
      }

      // A company writing to us about the season, not a customer writing about a trip.
      //
      // Same ticket: a legal-entity signature (GmbH, UID, FN) with a message about
      // stopping bookings and agreeing conditions before the season. That is a
      // partner negotiating commercial terms. No flow should answer it, and the
      // cancellation flow least of all - "stop the bookings" is not "cancel mine".
      const body = String(message || '');
      const hasCompanySignature =
              /\b(gmbh|s\.?r\.?o\.?|s\.?a\.?r\.?l\.?|ltd\b|b\.?v\.?|a\.?g\b|UID\s*[A-Z]{2}|FN\s*\d{4,}|VAT\s*(?:no|number|ID))/i.test(body);
      const talksBusiness =
              /\b(buchungen\s+stoppen|stop\s+(?:all\s+)?bookings|arr[eê]ter\s+les\s+r[eé]servations|konditionen|conditions?\s+for\s+(?:the\s+)?(?:next\s+)?season|vor\s+der\s+saison|preise\s+(?:bekannt|festgelegt)|tarifs?\s+(?:de\s+la\s+)?saison|commission|vertrag|contract)\b/i.test(body);
      if (hasCompanySignature && talksBusiness) {
              return { topic: 'OTHER', source: 'partner_business', blocked: true };
      }

      return null;
}

function detectFromTags(tags) {
      const list = Array.isArray(tags) ? tags : String(tags || '').split(/[,\s]+/);
      const clean = list.map(t => String(t || '').trim()).filter(Boolean);
      if (clean.some(t => NEVER_ANSWER.includes(t))) {
              return { topic: 'OTHER', source: 'native_tag_never_answer', blocked: true };
      }
      for (const t of clean) {
              if (TAG_TO_TOPIC[t]) return { topic: TAG_TO_TOPIC[t], source: 'native_tag', blocked: false };
      }
      return null;
}

function detectFromKeywords(message) {
      const m = String(message || '');
      if (m.trim().length < 3) return null;
      for (const k of KEYWORDS) {
              if (k.re.test(m)) return { topic: k.topic, source: 'keyword', blocked: false };
      }
      return null;
}

/**
 * Slots the message states outright.
 *
 * Caught on the first live call: "I want to cancel my booking B1AF9J" came back
 * as ASK / missing booking_ref, because slot values only ever came from the
 * caller's model. The flow would have asked the customer for the reference they
 * had just written. That is the same insult as asking someone to resend their
 * own message, and it is worse than not asking at all.
 *
 * Deliberately narrow: only patterns that cannot be mistaken for prose. A
 * booking reference is 6 alphanumerics with at least one digit, which excludes
 * ordinary words; dates are ISO only. Anything looser belongs to the model, and
 * the model's values still go through looksValid.
 */
function extractFromMessage(message) {
      const m = String(message || '');
      const found = {};

      // Odin references are 6 chars, upper case, and always carry a digit.
      // Requiring the digit keeps "PLEASE" and "CANCEL" out.
      // The real format, measured on 100 live Odin bookings (24/08/2026):
      // every one is exactly six characters, every one starts with B, and the
      // alphabet is 123456789ABCDEFGHJKLMNPQRSTUVWXYZ - no zero, no I, no O.
      // Someone chose an alphabet without look-alike characters.
      //
      // 26 of those 100 contain no digit at all. The old rule required one, so
      // it was blind to a quarter of all bookings - including BTRNLK, which is
      // why Alice's list of five looked like four on ticket 581695.
      //
      // Matching is case-SENSITIVE on purpose. Customers copy the reference out
      // of their confirmation email, so it arrives upper case; folding the whole
      // message to upper case first is what would turn the word "basket" into a
      // booking.
      const REF = /\bB[123456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}\b/g;
      // Six-letter upper-case words that happen to fit the alphabet. Rare in a
      // real message, free to exclude.
      const NOT_A_REF = ['BASKET','BUDGET','BEAUTY','BRANCH','BREATH','BREADS','BEHALF',
                         'BUCKET','BUNDLE','BRAKES','BLANKS','BEARER','BLAZER','BADGES'];
      const refs = [...new Set(m.match(REF) || [])].filter(t => !NOT_A_REF.includes(t));
      if (refs.length === 1) found.booking_ref = refs[0];
      // Several references is not "no reference".
      //
      // The old rule kept nothing unless exactly one matched, and on ticket
      // 581695 that turned a clear customer into a loop: Alice sent five
      // references and was asked for "your booking reference" three times, each
      // time answering with the same five. Silence read as absence, and the flow
      // asked again.
      //
      // Five bookings is not something a one-booking flow can do. Carrying the
      // list lets the handler say so and hand over, which is the honest answer.
      if (refs.length > 1) found._booking_refs = refs.join(', ');

      // Two ISO dates in order are a period. One alone is ambiguous - it could be
      // a start or an end - so we take nothing.
      const dates = m.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
      if (dates.length >= 2) {
              const sorted = dates.slice(0, 2).sort();
              found.start_date = sorted[0];
              found.end_date = sorted[1];
      }

      return found;
}

function normaliseTopic(t) {
      const up = String(t || '').trim().toUpperCase();
      return TOPICS.includes(up) ? up : null;
}

/**
 * Slot values the caller extracted, kept only when they look like the thing
 * they claim to be. A model that returns "next week" for start_date is not
 * giving us a date, and letting it through is how a flow ends up writing a
 * booking to Odin for the wrong period.
 */
/**
 * Slots arrive in three shapes, and all three have to work.
 *
 * A Zendesk custom action builds its body with
 * evaluate_handlebar_expression_for_json_body, so a value that is itself JSON
 * either gets escaped or breaks the body outright - and which one it does is not
 * something to find out in production. So the flow sends the slots as plain
 * "key=value;key=value", which carries no quotes and no braces and therefore
 * cannot break anything. A JSON string and a real object are accepted too, for
 * callers that are not a Zendesk flow.
 */
function parseSlotBag(raw) {
      if (!raw) return {};
      if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
      const s = String(raw).trim();
      if (!s) return {};
      // The JSON does not have to be the whole string.
      //
      // This used to require s to START with "{", and a detector that answered
      // ```json\n{...}\n``` - or prefixed one polite sentence - fell through to
      // the key=value parser, matched nothing, and returned {}. Every slot then
      // read as missing, the flow's gate closed, and the ticket went silent with
      // no error anywhere: the model had extracted everything correctly and we
      // threw it away over a code fence.
      //
      // So take the first balanced object found anywhere in the string. A prompt
      // saying "no code fences" is a request, not a guarantee.
      const first = s.indexOf('{');
      const last = s.lastIndexOf('}');
      if (first !== -1 && last > first) {
              const slice = s.slice(first, last + 1);
              try { const o = JSON.parse(slice); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch { /* fall through */ }
      }
      const out = {};
      for (const pair of s.split(';')) {
              const i = pair.indexOf('=');
              if (i <= 0) continue;
              out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      }
      return out;
}

/**
 * Each capability flow names the same thing differently.
 *
 * Quote Generator's classifier emits preferred_resort_town, rental_start_date,
 * rental_end_date; the gatekeeper emits resort_name, start_date, end_date. Both
 * describe a resort and two dates. Rather than force every flow to be rewritten
 * to speak _slots.js, or worse, to add a translating custom-code step in front
 * of every call, the translation lives here - once.
 *
 * This is what lets a flow hand over its detector's raw JSON blob untouched:
 * Quote Generator already passes {{content}} straight to generate-quote, and it
 * can now pass the same blob to /api/intent.
 *
 * Aliases never win over the canonical name. A payload carrying both keeps the
 * canonical one, so adding a dialect can not change the meaning of a request
 * that was already correct.
 */
const SLOT_ALIASES = {
      resort_name:     ['preferred_resort_town', 'resort', 'resort_town', 'town'],
      shop_name:       ['shop', 'preferred_shop'],
      // new_start / new_end are Date Change's own names: its detector reports
      // the dates the customer wants to move TO, which is exactly what the
      // capability needs before it may run.
      start_date:      ['rental_start_date', 'startDate', 'start', 'new_start'],
      end_date:        ['rental_end_date', 'endDate', 'end', 'new_end'],
      booking_ref:     ['booking_reference', 'bookingReference', 'reference'],
      adults:          ['adult_count', 'nb_adults'],
      children_ages:   ['children', 'child_ages', 'kids_ages'],
      equipment_level: ['equipment', 'level', 'skill'],
      boots:           ['with_boots'],
      helmets:         ['helmet', 'with_helmets'],
      insurance:       ['protection', 'with_insurance', 'guaranty'],
};

function readSlot(src, name) {
      const candidates = [name].concat(SLOT_ALIASES[name] || []);
      for (const key of candidates) {
              const v = src[key];
              if (v === undefined || v === null) continue;
              const s = String(v).trim();
              if (s) return s;
      }
      return '';
}

function cleanSlots(raw) {
      const out = {};
      const src = parseSlotBag(raw);
      for (const name of Object.keys(SLOTS)) {
              const s = readSlot(src, name);
              if (!s) continue;
              out[name] = (name === 'booking_ref') ? s.toUpperCase() : s;
      }
      return out;
}

/**
 * The ticket is the memory.
 *
 * A flow sees one comment. That is why ticket 581704 asked Alice's colleague for
 * dates he had already narrowed down, and why on 581695 five booking references
 * were requested three times: each run started from nothing.
 *
 * Two ways to fix it were on the table. Writing what we learn into ticket fields
 * or an internal note gives a store that can silently disagree with what the
 * customer actually wrote - an agent clears a field, and the quote is built on a
 * memory of a conversation rather than the conversation. Reading the thread has
 * no such gap: the customer's own words are the store, and they cannot drift.
 *
 * Needs ZENDESK_SUBDOMAIN, ZENDESK_EMAIL and ZENDESK_API_TOKEN. With any of them
 * missing this returns null and everything behaves exactly as before - one
 * message, no history. Degrading to the old behaviour is the right failure: a
 * flow that stops working because a token expired would be worse than a flow
 * that briefly forgets.
 */
// Accept every shape of the same answer: "skisupport", "skisupport.zendesk.com",
// or the full "https://skisupport.zendesk.com/". Asking a human to remember which
// third of a URL a field wants is a trap, and it cost us one deploy: the value
// with the domain attached built skisupport.zendesk.com.zendesk.com, which does
// not resolve, and the failure surfaced only as "fetch failed".
const ZD_SUB = String(process.env.ZENDESK_SUBDOMAIN || '')
  .trim()
  .replace(/^https?:\/\//i, '')
  .replace(/\/.*$/, '')
  .replace(/\.zendesk\.com$/i, '');
const ZD_EMAIL = String(process.env.ZENDESK_EMAIL || '').trim();
const ZD_TOKEN = String(process.env.ZENDESK_API_TOKEN || '').trim();

function zdAuth() {
      if (!ZD_SUB || !ZD_EMAIL || !ZD_TOKEN) return null;
      return 'Basic ' + Buffer.from(ZD_EMAIL + '/token:' + ZD_TOKEN).toString('base64');
}

/**
 * Everything the customer has written on this ticket, oldest first.
 *
 * Our own replies are dropped on purpose. They quote the customer, they carry
 * our footer, and they contain the very questions we are trying to decide
 * whether to repeat - feeding them back in is how a bot ends up reading its own
 * words as evidence.
 */
/**
 * What the customer booked LAST TIME, read straight from Odin.
 *
 * "The same as last year" and "same specification as before" are among the most
 * common things a returning customer writes, and until now we answered them by
 * asking the questions the customer had just told us not to ask. On 581788 that
 * produced a question about children who do not exist - the previous booking was
 * two adults - and the customer had to explain themselves twice.
 *
 * Vercel CAN reach this route. The IP block that stops us calling Odin applies
 * to /webhook/*; GET /api/v2/booking/{ref} is public and requote-booking.js has
 * been calling it from Vercel for weeks. So the history lookup belongs here,
 * where every flow gets it for free, and not as a step in one flow.
 *
 * Returns a short prose summary, or '' - never throws, never blocks. A slow or
 * absent Odin costs us the history and nothing else, so the timeout is short and
 * every failure degrades to exactly the behaviour we had before.
 */
/**
 * "The same as last time."
 *
 * Detected on the customer's own words, never inferred. It is the one phrase
 * that licenses us to carry a previous booking's CHOICES into a new quote -
 * resort, discipline, level, who needs boots - because the customer has just
 * told us to. Dates are never carried: nobody means "the same week last year".
 *
 * Deliberately narrow. A customer who writes "I booked with you last year" is
 * giving context, not an instruction, and gets no prefill.
 */
const SAME_AS_BEFORE = new RegExp(
      '(same|identical|as)\\s+(as\\s+)?(last|previous|before|last\\s+year|last\\s+time)' +
      '|same\\s+(spec|specification|equipment|setup|kit|as\\s+before)' +
      '|(comme|identique\\s+a)\\s+(l.?an\\s+dernier|la\\s+derniere\\s+fois|avant|precedemment)' +
      '|meme\\s+(chose|equipement|materiel|configuration)\\s+(qu|que)' +
      '|(wie|dasselbe)\\s+(letztes\\s+jahr|beim\\s+letzten\\s+mal)',
      'i');

function saysSameAsBefore(text) {
      const t = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return SAME_AS_BEFORE.test(t);
}

const ODIN_BASE = 'https://odin.alpy.com';

async function fetchBookingHistory(ref) {
      const code = String(ref || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{4,12}$/.test(code)) return '';

      let booking = null;
      try {
              const ctrl = new AbortController();
              const t = setTimeout(() => ctrl.abort(), 4000);
              const r = await fetch(ODIN_BASE + '/api/v2/booking/' + encodeURIComponent(code),
                                    { headers: { Accept: 'application/json' }, signal: ctrl.signal });
              clearTimeout(t);
              if (!r.ok) return '';
              booking = await r.json();
      } catch { return ''; }
      if (!booking || typeof booking !== 'object') return '';

      const day = v => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || '')); return m ? m[1] : ''; };
      const from = day(booking.rentalPeriod && booking.rentalPeriod.from);
      const to   = day(booking.rentalPeriod && booking.rentalPeriod.to);

      // Age and equipment per person, plus who had boots and who had a helmet.
      // This is the part that answers "the same as before": it is the shape of
      // the group, not the price, that the customer is referring to.
      const people = [];
      let boots = 0, helmets = 0;
      for (const item of (booking.equipment || [])) {
              const age  = (item.personalInfo && parseInt(item.personalInfo.age, 10)) || null;
              const name = String(item.name || '').trim();
              const kind = /snowboard|board/i.test(name) ? 'snowboard' : 'ski';
              people.push((age ? age + 'yr' : 'adult') + ' ' + kind + (name ? ' (' + name + ')' : ''));
              for (const a of (item.accessories || [])) {
                        const an = String(a.name || '').toLowerCase();
                        if (a.definitionId === 1 || an.indexOf('boot') > -1) boots++;
                        if (a.definitionId === 2 || an.indexOf('helmet') > -1 || an.indexOf('casque') > -1) helmets++;
              }
      }
      if (!people.length) return '';

      const shop = (booking.shop && (booking.shop.name || booking.shop.town)) || '';
      const town = (booking.shop && booking.shop.town) || '';

      const bits = [];
      bits.push('Booking ' + code + ':');
      if (town) bits.push(' resort ' + town + (shop && shop !== town ? ' (' + shop + ')' : '') + ';');
      if (from && to) bits.push(' ' + from + ' to ' + to + ';');
      bits.push(' ' + people.length + ' person(s) - ' + people.join(', ') + ';');
      bits.push(' boots for ' + boots + ', helmets for ' + helmets + '.');
      return bits.join('');
}

async function fetchCustomerThread(ticketId) {
      // Why the memory is off is operational information, not debug output. A
      // silent null was enough to spend an afternoon guessing between "no token",
      // "wrong subdomain" and "the flow never sent a ticket id" - so the reason
      // travels back with the answer.
      const auth = zdAuth();
      if (!auth) {
              const missing = [
                        !ZD_SUB && 'ZENDESK_SUBDOMAIN',
                        !ZD_EMAIL && 'ZENDESK_EMAIL',
                        !ZD_TOKEN && 'ZENDESK_API_TOKEN',
              ].filter(Boolean);
              return { turns: [], count: 0, status: 'missing_env:' + missing.join(',') };
      }
      if (!ticketId) return { turns: [], count: 0, status: 'no_ticket_id' };

      try {
              const base = 'https://' + ZD_SUB + '.zendesk.com/api/v2/tickets/' + encodeURIComponent(ticketId);
              const headers = { Authorization: auth, Accept: 'application/json' };
              const [tRes, cRes] = await Promise.all([
                        fetch(base + '.json', { headers }),
                        fetch(base + '/comments.json?sort_order=asc', { headers }),
              ]);
              if (!tRes.ok || !cRes.ok) {
                        return { turns: [], count: 0, status: 'http_' + tRes.status + '_' + cRes.status };
              }

              const ticket = (await tRes.json()).ticket || {};
              const comments = (await cRes.json()).comments || [];
              const requester = ticket.requester_id;

              const mine = comments
                .filter(c => c && c.author_id === requester)
                .map(c => stripQuotedAndSignature(String(c.plain_body || c.body || '')))
                .filter(Boolean);

              // Has a human colleague already answered this customer in public?
              //
              // On 581718 an agent had done the whole job, the customer wrote
              // "Thanks a lot", and the automation answered that thank-you by
              // asking for a booking reference that had been on the ticket from
              // the first message. The customer had to be apologised to.
              //
              // So: once a person has replied in public, the automation is out.
              // Not "more careful" - out. A colleague who takes a ticket owns the
              // conversation, and a machine that talks over them costs more
              // credibility than it can ever earn back by being occasionally
              // right.
              //
              // Everyone who is not the requester and not us counts as that
              // person, minus the people Zendesk lets watch a ticket without
              // owning it - CCs, followers, collaborators - who would otherwise
              // read as agents. Our own comments are authored by Zendesk's
              // system user, whose id is negative.
              const watching = new Set([]
                        .concat(ticket.collaborator_ids || [])
                        .concat(ticket.follower_ids || [])
                        .concat(ticket.email_cc_ids || [])
                        .map(Number));
              const humanReply = comments.find(c => c && c.public &&
                        Number(c.author_id) > 0 &&
                        Number(c.author_id) !== Number(requester) &&
                        !watching.has(Number(c.author_id)));

              // The subject line is the customer's words too, and we were throwing
              // it away.
              //
              // Observed on 581658: the customer put "Val Thorens" in the subject
              // and wrote only "arriving in Val" in the body. We read the body,
              // saw "Val", and quoted a shop in Valmalenco, Italy. The one place
              // where the resort was written in full was the one place we never
              // looked.
              //
              // It is read as the OLDEST source, below every comment: a subject is
              // written once, at the start, and never updated, so anything the
              // customer says later must win. It is shown to the detectors at the
              // head of the transcript, where the resort is extracted. And it is
              // deliberately NOT a turn - it does not count towards turns_read or
              // the repeat-ask guard, because nobody "said" it twice.
              const subject = String(ticket.subject || '')
                .replace(/^\s*(re|fw|fwd|tr|aw|wg)\s*:\s*/gi, '')
                .trim();

              // The booking reference the "Last booking by email" flow found for us.
              //
              // That flow runs on ticket creation, searches Odin on the
              // requester's email and posts ONE internal note naming their most
              // recent booking. The note is authored by our system user, so the
              // requester-only filter above skips it - and the whole point of
              // finding the reference is lost the moment a customer writes "I
              // lost my voucher" without quoting a code.
              //
              // We read it back here, and it is a FALLBACK only: see
              // REF_FROM_HISTORY_IS_SAFE_FOR below for the topics allowed to act
              // on a reference the customer never typed.
              let knownRef = '';
              for (const c of comments) {
                        const body = String((c && (c.plain_body || c.body)) || '');
                        if (body.indexOf('SKIBOT - this customer has booked with us before') === -1) continue;
                        const m = body.match(/Most recent booking reference:\s*([A-Z0-9]{4,12})/);
                        if (m) knownRef = m[1];
              }

              return { turns: mine, text: mine.join('\n\n'), count: mine.length,
                       subject, knownRef,
                       agentReplied: !!humanReply,
                       agentRepliedAt: humanReply ? humanReply.created_at : null,
                       status: 'ok:' + comments.length + '_comments' +
                               (humanReply ? '_agent_answered' : '') };
      } catch (e) {
              // Name the host we tried. It is not a secret, and it is the
              // difference between "the token is wrong" and "the URL is wrong".
              return { turns: [], count: 0,
                       status: 'error:' + String((e && e.message) || e).slice(0, 40) +
                               ' host=' + ZD_SUB + '.zendesk.com' };
      }
}

/**
 * Keep what the customer typed; drop the mail furniture underneath it.
 *
 * Their reply carries our whole previous message quoted below theirs, plus their
 * own signature. Left in, our footer's "bd@alpy.com" once made a customer look
 * like a colleague, and our own question about children's ages could be mistaken
 * for their answer.
 */
function stripQuotedAndSignature(body) {
      let t = body.replace(/\r/g, '');
      const cuts = [
              /^\s*-{2,}\s*$/m,                       // -- signature delimiter
              /^\s*_{5,}\s*$/m,
              /^\s*>/m,                               // quoted block
              /^\s*(On|Le|Am|El)\b.{0,80}\b(wrote|a [eé]crit|schrieb|escribi[oó])\s*:/mi,
              /^\s*(De|From|Von|Da)\s*:/mi,
              /The information transmitted in this e-?mail/i,
              /Powered\s*by\s*2beGROUP/i,
              /Head of Support/i,
      ];
      for (const re of cuts) {
              const m = t.match(re);
              if (m && m.index > 0) t = t.slice(0, m.index);
      }
      return t.trim();
}

/**
 * What we can answer without a human, and without inventing anything.
 *
 * Every line here is checked against the live catalogue or the shop data - the
 * 15% is the insurance addon's priceRelative on core.alpy.com, measured, not
 * remembered. When a customer asks something outside this list we say nothing
 * rather than improvise: a wrong answer about cover is worse than a slow one.
 */
const PRODUCT_ANSWERS = [
      {
              key: 'insurance',
              re: /\b(alpin\s*guaranty|alpinguaranty|guaranty|assurance|insurance|protection|casse\s*(et|&)?\s*vol|dommages?\s*(et|&)?\s*(le\s*)?vol|damage\s*(and|&)?\s*theft|versicherung|seguro|assicurazione)\b/i,
              fact: 'Damage & theft protection (sold as AlpinGuaranty) costs 15% of the rental price and covers breakage and theft of the equipment we rent out. It is optional, it is added per person, and it is never included unless the customer asks for it.',
      },
      {
              key: 'boots',
              re: /\b(boots?|chaussures?|schuhe|scarponi|botas)\b/i,
              fact: 'Boots are an optional extra, priced per person and per day. Anyone bringing their own does not pay for them.',
      },
      {
              key: 'helmets',
              re: /\b(helmets?|casques?|helm|casco|kask)\b/i,
              fact: 'Helmets are an optional extra, priced per person and per day. Nobody is obliged to take one.',
      },
      {
              key: 'children',
              re: /\b(child|children|kid|kids|enfant|enfants|kinder|ni[nñ]os|bambini)\b.{0,40}\b(price|pricing|cost|tarif|prix|preis|precio)\b|\b(price|pricing|tarif|prix)\b.{0,40}\b(child|children|enfant|kinder)\b/i,
              fact: 'Children are priced on their exact age, and the age bands differ from shop to shop. That is why a quote cannot be produced without every child\'s age.',
      },
];

/**
 * A question, not an answer.
 *
 * On 581704 the customer replied to our list of questions with "que couvre la
 * protection alpinguaranty ?" - and got silence, because the reply did not
 * contain the slots we wanted. A question deserves its answer even when it
 * arrives instead of the information we asked for.
 */
function buildTranscript(turns, subject, knownRef, history) {
      if (!turns || !turns.length) return '';
      const numbered = turns.map((t, i) => 'Customer, message ' + (i + 1) + ' of ' + turns.length + ':\n' + t);
      let out = numbered.join('\n\n');
      // The subject line, at the head, labelled for what it is.
      //
      // 581658: "Val Thorens" was in the subject and only "Val" in the body. The
      // detector never saw the subject, resolved "Val" on its own, and we quoted
      // Valmalenco - a different country. A customer who names the resort once,
      // in the title, has named it.
      //
      // It sits ABOVE the messages and outside the numbering: it is context, not
      // a turn, and a detector must not count it as something the customer said
      // twice.
      if (subject) out = 'Email subject: ' + subject + '\n\n' + out;

      // The reference we found on their email, labelled for exactly what it is.
      //
      // A detector reading this transcript must be able to use the code AND to
      // know the customer never typed it - those are different facts and a bare
      // reference in the text would collapse them into one. Hence the wording:
      // it says where the code came from, in the same breath as the code.
      // What they booked last time, above everything else: it is the answer to
      // "the same as before", and a detector that reads it can stop asking.
      if (history) {
              out = 'WHAT THIS CUSTOMER BOOKED LAST TIME (from our records, not ' +
                    'stated by them now): ' + history + '\nUse it to understand ' +
                    '"the same as before". Never reuse the dates - those are always new.\n\n' + out;
      }

      if (knownRef) {
              out = 'Known from our records (NOT stated by the customer): this ' +
                    'customer\'s most recent booking with us is ' + knownRef +
                    '. Use it only where acting on the wrong booking would be ' +
                    'harmless.\n\n' + out;
      }
      if (out.length > 8000) out = '[…earlier messages omitted…]\n\n' + out.slice(out.length - 8000);
      // The date travels INSIDE the transcript, not beside it.
      //
      // `today` is returned as its own field too, but a detector prompt can only
      // reference a field the Zendesk custom action declares in its response
      // schema - and that schema was captured before `today` existed. Every
      // prompt pointing at it showed "Variable is no longer available", which
      // made the step invalid, which made the whole flow refuse to save. The
      // schema still lists only action, agentnote, answers, missinglabels,
      // next_question, run_topic, topic and transcript.
      //
      // So the date rides on `transcript`, a leaf that has always been declared.
      // Every detector gets it with no schema surgery and no per-flow wiring.
      return 'Today is ' + new Date().toISOString().slice(0, 10) +
             '. Resolve every relative or year-less date against it, and never ' +
             'output a date in the past.\n\n' + out;
}

/**
 * Is this message nothing but a thank-you or a goodbye?
 *
 * A closing courtesy is not a request. It carries no topic, no slot and no
 * question - answering it can only produce noise, and on 581718 it produced an
 * apology.
 *
 * Deliberately strict: the message must be SHORT and contain nothing but
 * pleasantries. "Thanks, and could you also move the dates?" is a request and
 * must fall through to the normal path. When in doubt this returns false, which
 * costs a handover at worst - the safe direction.
 */
const GRATITUDE_ONLY = new RegExp(
      '^(?:' +
      'thanks?(?:\\s+(?:a\\s+lot|very\\s+much|so\\s+much|again))?|thank\\s+you(?:\\s+very\\s+much)?|' +
      'many\\s+thanks|much\\s+appreciated|appreciate\\s+it|' +
      'perfect|great|super|excellent|brilliant|lovely|noted|understood|ok(?:ay)?|received|' +
      'merci(?:\\s+(?:beaucoup|bien|d\\W?avance))?|je\\s+vous\\s+remercie|parfait|tr[eè]s\\s+bien|' +
      'danke(?:\\s+(?:sch[oö]n|dir|ihnen|vielmals))?|vielen\\s+dank|besten\\s+dank|alles\\s+klar|' +
      'grazie|gracias|bedankt|tack|' +
      'best\\s+regards|kind\\s+regards|regards|cheers|bye|goodbye|have\\s+a\\s+nice\\s+day|' +
      'cordialement|bien\\s+[aà]\\s+vous|salutations|bonne\\s+journ[eé]e|' +
      'mit\\s+freundlichen\\s+gr[uü]ssen|freundliche\\s+gr[uü]sse|sch[oö]nen\\s+tag|' +
      'hi|hello|hey|dear\\s+\\w+|bonjour|hallo|guten\\s+tag' +
      ')$', 'i');

function isCourtesyOnly(message) {
      const body = stripQuotedAndSignature(String(message || ''));
      // A thank-you is short. Anything long enough to hide a request is treated
      // as one.
      if (!body || body.length > 240) return false;
      if (/\?/.test(body)) return false;

      // Split on anything that separates a courtesy from the next one, then
      // require every remaining fragment to be a courtesy.
      const parts = body
        .split(/[\n\r,;.!]+/)
        .map(p => p.replace(/^[\s"\u2018\u2019\u201c\u201d]+|[\s"\u2018\u2019\u201c\u201d]+$/g, ''))
        .filter(p => p.length > 0);
      if (!parts.length) return false;
      if (parts.every(p => GRATITUDE_ONLY.test(p))) return true;

      // A signature that survived the stripper is not a request. "Thanks a lot.
      // Regards, Yuriy Mykhaylyshchuk" is a thank-you, and it is the exact shape
      // 581718 arrived in.
      //
      // Only the LAST fragment may be a bare name, and only when everything
      // before it was courtesy - so "Please cancel Booking" cannot slip through
      // on capitalisation alone.
      const last = parts[parts.length - 1];
      const head = parts.slice(0, -1);
      const looksLikeAName = /^(?:[A-Z\u00C0-\u00DE][A-Za-z\u00C0-\u024F'\u2019-]*)(?:\s+[A-Z\u00C0-\u00DE][A-Za-z\u00C0-\u024F'\u2019-]*){0,3}$/.test(last);
      return head.length > 0 && looksLikeAName &&
             head.every(p => GRATITUDE_ONLY.test(p));
}

function detectProductQuestion(message) {
      const m = String(message || '');
      if (!/\?|\bque\s+couvre\b|\bwhat\s+(is|does|are)\b|\bqu(\'|e\s)est[- ]ce\b|\bwas\s+ist\b/i.test(m)) return [];
      return PRODUCT_ANSWERS.filter(a => a.re.test(m)).map(a => ({ topic: a.key, fact: a.fact }));
}

/**
 * You may not ask someone to buy something you have not described.
 *
 * The slot named "damage & theft protection" reached the composing prompt as
 * that label and nothing else, so the message that came out asked the customer
 * whether they wanted an option it had never explained - and, having no facts to
 * work with, the model filled the hole by promising that "another team" would
 * answer about it, then asked anyway. Deflection and interrogation in the same
 * paragraph.
 *
 * The label alone was never enough. Whenever we ask for one of these, the fact
 * that describes it travels with the question: what it is, what it costs, that
 * it is optional. The customer can then actually answer.
 *
 * children_ages carries its own reason for the same reason - "how old is each
 * child" with no explanation reads as bureaucracy rather than pricing.
 */
const SLOT_FACTS = {
      insurance:     'insurance',
      boots:         'boots',
      helmets:       'helmets',
      children_ages: 'children',
};

// A slot counts as stated when it carries any non-empty value, including an
// explicit refusal. "No one needs insurance" is an answer, not a gap.
function hasSlot(slots, name) {
      const v = slots && slots[name];
      return v !== undefined && v !== null && String(v).trim() !== '';
}

function factsForMissing(missing) {
      const out = [];
      for (const requirement of (missing || [])) {
              for (const name of String(requirement).split('|')) {
                        const key = SLOT_FACTS[name];
                        if (!key) continue;
                        const entry = PRODUCT_ANSWERS.find(a => a.key === key);
                        if (entry) out.push({ topic: entry.key, fact: entry.fact });
              }
      }
      return out;
}

// A fact the customer asked for and a fact we owe them because we are about to
// ask for the slot are the same sentence; saying it twice is worse than saying
// it once.
function mergeFacts(asked, owed) {
      const seen = new Set();
      const out = [];
      for (const f of asked.concat(owed)) {
              if (seen.has(f.topic)) continue;
              seen.add(f.topic);
              out.push(f);
      }
      return out;
}

export default async function handler(req, res) {
      Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
      if (req.method === 'OPTIONS') return res.status(200).end();

      let params = req.method === 'POST' ? (req.body || {}) : (req.query || {});
      if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = {}; } }
      if (!params || typeof params !== 'object' || Array.isArray(params)) params = {};

      const message = params.message ?? params.comment ?? '';
      const tags = params.tags ?? [];
      const llmTopic = normaliseTopic(params.llm_topic ?? params.llmtopic ?? params.topic);

      // Who wrote this. The flow passes the requester's email; when it is absent
      // we simply do not apply the internal-sender rule, rather than falling
      // back to scanning the body - that fallback is what silenced 581697.
      const senderEmail = params.sender_email ?? params.senderemail
                        ?? params.requester_email ?? params.requesteremail ?? '';

      // The topic this ticket was already waiting on, carried by the flow as an
      // awaiting__<topic> tag.
      //
      // Without it the second turn of every conversation collapses: we ask "what
      // is your booking reference", the customer replies "B1AF9J", and a message
      // of six characters matches no keyword and carries no topic - so the flow
      // that just asked the question forgets it ever did. The customer answered
      // exactly what was asked and lands on a human anyway.
      //
      // It ranks below the tag and keyword layers (a customer who was asked about
      // a cancellation may well change the subject) but above the model, because a
      // question we asked one message ago is better evidence than a guess.
      const pendingTopic = normaliseTopic(
              params.pending_topic ?? params.pendingtopic ??
              (function () {
                        const list = Array.isArray(tags) ? tags : String(tags || '').split(/[,\s]+/);
                        const hit = list.map(t => String(t || '').trim())
                          .find(t => /^awaiting__/.test(t));
                        return hit ? hit.replace(/^awaiting__/, '') : null;
              })()
      );
      // A quote we OFFERED is not a question we ASKED. Different tag, on purpose.
      //
      // General questions and Shop services both end by offering to prepare a
      // quote. When the customer replies "oui avec plaisir", that reply matches
      // no keyword and carries no topic, so without a marker it lands on OTHER
      // and a human reads a message that says yes to something we proposed.
      //
      // Reusing awaiting__quote would have routed it - and then tripped the
      // anti-loop rule below, which reads awaiting__ as "we already asked for
      // these details and they still are not here" and hands over. We never
      // asked. So the offer carries its own tag, it feeds the topic decision
      // exactly like a pending topic, and it is deliberately absent from
      // alreadyAsked: the first real question about the rental has yet to be
      // put, and putting it is the whole point.
      const offeredTopic = normaliseTopic(
              params.offered_topic ?? params.offeredtopic ??
              (function () {
                        const list = Array.isArray(tags) ? tags : String(tags || '').split(/[,\s]+/);
                        const hit = list.map(t => String(t || '').trim())
                          .find(t => /^offered__/.test(t));
                        return hit ? hit.replace(/^offered__/, '') : null;
              })()
      );
      // What the message says outright wins over what the model reported: the
      // customer's own words are the better source, and a model that paraphrases
      // a reference gets it wrong.
      const ticketId = params.ticket_id ?? params.ticketid ?? params.ticket ?? '';

      // The whole conversation, when we are allowed to read it.
      const thread = await fetchCustomerThread(ticketId);

      const fromMessage = extractFromMessage(message);

      // Oldest turn first, so a later correction wins over an earlier value:
      // "the 28th" then "actually the 29th" must end up as the 29th. cleanSlots
      // drops empty values, so a turn that says nothing about dates cannot erase
      // the dates an earlier turn gave.
      const fromThread = {};
      // The subject first, so any comment can overrule it. See fetchCustomerThread.
      if (thread.subject) {
              Object.assign(fromThread, cleanSlots(extractFromMessage(thread.subject)));
      }
      if (thread.turns.length) {
              for (const turn of thread.turns) Object.assign(fromThread, cleanSlots(extractFromMessage(turn)));
      }

      const slots = Object.assign(
              fromThread,
              cleanSlots(params.llm_slots ?? params.llmslots ?? params.slots ?? params),
              cleanSlots(fromMessage)
      );

      // Every reference the customer named, when they named more than one.
      const refsSeen = new Set();
      for (const src of [fromMessage].concat(thread.turns.map(extractFromMessage))) {
              String(src._booking_refs || '').split(',').map(x => x.trim()).filter(Boolean).forEach(r => refsSeen.add(r));
              if (src.booking_ref) refsSeen.add(src.booking_ref);
      }
      const multipleRefs = refsSeen.size > 1 ? [...refsSeen] : [];

      /**
       * A reference WE found is not a reference the customer GAVE.
       *
       * The email lookup is genuinely useful: a customer who writes "I've lost my
       * voucher" and nothing else can be served instead of being asked for a code
       * they do not have. But acting on a booking the customer never named is
       * only acceptable where being wrong is cheap and reversible.
       *
       *   VOUCHER_RESEND  - re-sends the confirmation to the address that owns
       *                     the booking. If we picked the wrong booking, the
       *                     customer receives their own other voucher. Harmless.
       *   REQUOTE         - produces an internal note for an agent. Nobody is
       *                     charged, nothing is written to Odin. Harmless.
       *
       * Everything else is deliberately excluded. CANCELLATION,
       * PARTIAL_CANCELLATION and DATE_CHANGE move money or destroy a booking, and
       * "we guessed which one you meant" is not a defence. Those still require
       * the customer to name the reference themselves - which is the rule
       * Benjamin set the first day: never cancel a booking on an assumption.
       */
      const REF_FROM_HISTORY_IS_SAFE_FOR = ['VOUCHER_RESEND', 'REQUOTE'];
      let refFromHistory = '';
      if (thread.knownRef && !slots.booking_ref) {
              refFromHistory = thread.knownRef;
      }

      // Layer 0 - internal or partner sender. Layer 1 - native tags.
      // Either one stops the whole thing, before any topic is considered.
      const fromTags = detectFromTags(tags);
      const blocked = detectInternalSender(message, senderEmail, thread.subject) || (fromTags && fromTags.blocked ? fromTags : null);
      if (blocked) {
              const note = blocked.source === 'internal_sender'
                ? 'This is internal or partner mail, not a customer request. Route it to the right team - no flow should answer it.'
                : blocked.source === 'forwarded_mail'
                ? 'This is a forwarded message, not a request written by the customer. A human should read it before any flow acts.'
                : 'Zendesk classified this as unsolicited mail or a job application. No flow should answer it.';
              return res.status(200).json({
                        topic: 'OTHER',
                        route: null,
                        source: blocked.source,
                        slots: {},
                        ready: false,
                        missing: [],
                        missingLabels: [],
                        missinglabels: [],
                        next_question: null,
                        nextquestion: null,
                        action: 'STOP',
                        agentNote: note,
                        agentnote: note,
              });
      }

      // Layer 1b - two reasons to say nothing at all.
      //
      // NOOP is not HANDOVER. HANDOVER means "a human must read this" and is
      // worth a note and a tag. NOOP means "there is nothing here to do, by
      // anyone" - and the right amount of output for that is none. A tag on
      // every thank-you would bury the tags that matter.
      const noop = thread.agentReplied
        ? { source: 'agent_answered',
            note: 'A colleague has already answered this ticket in public. The ' +
                  'automation stays out of it - the conversation is theirs.' }
        : isCourtesyOnly(message)
        ? { source: 'courtesy_only',
            note: 'The customer only thanked us or said goodbye. Nothing to do.' }
        : null;
      //
      // The verdict is decided here but NOT returned here. An early return that
      // strips the payload starves every caller that does not read `action` -
      // and the topic flows do not: they read `transcript` and
      // `booking_reference` and carry on. On ticket 581767 that produced an
      // empty intent, an empty reference, and an Odin call with nothing in it.
      //
      // So NOOP now rides along with the full answer, applied at the end. The
      // gatekeeper's branch on `action` still stops the run silently; a flow
      // that ignores `action` still gets everything it had before.

      // Layer 2 - Alpy vocabulary. Layer 3 - whatever the caller's model said.
      const decision = fromTags || detectFromKeywords(message) ||
                       (pendingTopic ? { topic: pendingTopic, source: 'pending_topic', blocked: false } : null) ||
                       (offeredTopic ? { topic: offeredTopic, source: 'offered_topic', blocked: false } : null) ||
                       (llmTopic ? { topic: llmTopic, source: 'llm', blocked: false } : null) ||
                       { topic: 'OTHER', source: 'none', blocked: false };

      const topic = decision.topic;

      // Apply the history reference, but only where it is safe (see above).
      // Done here rather than earlier because the rule depends on the topic, and
      // the topic is only decided on the line above.
      let usedRefFromHistory = false;
      if (refFromHistory && REF_FROM_HISTORY_IS_SAFE_FOR.includes(topic)) {
              slots.booking_ref = refFromHistory;
              usedRefFromHistory = true;
      }

      // ── What they booked last time ───────────────────────────────────────────
      //
      // Read for a QUOTE or a REQUOTE, and for one reason: a returning customer
      // who writes "the same as last year" is telling us the answers, not asking
      // to be interviewed. On 581788 we asked that customer about children when
      // the booking they were pointing at held two adults.
      //
      // The reference can come from either side - one the customer quoted, or
      // one the email lookup found - because reading a booking changes nothing.
      // What it may DO with what it reads is the part that is fenced.
      let history = '';
      let historyApplied = [];
      const wantsSame = saysSameAsBefore(message) ||
                        (thread.turns || []).some(saysSameAsBefore);
      const refForHistory = slots.booking_ref || refFromHistory;

      if ((topic === 'QUOTE' || topic === 'REQUOTE') && refForHistory) {
              history = await fetchBookingHistory(refForHistory);
      }

      // Prefill ONLY on the customer's own instruction, and only the choices
      // that survive a year. Dates never carry: nobody means the same week
      // twelve months on, and a silently reused date is the 581658 failure
      // wearing different clothes. The ages of children are not carried either
      // - a child who was 7 last winter is 8 now, and a quote priced on last
      // year's age is wrong at the till, which is the exact harm children_ages
      // exists to prevent.
      if (history && wantsSame && topic === 'QUOTE') {
              const townMatch = history.match(/resort ([^;(]+)/);
              if (townMatch && !slots.resort_name && !slots.shop_name) {
                        slots.resort_name = townMatch[1].trim();
                        historyApplied.push('resort_name');
              }
              if (!slots.equipment_level) {
                        const kinds = [];
                        if (/\bski\b/.test(history)) kinds.push('ski');
                        if (/snowboard/.test(history)) kinds.push('snowboard');
                        if (kinds.length) {
                                  slots.equipment_level = 'same as booking ' + refForHistory +
                                                          ' (' + kinds.join(' and ') + ') - see the history line in the transcript';
                                  historyApplied.push('equipment_level');
                        }
              }
      }

      // Not const: a second pass over an unanswered paid option rewrites this.
      // See the declineUnstatedExtras block below.
      let check = checkSlots(topic, slots);
      // Two different things, deliberately kept apart.
      //
      // askedQuestions is what the customer actually wanted to know. It is the
      // only one that may suppress the repeat-ask escalation: a customer who
      // asked us something instead of answering has not gone quiet, so we answer
      // and ask again rather than hand over. Facts we owe them because we are
      // about to ask for a paid option say nothing about whether they replied,
      // and letting those suppress the escalation would disable the loop guard
      // on every quote - which is the bug that made 581695 seventeen messages.
      const askedQuestions = detectProductQuestion(message);
      // Optional extras are priced out, not asked about - but they are still
      // named.
      //
      // boots, helmets and damage & theft protection are no longer gates (see
      // ROUTES.QUOTE in _slots.js): silence on a paid option means the customer
      // does not want it, so the quote is built without it and goes out at once.
      // The one thing we owe them is knowing the option exists, at the price it
      // costs, so the figure they receive is not quietly missing something they
      // would have taken. That belongs in the reply, not in a question.
      const unstatedExtras = topic === 'QUOTE'
        ? factsForMissing(['boots', 'helmets', 'insurance'].filter(n => !hasSlot(slots, n)))
        : [];
      const productQuestions = mergeFacts(askedQuestions, mergeFacts(factsForMissing(check.missing), unstatedExtras));
      const missingLabelsOf = c => c.missing.map(req => {
              const first = req.split('|')[0];
              return SLOTS[first] ? SLOTS[first].label : first;
      }).join(', ');

      // ANSWER means the owning flow may run. ASK means we know what the customer
      // wants but not enough to act - the flow asks one question. HANDOVER means
      // we could not identify a capability: a human reads it.
      let action = 'HANDOVER';
      if (topic !== 'OTHER') action = check.ready ? 'RUN' : 'ASK';

      // Two ways a correct-looking ASK is the wrong answer.
      let escalation = null;

      // One: the request spans several bookings. No capability we have edits
      // five bookings at once, so asking for "the" reference can only loop.
      if (multipleRefs.length > 1 && topic !== 'OTHER') {
              action = 'HANDOVER';
              escalation = 'The customer named ' + multipleRefs.length + ' bookings (' +
                           multipleRefs.join(', ') + '). Our flows act on one booking at a ' +
                           'time, so none of them can carry this out. Handle it manually - and ' +
                           'do not ask for "the" booking reference, it has already been given.';
      }

      // Asked once. The second time, silence on a paid option means no.
      //
      // This is what makes it safe to gate on boots, helmets and damage & theft
      // protection at all. They are real money - AlpinGuaranty is 15% of the
      // rental, which on a group of fifteen is not a detail to discover in the
      // basket - so the customer is asked before the price is built. But a
      // customer who replies about dates and levels and says nothing about
      // helmets has not gone quiet: they have shown what they care about. Asking
      // again would be pedantry, and escalating to a human over an unmentioned
      // helmet is how 581739 ended with a note about a sentence the customer had
      // already written.
      //
      // So on the second pass, if the only holes left are optional extras, they
      // are recorded as declined and the quote goes out. The reply still names
      // them - unstatedExtras above was computed before this ran, on purpose -
      // so the customer sees what was left out and at what price, and can ask
      // for it in one line.
      //
      // Anything that is not an optional extra - a resort, a date, the ages of
      // the children - is never filled in on the customer's behalf. A guessed
      // age is a wrong price discovered at the till.
      const OPTIONAL_EXTRAS = ['boots', 'helmets', 'insurance'];
      const alreadyAsked = pendingTopic === topic;
      if (action === 'ASK' && alreadyAsked &&
              check.missing.length && check.missing.every(req => OPTIONAL_EXTRAS.includes(req))) {
              check.missing.forEach(req => { slots[req] = 'no'; });
              check = checkSlots(topic, slots);
              action = check.ready ? 'RUN' : action;
      }

      // Two: we already asked, they answered, and we are about to ask again.
      //
      // The awaiting__<topic> tag means a question went out on this ticket. If
      // the reply still leaves the same hole, repeating the question is how
      // 581695 reached seventeen messages. A human reads it instead.
      // A customer who asked a question instead of answering ours has not gone
      // quiet - they are waiting on us. Answer, ask again, and do not escalate.
      if (action === 'ASK' && pendingTopic === topic && !askedQuestions.length) {
              action = 'HANDOVER';
              escalation = 'We already asked this customer for ' + missingLabelsOf(check) +
                           ' and their reply still does not contain it. Asking a second time ' +
                           'is how a ticket turns into a loop - read the thread and answer.';
      }

      const missingLabels = check.missing.map(req => {
              const first = req.split('|')[0];
              return SLOTS[first] ? SLOTS[first].label : first;
      });


      const body = {
              topic,
              route: ROUTES[topic] ? ROUTES[topic].flow : null,
              source: decision.source,
              slots,
              ready: check.ready,
              missing: check.missing,
              missingLabels,
              next_question: check.nextQuestion,
              // Several holes -> one message asking for all of them. See the
              // comment in _slots.js: a flow has no memory between comments, so
              // one question per turn can never collect six things.
              next_question_all: check.nextQuestionAll,
              // What we took by default on the paid extras, in one sentence the
              // reply must print as-is.
              //
              // This is the other half of not gating on boots, helmets and
              // protection: we price them on an assumption, and the customer
              // reads the assumption in the same message as the figure. An
              // assumption stated is correctable in one word; an assumption
              // hidden is a surprise at the till, which is what we were trying
              // to avoid when we made them gates in the first place.
              assumptions: check.assumedSentence || '',
              // The booking we found on the customer's email, and whether this
              // topic was allowed to use it. Both travel so a flow - or a human
              // reading the run - can see that the reference was inferred, not
              // quoted.
              ref_from_history: refFromHistory,
              used_ref_from_history: usedRefFromHistory,
              // The previous booking, in one line, and which slots it filled.
              // Both travel so a human reading the run can see that a value came
              // from history rather than from the customer's message.
              booking_history: history,
              history_applied: historyApplied.join(','),
              assumed_slots: (check.assumed || []).map(a => a.slot).join(','),
              action,
              // The whole gate in one value.
              //
              // A flow's entry condition can test exactly one thing, but the
              // question it must answer is two: "is this my subject" AND "is
              // there enough to act on". Returning the topic ONLY when the
              // answer is RUN collapses both into a single comparison, so
              // Quote Generator asks `run_topic Is QUOTE` and gets a no both
              // when the customer wanted a cancellation and when they wanted a
              // quote but gave no dates.
              //
              // Empty string, never null: a Zendesk Branch on a Text variable
              // compares strings, and null renders as the word "null".
              run_topic: action === 'RUN' ? topic : '',
              // Facts the reply must state before asking for anything else.
              answers: productQuestions.length ? productQuestions.map(a => a.fact).join(' ') : '',
              // How much of the conversation we could read. 0 means we are back
              // to one message at a time - say so rather than pretend.
              turns_read: thread.count,
              thread_status: thread.status,
              // What today is.
              //
              // A detector prompt told "if the date has already passed this year,
              // use next year" has no idea what this year is, and on 581710 it
              // decided December meant 2024. Everything after that was wasted: no
              // live price exists for a past season, so the quote went out with no
              // figure and a link alpy.com silently rewrote to another week.
              //
              // A model cannot know the date. It can be told.
              today: new Date().toISOString().slice(0, 10),
              // The conversation, for a flow's own detector to read instead of
              // the last comment alone.
              //
              // Turns are numbered and ordered oldest first so a prompt can be
              // told plainly that the last one wins. Without the numbering a
              // model reading five paragraphs has no way to know which "the
              // 28th" superseded which.
              //
              // Capped at 8000 characters from the END: a long thread's useful
              // information is in its recent turns, and an unbounded transcript
              // would eventually cost more than the answer is worth.
              //
              // FAIL-SOFT. When the thread cannot be read - no credentials, an
              // expired token, a ticket id the flow did not pass - this falls
              // back to the message we were given. A flow whose detector reads
              // `transcript` must never receive an empty string, because an
              // empty detector input classifies as OTHER and closes the gate on
              // every ticket at once. Degraded memory is a bad day; a silent
              // outage across all capabilities is a bad week.
              transcript: buildTranscript(thread.turns, thread.subject, thread.knownRef, history) ||
                (String(message || '').trim()
                  ? 'Customer, message 1 of 1:\n' + String(message).trim()
                  : ''),
              bookingRefs: multipleRefs.length > 1 ? multipleRefs : null,
              agentNote: escalation ? escalation : (action === 'HANDOVER'
                ? 'No capability matches this message. Read it and answer manually.'
                : (action === 'ASK'
                    ? 'We know what the customer wants but not enough to act. Missing: ' + missingLabels.join(', ') + '.'
                    : null)),
              // next_question is a suggestion, never an instruction to send.
              // The flow must still pass its own gate before asking a customer
              // anything in public.
              _contract: 'The caller decides whether to send next_question. This endpoint never authorises a public reply.',
      };

      // A NOOP verdict overrides the action and says why, and changes nothing
      // else: the transcript, the slots and the booking reference stay exactly
      // as computed, because a caller may need them even when nobody should act.
      if (noop) {
              body.action = 'NOOP';
              body.source = noop.source;
              body.agentNote = noop.note;
      }

      // Zendesk forces custom-action output names to lowercase and JSON keys are
      // case-sensitive, so every camelCase key is aliased.
      body.runtopic = body.run_topic;
      body.turnsread = body.turns_read;
      body.threadstatus = body.thread_status;
      body.transcript = body.transcript;
      body.bookingrefs = body.bookingRefs;
      body.nextquestion = body.next_question;
      body.nextquestionall = body.next_question_all;
      // missinglabels carries the WRITTEN QUESTION, not a list of nouns.
      //
      // This is a repurposing, and it is deliberate. The Zendesk custom action's
      // response schema was captured before next_question_all existed, so the
      // flow's prompt can only reference the leaves that schema declares -
      // action, agentnote, answers, missinglabels, next_question, run_topic,
      // topic, transcript. Adding one mints a new operationId and every step
      // bound to the old one goes blind, which means deleting and re-adding ten
      // steps across five flows. Not worth it.
      //
      // So the composed question rides on `missinglabels`, exactly as `today`
      // rides on `transcript`. The field's MEANING is unchanged - it is still
      // "what we still need" - only its form improves, from
      //   "first day of the rental, last day of the rental, number of adults"
      // to the sentence _slots.js actually wrote, warnings and all. That is the
      // point: the careful wording about children's ages, or about a paid
      // option and its price, was being thrown away and re-derived by a model
      // from three bare nouns. Now the model receives the finished sentence and
      // its job is to carry it across, not to invent it.
      //
      // `missingLabels` (camelCase, the array) is untouched for any caller that
      // wants the raw list.
      body.missinglabels = check.nextQuestionAll || missingLabels.join(', ');
      body.reffromhistory = body.ref_from_history;
      body.bookinghistory = body.booking_history;
      body.historyapplied = body.history_applied;
      body.usedreffromhistory = body.used_ref_from_history;
      body.agentnote = body.agentNote;

      return res.status(200).json(body);
}
