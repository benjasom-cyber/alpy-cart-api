/**
 * The trainer's second reading.
 *
 *   POST /api/training-run     ?since=24h&limit=25&dry=1
 *   GET  /api/training-digest  ?since=7d
 *
 * WHAT THIS IS FOR
 *
 * In the sandbox, new agents answer practice tickets and Benjamin reads every
 * one of them by hand to make sure our procedures are followed. That reading is
 * the valuable part of the training and it is also the part that does not scale:
 * it is hours a week, and the hours grow with every new joiner.
 *
 * So this reads the same tickets against the same standards and writes what it
 * finds as an internal note on the ticket. It is the reading that is automated,
 * not the judgement of what good looks like - that lives in the playbook below,
 * in plain words, and it is meant to be edited as the procedures change.
 *
 * IT ANNOTATES. IT DOES NOT CORRECT.
 *
 * A deliberate choice, and the whole reason this teaches anything. The note says
 * what is wrong and which rule it breaks; it never writes the corrected reply.
 * A trainee who is handed a model answer has read one; a trainee who has to
 * write it has learnt it. It never touches a public comment, never writes to a
 * customer, and never edits anyone's draft.
 *
 * IT ONLY EVER RUNS AGAINST THE SANDBOX
 *
 * Its credentials are separate variables, and it refuses to start if they
 * resolve to the production subdomain. A trainer that accidentally posts
 * coaching notes on real customer tickets would be worse than no trainer, and
 * "we were careful" is not a control - the check below is.
 *
 * SECRETS
 *
 * SANDBOX_SUBDOMAIN / SANDBOX_EMAIL / SANDBOX_API_TOKEN, plus the existing
 * ANTHROPIC_API_KEY and REVIEW_SECRET. All of them live in the Vercel project's
 * environment and nowhere else.
 */

import { knowledgeFor } from './_knowledge.js';

/* ------------------------------------------------------------------ config */

const clean = v => String(v || '').trim()
  .replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\.zendesk\.com$/i, '');

const SB_SUB   = clean(process.env.SANDBOX_SUBDOMAIN);
const SB_EMAIL = String(process.env.SANDBOX_EMAIL || '').trim();
const SB_TOKEN = String(process.env.SANDBOX_API_TOKEN || '').trim();
const PROD_SUB = clean(process.env.ZENDESK_SUBDOMAIN);

const ANTHROPIC_KEY = String(process.env.ANTHROPIC_API_KEY || '').trim();
const REVIEW_SECRET = String(process.env.REVIEW_SECRET || '').trim();
const CRON_SECRET   = String(process.env.CRON_SECRET || '').trim();
const MODEL = String(process.env.REVIEW_MODEL || 'claude-sonnet-4-6').trim();

// The note is written for the trainee, so it is written in the language the
// training is given in. Change this variable, not the code, if that changes.
const LANG = String(process.env.TRAINING_NOTE_LANG || 'fr').trim().toLowerCase();

const MARK = 'SKIBOT-TRAINING';
const T_REVIEWED = 'training_reviewed';
const T_TOFIX    = 'training_to_fix';

const BUDGET_MS  = 48000;
const CONCURRENCY = 3;

/* ---------------------------------------------------------------- playbook */

/**
 * What "following the procedure" means, in words.
 *
 * This is the part Benjamin owns. Everything the reviewer is strict about is
 * here and nowhere else - there is no second list hidden in the code. Adding a
 * rule means adding a sentence here.
 */
