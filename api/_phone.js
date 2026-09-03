/**
 * GET /api/metrics-phone?month=2026-01     (served through /api/support?action=metrics-phone)
 *
 * THE MONTHLY PHONE AVAILABILITY RATE.
 *
 * What was tried first, and why it does not work
 * ----------------------------------------------
 * `channels/voice/stats/agents_activity.json` and `agents_overview.json` carry
 * online_time / available_time / away_time per agent, which reads like exactly
 * the number we want. It is not. Both endpoints ACCEPT `start_time` /
 * `end_time` and then IGNORE them: a July 2026 window and a January 2026 window
 * return byte-identical payloads. They are a rolling snapshot of the current
 * period, nothing else. `historical_queue_activity` and `availabilities` 404 on
 * this plan. So there is no server-side history of agent STATE.
 *
 * What does work
 * --------------
 * The Talk incremental export IS historical and complete:
 *
 *   GET /api/v2/channels/voice/stats/incremental/calls.json?start_time=<epoch>
 *   GET /api/v2/channels/voice/stats/incremental/legs.json?start_time=<epoch>
 *
 * 1000 calls per page, `next_page` until `end_of_stream`. Each call carries
 * `direction`, `completion_status`, `outside_business_hours`, `time_to_answer`,
 * `agent_id`, `ticket_id`, `phone_number`. Measured on this account: 13 885
 * calls in January 2026, 14 075 in February.
 *
 * So availability is measured FROM THE CUSTOMER'S SIDE, which is the honest
 * definition anyway: of the calls offered during business hours, how many did
 * someone pick up. January 2026: 6 827 answered out of 10 661 offered = 64 %.
 * February: 60 %. That is the number this season has to move.
 *
 * Cost, and why this is its own endpoint
 * --------------------------------------
 * A peak month is ~14 pages, roughly 20 s. Eight months in one request is a
 * minute and a half and would blow the function budget, so the dashboard asks
 * for one month at a time and fills the chart as the answers land. A warm
 * lambda keeps the months it has already computed in memory.
 */

const ZD_SUB = String(process.env.ZENDESK_SUBDOMAIN || '')
  .trim()
  .replace(/^https?:\/\//i, '')
  .replace(/\/.*$/, '')
  .replace(/\.zendesk\.com$/i, '');
const ZD_EMAIL = String(process.env.ZENDESK_EMAIL || '').trim();
const ZD_TOKEN = String(process.env.ZENDESK_API_TOKEN || '').trim();
const METRICS_SECRET = String(process.env.METRICS_SECRET || process.env.REVIEW_SECRET || '').trim();

const BUDGET_MS = 50000;

/** Survives between invocations on a warm lambda. Cheap, and often enough. */
const CACHE = globalThis.__phoneCache || (globalThis.__phoneCache = new Map());
const CACHE_TTL_MS = 30 * 60 * 1000;

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
    const r = await fetch(full, {
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('Zendesk ' + r.status + ' on ' + full.split('?')[0]);
    return await r.json();
  } finally { clearTimeout(t); }
}

function pctile(xs, p) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
}

const pct = (n, d) => (d ? Math.round((n * 1000) / d) / 10 : null);

function monthBounds(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '');
  if (!m) return null;
  const start = Date.UTC(+m[1], +m[2] - 1, 1);
  const end = Date.UTC(+m[1], +m[2], 1);
  return { start, end };
}

/**
 * Page the incremental export from the month start. Records come back ordered
 * by `updated_at`, not `created_at`, so a call created on the 31st and updated
 * in the next month appears late: keep reading two days past the month end
 * before stopping, and filter on `created_at`.
 */
async function fetchMonthCalls(month, deadline) {
  const b = monthBounds(month);
  if (!b) throw new Error('month must be YYYY-MM');
  const stopAfter = b.end + 2 * 86400000;

  let url = '/api/v2/channels/voice/stats/incremental/calls.json?start_time=' +
    Math.floor(b.start / 1000);
  const calls = [];
  let pages = 0;
  let truncated = false;

  while (url) {
    if (Date.now() > deadline) { truncated = true; break; }
    const d = await zd(url);
    pages++;
    const batch = d.calls || [];
    for (const c of batch) {
      const t = Date.parse(c.created_at);
      if (t >= b.start && t < b.end) calls.push(c);
    }
    const last = batch.length ? Date.parse(batch[batch.length - 1].updated_at || batch[batch.length - 1].created_at) : 0;
    if (d.end_of_stream || !d.next_page || last > stopAfter) break;
    url = d.next_page;
  }
  return { calls, pages, truncated };
}

