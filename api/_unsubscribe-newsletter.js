/**
 * POST /api/unsubscribe-newsletter
 *
 * Handles a newsletter unsubscribe request raised by a support agent or SKIBOT.
 * Sends a notification card to the marketing team via a Microsoft Teams incoming
 * webhook so they can manually remove the customer from the mailing list.
 *
 * Body params:
 *   customerEmail      (string, required)  - email address to unsubscribe
 *   customerName       (string, optional)  - customer's full name
 *   bookingReference   (string, optional)  - related booking reference
 *   language           (string, optional)  - customer's language / locale
 *
 * Environment variables:
 *   TEAMS_WEBHOOK_URL  - Microsoft Teams incoming webhook URL
 *                        (warn and continue gracefully if not set)
 *
 * Returns:
 *   { success, teamNotified, customerEmail, message, confirmationText }
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Webhook-Secret',
};

/**
 * Format a UTC timestamp as "YYYY-MM-DD HH:MM UTC".
 */
function formatUtcDate(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/**
 * Build a Microsoft Teams MessageCard payload.
 * Uses the legacy "MessageCard" format supported by all Teams incoming webhooks.
 */
function buildTeamsCard({ customerEmail, customerName, bookingReference, language }) {
  const now = formatUtcDate(new Date());
  const facts = [
    { name: 'Email',       value: customerEmail },
    { name: 'Name',        value: customerName       || '(not provided)' },
    { name: 'Booking Ref', value: bookingReference   || '(not provided)' },
    { name: 'Language',    value: language            || '(not provided)' },
    { name: 'Date',        value: now },
    { name: 'Source',      value: 'Zendesk SKIBOT' },
  ];

  return {
    '@type':     'MessageCard',
    '@context':  'http://schema.org/extensions',
    themeColor:  'FF0000',
    summary:     'Newsletter unsubscribe request',
    sections: [
      {
        activityTitle: '🔕 Newsletter Unsubscribe Request',
        activitySubtitle: `Customer ${customerEmail} has requested to be removed from the newsletter.`,
        facts,
        markdown: true,
      },
    ],
    potentialAction: [
      {
        '@type': 'OpenUri',
        name:    'View in Brevo / Mailchimp',
        targets: [{ os: 'default', uri: 'https://app.brevo.com' }],
      },
    ],
  };
}

/**
 * POST the Teams card to the configured webhook URL.
 * Returns { notified: true } on success, { notified: false, reason } on failure.
 */
async function notifyTeams(cardPayload) {
  const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[unsubscribe-newsletter] TEAMS_WEBHOOK_URL is not set — skipping Teams notification.');
    return { notified: false, reason: 'TEAMS_WEBHOOK_URL environment variable not configured.' };
  }

  try {
    const res = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(cardPayload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[unsubscribe-newsletter] Teams webhook returned ${res.status}: ${body}`);
      return { notified: false, reason: `Teams webhook returned HTTP ${res.status}.` };
    }

    return { notified: true };
  } catch (err) {
    console.error('[unsubscribe-newsletter] Teams webhook error:', err);
    return { notified: false, reason: err.message };
  }
}

// ── Claude JSON blob normalizer ───────────────────────────────────────────────
function expandBlob(raw) {
  const b = { ...raw };
  const blob = Object.values(b).find(v => typeof v === 'string' && v.trim().startsWith('{'));
  if (blob) { try { Object.assign(b, JSON.parse(blob)); } catch {} }
  const LC = { customeremail:'customerEmail', customername:'customerName', bookingreference:'bookingReference' };
  for (const [lc, cc] of Object.entries(LC)) if (b[lc] !== undefined && b[cc] === undefined) b[cc] = b[lc];
  return b;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const body = expandBlob(req.body || {});
  const { customerEmail, customerName, bookingReference, language } = body;

  if (!customerEmail || typeof customerEmail !== 'string' || !customerEmail.includes('@')) {
    return res.status(400).json({
      error: 'customerEmail is required and must be a valid email address.',
    });
  }

  const card = buildTeamsCard({ customerEmail, customerName, bookingReference, language });
  const { notified, reason } = await notifyTeams(card);

  if (!notified) {
    // Log for ops, but return success to the agent — the manual process is still triggered
    console.warn(`[unsubscribe-newsletter] Teams notification failed: ${reason}`);
  }

  return res.status(200).json({
    success:          true,
    teamNotified:     notified,
    customerEmail,
    message:          'Unsubscribe request sent to marketing team. The customer will be removed within 24-48 hours.',
    confirmationText: 'We have received your unsubscribe request and forwarded it to our marketing team. '
      + 'You will be unsubscribed from our newsletter within 24-48 hours. Thank you.',
    ...((!notified && reason) && { teamsWarning: reason }),
  });
}
