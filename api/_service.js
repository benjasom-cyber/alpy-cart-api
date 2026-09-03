/**
 * GET /api/metrics-service?month=YYYY-MM   (via /api/support?action=metrics-service)
 *
 * THE NUMBERS THAT USED TO LIVE IN EXPLORE.
 *
 * "Board 2025" carried six widgets — ticket volume, % satisfaction, good
 * satisfaction, first reply time, call talk time, missed and declined call legs
 * — split by agent. Five of them are computed here; the two call widgets belong
 * to the Talk export and live in _phone.js, which already reads it.
 *
 * HOW THE MONTH IS READ, AND WHY NOT WITH SEARCH
 *
 * `/api/v2/search.json` caps out and pages badly past a few thousand hits. The
 * incremental ticket export does not: 1000 per page, ordered by update time,
 * `end_of_stream` when it is done. It also side-loads `metric_sets`, which is
 * the whole reason first reply time is affordable here — the alternative is one
 * HTTP call per ticket, i.e. a minute of runtime for a busy month.
 *
 * Records come back ordered by `updated_at`, not `created_at`, so a ticket
 * created on the 31st and touched in the next month arrives late: the walk
 * continues two days past the month end and filters on `created_at`.
 *
 * WHAT EACH NUMBER MEANS, EXACTLY
 *
 *   first reply time    minutes between ticket creation and the first PUBLIC
 *                       agent reply, as Zendesk itself computes it. Reported as
 *                       a median and a 90th percentile, never as an average: one
 *                       ticket answered after a week moves an average and tells
 *                       you nothing. Tickets the bot answered are included —
 *                       excluding them would flatter the number.
 *
 *   full resolution     creation to solve, wall clock. A service level, not a
 *                       time spent. Zendesk does not expose time spent.
 *
 *   satisfaction        offered / answered / good, from the ratings endpoint
 *                       (which does filter on time, unlike most of Talk). The
 *                       score is good ÷ answered, the same definition Explore
 *                       uses, so the two agree.
 *
 *   one touch           solved with a single public agent reply. The closest
 *                       honest proxy for "handled in one go".
 *
 * PER AGENT
 *
 * Everything above is also grouped by assignee, because a support operation is
 * not one queue and the board it replaces was already split that way. The agent
 * of a ticket is its assignee at the time of reading — a ticket reassigned after
 * being solved is credited to whoever holds it now, which is the same thing
 * Explore does.
 */

const ZD_SUB = String(process.env.ZENDESK_SUBDOMAIN || '')
  .trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\.zendesk\.com$/i, '');
const ZD_EMAIL = String(process.env.ZENDESK_EMAIL || '').trim();
const ZD_TOKEN = String(process.env.ZENDESK_API_TOKEN || '').trim();
const METRICS_SECRET = String(process.env.METRICS_SECRET || process.env.REVIEW_SECRET || '').trim();

const BUDGET_MS = 50000;

const CACHE = globalThis.__serviceCache || (globalThis.__serviceCache = new Map());

function zdAuth() {
  if (!ZD_SUB || !ZD_EMAIL || !ZD_TOKEN) return null;
  return 'Basic ' + Buffer.from(ZD_EMAIL + '/token:' + ZD_TOKEN).toString('base64');
}

async function zd(url, timeout) {
  const auth = zdAuth();
  if (!auth) throw new Error('Zendesk credentials are not configured');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout || 20000);
  try {
    const full = url.indexOf('http') === 0 ? url : 'https://' + ZD_SUB + '.zendesk.com' + url;
    const r = await fetch(full, { headers: { Authorization: auth, Accept: 'application/json' }, signal: ctrl.signal });
    if (!r.ok) throw new Error('Zendesk ' + r.status + ' on ' + full.split('?')[0]);
    return await r.json();
  } finally { clearTimeout(t); }
}

function monthBounds(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '');
  if (!m) return null;
  return { start: Date.UTC(+m[1], +m[2] - 1, 1), end: Date.UTC(+m[1], +m[2], 1) };
}

const pct = (n, d) => (d ? Math.round((n * 1000) / d) / 10 : null);

function pctile(xs, p) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
}

/** The ticket's channel, folded into the handful of names anyone uses. */
function channelOf(t) {
  const c = (t.via && t.via.channel) || 'unknown';
  if (c === 'email') return 'email';
  if (c === 'voice' || c === 'phone') return 'phone';
  if (c === 'web' || c === 'web_form') return 'web_form';
  if (c === 'chat' || c === 'native_messaging' || c === 'messaging') return 'messaging';
  if (c === 'api' || c === 'rule' || c === 'system') return 'automated';
  return c;
}

