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
const MAX_STEPS = 400;   // a for_each over a dozen items walks its body a dozen times

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

/**
 * The Zendesk step types that only READ. They share the tickets_ prefix with
 * the writes, and recording one as a write is not merely untidy: the step then
 * produces no output, so every later step that reads the ticket sees nothing
 * and the flow takes a branch it would never take in production.
 */
const TICKET_READ = /^tickets_(get|list|search|find|count)/;

/**
 * Odin steps that CHANGE something: cancel a booking or an item, refund a
 * payment, move a rental period. Recorded with their resolved parameters and
 * never executed - this simulator must stay safe to point at production data.
 */
const ODIN_READ = /_(payment_get_[a-z_]+|booking_refund_amount_by_coupon|payment_can_be_refunded|payment_is_refund_within_limit|booking_get_expiration|booking_get_item)$/;
const ODIN_WRITE = /_(booking_cancel|booking_cancel_item|booking_refund_amount_by_payment|payment_refund|booking_update_rental_period|booking_update_customer_info|booking_update_personal_info|booking_replace_shop|booking_send_update_email|booking_revert_canceled_item)$/;

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
    // "present" is Zendesk's own name for "this variable carries something".
    // BLANK stringifies to '', so an unrun step reads as absent, which is right.
    case 'present':           return s(a).trim() !== '';
    case 'not_present':       return s(a).trim() === '';
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
  const read = async (r) => {
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json };
  };
  try {
    let out = await read(await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
      signal: ctrl.signal,
    }));
    // Some of our own endpoints only answer GET. A POST to one of those comes
    // back 405 with a JSON error body, which the simulator used to hand to the
    // flow as if it were data: every booking lookup then read as "no booking"
    // and every flow took its no-booking branch. Retry the honest way instead.
    // 405 only: a 404 means "this route answered, and there is no such thing",
    // which is an answer. Retrying it as a GET turned a plain not-found into a
    // "405 Method not allowed" from the same endpoint, hiding the real result.
    if (out.status === 405) {
      const qs = Object.keys(params || {})
        .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '')
        .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(
          typeof params[k] === 'object' ? JSON.stringify(params[k]) : String(params[k])))
        .join('&');
      out = await read(await fetch(url + (qs ? '&' + qs : ''), { method: 'GET', signal: ctrl.signal }));
    }
    if (!out.json) throw new Error(route + ' answered ' + out.status + ' with no JSON');
    if (out.status >= 400) {
      // Loud on purpose: in production the connector gets a 200. A 4xx here is
      // a hole in the simulation, not a fact about the customer.
      throw new Error(route + ' answered ' + out.status + ': ' +
        String((out.json && (out.json.error || out.json.message)) || '').slice(0, 120));
    }
    return out.json;
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

/**
 * An object whose missing keys read as BLANK instead of throwing.
 *
 * Zendesk hands a flow a far richer ticket than a simulation can rebuild, and a
 * flow that touches `workflow.input.<something we did not model>.id` must read
 * as empty, not die. Symbols are passed through untouched so String(), JSON and
 * iteration keep working.
 */