const PLAYBOOK = [
'=== TAGS AND PROCEDURE ===',
'- The ticket must carry the tags our procedure requires for what it is. A reply',
'  sent without the tags that classify it is not finished work, however good the',
'  wording is: the ticket becomes invisible to every report and every follow-up.',
'- The procedure for the case must be the one actually followed, in order. A',
'  correct-sounding answer that skipped a mandatory step is a fail.',
'- Anything that belongs to a human specialist - a complaint, an injury, an',
'  insurance claim, a legal threat, a refund decision, a specific booking that',
'  needs a change in the system - must be escalated, not answered.',
'',
'=== FACTS ===',
'- Every product is called by its exact name on the platform the customer wrote',
'  from. Naming a protection that belongs to another brand is always a fail.',
'- Prices, deadlines, percentages and cover limits must match the reference',
'  material. Approximations invented on the spot are a fail even when they are',
'  close.',
'- Never send a customer to contact a shop before they have booked. The shop',
'  contact comes after the booking - that is the point of the service.',
'',
'=== PROTECTIONS - MENTIONED WHENEVER THEY CAN BE ===',
'- Whenever the exchange makes it possible, our protections must be named:',
'  the cancellation protection for anything booked in advance, the damage and',
'  theft protection for the equipment, the accident cover where the conversation',
'  touches injury risk. Saying nothing about them when the opening was there is',
'  a fail in this training, not a matter of taste.',
'- They are offered, never pushed, and never presented as included by default.',
'',
'=== CONVERSION - THE POINT OF THE CONVERSATION ===',
'- A pre-booking exchange exists to turn into a booking. Any message from someone',
'  who has not booked yet must move towards a quote.',
'- If we already have what a quote needs, produce it. Asking for information the',
'  customer has already given - including a resort they named through a lift, a',
'  shop or a hotel - is a fail.',
'- When the customer describes one family or one person as an example of a bigger',
'  group, quote that example and offer to extend it. Withholding a price we could',
'  already give, because the total headcount is unknown, is a lost booking.',
'- Closing an exchange with a bare answer and no next step is a fail: there is',
'  always a next step to offer.',
'',
'=== TONE AND FORM ===',
'- The customer language, throughout, with no mixing.',
'- The customer is addressed the way our register requires, and by name when we',
'  have it.',
'- Every question actually asked gets an answer. A multi-part question answered',
'  in part is a fail.',
'- Short, structured, no wall of text, no internal jargon, no note to self.',
].join('\n');

const CATEGORIES = [
  'MISSING_TAG', 'WRONG_PROCEDURE', 'SHOULD_ESCALATE',
  'WRONG_FACT', 'WRONG_PRODUCT_NAME', 'SENT_TO_SHOP',
  'NO_PROTECTION_OFFERED', 'NO_QUOTE', 'ASKED_AGAIN', 'NO_NEXT_STEP',
  'WRONG_LANGUAGE', 'MISSED_QUESTION', 'TONE',
];

const RUBRIC = [
'You are the trainer reading over a new agent\'s shoulder in our training',
'environment. The reply below was written by a person learning our procedures,',
'on a practice ticket. Nothing was sent to a real customer.',
'',
'Judge it against the playbook. Be strict: this is training, and a habit not',
'corrected here becomes a habit in front of customers. But be strict about the',
'playbook, not about how you personally would have phrased it - a fair reading',
'is what makes the note worth reading.',
'',
'You do NOT rewrite the reply. Never quote a corrected version, never draft the',
'sentence they should have written. Name what is wrong and which rule it breaks;',
'the agent writes the fix themselves. That is the whole point of the exercise.',
'',
PLAYBOOK,
'',
'=== WHAT COUNTS AS PASS ===',
'The procedure was followed, the tags are there, the facts are right, the',
'protections were named where there was an opening, the exchange moves towards a',
'booking, and every question is answered. Small stylistic differences are a pass.',
'',
'=== SEVERITY ===',
'HIGH   - a customer would have been told something false, promised something,',
'         sent to a shop before booking, or a case that belongs to a human was',
'         answered. Also: a booking we could have won was lost.',
'MEDIUM - procedure or tags not respected, a protection or a quote not offered',
'         when the opening was there, a question half answered, wrong language.',
'',
'=== CATEGORY ===',
'One of exactly: ' + CATEGORIES.join(', ') + '.',
'Pick the one that matters most. Do not list several.',
'',
'=== WHAT YOU RETURN ===',
'Return exactly ONE json object and nothing else. No prose before or after.',
'',
'{"verdict":"PASS","severity":"","category":"","note":"","rule":""}',
'',
'or',
'',
'{"verdict":"FAIL","severity":"MEDIUM","category":"NO_PROTECTION_OFFERED","note":"<two sentences to the agent: what is missing or wrong, and where in their reply>","rule":"<the playbook rule it breaks, in one short sentence>"}',
'',
'`note` is addressed to the agent directly, in ' + (LANG === 'fr' ? 'FRENCH' : LANG.toUpperCase()) + ',',
'in the second person, factual and calm. No praise padding, no apology, no model',
'answer, no rewritten sentence.',
].join('\n');

/* ------------------------------------------------------------------ io */

function sbAuth() {
  if (!SB_SUB || !SB_EMAIL || !SB_TOKEN) return null;
  return 'Basic ' + Buffer.from(SB_EMAIL + '/token:' + SB_TOKEN).toString('base64');
}