/**
 * One pass over the month, metric sets side-loaded. The side-load is requested
 * but never assumed: if the plan stops returning it, every timing falls to null
 * and the counts still stand, rather than the whole endpoint failing.
 */
async function walkMonth(b, deadline) {
  let url = '/api/v2/incremental/tickets.json?include=metric_sets&start_time=' +
    Math.floor(b.start / 1000);
  const tickets = [];
  const metrics = new Map();   // ticket_id -> metric_set
  let pages = 0, truncated = false, metricSetsSeen = 0;

  while (url) {
    if (Date.now() > deadline) { truncated = true; break; }
    const d = await zd(url);
    pages++;
    for (const ms of (d.metric_sets || [])) {
      if (ms && ms.ticket_id != null) { metrics.set(ms.ticket_id, ms); metricSetsSeen++; }
    }
    const batch = d.tickets || [];
    for (const t of batch) {
      const c = Date.parse(t.created_at);
      if (c >= b.start && c < b.end) tickets.push(t);
    }
    const last = batch.length
      ? (batch[batch.length - 1].generated_timestamp
          ? batch[batch.length - 1].generated_timestamp * 1000
          : Date.parse(batch[batch.length - 1].updated_at))
      : 0;
    if (d.end_of_stream || !d.next_page || last > b.end + 2 * 86400000) break;
    url = d.next_page;
  }
  return { tickets, metrics, pages, truncated, metricSetsSeen };
}

/** Ratings for the month. This endpoint does honour start_time / end_time. */
async function ratingsOfMonth(b, deadline) {
  let url = '/api/v2/satisfaction_ratings.json?start_time=' + Math.floor(b.start / 1000) +
    '&end_time=' + Math.floor(b.end / 1000) + '&per_page=100';
  const rows = [];
  let pages = 0;
  while (url && pages < 40) {
    if (Date.now() > deadline) break;
    const d = await zd(url);
    pages++;
    for (const r of (d.satisfaction_ratings || [])) rows.push(r);
    if (!d.next_page) break;
    url = d.next_page.replace(/^https?:\/\/[^/]+/, '');
  }
  return rows;
}

