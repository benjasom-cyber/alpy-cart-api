/**
 * POST /api/support?action=<action>
 *
 * Unified SKIBOT support router. Routes to the appropriate handler
 * based on the `action` query parameter.
 *
 * Actions:
 *   check-date-change       → POST /api/check-date-change
 *   check-shop-change       → POST /api/check-shop-change
 *   find-nearest-shop       → POST /api/find-nearest-shop
 *   update-personal-info    → POST /api/update-personal-info
 *   unsubscribe-newsletter  → POST /api/unsubscribe-newsletter
 *   large-group-quote       → POST /api/large-group-quote
 *   resend-voucher          → POST /api/resend-voucher
 *   knowledge               → GET  /api/knowledge
 *   review-run              → POST /api/review-run      (secret required)
 *   review-digest           → GET  /api/review-digest   (secret required)
 *   review-report           → POST /api/review-report   (run + email the summary)
 *   training-run            → POST /api/training-run     (sandbox only)
 *   training-digest         → GET  /api/training-digest  (sandbox only)
 *
 * Vercel rewrites in vercel.json forward the legacy endpoint paths here,
 * so all existing Zendesk custom action URLs continue to work unchanged.
 *
 * Everything routed here lives in an api/_*.js module. The underscore is what
 * keeps it out of Vercel's function count: this project sits exactly on the
 * Hobby plan's twelve-function limit, and a thirteenth file in api/ without an
 * underscore fails the whole deployment.
 */

import { handler as checkDateChange } from './_check-date-change.js';
import { handler as checkShopChange } from './_check-shop-change.js';
import { handler as findNearestShop } from './_find-nearest-shop.js';
import { handler as updatePersonalInfo } from './_update-personal-info.js';
import { handler as unsubscribeNewsletter } from './_unsubscribe-newsletter.js';
import { handler as largeGroupQuote } from './_large-group-quote.js';
import { handler as resendVoucher } from './_resend-voucher.js';
import { handler as knowledge } from './_knowledge.js';
import { handler as metrics } from './_metrics.js';
import { handler as phone } from './_phone.js';
import { handler as conversion } from './_conversion.js';
import { handler as service } from './_service.js';
import { handler as phoneIndex } from './_phone-index.js';
import { handler as scoreboard } from './_scoreboard.js';
import { handler as review } from './_review.js';
import { handler as training } from './_training.js';

const HANDLERS = {
  'check-date-change': checkDateChange,
  'check-shop-change': checkShopChange,
  'find-nearest-shop': findNearestShop,
  'update-personal-info': updatePersonalInfo,
  'unsubscribe-newsletter': unsubscribeNewsletter,
  'large-group-quote': largeGroupQuote,
  'resend-voucher': resendVoucher,
  'knowledge': knowledge,
  // The support dashboard's numbers: what the bot finished, what it handed
  // over, and what it dropped without writing a line.
  'metrics': metrics,
  // The phone, month by month, from the Talk incremental export. Its own action
  // because one peak month is ~14 pages of 1000 calls and eight months in one
  // request would not fit the function budget.
  'metrics-phone': phone,
  // Le taux de conversion du support : tickets Zendesk hachés d'un cote, table
  // BI (BigQuery via Metabase) de l'autre, jointure sur md5(email).
  'metrics-conversion': conversion,
  // Les chiffres qui vivaient dans Explore : volume, satisfaction, premier
  // temps de reponse, resolution, et le tout ventile par agent.
  'metrics-service': service,
  // Le pont telephone : l'index numero -> empreinte d'email construit depuis
  // Odin, que la conversion interroge pour rattraper les appelants sans adresse.
  'phone-index': phoneIndex,
  'agent-scoreboard': scoreboard,
  // Both review actions share one handler: it reads req.query.action itself, so
  // the two URLs stay separate for the caller while the code stays single.
  'review-run': review,
  'review-digest': review,
  'review-report': review,
  // The sandbox trainer. Same shape, different account and a different standard:
  // it reads what people in training wrote, and it never writes to a customer.
  'training-run': training,
  'training-digest': training,
  // One or several bookings, checked together, cancelled together.
};

export default async function handler(req, res) {
  const action = req.query.action;

  if (!action) {
    return res.status(400).json({
      error: 'Missing required query parameter: action',
      validActions: Object.keys(HANDLERS),
    });
  }

  const fn = HANDLERS[action];
  if (!fn) {
    return res.status(400).json({
      error: `Unknown action: "${action}"`,
      validActions: Object.keys(HANDLERS),
    });
  }

  return fn(req, res);
}
