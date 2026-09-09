/**
 * The flow simulator.
 *
 *   POST /api/flow-sim        (served through /api/support, secret required)
 *
 * WHAT IT IS FOR
 *
 * Until now the only way to find out what SKIBOT would answer was to send a mail
 * to info@alpy.com and wait: three minutes, one real Zendesk ticket, and a hard
 * ceiling of about fifteen tests an hour before Zendesk's loop protection starts
 * suspending the sender. On 9 September that ceiling stopped a replay of 314
 * mails at 69, and every prompt change since has been validated on one or two
 * tickets read by eye.
 *
 * This runs a flow WITHOUT Zendesk and WITHOUT mail. It takes the flow itself -
 * the real one, exported from the account - walks its wires, runs its steps, and
 * returns the reply the customer would have received, plus the branch that was
 * taken and the list of things the flow WOULD have written. Nothing is sent,
 * nothing is tagged, no ticket is created or touched.
 *
 * WHY IT DOES NOT DRIFT
 *
 * It does not re-implement the flows. The custom_code steps are executed as the
 * code they are; the prompt is the stored prompt, with its variables resolved;
 * the conditions are the stored conditions. The flow is passed in with the
 * request, read live from the account, so a simulation always runs the version
 * that is deployed. A re-implementation would have been wrong within a week -
 * this cannot be wrong without the real flow being wrong in the same way.
 *
 *   In the browser, on any Zendesk admin page (window.__gql reads the account):
 *     const wf = (await __gql(Q, { id: __IDS['General questions'] })).data.workflow;
 *     await fetch('https://alpy-cart-api.vercel.app/api/flow-sim', {
 *       method: 'POST',
 *       headers: { 'Content-Type': 'application/json', 'x-review-secret': SECRET },
 *       body: JSON.stringify({ workflow: wf, mails: [{ subject, body, from }] }),
 *     }).then(r => r.json());
 *
 * The session that can read the flows lives in the browser; the model key lives
 * here. Passing the flow in the request is what joins them, and it is also why
 * this endpoint needs no Zendesk credentials of its own and can never write.
 *
 * WHAT IT DOES NOT DO
 *
 * It is not a second Zendesk. Steps that write - a public reply, an internal
 * note, a tag, a status - are RECORDED and skipped, never executed. A step type
 * it does not know halts that run and says so by name, rather than guessing: a
 * simulator that quietly invents a step is worse than one that stops.
 *
 * SECRETS
 *
 * REVIEW_SECRET (or CRON_SECRET as a bearer) to call it, ANTHROPIC_API_KEY to
 * run the model step. Both already exist in this project.
 */

/* ------------------------------------------------------------------ config */

const ANTHROPIC_KEY = String(process.env.ANTHROPIC_API_KEY || '').trim();
const REVIEW_SECRET = String(process.env.REVIEW_SECRET || '').trim();
const CRON_SECRET   = String(process.env.CRON_SECRET || '').trim();
const MODEL = String(process.env.SIM_MODEL || process.env.REVIEW_MODEL || 'claude-sonnet-4-6').trim();

// Same reason as the reviewer: Vercel kills the function at 60s, so the loop
// stops dispatching before the platform stops it and returns what it has.
const BUDGET_MS = 48000;

// A flow is a few dozen steps; anything past this is a loop we do not want to
// discover in production.
const MAX_STEPS = 120;

/**
 * Custom API steps, by the type id the flow carries, to the route that serves
 * them here. These are OUR OWN endpoints - the same ones the Zendesk custom
 * action calls - so the simulated step and the real step hit identical code.
 *
 * A type id that is not in this table is reported, not guessed. Add it here (or
 * pass `apiMap` in the request) when a flow gains a new custom action.
 */
const API_MAP = {
  // General questions
  customapi_01M17534RMNGBSM2E02HTHC449_01M176FNSK7NP56XSK4CNSADH1: '/api/support?action=knowledge',
  customapi_01M0J8VMCWGETF88E66S0K770J_01M1K3WM4KNWMK412SKG27Z46N: '/api/requote-booking',
};

/**
 * Odin MCP steps. The flows reach Odin through Zendesk's MCP connector, which we
 * cannot call from here - but every read they do has a public twin on this API,
 * so the simulation reads the same data by another door.
 */