export async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (METRICS_SECRET) {
    const given = String(req.query.secret || req.headers['x-metrics-secret'] || '');
    if (given !== METRICS_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const now = new Date();
  const month = String(req.query.month || '').trim() || now.toISOString().slice(0, 7);
  const b = monthBounds(month);
  if (!b) return res.status(400).json({ ok: false, error: 'month must be YYYY-MM' });

  const hit = CACHE.get(month);
  const isCurrent = month === now.toISOString().slice(0, 7);
  if (hit && Date.now() - hit.at < (isCurrent ? 5 * 60 * 1000 : 30 * 60 * 1000)) {
    return res.status(200).json({ ...hit.value, cached: true });
  }

  const deadline = Date.now() + BUDGET_MS;
  try {
    const { tickets, metrics, pages, truncated, metricSetsSeen } = await walkMonth(b, deadline);

    const frt = [], frtBusiness = [], full = [];
    const byChannel = {};
    const byAgent = {};
    let solved = 0, oneTouch = 0, reopened = 0, withReply = 0;

    for (const t of tickets) {
      const ms = metrics.get(t.id) || null;
      const ch = channelOf(t);
      byChannel[ch] = (byChannel[ch] || 0) + 1;

      const isSolved = t.status === 'solved' || t.status === 'closed';
      if (isSolved) solved++;

      const reply = ms && ms.reply_time_in_minutes ? ms.reply_time_in_minutes.calendar : null;
      const replyBiz = ms && ms.reply_time_in_minutes ? ms.reply_time_in_minutes.business : null;
      const res_ = ms && ms.full_resolution_time_in_minutes ? ms.full_resolution_time_in_minutes.calendar : null;
      const replies = ms ? (ms.replies || 0) : 0;
      const reopens = ms ? (ms.reopens || 0) : 0;

      if (Number.isFinite(reply)) { frt.push(reply); withReply++; }
      if (Number.isFinite(replyBiz)) frtBusiness.push(replyBiz);
      if (Number.isFinite(res_)) full.push(res_);
      if (reopens > 0) reopened++;
      if (isSolved && replies === 1) oneTouch++;

      const k = t.assignee_id ? String(t.assignee_id) : 'unassigned';
      const a = byAgent[k] || (byAgent[k] = {
        assignee_id: k, tickets: 0, solved: 0, one_touch: 0, reopened: 0,
        _frt: [], _res: [], csat_good: 0, csat_bad: 0,
      });
      a.tickets++;
      if (isSolved) a.solved++;
      if (isSolved && replies === 1) a.one_touch++;
      if (reopens > 0) a.reopened++;
      if (Number.isFinite(reply)) a._frt.push(reply);
      if (Number.isFinite(res_)) a._res.push(res_);
    }

    // ── Satisfaction ─────────────────────────────────────────────────────────
    let csat = { offered: 0, answered: 0, good: 0, bad: 0, score_pct: null, response_rate_pct: null };
    try {
      const rows = await ratingsOfMonth(b, deadline);
      const ticketAgent = new Map();
      for (const t of tickets) ticketAgent.set(t.id, t.assignee_id ? String(t.assignee_id) : 'unassigned');
      for (const r of rows) {
        const s = r.score;
        if (s === 'offered' || s === 'unoffered') { csat.offered++; continue; }
        csat.offered++;
        if (s === 'good' || s === 'goodwithcomment') {
          csat.good++; csat.answered++;
          const k = ticketAgent.get(r.ticket_id);
          if (k && byAgent[k]) byAgent[k].csat_good++;
        } else if (s === 'bad' || s === 'badwithcomment') {
          csat.bad++; csat.answered++;
          const k = ticketAgent.get(r.ticket_id);
          if (k && byAgent[k]) byAgent[k].csat_bad++;
        }
      }
      csat.score_pct = pct(csat.good, csat.answered);
      csat.response_rate_pct = pct(csat.answered, csat.offered);
    } catch (e) {
      csat = { error: String((e && e.message) || e).slice(0, 160) };
    }

    // ── Agent names, one call ────────────────────────────────────────────────
    const agents = Object.values(byAgent).map(a => {
      const rated = a.csat_good + a.csat_bad;
      return {
        assignee_id: a.assignee_id,
        tickets: a.tickets,
        solved: a.solved,
        one_touch: a.one_touch,
        one_touch_rate_pct: pct(a.one_touch, a.solved),
        reopened: a.reopened,
        median_first_reply_minutes: pctile(a._frt, 0.5),
        median_resolution_minutes: pctile(a._res, 0.5),
        csat_good: a.csat_good,
        csat_bad: a.csat_bad,
        csat_score_pct: pct(a.csat_good, rated),
      };
    }).sort((x, y) => y.tickets - x.tickets);

    const ids = agents.map(a => a.assignee_id).filter(x => /^\d+$/.test(x)).slice(0, 80);
    if (ids.length && Date.now() < deadline) {
      try {
        const uj = await zd('/api/v2/users/show_many.json?ids=' + ids.join(','));
        const byId = {};
        for (const u of (uj.users || [])) byId[String(u.id)] = u.name;
        for (const a of agents) a.name = byId[a.assignee_id] || a.assignee_id;
      } catch { /* names are a nicety */ }
    }
    for (const a of agents) if (!a.name) a.name = a.assignee_id === 'unassigned' ? 'Unassigned' : a.assignee_id;

    const value = {
      ok: true,
      month,
      generated_at: new Date().toISOString(),
      pages_read: pages,
      truncated,
      // If this is 0 while tickets is not, the plan stopped side-loading metric
      // sets and every timing below is null for that reason and no other.
      metric_sets_seen: metricSetsSeen,

      volume: {
        created: tickets.length,
        solved,
        solve_rate_pct: pct(solved, tickets.length),
        one_touch: oneTouch,
        one_touch_rate_pct: pct(oneTouch, solved),
        reopened,
        reopen_rate_pct: pct(reopened, solved),
        answered: withReply,
        by_channel: Object.entries(byChannel)
          .map(([channel, count]) => ({ channel, count, share_pct: pct(count, tickets.length) }))
          .sort((x, y) => y.count - x.count),
      },

      first_reply: {
        median_minutes: pctile(frt, 0.5),
        p90_minutes: pctile(frt, 0.9),
        median_business_minutes: pctile(frtBusiness, 0.5),
        measured_on: frt.length,
      },

      resolution: {
        median_minutes: pctile(full, 0.5),
        p90_minutes: pctile(full, 0.9),
        measured_on: full.length,
      },

      satisfaction: csat,
      agents,
    };

    if (!truncated) CACHE.set(month, { at: Date.now(), value });
    return res.status(200).json(value);
  } catch (e) {
    return res.status(200).json({ ok: false, month, error: String((e && e.message) || e).slice(0, 200) });
  }
}

export default handler;
