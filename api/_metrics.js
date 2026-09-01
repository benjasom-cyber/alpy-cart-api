/**
 * GET /api/metrics?days=30        (served through /api/support?action=metrics)
 *
 * The numbers behind the support dashboard: what the bot finished, what it
 * handed over, what it dropped in silence, and what that leaves the agents.
 *
 * WHY THE TAGS ARE ENOUGH
 *
 * Everything below is computed from the ticket list alone - tags, status,
 * timestamps, assignee. No comment is fetched. That is a deliberate constraint:
 * comments would mean one HTTP call per ticket, which is a minute of runtime for
 * a month of traffic, and this endpoint has sixty seconds. The tags our flows
 * already write turn out to say everything we need:
 *
 *   routed_by_system   the gatekeeper looked at it
 *   skibot_answered    a public reply was sent by a flow
 *   skibot_handled     a flow acted on the booking
 *   needs_human        a flow asked for a human
 *   handover_*         why it asked
 *   awaiting__*        a flow is waiting for the customer
 *
 * THE ONE METRIC NOBODY HAS TODAY
 *
 * A ticket tagged `routed_by_system` with NO answer tag, NO handover tag and no
 * agent reply is a ticket a flow started and abandoned without writing a line.
 * That is exactly what happened on 581853, and it took an hour and the execution
 * logs to notice ONE of them. Counted here, it is a number on a page.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED
 *
 * Handling time per agent is not "time the agent spent" - Zendesk does not
 * expose that without Explore. What is measured is the wall-clock from creation
 * to solve, which is a service-level number, not a productivity one. It is
 * labelled as such on the page rather than dressed up.
 */

