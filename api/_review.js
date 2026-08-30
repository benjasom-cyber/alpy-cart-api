/**
 * The second reader.
 *
 *   POST /api/review-run     ?since=24h&limit=20&dry=1     (served through /api/support)
 *   GET  /api/review-digest  ?since=7d
 *
 * WHY THIS IS NOT A FIFTH ZENDESK FLOW
 *
 * Every answer a flow sends should be read by something other than the thing
 * that wrote it. The obvious place to put that reader is Zendesk, as a flow that
 * runs after the others - and that was the first design. It was wrong twice
 * over. A flow can only see the run it is part of, so it would review one reply
 * at a time with no memory and no way to compare Tuesday with Monday; and the
 * account is already carrying four flows whose ordering we have had to reason
 * about carefully, so a fifth one that fires on every ticket is a new source of
 * races for no gain.
 *
 * Outside Zendesk the reader is just a program with an API token. It can look at
 * a whole day at once, it can be re-run over a window that was already reviewed
 * without doing damage, and the thing it produces - a list of corrections for
 * whoever maintains the flows - is a document rather than a side effect.
 *
 * WHAT IT DOES
 *
 * review-run walks every ticket an AI flow touched in the window, finds the last
 * public reply the flow sent, and asks one Claude call whether a human must now
 * write again. The judgement is made against the SAME answer book the flow was
 * given - imported in-process from _knowledge.js, not re-typed here - because
 * judging a reply against a different book fails correct answers for facts the
 * flow never had and passes invented ones.
 *
 * On FAIL the ticket is reopened, tagged, and an internal note explains to the
 * agent picking it up what is wrong with the message above. On PASS the same
 * note records that it was read. Either way the note carries the id of the
 * comment it judged, and that id is the whole idempotency story: re-running the
 * same window costs a search and nothing else.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It never edits, deletes or resends a customer-facing message. The reply has
 * already gone out; pretending otherwise by adding a "correction" the customer
 * did not ask for would turn one imperfect answer into two. It never assigns to
 * a named person - it reopens and marks, and the group's normal triage decides
 * who. And it never fails a ticket on its own uncertainty: an unreadable
 * reviewer answer is a PASS, because a reader that cries wolf is a reader
 * nobody reads.
 *
 * SECRETS
 *
 * ZENDESK_SUBDOMAIN / ZENDESK_EMAIL / ZENDESK_API_TOKEN are already set for this
 * project. Two more are needed: ANTHROPIC_API_KEY, and REVIEW_SECRET - any long
 * random string - which callers must present. They belong in the Vercel project's
 * environment variables and nowhere else: not in this file, not in a Zendesk
 * field, not in a chat window. Vercel's own cron presents CRON_SECRET instead and
 * is accepted on the same terms.
 */

import { knowledgeFor } from './_knowledge.js';

/* ------------------------------------------------------------------ config */