const MCP_MAP = {
  booking_search: '/api/search-bookings',
  booking_get_by_reference: '/api/get-booking',
};

// Steps that change the world. Recorded, never run.
const WRITE_PREFIXES = ['tickets_'];

/* -------------------------------------------------------------- expressions */

/**
 * A flow setting IS JavaScript.
 *
 * `condition` holds `evaluate_conditional("equals", step_kb.output.action, ` + '`ANSWER`' + `)`,
 * `comment_plain_body` holds a template literal, `inputs` holds an array of
 * objects whose `variable` is a path. So the honest evaluator is the language
 * itself: build a function whose scope is the steps' outputs and evaluate the
 * setting verbatim. Re-parsing it by hand would introduce exactly the
 * differences this endpoint exists to rule out.
 *
 * `with` is what makes `step_ctx.output.stage` resolve against the scope object
 * without rewriting the expression. It is the right tool here and the input is
 * our own flow definition, not user data.
 */
function evaluate_conditional(op, a, b) {
  const s = v => (v === null || v === undefined) ? '' : String(v);
  const arr = v => Array.isArray(v) ? v.map(s) : s(v).split(/[\s,]+/).filter(Boolean);
  switch (String(op)) {
    case 'equals':            return s(a) === s(b);
    case 'not_equals':        return s(a) !== s(b);
    case 'starts_with':       return s(a).indexOf(s(b)) === 0;
    case 'ends_with':         return s(a).lastIndexOf(s(b)) === s(a).length - s(b).length;
    case 'contains':          return s(a).indexOf(s(b)) > -1;
    case 'boolean_is_true':   return a === true || s(a).toLowerCase() === 'true';
    case 'boolean_is_false':  return !(a === true || s(a).toLowerCase() === 'true');
    case 'integer_equals':    return parseInt(s(a), 10) === parseInt(s(b), 10);
    case 'integer_not_equals':return parseInt(s(a), 10) !== parseInt(s(b), 10);
    case 'is_empty':          return s(a).trim() === '';
    case 'is_not_empty':      return s(a).trim() !== '';
    case 'array_intersects':      { const B = arr(b); return arr(a).some(x => B.indexOf(x) > -1); }
    case 'array_not_intersects':  { const B = arr(b); return !arr(a).some(x => B.indexOf(x) > -1); }
    default: throw new Error('unknown conditional operator: ' + op);
  }
}

/**
 * The empty value, at any depth.
 *
 * Reading `.output.whatever` off a step that never ran must give "" rather than
 * a TypeError - see the guard in evalSetting.
 */
const BLANK = new Proxy(function () {}, {
  get: (t, k) => {
    if (k === Symbol.toPrimitive) return () => '';
    if (k === 'toString' || k === 'valueOf') return () => '';
    if (k === Symbol.iterator) return function* () {};
    if (k === 'length') return 0;
    if (k === 'then') return undefined;          // never mistaken for a promise
    return BLANK;
  },
  apply: () => BLANK,
  has: () => true,
});

function evalSetting(expr, scope) {
  const src = String(expr === null || expr === undefined ? '' : expr);
  if (!src.trim()) return '';
  // An unresolved variable must not kill the run: the flow itself renders a
  // missing output as an empty string, so a Proxy that answers for anything
  // unknown reproduces that rather than throwing ReferenceError.
  const guard = new Proxy(scope, {
    has: () => true,
    get: (t, k) => {
      // `with` asks for this first, and a truthy answer would push every single
      // name out of scope - which read as "evaluate_conditional is not defined"
      // and cost an hour. It must be undefined, never BLANK.
      if (k === Symbol.unscopables) return undefined;
      if (k in t) return t[k];
      if (k === 'evaluate_conditional') return evaluate_conditional;
      // A step that has not run yet - a branch the flow did not take, or a step
      // this simulation stopped short of - must read as an empty string at every
      // depth. `${step_nope.output.thing}` has to render "", not throw: that is
      // what the flow does, and a simulator that dies on it would be unable to
      // run any prompt that mentions a step from the other branch.
      return BLANK;
    },
  });
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('__s', 'with (__s) { return (' + src + '); }');
    return fn(guard);
  } catch (e) {
    throw new Error('could not evaluate setting: ' + String(e && e.message || e) + ' :: ' + src.slice(0, 120));
  }
}