const ZD_SUB = String(process.env.ZENDESK_SUBDOMAIN || '')
  .trim()
  .replace(/^https?:\/\//i, '')
  .replace(/\/.*$/, '')
  .replace(/\.zendesk\.com$/i, '');
const ZD_EMAIL = String(process.env.ZENDESK_EMAIL || '').trim();
const ZD_TOKEN = String(process.env.ZENDESK_API_TOKEN || '').trim();

const METRICS_SECRET = String(process.env.METRICS_SECRET || process.env.REVIEW_SECRET || '').trim();

const BUDGET_MS = 45000;

function zdAuth() {
  if (!ZD_SUB || !ZD_EMAIL || !ZD_TOKEN) return null;
  return 'Basic ' + Buffer.from(ZD_EMAIL + '/token:' + ZD_TOKEN).toString('base64');
}

async function zd(path, timeout) {
  const auth = zdAuth();
  if (!auth) throw new Error('Zendesk credentials are not configured');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout || 15000);
  try {
    const r = await fetch('https://' + ZD_SUB + '.zendesk.com' + path, {
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('Zendesk ' + r.status + ' on ' + path.split('?')[0]);
    return await r.json();
  } finally { clearTimeout(t); }
}

const day = (d) => new Date(d).toISOString().slice(0, 10);

function median(xs) {
  const a = xs.filter(x => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

/** The capability a ticket was routed to, read from the tags we already write. */
const CAPABILITY_TAGS = [
  ['cancellation',        /^(awaiting__cancellation|cancellation_before|cancellation_after)$/],
  ['partial_cancellation',/^(partial_cancellation|partial_cancelled|partial_cancel_clarify)$/],
  ['date_change',         /^(change_of_dates|date_change_refused|change)$/],
  ['quote',               /^(quote|awaiting__quote)$/],
  ['requote',             /^requote/],
  ['voucher',             /^(voucher|awaiting__voucher_resend)$/],
  ['general_question',    /^(general_question|awaiting__general_question)$/],
  ['depot_switch',        /^(depot|switch|shop_services)/],
];

function capabilityOf(tags) {
  for (const [name, re] of CAPABILITY_TAGS) {
    if (tags.some(t => re.test(t))) return name;
  }
  return 'other';
}

function classify(t) {
  const tags = t.tags || [];
  const has = (x) => tags.indexOf(x) > -1;
  const handoverTag = tags.find(x => x.indexOf('handover_') === 0) || '';

  const routed    = has('routed_by_system');
  const answered  = has('skibot_answered');
  const acted     = has('skibot_handled');
  const waiting   = tags.some(x => x.indexOf('awaiting__') === 0);
  const human     = has('needs_human') || !!handoverTag;
  const spam      = has('x_spam') || has('suspended');

  // Started and left no trace. Not "the bot decided to stay silent" - that is
  // `needs_human` - but a run that wrote nothing at all.
  const silent = routed && !answered && !acted && !human && !waiting && !spam;

  return {
    routed, answered, acted, waiting, human, spam, silent,
    handoverReason: handoverTag || (has('needs_human') ? 'needs_human' : ''),
    capability: capabilityOf(tags),
    solved: t.status === 'solved' || t.status === 'closed',
    createdAt: t.created_at,
    solvedAt: (t.status === 'solved' || t.status === 'closed') ? t.updated_at : null,
    assignee: t.assignee_id || null,
    reopens: 0,
  };
}

/**
 * Every ticket created in the window.
 *
 * The search API is the only endpoint that filters on creation date without
 * walking the whole account, and it pages 100 at a time. A month of Alpy traffic
 * is a few thousand tickets, so a handful of seconds - but the budget is checked
 * on every page so a busy month degrades into a partial answer instead of a
 * timeout.
 */
async function fetchTickets(sinceDay, deadline) {
  const out = [];
  let url = '/api/v2/search.json?sort_by=created_at&sort_order=desc&query=' +
            encodeURIComponent('type:ticket created>' + sinceDay);
  let pages = 0;
  let truncated = false;
  while (url && pages < 60) {
    if (Date.now() > deadline) { truncated = true; break; }
    const j = await zd(url);
    for (const t of (j.results || [])) if (t && t.id) out.push(t);
    pages++;
    if (!j.next_page) break;
    url = j.next_page.replace(/^https?:\/\/[^/]+/, '');
  }
  return { tickets: out, pages, truncated };
}

export async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // A read-only endpoint, but it exposes the shape of the support operation, so
  // it is not left open. The dashboard passes the same secret.
  if (METRICS_SECRET) {
    const given = String(req.query.secret || req.headers['x-metrics-secret'] || '');
    if (given !== METRICS_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  }

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
  const since = new Date(Date.now() - days * 86400000);
  const deadline = Date.now() + BUDGET_MS;

  let data;
  try {
    data = await fetchTickets(day(since), deadline);
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
  }

  const rows = data.tickets.map(classify);

  // ── The bot ──────────────────────────────────────────────────────────────
  const routed = rows.filter(r => r.routed && !r.spam);
  const answered = routed.filter(r => r.answered);
  const acted = routed.filter(r => r.acted);
  const humans = routed.filter(r => r.human);
  const silent = routed.filter(r => r.silent);
  const waiting = routed.filter(r => r.waiting && !r.human);

  // Finished without a human: the bot replied or acted, and nobody was called.
  const finished = routed.filter(r => (r.answered || r.acted) && !r.human);

  const byReason = {};
  for (const r of humans) {
    const k = r.handoverReason || 'needs_human';
    byReason[k] = (byReason[k] || 0) + 1;
  }

  const byCapability = {};
  for (const r of routed) {
    const c = r.capability;
    byCapability[c] = byCapability[c] || { total: 0, finished: 0, human: 0, silent: 0 };
    byCapability[c].total++;
    if ((r.answered || r.acted) && !r.human) byCapability[c].finished++;
    if (r.human) byCapability[c].human++;
    if (r.silent) byCapability[c].silent++;
  }

  // ── The agents ───────────────────────────────────────────────────────────
  const solvedRows = rows.filter(r => r.solved && r.solvedAt);
  const byAgent = {};
  for (const r of solvedRows) {
    const k = r.assignee ? String(r.assignee) : 'unassigned';
    byAgent[k] = byAgent[k] || { solved: 0, durations: [], afterHandover: 0 };
    byAgent[k].solved++;
    const ms = new Date(r.solvedAt) - new Date(r.createdAt);
    if (Number.isFinite(ms) && ms >= 0) byAgent[k].durations.push(ms);
    if (r.human) byAgent[k].afterHandover++;
  }
  const agents = Object.entries(byAgent).map(([id, v]) => ({
    assignee_id: id,
    solved: v.solved,
    // Wall clock from creation to solve. NOT time spent - see the header.
    median_hours_to_solve: v.durations.length
      ? Math.round(median(v.durations) / 36000) / 100 : null,
    solved_after_handover: v.afterHandover,
  })).sort((a, b) => b.solved - a.solved);

  // Names, one call, only for the agents who appear.
  const ids = agents.map(a => a.assignee_id).filter(x => /^\d+$/.test(x)).slice(0, 60);
  if (ids.length && Date.now() < deadline) {
    try {
      const uj = await zd('/api/v2/users/show_many.json?ids=' + ids.join(','));
      const byId = {};
      for (const u of (uj.users || [])) byId[String(u.id)] = u.name;
      for (const a of agents) a.name = byId[a.assignee_id] || a.assignee_id;
    } catch { /* names are a nicety, never a reason to fail */ }
  }
  for (const a of agents) if (!a.name) a.name = a.assignee_id === 'unassigned' ? 'Non assigné' : a.assignee_id;

  // ── The day-by-day series ────────────────────────────────────────────────
  const series = {};
  for (const r of rows) {
    const d = day(r.createdAt);
    series[d] = series[d] || { day: d, tickets: 0, finished: 0, human: 0, silent: 0 };
    series[d].tickets++;
    if (r.routed && (r.answered || r.acted) && !r.human) series[d].finished++;
    if (r.routed && r.human) series[d].human++;
    if (r.routed && r.silent) series[d].silent++;
  }
  const daily = Object.values(series).sort((a, b) => a.day < b.day ? -1 : 1);

  // ── The phone ────────────────────────────────────────────────────────────
  //
  // Zendesk Talk is live on this account (lines, greetings and stats all answer),
  // and agents_activity carries exactly what a head of support needs this season:
  // online_time, available_time, away_time, the current agent_state, and calls
  // accepted / denied / missed per agent.
  //
  // ONE THING TO KNOW ABOUT THESE NUMBERS: they are a ROLLING snapshot, not a
  // history. Zendesk resets them; there is no historical endpoint on this plan
  // (historical_queue_activity returns 404). So the page shows them as "right
  // now", and a trend needs this endpoint called on a schedule and the answers
  // stored - see the note in the dashboard.
  let talk = null;
  if (Date.now() < deadline) {
    try {
      const [act, queue, over] = await Promise.all([
        zd('/api/v2/channels/voice/stats/agents_activity.json'),
        zd('/api/v2/channels/voice/stats/current_queue_activity.json'),
        zd('/api/v2/channels/voice/stats/account_overview.json'),
      ]);
      const list = (act.agents_activity || []).map(a => ({
        agent_id: a.agent_id,
        name: a.name,
        state: a.agent_state,
        call_status: a.call_status,
        online_seconds: a.online_time,
        available_seconds: a.available_time,
        away_seconds: a.away_time,
        calls_accepted: a.calls_accepted,
        calls_denied: a.calls_denied,
        calls_missed: a.calls_missed,
        average_talk_seconds: a.average_talk_time,
        total_talk_seconds: a.total_talk_time,
        total_wrapup_seconds: a.total_wrap_up_time,
      })).sort((x, y) => (y.online_seconds || 0) - (x.online_seconds || 0));
      const answered = list.reduce((n, a) => n + (a.calls_accepted || 0), 0);
      const missed = list.reduce((n, a) => n + (a.calls_missed || 0) + (a.calls_denied || 0), 0);
      talk = {
        agents: list,
        agents_online: (queue.current_queue_activity || {}).agents_online,
        calls_waiting: (queue.current_queue_activity || {}).calls_waiting,
        longest_wait_seconds: (queue.current_queue_activity || {}).longest_wait_time,
        average_wait_seconds: (queue.current_queue_activity || {}).average_wait_time,
        calls_answered: answered,
        calls_missed: missed,
        answer_rate_pct: (answered + missed) ? Math.round(answered * 1000 / (answered + missed)) / 10 : null,
        account: over.account_overview || null,
        rolling_snapshot: true,
      };
    } catch (e) {
      talk = { error: String((e && e.message) || e).slice(0, 160) };
    }
  }

  const pct = (n, d) => d ? Math.round(n * 1000 / d) / 10 : null;

  return res.status(200).json({
    ok: true,
    generated_at: new Date().toISOString(),
    window_days: days,
    truncated: data.truncated,
    pages_read: data.pages,

    totals: {
      tickets: rows.length,
      routed_by_system: routed.length,
      spam: rows.filter(r => r.spam).length,
    },

    bot: {
      finished_without_human: finished.length,
      finished_rate_pct: pct(finished.length, routed.length),
      answered: answered.length,
      acted_on_booking: acted.length,
      handed_over: humans.length,
      handover_rate_pct: pct(humans.length, routed.length),
      waiting_on_customer: waiting.length,
      // The one nobody measures. Every unit is a customer who got nothing.
      silent_failures: silent.length,
      silent_rate_pct: pct(silent.length, routed.length),
      handover_reasons: Object.entries(byReason)
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      by_capability: Object.entries(byCapability)
        .map(([capability, v]) => ({
          capability,
          ...v,
          finished_rate_pct: pct(v.finished, v.total),
        }))
        .sort((a, b) => b.total - a.total),
    },

    agents,
    talk,
    daily,
  });
}

export default handler;