function blankly(o) {
  return new Proxy(o, {
    has: () => true,
    get: (t, k) => (typeof k === 'symbol' || k in t) ? t[k] : BLANK,
  });
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
        comment: {
          value: mail.comment != null ? String(mail.comment) : String(mail.body || ''),
          // The gatekeeper's very first test is whether the comment was written
          // by the requester or by an agent. Without an author the whole flow
          // died on `comment.author.id` before doing anything at all.
          author: { id: mail.requester_id || 0, email: String(mail.from || ''), name: String(mail.name || '') },
          public: mail.public !== false,
        },
        subject: String(mail.subject || ''),
        brand_id: mail.brand_id != null ? mail.brand_id : 0,
        requester_id: mail.requester_id || 0,
        tags: mail.tags || [],
        status: mail.status || 'new',
      },
    },
  };
  // Written by update_custom_variables inside a loop body and read after it -
  // the Cancellation flow decides whether to answer the customer on this.
  scope.workflow.custom_variables = {};
  scope.workflow.input.comment = blankly(scope.workflow.input.comment);
  scope.workflow.input = blankly(scope.workflow.input);
  scope.workflow = blankly(scope.workflow);

  const trace = [];
  const actions = [];
  // Booking searches the caller did not feed - reported, never hidden.
  const unfedSearches = [];
  // Odin reads the simulator cannot perform - same rule: reported, never hidden.
  const unfedReads = [];
  // Open for_each steps, innermost last.
  const loopStack = [];
  // References this run "cancelled" - recorded, not really cancelled. Used only
  // when the caller asks the simulation to assume its writes worked, so that
  // the flow's own verification step (cancel, then read the booking back) does
  // not always conclude "the cancellation was refused" and hand over. Every
  // such assumption is listed in the result.
  const assumedCancelled = new Set();
  const assumptions = [];
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
      // A CANNED OUTPUT, SUPPLIED BY THE CALLER.
      //
      // Checked before anything else, and the reason the simulator can be
      // complete without pretending to reach systems it cannot reach. Zendesk's
      // MCP connector to Odin is one of those: the flows read shops through it,
      // Odin's REST equivalent is not public, and guessing its paths is how a
      // simulation quietly starts lying. Whoever runs the simulation usually CAN
      // read that data - the Odin tools are one call away in a Claude session -
      // so they hand it in, keyed by step name or by step type, and the trace
      // says plainly which steps were fed rather than executed.
      // NOTE: written as a ternary on purpose. `opts.stubs && (...)` yields null
      // when there are no stubs at all, and `null !== undefined` is true, which
      // silently stubbed EVERY step of every run.
      const stub = opts.stubs
        ? (opts.stubs[cursor] !== undefined ? opts.stubs[cursor] : opts.stubs[type])
        : undefined;
      if (stub !== undefined) {
        scope[cursor] = { output: withLowercaseMirror(stub && typeof stub === 'object' ? stub : { value: stub }) };
        entry.stubbed = 'supplied by the caller';
        trace.push(entry);
        const nx = nextStep(wf, cursor, null);
        if (!nx) {
          if (loopStack.length) { cursor = loopStack[loopStack.length - 1].step; continue; }
          break;
        }
        cursor = nx;
        continue;
      }

      // A DIRECTORY, SUPPLIED BY THE CALLER.
      //
      // The step-level stub above answers the same thing for every mail, which
      // is wrong for a lookup: General questions asks Odin for the shops of the
      // booking's own town, and each mail has a different town. So the caller
      // may instead hand in a directory - which setting to read, and what to
      // answer for each value that setting can take. One map covers a whole
      // batch, and a value the map does not carry is reported rather than
      // invented.
      const dir = opts.stubMaps && (opts.stubMaps[cursor] || opts.stubMaps[type]);
      if (dir && dir.map) {
        const raw = settingOf(step, dir.by);
        const key = String(evalSetting(raw, scope)).trim();
        const hit = Object.prototype.hasOwnProperty.call(dir.map, key) ? dir.map[key]
                  : (dir.fallback !== undefined ? dir.fallback : undefined);
        if (hit === undefined) {
          halted = 'no directory entry for ' + dir.by + '=' + JSON.stringify(key) + ' at ' + cursor;
          entry.missingDirectoryKey = key;
          trace.push(entry);
          break;
        }
        scope[cursor] = { output: withLowercaseMirror(hit && typeof hit === 'object' ? hit : { value: hit }) };
        entry.stubbed = 'directory ' + dir.by + '=' + key;
        trace.push(entry);
        const nx = nextStep(wf, cursor, null);
        if (!nx) {
          if (loopStack.length) { cursor = loopStack[loopStack.length - 1].step; continue; }
          break;
        }
        cursor = nx;
        continue;
      }

      if (TICKET_READ.test(type)) {
        // Supplied by the caller, like the requester: the simulator holds no
        // Zendesk credentials. `mail.ticket` is the ticket as Zendesk returns
        // it; without one, the little we do know about the mail.
        const t = (mail.ticket && typeof mail.ticket === 'object') ? mail.ticket : {
          id: mail.ticket_id || 0,
          subject: String(mail.subject || ''),
          description: String(mail.body || ''),
          status: mail.status || 'new',
          tags: mail.tags || [],
          brand_id: mail.brand_id != null ? mail.brand_id : 0,
          requester_id: mail.requester_id || 0,
        };
        scope[cursor] = { output: withLowercaseMirror(t) };
        entry.stubbed = mail.ticket ? 'ticket supplied by the caller' : 'ticket rebuilt from the mail';

      } else if (WRITE_PREFIXES.some(p => type.indexOf(p) === 0)) {
        // Recorded, never executed. This is the whole safety story.
        const body = settingOf(step, 'comment_plain_body') || settingOf(step, 'comment_html_body');
        const tags = settingOf(step, 'tags');
        const status = settingOf(step, 'status');
        const act = { step: cursor, type };
        if (body !== undefined)   act.text   = String(evalSetting(body, scope)).slice(0, 4000);
        if (tags !== undefined)   act.tags   = evalSetting(tags, scope);
        if (status !== undefined) act.status = evalSetting(status, scope);
        actions.push(act);
        // A flow answers the customer in two different ways, and reading only
        // the first made 25 of 39 Voucher Resend runs look like silent
        // non-answers: addPublicTicketComment, and updateTicket carrying
        // comment_public. Both are the reply.
        const pub = settingOf(step, 'comment_public');
        act.public = pub === undefined ? undefined : !!evalSetting(pub, scope);
        if (act.text && (type === 'tickets_addPublicTicketComment' ||
                        (type === 'tickets_updateTicket' && act.public))) reply = act.text;
        entry.recorded = true;

      } else if (type === 'for_each') {
        // A real loop. The body is walked once per item, with the current item
        // exposed the way Zendesk exposes it - step_<name>.output.item - and
        // the Odin writes inside it recorded rather than run. Skipping the body
        // (the first version of this) left every variable the body sets empty:
        // the Cancellation flow reads `cancelled_summary` after the loop to
        // decide whether to answer at all, so 23 of 35 runs looked like silent
        // non-answers that production would never produce.
        const open = loopStack.length && loopStack[loopStack.length - 1].step === cursor
                   ? loopStack[loopStack.length - 1] : null;
        if (!open) {
          let list = evalSetting(settingOf(step, 'items'), scope);
          if (typeof list === 'string') {
            try { list = JSON.parse(list); }
            catch { list = String(list).split(/[\s,]+/).filter(Boolean); }
          }
          if (!Array.isArray(list)) list = (list === '' || list == null) ? [] : [list];
          entry.loopTimes = list.length;
          if (!list.length) { outcome = 'done'; }
          else {
            loopStack.push({ step: cursor, list, i: 0 });
            scope[cursor] = { output: withLowercaseMirror({ item: list[0], index: 0 }) };
            outcome = 'loop';
          }
        } else {
          open.i++;
          if (open.i < open.list.length) {
            scope[cursor] = { output: withLowercaseMirror({ item: open.list[open.i], index: open.i }) };
            outcome = 'loop';
          } else { loopStack.pop(); outcome = 'done'; }
        }

      } else if (ODIN_WRITE.test(type)) {
        // Same rule as the ticket writes: recorded, never run.
        const params = {};
        for (const st of (step.settings || [])) {
          if (!st || !st.name) continue;
          params[st.name] = evalSetting(st.value, scope);
        }
        actions.push({ step: cursor, type, params });
        if (/_booking_cancel$/.test(type)) {
          const ref = String(params.bookingReference || params.reference || params.ref || '').trim().toUpperCase();
          if (ref) assumedCancelled.add(ref);
        }
        scope[cursor] = { output: withLowercaseMirror({ ok: true, simulated: true }) };
        entry.recorded = true;

      } else if (type === 'update_custom_variables') {
        // The setting is an array of { variable, value }; the account writes
        // them into workflow.custom_variables, which later steps read.
        let list = evalSetting(settingOf(step, 'custom_variables'), scope);
        if (!Array.isArray(list)) list = list ? [list] : [];
        const set = {};
        for (const v of list) {
          if (!v || !v.variable) continue;
          scope.workflow.custom_variables[v.variable] = v.value;
          set[v.variable] = true;
        }
        scope[cursor] = { output: withLowercaseMirror(set) };
        entry.output = Object.keys(set);

      } else if (ODIN_READ.test(type)) {
        // A read we cannot perform from here (payments, refund ceilings): it
        // answers empty AND says so, per run, so a branch taken because of it
        // is never mistaken for a finding about the customer.
        scope[cursor] = { output: withLowercaseMirror({}) };
        entry.unfedRead = type.replace(/^[a-z0-9]+_/, '');
        unfedReads.push(entry.unfedRead);

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
        // In verbose mode, keep what the model actually answered. Without it a
        // mis-extraction is invisible: the trace shows a prompt ran and a step
        // read nothing, with no way to tell which of the two was wrong.
        if (opts.verbose) entry.content = String(content).slice(0, 1500);
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

      } else if (/_booking_get_by_reference$/.test(type)) {
        // Odin's lookup by reference is public, so this one is honest: our own
        // /api/get-booking calls GET /api/v2/booking/{ref} with no token.
        // The MCP connector's parameter names are not our endpoint's.
        const p = {};
        for (const st of (step.settings || [])) {
          if (!st || !st.name) continue;
          p[st.name] = evalSetting(st.value, scope);
        }
        const params = {
          bookingReference: p.bookingReference || p.reference || p.ref || '',
          customerName: p.customerName || p.name || mail.name || 'x',
        };
        let out;
        try {
          out = await callOwnApi(base, MCP_MAP.booking_get_by_reference, params, opts.apiTimeoutMs);
        } catch (e) {
          // The MCP connector answers "no booking" where our endpoint answers
          // 400 (no reference given) or 404 (reference unknown). Treating those
          // as run-ending errors turned "the mail carried no booking code" -
          // an ordinary case the flow is built for - into a simulator failure.
          if (/answered (400|404)/.test(String(e && e.message))) {
            out = { found: false, reason: String(e.message).slice(0, 120) };
            entry.notFound = true;
          } else { throw e; }
        }
        // Our endpoint answers a FLATTENED booking (customerEmail, rentalFrom,
        // status) and keeps Odin's own object in `raw`. The flows read the MCP
        // connector's answer, which IS Odin's object - so a flow reading
        // customer.email saw nothing and concluded EMAIL_MISMATCH on 22 of 35
        // cancellations. Hand it the same shape the account gets.
        if (out && out.raw && typeof out.raw === 'object') out = out.raw;
        const ref = String(params.bookingReference || '').trim().toUpperCase();
        if (opts.assumeWrites && ref && assumedCancelled.has(ref)) {
          out = Object.assign({}, out, { status: 'CANCELED', bookingStatus: 'CANCELED' });
          entry.assumed = 'cancelled ' + ref;
          assumptions.push('booking ' + ref + ' read back as CANCELLED because this run recorded a cancel for it');
        }
        scope[cursor] = { output: withLowercaseMirror(out) };
        entry.api = MCP_MAP.booking_get_by_reference;

      } else if (/_booking_search$/.test(type)) {
        // Searching Odin by customer e-mail needs credentials this endpoint
        // deliberately does not hold - and /api/search-bookings cannot stand in
        // for it: its Odin OAuth client is refused (401 invalid_client). So the
        // caller feeds it, or the step answers "found nothing" AND SAYS SO. The
        // difference matters: a silent empty answer sends every flow down its
        // no-booking branch and the run looks like a finding about the customer
        // rather than a hole in the simulation.
        const p = {};
        for (const st of (step.settings || [])) {
          if (!st || !st.name) continue;
          p[st.name] = evalSetting(st.value, scope);
        }
        const key = String(p.customerEmail || p.email || mail.from || '').trim().toLowerCase();
        const table = (opts.bookings && typeof opts.bookings === 'object') ? opts.bookings : null;
        const hit = table && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
        if (hit) {
          scope[cursor] = { output: withLowercaseMirror(hit) };
          entry.stubbed = 'bookings supplied for ' + key;
        } else {
          scope[cursor] = { output: withLowercaseMirror({ bookings: [], data: [], total: 0 }) };
          entry.unfed = key || '(no e-mail)';
          unfedSearches.push(key || '(no e-mail)');
        }
        entry.api = 'booking_search (directory)';

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
    if (!next) {
      // The end of a for_each body has no wire back: Zendesk returns to the
      // loop step itself. So do we.
      if (loopStack.length) { cursor = loopStack[loopStack.length - 1].step; continue; }
      break;
    }
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
    stubbedSteps: trace.filter(t => t.stubbed).map(t => t.step),
    unfedBookingSearches: unfedSearches,
    unfedOdinReads: unfedReads,
    assumptions,
    halted,
    trace: opts.verbose ? trace : undefined,
  };
}