/**
 * The guard that makes this safe to run at all.
 *
 * Two independent conditions: the sandbox variables must be set, and they must
 * not resolve to production. Either one failing stops the run before a single
 * read, because the failure mode we are protecting against - coaching notes
 * appearing on live customer tickets - is not one you can undo by apologising.
 */
function refuseIfNotSandbox() {
  if (!sbAuth()) return 'SANDBOX_SUBDOMAIN, SANDBOX_EMAIL or SANDBOX_API_TOKEN is not set';
  if (PROD_SUB && SB_SUB.toLowerCase() === PROD_SUB.toLowerCase()) {
    return 'refusing to run: SANDBOX_SUBDOMAIN is the production subdomain';
  }
  return null;
}

async function zd(path, opts) {
  const o = opts || {};
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), o.timeout || 12000);
  try {
    const r = await fetch('https://' + SB_SUB + '.zendesk.com' + path, {
      method: o.method || 'GET',
      headers: { Authorization: sbAuth(), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: o.body ? JSON.stringify(o.body) : undefined,
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error('Zendesk ' + r.status + ' on ' + path + ': ' + text.slice(0, 250));
    return text ? JSON.parse(text) : {};
  } finally { clearTimeout(t); }
}

/* --------------------------------------------------------------- helpers */

function windowStart(since) {
  const s = String(since || '').trim();
  const m = /^(\d+)\s*([hd])$/i.exec(s);
  if (m) return new Date(Date.now() - parseInt(m[1], 10) * (m[2].toLowerCase() === 'h' ? 3600e3 : 86400e3));
  const d = new Date(s);
  if (s && !isNaN(d.getTime())) return d;
  return new Date(Date.now() - 26 * 3600e3);
}
const ymd = d => d.toISOString().slice(0, 10);

function strip(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n').trim();
}

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
    try { const c = JSON.parse(found[j]); if (c && typeof c === 'object' && 'verdict' in c) { o = c; break; } } catch { /* keep looking */ }
  }
  o = o || {};
  let verdict = String(o.verdict || '').toUpperCase();
  if (verdict !== 'FAIL') verdict = 'PASS';
  let sev = String(o.severity || '').toUpperCase();
  if (sev !== 'HIGH' && sev !== 'MEDIUM') sev = verdict === 'FAIL' ? 'MEDIUM' : '';
  let cat = String(o.category || '').toUpperCase().replace(/[^A-Z_]/g, '');
  if (verdict === 'FAIL' && CATEGORIES.indexOf(cat) === -1) cat = 'WRONG_PROCEDURE';
  if (verdict === 'PASS') cat = '';
  return {
    verdict, severity: sev, category: cat,
    note: String(o.note || '').slice(0, 700),
    rule: String(o.rule || '').slice(0, 400),
    parsed: found.length > 0,
  };
}

async function judge(prompt) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error('Anthropic ' + r.status + ': ' + text.slice(0, 250));
    return (JSON.parse(text).content || []).filter(c => c && c.type === 'text').map(c => c.text).join('\n');
  } finally { clearTimeout(t); }
}

/* ------------------------------------------------------------ one ticket */

/** The trainee's reply: the last public comment that is not the requester's. */
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
    const body = strip(c.plain_body || c.body);
    if (!body) continue;
    lines.push((c.author_id === requesterId ? 'CUSTOMER' : 'AGENT') + ':\n' + body);
  }
  let out = lines.join('\n\n---\n\n');
  if (out.length > 12000) out = '[earlier messages omitted]\n\n' + out.slice(out.length - 12000);
  return out;
}

const alreadySeen = (comments, id) =>
  comments.some(c => !c.public && String(c.plain_body || c.body || '').indexOf(MARK + ' c=' + id) > -1);

function noteFor(v, commentId) {
  const head = MARK + ' c=' + commentId + ' ' + v.verdict + (v.severity ? ' ' + v.severity : '') +
               (v.category ? ' ' + v.category : '');
  if (v.verdict === 'PASS') {
    return head + '\n\n' + (LANG === 'fr'
      ? 'Relecture de formation : la reponse ci-dessus respecte la procedure. Rien a corriger.'
      : 'Training review: the reply above follows the procedure. Nothing to correct.');
  }
  const body = LANG === 'fr'
    ? ['Relecture de formation.', '', v.note, '',
       'Regle concernee : ' + (v.rule || '(non precisee)'), '',
       'Reecris la reponse toi-meme en tenant compte de ce point. Aucune correction ' +
       'n\'est fournie ici : c\'est en la reformulant que la regle se retient.'].join('\n')
    : ['Training review.', '', v.note, '', 'Rule: ' + (v.rule || '(unspecified)'), '',
       'Rewrite the reply yourself with this in mind. No corrected version is given ' +
       'here on purpose - writing it is what makes the rule stick.'].join('\n');
  return head + '\n\n' + body;
}