/**
 * The legs export, which is the only place "missed" and "declined" exist per
 * agent — a call has one completion status, but it may have been offered to
 * three agents first. This is exactly what the Explore widget "Declined and
 * Missed" counted, and it is why that widget could not be rebuilt from the calls
 * export alone.
 *
 * Same paging rules as the calls export, and the same two-day overshoot.
 */
async function fetchMonthLegs(month, deadline) {
  const b = monthBounds(month);
  const stopAfter = b.end + 2 * 86400000;
  let url = '/api/v2/channels/voice/stats/incremental/legs.json?start_time=' +
    Math.floor(b.start / 1000);
  const legs = [];
  let pages = 0, truncated = false;

  while (url) {
    if (Date.now() > deadline) { truncated = true; break; }
    const d = await zd(url);
    pages++;
    const batch = d.legs || [];
    for (const l of batch) {
      const t = Date.parse(l.created_at);
      if (t >= b.start && t < b.end) legs.push(l);
    }
    const last = batch.length ? Date.parse(batch[batch.length - 1].updated_at || batch[batch.length - 1].created_at) : 0;
    if (d.end_of_stream || !d.next_page || last > stopAfter) break;
    url = d.next_page;
  }
  return { legs, pages, truncated };
}

function summarise(month, calls) {
  const inbound = calls.filter(c => c.direction === 'inbound' && c.completion_status !== 'failed');
  const inHours = inbound.filter(c => !c.outside_business_hours);
  const offHours = inbound.filter(c => c.outside_business_hours);
  const outbound = calls.filter(c => c.direction === 'outbound');

  const count = (arr, s) => arr.filter(c => c.completion_status === s).length;

  const answered = count(inHours, 'completed');
  const offered = inHours.length;
  const tta = inHours.filter(c => c.completion_status === 'completed').map(c => c.time_to_answer);

  // Per agent, from the calls they actually took.
  const byAgent = {};
  for (const c of calls) {
    if (!c.agent_id || c.completion_status !== 'completed') continue;
    const k = String(c.agent_id);
    byAgent[k] = byAgent[k] || { agent_id: k, calls: 0, talk_seconds: 0, hold_seconds: 0 };
    byAgent[k].calls++;
    byAgent[k].talk_seconds += c.duration || 0;
    byAgent[k].hold_seconds += c.hold_time || 0;
  }

  // Day by day, so a bad week is visible instead of averaged away.
  const days = {};
  for (const c of inHours) {
    const d = (c.created_at || '').slice(0, 10);
    days[d] = days[d] || { day: d, offered: 0, answered: 0, abandoned: 0, voicemail: 0 };
    days[d].offered++;
    if (c.completion_status === 'completed') days[d].answered++;
    else if (c.completion_status === 'abandoned_in_voicemail') days[d].voicemail++;
    else days[d].abandoned++;
  }

  return {
    month,
    calls_total: calls.length,
    inbound: inbound.length,
    outbound: outbound.length,

    // THE headline: of the calls offered while the line was open, how many did
    // a human answer.
    business_hours: {
      offered,
      answered,
      availability_rate_pct: pct(answered, offered),
      abandoned_in_queue: count(inHours, 'abandoned_in_queue'),
      abandoned_on_hold: count(inHours, 'abandoned_on_hold'),
      voicemail: count(inHours, 'abandoned_in_voicemail'),
      abandon_rate_pct: pct(offered - answered, offered),
      median_answer_seconds: pctile(tta, 0.5),
      p90_answer_seconds: pctile(tta, 0.9),
      exceeded_queue_wait: inHours.filter(c => c.exceeded_queue_wait_time).length,
    },

    outside_hours: {
      offered: offHours.length,
      voicemail: count(offHours, 'abandoned_in_voicemail'),
      answered: count(offHours, 'completed'),
    },

    agents: Object.values(byAgent).sort((a, b) => b.calls - a.calls),
    daily: Object.values(days).sort((a, b) => (a.day < b.day ? -1 : 1)),
  };
}