/* ------------------------------------------------------------------- action */

export async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // THIS ENDPOINT IS CALLED FROM A BROWSER TAB, ON PURPOSE.
  //
  // The flow definition can only be read by the Zendesk session, which lives in
  // the browser - so the request that carries it comes from a Zendesk page, and
  // a cross-origin POST with a custom header is preflighted. Without these
  // headers the call fails as "Failed to fetch" before it ever reaches us.
  //
  // Opening it to any origin is safe here and nowhere near as broad as it looks:
  // there is no cookie and no session to ride on, the secret travels in a header
  // a page must set deliberately, and the endpoint holds no Zendesk credentials,
  // so the worst a caller can do with the secret is spend model tokens.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-review-secret, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  // Answered before the secret is checked: a preflight carries no custom header,
  // so demanding one here would reject every browser call on its first hop.
  if (req.method === 'OPTIONS') return res.status(200).end();

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});

  if (!authorised(req, body)) {
    // Enough to tell a wrong value from a missing one, and nothing more.
    //
    // Two afternoons went into a 401 that turned out to be two different
    // strings on the two sides, with no way to see which. Lengths compare
    // safely: they cannot reconstruct a secret, and they answer the only
    // question worth asking - is this the same value or another one.
    const p = presentedSecret(req, body);
    const presentedLen = Math.max(p.header.length, p.bearer.length, p.inBody.length);
    return res.status(401).json({
      error: 'Unauthorised.',
      how: 'Send the secret as the x-review-secret header, as an Authorization bearer ' +
           'token, or as a "secret" field in the JSON body. Never in the URL.',
      diagnostic: presentedLen
        ? ('a secret of ' + presentedLen + ' characters was presented; the one configured ' +
           'here is ' + REVIEW_SECRET.length + ' characters long' +
           (presentedLen === REVIEW_SECRET.length
             ? ' - the same length, so the difference is inside the value: retype it on both sides.'
             : ' - different lengths, so they are simply not the same value.'))
        : 'no secret was presented at all - the header did not arrive.',
      configured: { reviewSecret: REVIEW_SECRET.length > 0, cronSecret: CRON_SECRET.length > 0 },
    });
  }
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
    stubs: (q.stubs && typeof q.stubs === 'object') ? q.stubs : null,
    stubMaps: (q.stubMaps && typeof q.stubMaps === 'object') ? q.stubMaps : null,
    bookings: (q.bookings && typeof q.bookings === 'object') ? q.bookings : null,
    assumeWrites: q.assumeWrites === true || String(q.assumeWrites || '') === '1',
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

/**
 * The secret may travel in a header OR in the JSON body.
 *
 * The body is there because a custom header turns a cross-origin POST into a
 * preflighted request, and a preflight that is answered wrongly fails as a bare
 * "Failed to fetch" with nothing to debug. A field in the body has none of that
 * machinery in the way. It is never accepted in the URL: a query string is
 * logged, kept in history and shared by copy-paste, which a secret must not be.
 */
function presentedSecret(req, body) {
  const h = req.headers || {};
  const bearer = String(h.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const header = String(h['x-review-secret'] || '').trim();
  const inBody = String((body && (body.secret || body.review_secret)) || '').trim();
  return { header, bearer, inBody };
}

function authorised(req, body) {
  if (!REVIEW_SECRET && !CRON_SECRET) return false;
  const p = presentedSecret(req, body);
  if (REVIEW_SECRET && (p.header === REVIEW_SECRET || p.bearer === REVIEW_SECRET || p.inBody === REVIEW_SECRET)) return true;
  if (CRON_SECRET && (p.bearer === CRON_SECRET || p.inBody === CRON_SECRET)) return true;
  return false;
}

export default handler;