const agentCache = new Map();
async function agentName(id) {
  if (!id) return 'unknown';
  if (agentCache.has(id)) return agentCache.get(id);
  let name = 'user ' + id;
  try {
    const u = await zd('/api/v2/users/' + id + '.json');
    if (u && u.user && u.user.name) name = u.user.name;
  } catch { /* a missing name must not cost us the review */ }
  agentCache.set(id, name);
  return name;
}

async function reviewTicket(ticket, opts) {
  const id = ticket.id;
  const out = { ticket: id, url: 'https://' + SB_SUB + '.zendesk.com/agent/tickets/' + id };

  const cj = await zd('/api/v2/tickets/' + id + '/comments.json?sort_order=asc&page[size]=100');
  const comments = cj.comments || [];
  const picked = pickReply(comments, ticket.requester_id);
  if (!picked) { out.skipped = 'no agent reply'; return out; }

  const commentId = picked.comment.id;
  out.comment = commentId;
  if (alreadySeen(comments, commentId)) { out.skipped = 'already reviewed'; return out; }

  const message = strip(picked.comment.plain_body || picked.comment.body);
  if (!message) { out.skipped = 'empty reply'; return out; }

  out.agent = await agentName(picked.comment.author_id);

  const prompt = [
    RUBRIC, '',
    '=== THE REFERENCE MATERIAL THE AGENT WAS SUPPOSED TO USE ===',
    knowledgeFor(ticket.brand_id) || '(no confirmed answer book for this brand - judge ' +
      'procedure, tags, conversion and tone, and treat any product name or rule stated ' +
      'in the reply as unverified)',
    '',
    '=== TAGS CURRENTLY ON THE TICKET ===',
    (ticket.tags || []).join(', ') || '(none)',
    '',
    '=== THE CONVERSATION, oldest first ===',
    buildTranscript(comments, picked.index, ticket.requester_id) || '(the reply is the first message)',
    '',
    '=== THE REPLY THE AGENT WROTE ===',
    message,
  ].join('\n');

  const v = parseVerdict(await judge(prompt));
  Object.assign(out, { verdict: v.verdict, severity: v.severity, category: v.category, note: v.note, rule: v.rule });
  if (!v.parsed) out.unparsed = true;
  if (opts.dry) { out.applied = false; return out; }

  const tags = (ticket.tags || []).slice();
  const add = t => { if (tags.indexOf(t) === -1) tags.push(t); };
  add(T_REVIEWED);
  if (v.verdict === 'FAIL') { add(T_TOFIX); add('training__' + v.category.toLowerCase()); }

  await zd('/api/v2/tickets/' + id + '.json', {
    method: 'PUT',
    body: { ticket: { comment: { body: noteFor(v, commentId), public: false }, tags } },
  });
  out.applied = true;
  return out;
}

/* ---------------------------------------------------------------- actions */

async function runTraining(req, res) {
  const refusal = refuseIfNotSandbox();
  if (refusal) return res.status(400).json({ ok: false, error: refusal });

  const q = { ...(req.query || {}), ...(req.method === 'POST' ? (req.body || {}) : {}) };
  const start = windowStart(q.since);
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 25, 1), 60);
  const dry = String(q.dry || '') === '1' || q.dry === true;

  const sj = await zd('/api/v2/search.json?sort_by=updated_at&sort_order=desc&query=' +
    encodeURIComponent('type:ticket updated>' + ymd(new Date(start.getTime() - 86400e3))));

  const candidates = (sj.results || [])
    .filter(t => t && t.result_type === 'ticket')
    .filter(t => new Date(t.updated_at).getTime() >= start.getTime())
    .slice(0, limit);

  const began = Date.now();
  const results = [];
  let cut = 0;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    if (Date.now() - began > BUDGET_MS) { cut = candidates.length - i; break; }
    const done = await Promise.all(candidates.slice(i, i + CONCURRENCY).map(async t => {
      try { return await reviewTicket(t, { dry }); }
      catch (e) { return { ticket: t.id, error: String(e && e.message || e).slice(0, 250) }; }
    }));
    for (const r of done) results.push(r);
  }

  const fails = results.filter(r => r.verdict === 'FAIL');
  return res.status(200).json({
    ok: true, sandbox: SB_SUB, dry,
    window: { from: start.toISOString(), to: new Date().toISOString() },
    scanned: (sj.results || []).length, reviewed: results.filter(r => r.verdict).length,
    passed: results.filter(r => r.verdict === 'PASS').length, failed: fails.length,
    remaining: cut, timedOut: cut > 0,
    results,
  });
}

