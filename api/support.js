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
 *
 * Vercel rewrites in vercel.json forward the legacy endpoint paths here,
 * so all existing Zendesk custom action URLs continue to work unchanged.
 */

import { handler as checkDateChange }      from './_check-date-change.js';
import { handler as checkShopChange }      from './_check-shop-change.js';
import { handler as findNearestShop }      from './_find-nearest-shop.js';
import { handler as updatePersonalInfo }   from './_update-personal-info.js';
import { handler as unsubscribeNewsletter } from './_unsubscribe-newsletter.js';
import { handler as largeGroupQuote }      from './_large-group-quote.js';

const HANDLERS = {
  'check-date-change':      checkDateChange,
  'check-shop-change':      checkShopChange,
  'find-nearest-shop':      findNearestShop,
  'update-personal-info':   updatePersonalInfo,
  'unsubscribe-newsletter': unsubscribeNewsletter,
  'large-group-quote':      largeGroupQuote,
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