export async function handler(req, res) {
  if (METRICS_SECRET) {
    const given = String(req.query.secret || req.headers['x-metrics-secret'] || '');
    if (given !== METRICS_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const now = new Date();
  const month = String(req.query.month || '').trim() ||
    now.toISOString().slice(0, 7);
  if (!monthBounds(month)) return res.status(400).json({ ok: false, error: 'month must be YYYY-MM' });

  const hit = CACHE.get(month);
  const isCurrent = month === now.toISOString().slice(0, 7);
  if (hit && Date.now() - hit.at < (isCurrent ? 5 * 60 * 1000 : CACHE_TTL_MS)) {
    return res.status(200).json({ ...hit.value, cached: true });
  }

  const deadline = Date.now() + BUDGET_MS;
  try {
    const { calls, pages, truncated } = await fetchMonthCalls(month, deadline);
    const value = {
      ok: true,
      generated_at: new Date().toISOString(),
      pages_read: pages,
      truncated,
      ...summarise(month, calls),
    };

    // Missed and declined, per agent, from the legs export. Attempted only with
    // real time left: it is a second full walk of the month, and the answer is
    // still useful without it — the flag says which case the reader is looking at.
    value.legs_read = false;
    if (!truncated && Date.now() < deadline - 12000) {
      try {
        const { legs, pages: lp, truncated: lt } = await fetchMonthLegs(month, deadline - 6000);
        const byAgent = {};
        for (const l of legs) {
          if (!l.agent_id) continue;
          const k = String(l.agent_id);
          const a = byAgent[k] || (byAgent[k] = { missed: 0, declined: 0, answered: 0, talk_seconds: 0, hold_seconds: 0 });
          const s = l.completion_status;
          if (s === 'missed') a.missed++;
          else if (s === 'declined') a.declined++;
          else if (s === 'completed') { a.answered++; a.talk_seconds += l.talk_time || 0; a.hold_seconds += l.hold_time || 0; }
        }
        for (const a of value.agents) {
          const v = byAgent[a.agent_id];
          if (!v) continue;
          a.missed_legs = v.missed;
          a.declined_legs = v.declined;
          a.answered_legs = v.answered;
          // Offered = everything the agent's phone actually rang for.
          const offered = v.answered + v.missed + v.declined;
          a.offered_legs = offered;
          a.pickup_rate_pct = pct(v.answered, offered);
          a.average_talk_seconds = v.answered ? Math.round(v.talk_seconds / v.answered) : null;
        }
        // Agents who were offered calls but answered none never appear in the
        // calls-based list. They are exactly the ones worth seeing.
        for (const [id, v] of Object.entries(byAgent)) {
          if (value.agents.some(a => a.agent_id === id)) continue;
          const offered = v.answered + v.missed + v.declined;
          value.agents.push({
            agent_id: id, calls: 0, talk_seconds: 0, hold_seconds: 0,
            missed_legs: v.missed, declined_legs: v.declined, answered_legs: v.answered,
            offered_legs: offered, pickup_rate_pct: pct(v.answered, offered),
            average_talk_seconds: null,
          });
        }
        value.legs_read = !lt;
        value.legs_pages_read = lp;
        value.legs = {
          total: legs.length,
          missed: legs.filter(l => l.completion_status === 'missed').length,
          declined: legs.filter(l => l.completion_status === 'declined').length,
          completed: legs.filter(l => l.completion_status === 'completed').length,
        };
      } catch { /* the month still stands without the legs */ }
    }
    // Names, one call, only for the agents who took a call this month.
    const ids = value.agents.map(a => a.agent_id).filter(x => /^\d+$/.test(x)).slice(0, 60);
    if (ids.length) {
      try {
        const uj = await zd('/api/v2/users/show_many.json?ids=' + ids.join(','));
        const byId = {};
        for (const u of (uj.users || [])) byId[String(u.id)] = u.name;
        for (const a of value.agents) a.name = byId[a.agent_id] || a.agent_id;
      } catch { /* names are a nicety */ }
    }
    if (!truncated) CACHE.set(month, { at: Date.now(), value });
    return res.status(200).json(value);
  } catch (e) {
    return res.status(200).json({ ok: false, month, error: String((e && e.message) || e).slice(0, 200) });
  }
}

export default handler;