/**
 * Who repeats what.
 *
 * A list of mistakes is a to-do list; the same list grouped by person and by
 * category is a training plan. That is the only reason this endpoint exists
 * separately from the run.
 */
async function runDigest(req, res) {
  const refusal = refuseIfNotSandbox();
  if (refusal) return res.status(400).json({ ok: false, error: refusal });

  const q = { ...(req.query || {}), ...(req.method === 'POST' ? (req.body || {}) : {}) };
  const start = windowStart(q.since || '7d');

  const sj = await zd('/api/v2/search.json?sort_by=updated_at&sort_order=desc&query=' +
    encodeURIComponent('type:ticket tags:' + T_TOFIX + ' updated>' + ymd(new Date(start.getTime() - 86400e3))));

  const tickets = (sj.results || [])
    .filter(t => t && t.result_type === 'ticket')
    .filter(t => new Date(t.updated_at).getTime() >= start.getTime())
    .slice(0, 120);

  const items = [];
  for (const t of tickets) {
    try {
      const cj = await zd('/api/v2/tickets/' + t.id + '/comments.json?sort_order=desc&page[size]=30');
      const comments = cj.comments || [];
      const note = comments.find(c => !c.public && String(c.plain_body || c.body || '').indexOf(MARK) === 0);
      if (!note) continue;
      const body = String(note.plain_body || note.body || '');
      const head = body.split('\n')[0].split(' ');
      if (head[2] !== 'FAIL') continue;
      const reply = comments.filter(c => c.public && c.author_id !== t.requester_id).pop();
      items.push({
        ticket: t.id,
        url: 'https://' + SB_SUB + '.zendesk.com/agent/tickets/' + t.id,
        agent: await agentName(reply && reply.author_id),
        severity: head[3] || '', category: head[4] || 'UNSPECIFIED',
        at: note.created_at,
      });
    } catch { /* one unreadable ticket must not lose the digest */ }
  }

  const byAgent = {};
  const byCategory = {};
  for (const i of items) {
    (byAgent[i.agent] = byAgent[i.agent] || []).push(i);
    byCategory[i.category] = (byCategory[i.category] || 0) + 1;
  }

  return res.status(200).json({
    ok: true, sandbox: SB_SUB,
    window: { from: start.toISOString(), to: new Date().toISOString() },
    total: items.length,
    high: items.filter(i => i.severity === 'HIGH').length,
    byAgent: Object.keys(byAgent).map(name => {
      const counts = {};
      for (const i of byAgent[name]) counts[i.category] = (counts[i.category] || 0) + 1;
      const worst = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
      return {
        agent: name, count: byAgent[name].length,
        // The one habit to work on with this person next.
        repeats: worst.slice(0, 3).map(c => c + ' x' + counts[c]),
        tickets: byAgent[name].map(i => i.ticket),
      };
    }).sort((a, b) => b.count - a.count),
    byCategory: Object.keys(byCategory).map(c => ({ category: c, count: byCategory[c] }))
      .sort((a, b) => b.count - a.count),
    items,
  });
}

/* ------------------------------------------------------------ entry point */

function authorised(req) {
  if (!REVIEW_SECRET && !CRON_SECRET) return false;
  const h = req.headers || {};
  const bearer = String(h.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const given = String(h['x-review-secret'] || (req.query && req.query.secret) || '').trim();
  if (REVIEW_SECRET && (given === REVIEW_SECRET || bearer === REVIEW_SECRET)) return true;
  if (CRON_SECRET && bearer === CRON_SECRET) return true;
  return false;
}

export async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!authorised(req)) {
    return res.status(401).json({
      error: 'Unauthorised.',
      how: 'Send the review secret as the x-review-secret header. Secrets live in the ' +
           'Vercel project environment - never in a Zendesk field or a chat message.',
    });
  }
  const action = String((req.query && req.query.action) || '').trim();
  try {
    if (action === 'training-digest') return await runDigest(req, res);
    return await runTraining(req, res);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e).slice(0, 500) });
  }
}

export default handler;