const ZD_SUB = String(process.env.ZENDESK_SUBDOMAIN || '')
  .trim()
  .replace(/^https?:\/\//i, '')
  .replace(/\/.*$/, '')
  .replace(/\.zendesk\.com$/i, '');
const ZD_EMAIL = String(process.env.ZENDESK_EMAIL || '').trim();
const ZD_TOKEN = String(process.env.ZENDESK_API_TOKEN || '').trim();

const ANTHROPIC_KEY = String(process.env.ANTHROPIC_API_KEY || '').trim();
const REVIEW_SECRET = String(process.env.REVIEW_SECRET || '').trim();
const CRON_SECRET   = String(process.env.CRON_SECRET || '').trim();

// Overridable so a model rename never needs a code change.
const MODEL = String(process.env.REVIEW_MODEL || 'claude-sonnet-4-6').trim();

// The marker that makes a re-run safe. It is deliberately ugly and unique: an
// agent will never type it, and a substring search for it cannot false-positive.
const MARK = 'SKIBOT-REVIEW';

// Tags a flow leaves behind. A ticket carrying any of these, or any tag starting
// with one of the two prefixes, was touched by an AI answer.
const AI_TAGS = new Set([
  'offered__quote',
  'skibot_answered',
  'skibot_handled',
  'general_question_answered',
  'ai_answered',
]);
const AI_TAG_PREFIXES = ['awaiting__', 'offered__', 'skibot__'];

// Applied by this reader.
const T_REVIEWED = 'ai_reviewed';
const T_FAILED   = 'ai_review_failed';
const T_HUMAN    = 'needs_human';

const STATUS_OPEN = 'open';

// A run must always answer, even when it has not finished.
//
// The first live run died on FUNCTION_INVOCATION_TIMEOUT: a 72h window, tickets
// judged strictly one after another, one Claude call each. Vercel killed it at
// 60s and the caller got an error instead of the twelve verdicts that were
// already computed - the work was done and thrown away.
//
// So the loop now watches the clock and stops dispatching before the platform
// stops it. A partial answer with `remaining` in it is a useful answer: nothing
// is lost, because a ticket already judged carries its note and the next run
// skips it. A timeout is not.
const BUDGET_MS = 48000;

// Three at a time. The wall-clock cost of a ticket is almost entirely one
// Claude call spent waiting, so a little concurrency multiplies throughput
// without multiplying load; more than three and the Zendesk rate limiter starts
// answering 429 to the comment reads, which would cost more than it saves.
const CONCURRENCY = 3;

/**
 * Which flow wrote this, and therefore which rules apply.
 *
 * The first live run failed 5 replies out of 5, and three of those were my
 * mistake, not the flow's. The rubric was written for the general-questions
 * flow - which is forbidden to touch a specific booking - and then applied to
 * the cancellation flow, whose entire job is to read a booking from Odin and
 * tell the customer its dates. Two perfectly correct answers were graded HIGH
 * severity for doing exactly what they were built to do.
 *
 * A reviewer that reopens correct tickets is worse than no reviewer, so the
 * rules are now selected by the tags the flow itself left behind.
 */
function flowProfile(tags) {
  const t = tags || [];
  if (t.indexOf('awaiting__cancellation') > -1) return 'cancellation';
  if (t.indexOf('general_question') > -1 || t.indexOf('general_question_answered') > -1) return 'general';
  if (t.indexOf('depot') > -1 || t.indexOf('shop_services') > -1) return 'general';
  return 'unknown';
}

/**
 * A ticket the flow already escalated needs nothing from us.
 *
 * When a flow ends in handover it has already said so, tagged the ticket and
 * put it in front of a human. Grading that reply can only produce a note on a
 * ticket somebody is already reading - noise on the exact tickets where
 * attention is already where it should be.
 */
function alreadyWithHuman(tags) {
  const t = tags || [];
  return t.indexOf('needs_human') > -1 || t.indexOf('handover_done') > -1;
}

function isAiTouched(tags) {
  for (const t of tags || []) {
    if (AI_TAGS.has(t)) return true;
    for (const p of AI_TAG_PREFIXES) if (t.indexOf(p) === 0) return true;
  }
  return false;
}

/* -------------------------------------------------------------- zendesk io */

function zdAuth() {
  if (!ZD_SUB || !ZD_EMAIL || !ZD_TOKEN) return null;
  return 'Basic ' + Buffer.from(ZD_EMAIL + '/token:' + ZD_TOKEN).toString('base64');
}

async function zd(path, opts) {
  const auth = zdAuth();
  if (!auth) throw new Error('Zendesk credentials are not configured');
  const o = opts || {};
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), o.timeout || 12000);
  try {
    const r = await fetch('https://' + ZD_SUB + '.zendesk.com' + path, {
      method: o.method || 'GET',
      headers: {
        Authorization: auth,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: o.body ? JSON.stringify(o.body) : undefined,
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!r.ok) {
      const e = new Error('Zendesk ' + r.status + ' on ' + path + ': ' + text.slice(0, 300));
      e.status = r.status;
      throw e;
    }
    return json || {};
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------------ window */

/**
 * "24h", "3d", "2026-08-25". Anything unparseable falls back to 24 hours, which
 * is the cadence this runs at - a bad parameter should narrow nothing and widen
 * nothing, it should just do the normal day.
 */
function windowStart(since) {
  const s = String(since || '').trim();
  const m = /^(\d+)\s*([hd])$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 10);
    const ms = m[2].toLowerCase() === 'h' ? 3600e3 : 86400e3;
    return new Date(Date.now() - n * ms);
  }
  const d = new Date(s);
  if (s && !isNaN(d.getTime())) return d;
  // 26 hours, not 24. The cron fires once a day at an hour Vercel chooses within
  // the slot, so two consecutive runs can be more than 24h apart. The overlap
  // costs one search and nothing else - every ticket in it is skipped by its
  // comment id - while a 24h default would silently drop the tickets in the gap.
  return new Date(Date.now() - 26 * 3600e3);
}

function ymd(d) { return d.toISOString().slice(0, 10); }

/* ----------------------------------------------------------- the judgement */

const RUBRIC = [
'You are the second reader.',
'',
'An automated flow has just sent the message below to a customer of a ski and',
'snowboard rental company. It has already gone out - you cannot stop it. Your job',
'is to decide whether a human must now step in and write again.',
'',
'You are not the author. Do not rewrite the message, do not improve it, do not',
'grade its style. Judge only whether it is safe and correct to have sent.',
'',
'=== FAIL IT IF ANY OF THESE IS TRUE ===',
'',
'FACTS',
'- It states something that is not in the reference material below, or contradicts',
'  it. An invented price, deadline, delay, address, phone number or rule.',
'- It names a product that is not in the reference material - most often a',
'  protection belonging to a different platform.',
'- It answers a question about ONE SPECIFIC BOOKING - its price, dates, status,',
'  what was paid - which this flow is never allowed to do.',
'',
'PROMISES',
'- It promises a refund, a gesture, an amount, a percentage, or a date by which',
'  something will happen.',
'- It commits us to acting inside an insurance claim, or invites the customer to',
'  come back to us about a claim that belongs to the insurer.',
'- It tells the customer to contact a shop directly before they have booked.',
'',
'THE CUSTOMER',
'- It does not answer what the customer actually asked - it answers a neighbouring',
'  question, or only part of a multi-part question.',
'- It asks for information the customer has already given in this conversation.',
'- It is not written in the customer language, or mixes two languages.',
'- It contains reasoning, notes to self, draft markers, or any text that is not',
'  the message itself.',
'- It replies to a complaint, an injury, an illness or a legal threat. Those are',
'  never ours to answer.',
'',
'=== NOT PART OF THE MESSAGE ===',
'Ignore the signature block at the end - the name, the company, the phone number,',
'the email address, the website. It is appended by the mail system, it is the same',
'on every reply the company sends, and the flow did not write it. A contact detail',
'that appears there is never an invented fact. Judge only the body above it.',
'',
'=== DO NOT FAIL IT FOR ===',
'Being short. Being warm. Offering a quote or naming our protections - that is',
'deliberate and wanted. A formatting choice you would have made differently. A',
'turn of phrase. Saying we do not know something and offering to find out.',
'',
'Telling the customer that the reply was written by an assistant, that we use it',
'to answer everyone faster, or that a colleague can take over at any time. That',
'disclosure is deliberate company policy and is meant to be there. It is not',
'leaked reasoning - LEAKED_REASONING is for notes to self, draft markers and',
'thinking that was never meant to be read.',
'',
'A false alarm costs an agent the time we are trying to save, so when the message',
'is merely imperfect, pass it.',
'',
'=== SEVERITY, WHEN YOU FAIL ===',
'HIGH   - the customer was told something false, was promised something, or a',
'         complaint/injury/booking-specific question was answered. Someone must',
'         write today.',
'MEDIUM - the answer misses part of the question, asks again for what was given,',
'         or is in the wrong language. It should be followed up.',
'',
'=== CATEGORY, WHEN YOU FAIL ===',
'One of exactly: INVENTED_FACT, WRONG_PRODUCT_NAME, BOOKING_SPECIFIC, PROMISE,',
'CLAIM_INTERFERENCE, SENT_TO_SHOP, MISSED_QUESTION, ASKED_AGAIN, WRONG_LANGUAGE,',
'LEAKED_REASONING, SHOULD_HAVE_BEEN_HUMAN.',
'',
'=== WHAT YOU RETURN ===',
'Return exactly ONE json object and nothing else. No prose before or after, no',
'second object, no correction, no explanation of how you decided.',
'',
'{"verdict":"PASS","severity":"","category":"","reason":"","fix":""}',
'',
'or',
'',
'{"verdict":"FAIL","severity":"HIGH","category":"INVENTED_FACT","reason":"<one sentence, naming the exact words that are wrong>","fix":"<one sentence to the person who maintains the flow: what rule or fact would have prevented this>"}',
'',
'reason is written for the agent who picks the ticket up. fix is written for the',
'engineer who will change the prompt or the answer book - it must be actionable,',
'not "be more careful".',
].join('\n');

const VALID_CATEGORIES = new Set([
  'INVENTED_FACT', 'WRONG_PRODUCT_NAME', 'BOOKING_SPECIFIC', 'PROMISE',
  'CLAIM_INTERFERENCE', 'SENT_TO_SHOP', 'MISSED_QUESTION', 'ASKED_AGAIN',
  'WRONG_LANGUAGE', 'LEAKED_REASONING', 'SHOULD_HAVE_BEEN_HUMAN',
]);

/**
 * Keep the LAST balanced object that carries a verdict.
 *
 * A model that talks itself out of a first answer produces two objects, and
 * first-brace-to-last-brace spans both of them into something that parses as
 * neither. This is the same parser the gatekeeper uses, for the same reason.
 */
function parseVerdict(raw) {
  const s = String(raw || '');
  const found = [];
  let depth = 0, start = -1, inStr = false, prev = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (inStr) { if (ch === '"' && prev !== '\\') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start > -1) { found.push(s.slice(start, i + 1)); start = -1; } }
    prev = ch;
  }
  let o = null;
  for (let j = found.length - 1; j >= 0; j--) {
    try {
      const c = JSON.parse(found[j]);
      if (c && typeof c === 'object' && 'verdict' in c) { o = c; break; }
    } catch { /* keep looking */ }
  }
  o = o || {};

  let verdict = String(o.verdict || '').toUpperCase();
  // PASS is the safe default on purpose. An unreadable reviewer answer teaches
  // us nothing, and reopening a ticket on a parsing accident buries the real
  // failures under false alarms - which is the one way this stops being used.
  if (verdict !== 'FAIL') verdict = 'PASS';

  let sev = String(o.severity || '').toUpperCase();
  if (sev !== 'HIGH' && sev !== 'MEDIUM') sev = verdict === 'FAIL' ? 'MEDIUM' : '';

  let cat = String(o.category || '').toUpperCase().replace(/[^A-Z_]/g, '');
  if (verdict === 'FAIL' && !VALID_CATEGORIES.has(cat)) cat = 'UNSPECIFIED';
  if (verdict === 'PASS') cat = '';

  let reason = String(o.reason || '').slice(0, 600);
  const fix = String(o.fix || '').slice(0, 600);
  if (verdict === 'FAIL' && !reason) {
    reason = 'The reviewer failed this answer but gave no reason. Read the reply above before you write.';
  }

  return { verdict, severity: sev, category: cat, reason, fix, parsed: found.length > 0 };
}