function settingOf(step, name) {
  const s = (step.settings || []).find(x => x && x.name === name);
  return s ? s.value : undefined;
}

/* ------------------------------------------------------------- step runners */

/**
 * A custom_code step, run as the module it is.
 *
 * Its `code` setting is a template literal holding `module.exports = function
 * (inputs) {...}`. It is NOT interpolated: the code is the code, and a `${` in
 * it would be a bug in the flow, not a variable to expand (the flows say so in
 * their own comments). `inputs` is an array of {name, variable} whose variables
 * are resolved against the scope.
 */
function runCustomCode(step, scope) {
  let code = String(settingOf(step, 'code') || '');
  if (code.charAt(0) === '`' && code.charAt(code.length - 1) === '`') code = code.slice(1, -1);
  const specRaw = settingOf(step, 'inputs');
  const inputs = {};
  if (specRaw) {
    // The array is evaluated whole: its `variable` entries are paths into scope.
    const spec = evalSetting(specRaw, scope);
    for (const it of (Array.isArray(spec) ? spec : [])) {
      if (it && it.name) inputs[it.name] = it.variable;
    }
  }
  const mod = { exports: null };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', code)(mod, mod.exports, () => { throw new Error('require is not available in a flow step'); });
  const fn = typeof mod.exports === 'function' ? mod.exports : null;
  if (!fn) throw new Error('custom_code did not export a function');
  const out = fn(inputs);
  return (out && typeof out === 'object') ? out : {};
}

async function callOwnApi(base, route, params, timeoutMs) {
  const url = base + route + (route.indexOf('?') > -1 ? '&' : '?') + '_sim=1';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 25000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!json) throw new Error(route + ' answered ' + r.status + ' with no JSON');
    return json;
  } finally {
    clearTimeout(t);
  }
}

/**
 * A Zendesk custom action passes its settings as flat parameters, and forces
 * every output name to lowercase. Both endpoints already answer in both
 * spellings for that reason; the lowercase mirror here makes a step that reads
 * `.carturl` behave exactly as it does in the account.
 */
function withLowercaseMirror(o) {
  const out = Object.assign({}, o || {});
  for (const k of Object.keys(o || {})) {
    const lk = k.toLowerCase();
    if (!(lk in out)) out[lk] = o[k];
  }
  return out;
}

async function askModel(prompt, model, maxTokens) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY is not configured');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 40000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model || MODEL,
        max_tokens: maxTokens || 2000,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error('Anthropic ' + r.status + ': ' + text.slice(0, 300));
    const j = JSON.parse(text);
    return (j.content || []).filter(c => c && c.type === 'text').map(c => c.text).join('\n');
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------ the interpreter */

function firstStep(wf) {
  const to = new Set((wf.wires || []).map(w => w.toName));
  const start = (wf.steps || []).find(s => !to.has(s.name));
  return start ? start.name : ((wf.steps || [])[0] || {}).name;
}

function nextStep(wf, name, outcome) {
  const wires = (wf.wires || []).filter(w => w.fromName === name);
  if (!wires.length) return null;
  if (outcome) {
    const w = wires.find(x => x.fromOutcome === outcome);
    if (w) return w.toName;
    return null;
  }
  const w = wires.find(x => !x.fromOutcome || x.fromOutcome === 'done') || wires[0];
  return w ? w.toName : null;
}

