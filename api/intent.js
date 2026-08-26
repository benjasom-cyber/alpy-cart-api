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
      { topic: 'CANCELLATION',  re: /\b(cancel\s+(my|the)\s+(booking|reservation|order)|annuler\s+(ma|la)\s+r[eé]servation|storno)\b/i },
      { topic: 'DATE_CHANGE',   re: /\b(change\s+(my|the)\s+dates?|move\s+(my|the)\s+booking|postpone|d[eé]caler|changer\s+(mes|les)\s+dates?|different\s+dates?)\b/i },
      { topic: 'QUOTE',         re: /\b(quote|devis|how\s+much\s+would|combien\s+co[uû]te|price\s+for\s+\d|offre\s+de\s+prix)\b/i },
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

function detectInternalSender(message, senderEmail) {
      const from = String(senderEmail || '').trim();
      if (from && INTERNAL_DOMAINS.some(re => re.test(from))) {
              return { topic: 'OTHER', source: 'internal_sender', blocked: true };
      }

      // Only the first line is eligible - a forward prefix lives there or
      // nowhere. Scanning the whole body would match every quoted thread.
      const firstLine = String(message || '').split(/\r?\n/).find(l => l.trim() !== '') || '';
      if (FORWARD_PREFIX.test(firstLine)) {
              return { topic: 'OTHER', source: 'forwarded_mail', blocked: true };
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

              return { turns: mine, text: mine.join('\n\n'), count: mine.length,
                       status: 'ok:' + comments.length + '_comments' };
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
function buildTranscript(turns) {
      if (!turns || !turns.length) return '';
      const numbered = turns.map((t, i) => 'Customer, message ' + (i + 1) + ' of ' + turns.length + ':\n' + t);
      let out = numbered.join('\n\n');
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

      // Layer 0 - internal or partner sender. Layer 1 - native tags.
      // Either one stops the whole thing, before any topic is considered.
      const fromTags = detectFromTags(tags);
      const blocked = detectInternalSender(message, senderEmail) || (fromTags && fromTags.blocked ? fromTags : null);
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

      // Layer 2 - Alpy vocabulary. Layer 3 - whatever the caller's model said.
      const decision = fromTags || detectFromKeywords(message) ||
                       (pendingTopic ? { topic: pendingTopic, source: 'pending_topic', blocked: false } : null) ||
                       (llmTopic ? { topic: llmTopic, source: 'llm', blocked: false } : null) ||
                       { topic: 'OTHER', source: 'none', blocked: false };

      const topic = decision.topic;
      const check = checkSlots(topic, slots);
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
              transcript: buildTranscript(thread.turns) ||
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

      // Zendesk forces custom-action output names to lowercase and JSON keys are
      // case-sensitive, so every camelCase key is aliased.
      body.runtopic = body.run_topic;
      body.turnsread = body.turns_read;
      body.threadstatus = body.thread_status;
      body.transcript = body.transcript;
      body.bookingrefs = body.bookingRefs;
      body.nextquestion = body.next_question;
      body.nextquestionall = body.next_question_all;
      body.missinglabels = missingLabels;
      body.agentnote = body.agentNote;

      return res.status(200).json(body);
}