async function judge(prompt) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error('Anthropic ' + r.status + ': ' + text.slice(0, 300));
    const j = JSON.parse(text);
    const parts = (j.content || []).filter(c => c && c.type === 'text').map(c => c.text);
    return parts.join('\n');
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------- one ticket */

function strip(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The reply under review, and everything the customer said before it.
 *
 * "The flow's reply" is the last PUBLIC comment that is not the requester's, on
 * a ticket the flow tagged. That is an approximation and it has one known hole:
 * a human agent who answers a flow-tagged ticket has their message read too. It
 * fails safe - a human message almost always passes, and when it does not, the
 * note it earns is a fair one.
 */
function pickReply(comments, requesterId) {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (c.public && c.author_id !== requesterId) return { comment: c, index: i };
  }
  return null;
}

function buildTranscript(comments, upTo, requesterId) {
  const lines = [];
  for (let i = 0; i < upTo; i++) {
    const c = comments[i];
    if (!c.public) continue;
    const who = c.author_id === requesterId ? 'CUSTOMER' : 'US';
    const body = strip(c.plain_body || c.body);
    if (!body) continue;
    lines.push(who + ' (' + String(c.created_at).slice(0, 16).replace('T', ' ') + '):\n' + body);
  }
  // Oldest first, and trimmed from the front: the recent turns decide whether a
  // question was answered or asked twice; the opening of a long thread rarely does.
  let out = lines.join('\n\n---\n\n');
  if (out.length > 14000) out = '[earlier messages omitted]\n\n' + out.slice(out.length - 14000);
  return out;
}