async function runFlow(wf, mail, opts) {
  const base = opts.base;
  const apiMap = Object.assign({}, API_MAP, opts.apiMap || {});
  const scope = {
    workflow: {
      input: {
        id: mail.ticket_id || 0,
        // The gatekeeper's run note is what a topic flow actually receives, and
        // its first line is the gate every topic flow tests. Without it a flow
        // stops at its own front door - which is a true simulation of a
        // mis-routed mail, and a useless one of a correctly routed mail.
        comment: { value: mail.comment != null ? String(mail.comment) : String(mail.body || '') },
        subject: String(mail.subject || ''),
        brand_id: mail.brand_id != null ? mail.brand_id : 0,
        requester_id: mail.requester_id || 0,
        tags: mail.tags || [],
        status: mail.status || 'new',
      },
    },
  };

  const trace = [];
  const actions = [];
  let cursor = opts.start || firstStep(wf);
  let steps = 0;
  let halted = null;
  let reply = null;
  let saidHandover = false;

  while (cursor && steps < MAX_STEPS) {
    if (Date.now() > opts.deadline) { halted = 'time budget exhausted at ' + cursor; break; }
    steps++;
    const step = (wf.steps || []).find(s => s.name === cursor);
    if (!step) { halted = 'step not found: ' + cursor; break; }
    const type = String((step.type && step.type.name) || '');
    const entry = { step: cursor, type };
    let outcome = null;

    try {
      if (WRITE_PREFIXES.some(p => type.indexOf(p) === 0)) {
        // Recorded, never executed. This is the whole safety story.
        const body = settingOf(step, 'comment_plain_body') || settingOf(step, 'comment_html_body');
        const tags = settingOf(step, 'tags');
        const status = settingOf(step, 'status');
        const act = { step: cursor, type };
        if (body !== undefined)   act.text   = String(evalSetting(body, scope)).slice(0, 4000);
        if (tags !== undefined)   act.tags   = evalSetting(tags, scope);
        if (status !== undefined) act.status = evalSetting(status, scope);
        actions.push(act);
        if (type === 'tickets_addPublicTicketComment' && act.text) reply = act.text;
        entry.recorded = true;

      } else if (type === 'if') {
        const cond = settingOf(step, 'condition');
        const val = !!evalSetting(cond, scope);
        outcome = val ? 'then' : 'else';
        entry.condition = String(cond).slice(0, 160);
        entry.result = val;

      } else if (type === 'custom_code') {
        const out = runCustomCode(step, scope);
        scope[cursor] = { output: withLowercaseMirror(out) };
        entry.output = Object.keys(out);

      } else if (type === 'claude_send_prompt') {
        const prompt = String(evalSetting(settingOf(step, 'prompt'), scope));
        entry.promptChars = prompt.length;
        if (opts.promptOnly) {
          scope[cursor] = { output: { content: '' } };
          entry.promptOnly = true;
          entry.prompt = prompt;
          halted = 'promptOnly: stopped before calling the model at ' + cursor;
          trace.push(entry);
          break;
        }
        const content = await askModel(prompt, opts.model, opts.maxTokens);
        scope[cursor] = { output: withLowercaseMirror({ content }) };
        entry.chars = content.length;
        // A flow's refusal is the single word HANDOVER coming out of the model,
        // and the ticket then gets a note instead of a reply. Read it here: by
        // the time the run ends there is no public comment to read it off.
        if (/^HANDOVER\b/.test(String(content).trim())) saidHandover = true;
        if (opts.keepPrompts) entry.prompt = prompt;

      } else if (type === 'users_getUserById') {
        // Supplied by the caller: the simulator never reads the account.
        scope[cursor] = { output: withLowercaseMirror({
          email: String(mail.from || ''),
          name: String(mail.name || ''),
          id: mail.requester_id || 0,
        }) };
        entry.stubbed = 'requester from the request';

      } else if (apiMap[type]) {
        const params = {};
        for (const st of (step.settings || [])) {
          if (!st || !st.name) continue;
          params[st.name] = evalSetting(st.value, scope);
        }
        const out = await callOwnApi(base, apiMap[type], params, opts.apiTimeoutMs);
        scope[cursor] = { output: withLowercaseMirror(out) };
        entry.api = apiMap[type];

      } else if (/_booking_search$/.test(type) || /_booking_get_by_reference$/.test(type)) {
        const route = /_booking_search$/.test(type) ? MCP_MAP.booking_search : MCP_MAP.booking_get_by_reference;
        const params = {};
        for (const st of (step.settings || [])) {
          if (!st || !st.name) continue;
          params[st.name] = evalSetting(st.value, scope);
        }
        const out = await callOwnApi(base, route, params, opts.apiTimeoutMs);
        scope[cursor] = { output: withLowercaseMirror(out) };
        entry.api = route;

      } else {
        // Deliberately fatal for this run. A step nobody taught the simulator
        // is a hole in the simulation, and it must be visible as one.
        halted = 'unsupported step type: ' + type + ' (' + cursor + ')';
        entry.unsupported = true;
        trace.push(entry);
        break;
      }
    } catch (e) {
      entry.error = String(e && e.message || e).slice(0, 300);
      halted = 'error at ' + cursor + ': ' + entry.error;
      trace.push(entry);
      break;
    }

    trace.push(entry);
    const next = nextStep(wf, cursor, outcome);
    if (!next) break;
    cursor = next;
  }

  if (steps >= MAX_STEPS) halted = halted || 'step ceiling reached - the flow may loop';

  return {
    id: mail.id !== undefined ? mail.id : null,
    subject: mail.subject || '',
    reply,
    // The single word this flow returns when it refuses to answer.
    handover: saidHandover || (typeof reply === 'string' ? /^HANDOVER\b/.test(reply.trim()) : false),
    path: trace.map(t => t.step + (t.result === true ? '[then]' : t.result === false ? '[else]' : '')),
    branches: trace.filter(t => t.type === 'if').map(t => ({ step: t.step, taken: t.result ? 'then' : 'else' })),
    wouldHaveWritten: actions,
    halted,
    trace: opts.verbose ? trace : undefined,
  };
}

