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
const INTERNAL_MARKERS = [
      /@alpy\.com/i,
      /@2begroup/i,
      /@alpinresorts/i,
      /@skirent-booking/i,
      /powered\s+by\s+2begroup/i,
      /\bsales\s+representative\b/i,
      /\b(WG|TR)\s*:/,
];

function detectInternalSender(message) {
      const m = String(message || '');
      const hit = INTERNAL_MARKERS.find(re => re.test(m));
      return hit ? { topic: 'OTHER', source: 'internal_sender', blocked: true } : null;
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
function cleanSlots(raw) {
      const out = {};
      const src = (raw && typeof raw === 'object') ? raw : {};
      for (const name of Object.keys(SLOTS)) {
              const v = src[name];
              if (v === undefined || v === null) continue;
              const s = String(v).trim();
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
      const slots = cleanSlots(params.llm_slots ?? params.llmslots ?? params.slots ?? params);

      // Layer 0 - internal or partner sender. Layer 1 - native tags.
      // Either one stops the whole thing, before any topic is considered.
      const fromTags = detectFromTags(tags);
      const blocked = detectInternalSender(message) || (fromTags && fromTags.blocked ? fromTags : null);
      if (blocked) {
              const note = blocked.source === 'internal_sender'
                ? 'This is internal or partner mail, not a customer request. Route it to the right team - no flow should answer it.'
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
                       (llmTopic ? { topic: llmTopic, source: 'llm', blocked: false } : null) ||
                       { topic: 'OTHER', source: 'none', blocked: false };

      const topic = decision.topic;
      const check = checkSlots(topic, slots);

      // ANSWER means the owning flow may run. ASK means we know what the customer
      // wants but not enough to act - the flow asks one question. HANDOVER means
      // we could not identify a capability: a human reads it.
      let action = 'HANDOVER';
      if (topic !== 'OTHER') action = check.ready ? 'RUN' : 'ASK';

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
              action,
              agentNote: action === 'HANDOVER'
                ? 'No capability matches this message. Read it and answer manually.'
                : (action === 'ASK'
                    ? 'We know what the customer wants but not enough to act. Missing: ' + missingLabels.join(', ') + '.'
                    : null),
              // next_question is a suggestion, never an instruction to send.
              // The flow must still pass its own gate before asking a customer
              // anything in public.
              _contract: 'The caller decides whether to send next_question. This endpoint never authorises a public reply.',
      };

      // Zendesk forces custom-action output names to lowercase and JSON keys are
      // case-sensitive, so every camelCase key is aliased.
      body.nextquestion = body.next_question;
      body.missinglabels = missingLabels;
      body.agentnote = body.agentNote;

      return res.status(200).json(body);
}