function alreadyReviewed(comments, commentId) {
  const needle = MARK + ' c=' + commentId;
  return comments.some(c => !c.public && String(c.plain_body || c.body || '').indexOf(needle) > -1);
}

function noteFor(v, commentId) {
  const head = MARK + ' c=' + commentId + ' ' + v.verdict + (v.severity ? ' ' + v.severity : '');
  if (v.verdict === 'PASS') {
    return head + '\n\nAutomatic second reading of the reply above: nothing to correct. ' +
      'No action needed - this note is the audit trail, not a task.';
  }
  return head + (v.category ? ' ' + v.category : '') + '\n\n' +
    'The reply above was sent automatically and a second reading found a problem with it. ' +
    'It has NOT been corrected - the customer has read it as it stands.\n\n' +
    'What is wrong: ' + v.reason + '\n\n' +
    'Please write to the customer yourself.\n\n' +
    'For the flow maintainer: ' + (v.fix || '(no fix suggested)');
}

async function reviewTicket(ticket, opts) {
  const id = ticket.id;
  const out = { ticket: id, url: 'https://' + ZD_SUB + '.zendesk.com/agent/tickets/' + id };

  const cj = await zd('/api/v2/tickets/' + id + '/comments.json?sort_order=asc&page[size]=100');
  const comments = cj.comments || [];
  if (!comments.length) { out.skipped = 'no comments'; return out; }

  const picked = pickReply(comments, ticket.requester_id);
  if (!picked) { out.skipped = 'no outbound public reply'; return out; }

  const commentId = picked.comment.id;
  out.comment = commentId;

  const profile = flowProfile(ticket.tags);
  out.profile = profile;

  if (alreadyReviewed(comments, commentId)) { out.skipped = 'already reviewed'; return out; }
  if (alreadyWithHuman(ticket.tags)) { out.skipped = 'already handed to a human'; return out; }

  const message = strip(picked.comment.plain_body || picked.comment.body);
  if (!message) { out.skipped = 'empty reply'; return out; }

  const knowledge = knowledgeFor(ticket.brand_id);
  const transcript = buildTranscript(comments, picked.index, ticket.requester_id);

  const profileNote = profile === 'cancellation'
    ? ['=== WHAT THIS PARTICULAR FLOW WAS ALLOWED TO DO ===',
       'This reply came from the cancellation flow. That flow reads the customer own',
       'booking from the live reservation system and is REQUIRED to state its dates,',
       'its reference and whether a cancellation is free. Those facts are true by',
       'construction and are NOT in the reference material below - the book holds',
       'general rules, not one customer booking.',
       '',
       'So do NOT fail this reply for naming a booking reference, a rental start date,',
       'a cancellation deadline or whether fees apply. BOOKING_SPECIFIC does not exist',
       'for this flow. Judge the rest: promises, interference in an insurance claim,',
       'sending the customer to a shop, language, leaked reasoning, and whether a',
       'complaint or injury was answered that should not have been.'].join('\n')
    : ['=== WHAT THIS PARTICULAR FLOW WAS ALLOWED TO DO ===',
       'This reply came from a flow that answers general questions only. It has no',
       'access to any individual booking and must never state one booking dates,',
       'price or status. Everything factual it says must come from the reference',
       'material below.'].join('\n');

  const prompt = [
    RUBRIC,
    '',
    profileNote,
    '',
    '=== THE REFERENCE MATERIAL THE FLOW WAS ALLOWED TO USE ===',
    knowledge || '(none - this brand has no confirmed answer book, so ANY product name or ' +
                 'rule stated in the message is unsupported)',
    '',
    '=== THE CONVERSATION, oldest first ===',
    transcript || '(the reply above is the first message on the ticket)',
    '',
    '=== THE MESSAGE THAT WAS SENT ===',
    message,
  ].join('\n');

  const raw = await judge(prompt);
  const v = parseVerdict(raw);
  out.verdict = v.verdict;
  out.severity = v.severity;
  out.category = v.category;
  out.reason = v.reason;
  out.fix = v.fix;
  if (!v.parsed) out.unparsed = true;

  if (opts.dry) { out.applied = false; return out; }

  const tags = (ticket.tags || []).slice();
  const add = t => { if (tags.indexOf(t) === -1) tags.push(t); };
  add(T_REVIEWED);

  const update = {
    comment: { body: noteFor(v, commentId), public: false },
  };

  if (v.verdict === 'FAIL') {
    add(T_FAILED);
    add(T_HUMAN);
    if (v.category) add('ai_fail__' + v.category.toLowerCase());
    // Reopen so it lands back in the queue. Solved and closed tickets are left
    // where they are - reopening a closed conversation days later reads to the
    // customer as a new problem, and Zendesk will not reopen a closed one anyway.
    if (ticket.status === 'pending' || ticket.status === 'new' || ticket.status === 'open') {
      update.status = STATUS_OPEN;
    }
    // Deliberately not assigned to a person. Marked and reopened is a fact; who
    // should answer is a decision the group's triage already knows how to make.
  }

  update.tags = tags;
  await zd('/api/v2/tickets/' + id + '.json', { method: 'PUT', body: { ticket: update } });
  out.applied = true;
  return out;
}