/* ------------------------------------------------------------------- action */

export async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!authorised(req)) {
    return res.status(401).json({
      error: 'Unauthorised.',
      how: 'Send the review secret as the x-review-secret header, or as an Authorization ' +
           'bearer token. It lives in the Vercel project environment - never in a Zendesk ' +
           'field or a chat message.',
    });
  }

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const q = Object.assign({}, req.query || {}, body);

  const wf = q.workflow;
  if (!wf || !Array.isArray(wf.steps) || !Array.isArray(wf.wires)) {
    return res.status(400).json({
      error: 'No workflow supplied.',
      how: 'POST { workflow, mails } where workflow is the object returned by the account ' +
           'GraphQL read (steps and wires). The browser session is what can read it; this ' +
           'endpoint deliberately holds no Zendesk credentials and can therefore never write.',
    });
  }

  const mails = Array.isArray(q.mails) ? q.mails
              : (q.mail ? [q.mail]
              : (q.body || q.subject ? [{ subject: q.subject, body: q.body, from: q.from, brand_id: q.brand_id, comment: q.comment }] : []));
  if (!mails.length) return res.status(400).json({ error: 'No mail supplied. POST { workflow, mails: [{subject, body, from, brand_id, comment}] }.' });

  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const opts = {
    base: proto + '://' + host,
    start: q.start ? String(q.start) : null,
    model: q.model ? String(q.model) : MODEL,
    maxTokens: parseInt(q.maxTokens, 10) || 2000,
    apiMap: q.apiMap || null,
    apiTimeoutMs: parseInt(q.apiTimeoutMs, 10) || 25000,
    promptOnly: q.promptOnly === true || String(q.promptOnly || '') === '1',
    keepPrompts: q.keepPrompts === true || String(q.keepPrompts || '') === '1',
    verbose: q.verbose === true || String(q.verbose || '') === '1',
    deadline: Date.now() + (parseInt(q.budgetMs, 10) || BUDGET_MS),
  };

  const results = [];
  let remaining = 0;
  for (let i = 0; i < mails.length; i++) {
    if (Date.now() > opts.deadline) { remaining = mails.length - i; break; }
    try {
      results.push(await runFlow(wf, mails[i] || {}, opts));
    } catch (e) {
      results.push({ id: mails[i] && mails[i].id, error: String(e && e.message || e).slice(0, 300) });
    }
  }

  return res.status(200).json({
    ok: true,
    // Said out loud on every response, because the whole value of this endpoint
    // is that it is safe to run on anything.
    wroteNothing: true,
    flow: wf.title || null,
    model: opts.model,
    simulated: results.length,
    remaining,
    answered: results.filter(r => r.reply && !r.handover).length,
    handovers: results.filter(r => r.handover).length,
    halted: results.filter(r => r.halted).length,
    results,
  });
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

function authorised(req) {
  if (!REVIEW_SECRET && !CRON_SECRET) return false;
  const h = req.headers || {};
  const bearer = String(h.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const given = String(h['x-review-secret'] || (req.query && req.query.secret) || '').trim();
  if (REVIEW_SECRET && (given === REVIEW_SECRET || bearer === REVIEW_SECRET)) return true;
  if (CRON_SECRET && bearer === CRON_SECRET) return true;
  return false;
}

export default handler;
