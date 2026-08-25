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
      if (s.startsWith('{')) {
              try { const o = JSON.parse(s); return (o && typeof o === 'object') ? o : {}; } catch { /* fall through */ }
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
      const fromMessage = extractFromMessage(message);
      const slots = Object.assign(
              cleanSlots(params.llm_slots ?? params.llmslots ?? params.slots ?? params),
              cleanSlots(fromMessage)
      );

      // Every reference the customer named, when they named more than one.
      const multipleRefs = String(fromMessage._booking_refs || '')
        .split(',').map(x => x.trim()).filter(Boolean);

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
      if (action === 'ASK' && pendingTopic === topic) {
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
      body.bookingrefs = body.bookingRefs;
      body.nextquestion = body.next_question;
      body.nextquestionall = body.next_question_all;
      body.missinglabels = missingLabels;
      body.agentnote = body.agentNote;

      return res.status(200).json(body);
}