/* ------------------------------------------------------------------ actions */

async function runReview(req, res) {
  const q = { ...(req.query || {}), ...(req.method === 'POST' ? (req.body || {}) : {}) };
  const start = windowStart(q.since);
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 25, 1), 60);
  const dry = String(q.dry || '') === '1' || q.dry === true;

  // Zendesk search granularity is a day, so we over-fetch and filter on the real
  // timestamp. Cheaper than being clever, and never misses a ticket.
  const query = 'type:ticket updated>' + ymd(new Date(start.getTime() - 86400e3));
  const sj = await zd('/api/v2/search.json?sort_by=updated_at&sort_order=desc&query=' +
                      encodeURIComponent(query));

  const candidates = (sj.results || [])
    .filter(t => t && t.result_type === 'ticket')
    .filter(t => new Date(t.updated_at).getTime() >= start.getTime())
    .filter(t => isAiTouched(t.tags))
    .slice(0, limit);

  const began = Date.now();
  const results = [];
  let cut = 0;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    if (Date.now() - began > BUDGET_MS) { cut = candidates.length - i; break; }
    const slice = candidates.slice(i, i + CONCURRENCY);
    const done = await Promise.all(slice.map(async t => {
      try { return await reviewTicket(t, { dry }); }
      catch (e) { return { ticket: t.id, error: String(e && e.message || e).slice(0, 300) }; }
    }));
    for (const r of done) results.push(r);
  }

  const failures = results.filter(r => r.verdict === 'FAIL');
  return res.status(200).json({
    ok: true,
    window: { from: start.toISOString(), to: new Date().toISOString() },
    dry,
    model: MODEL,
    scanned: (sj.results || []).length,
    aiTouched: candidates.length,
    // Not an error. Call again with the same parameters: everything already
    // judged is skipped by its comment id, so a second call resumes here.
    remaining: cut,
    timedOut: cut > 0,
    reviewed: results.filter(r => r.verdict).length,
    passed: results.filter(r => r.verdict === 'PASS').length,
    failed: failures.length,
    reopened: failures.filter(r => r.applied).length,
    // The correction list, which is the point of the whole thing.
    corrections: failures.map(f => ({
      ticket: f.ticket, url: f.url, severity: f.severity,
      category: f.category, reason: f.reason, fix: f.fix,
    })),
    results,
  });
}

/**
 * The standing correction list.
 *
 * review-run returns the failures it found in one window and then forgets them,
 * because nothing here has a database. It does not need one: the notes on the
 * tickets ARE the record, and this reads them back. Any window, any time, no
 * second Claude call, no new writes.
 */
async function runDigest(req, res) {
  const q = { ...(req.query || {}), ...(req.method === 'POST' ? (req.body || {}) : {}) };
  const start = windowStart(q.since || '7d');

  const query = 'type:ticket tags:' + T_FAILED + ' updated>' +
                ymd(new Date(start.getTime() - 86400e3));
  const sj = await zd('/api/v2/search.json?sort_by=updated_at&sort_order=desc&query=' +
                      encodeURIComponent(query));

  const tickets = (sj.results || [])
    .filter(t => t && t.result_type === 'ticket')
    .filter(t => new Date(t.updated_at).getTime() >= start.getTime())
    .slice(0, 100);

  const items = [];
  for (const t of tickets) {
    try {
      const cj = await zd('/api/v2/tickets/' + t.id + '/comments.json?sort_order=desc&page[size]=30');
      for (const c of (cj.comments || [])) {
        if (c.public) continue;
        const body = String(c.plain_body || c.body || '');
        if (body.indexOf(MARK) !== 0) continue;
        if (body.split('\n')[0].indexOf(' FAIL') === -1) continue;
        const head = body.split('\n')[0].split(' ');
        const category = head[4] || 'UNSPECIFIED';
        const severity = head[3] || '';
        const wrong = /What is wrong: ([\s\S]*?)\n\n/.exec(body);
        const fix = /For the flow maintainer: ([\s\S]*)$/.exec(body);
        items.push({
          ticket: t.id,
          url: 'https://' + ZD_SUB + '.zendesk.com/agent/tickets/' + t.id,
          at: c.created_at,
          severity, category,
          reason: wrong ? wrong[1].trim() : '',
          fix: fix ? fix[1].trim() : '',
        });
        break; // the newest review note on this ticket is the current one
      }
    } catch { /* one unreadable ticket must not lose the digest */ }
  }

  const byCategory = {};
  for (const i of items) {
    (byCategory[i.category] = byCategory[i.category] || []).push(i);
  }
  const ranked = Object.keys(byCategory)
    .map(k => ({ category: k, count: byCategory[k].length, fixes: byCategory[k].map(x => x.fix).filter(Boolean) }))
    .sort((a, b) => b.count - a.count);

  return res.status(200).json({
    ok: true,
    window: { from: start.toISOString(), to: new Date().toISOString() },
    failures: items.length,
    high: items.filter(i => i.severity === 'HIGH').length,
    byCategory: ranked,
    items,
  });
}

/* ---------------------------------------------------------------- entry point */

function authorised(req) {
  if (!REVIEW_SECRET && !CRON_SECRET) return false;   // unconfigured means closed
  const h = req.headers || {};
  const bearer = String(h.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const given = String(h['x-review-secret'] || (req.query && req.query.secret) || '').trim();
  if (REVIEW_SECRET && (given === REVIEW_SECRET || bearer === REVIEW_SECRET)) return true;
  if (CRON_SECRET && bearer === CRON_SECRET) return true;   // Vercel Cron
  return false;
}

export async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!authorised(req)) {
    return res.status(401).json({
      error: 'Unauthorised.',
      how: 'Send the review secret as the x-review-secret header, or as an Authorization ' +
           'bearer token. Set REVIEW_SECRET (and ANTHROPIC_API_KEY) in the Vercel project ' +
           'environment - never in a Zendesk field or a chat message.',
    });
  }

  const action = String((req.query && req.query.action) || '').trim();

  try {
    if (action === 'review-digest') return await runDigest(req, res);
    return await runReview(req, res);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e).slice(0, 500) });
  }
}

export default handler;
