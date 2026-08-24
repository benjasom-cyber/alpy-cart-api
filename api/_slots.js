/**
 * Slots and routes — the single declaration of "what a capability needs before
 * it can run", and "what we ask when it is missing".
 *
 * Two tables, deliberately small.
 *
 * SLOTS is keyed by the piece of information, not by the topic: a booking
 * reference is asked for the same way whether the customer wants to cancel or
 * to move their dates. Four slots serve every capability we have.
 *
 * ROUTES declares, per capability, which slots must be present. "a|b" means
 * either one satisfies the requirement — a switch/storage question needs a shop
 * OR a resort, not both.
 *
 * WHY THIS EXISTS. A flow that starts without the information it needs does not
 * fail cleanly: it improvises. On ticket 581628 a date-change flow with no
 * booking reference asked the customer, publicly, to resend their own message.
 * On 581663 the same path answered a job application. Declaring the
 * requirements here, in code, is what turns "the model will figure it out" into
 * "the flow does not start".
 *
 * WHAT THIS IS NOT. It is not a catalogue of every subject a customer can
 * raise. The topics below are the ones we can finish; everything else is OTHER
 * and goes to a human. A classifier with fifty labels, forty of which route to
 * a person, is fifty chances to be wrong for no gain.
 */

export const SLOTS = {
      booking_ref: {
              label: 'booking reference',
              ask: 'Could you send us your booking reference? It is a short code such as B1AF9J, in your confirmation email.',
              // Odin references are 6 uppercase alphanumerics in practice, but we
              // accept 4-12 so a customer who mistypes still gets past the gate
              // and is corrected by the booking lookup rather than by us.
              looksValid: v => /^[A-Z0-9]{4,12}$/.test(String(v || '').trim().toUpperCase()),
      },
      resort_name: {
              label: 'resort',
              ask: 'Which resort will you be skiing in?',
              looksValid: v => String(v || '').trim().length >= 3,
      },
      shop_name: {
              label: 'shop',
              ask: 'Which shop are you asking about?',
              looksValid: v => String(v || '').trim().length >= 3,
      },
      start_date: {
              label: 'first day of the rental',
              ask: 'Which day would you like to pick the equipment up?',
              looksValid: v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()),
      },
      end_date: {
              label: 'last day of the rental',
              ask: 'And which day will you return it?',
              looksValid: v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()),
      },
      adults: {
              label: 'number of adults',
              ask: 'How many adults is the equipment for?',
              looksValid: v => Number.isFinite(parseInt(v, 10)) && parseInt(v, 10) >= 0,
      },
      // The one slot that is never optional on a quote, and the reason this file
      // exists at all. generate-quote will happily price a child as a 35-year-old
      // if the age is absent - it defaults to ADULT_DEFAULT_AGE. The quote comes
      // out plausible, the customer accepts it, and the real price appears at the
      // till. "No children" is a perfectly good answer; a silent guess is not.
      children_ages: {
              label: 'age of each child',
              ask: 'How old is each child skiing with you? We need every age — a child is priced on their age, so a quote without them would be wrong. If there are no children, just say so.',
              looksValid: v => {
                        const s = String(v == null ? '' : v).trim();
                        if (s === '' ) return false;
                        if (/^(none|no|no children|aucun|0)$/i.test(s)) return true;   // explicit "no children"
                        const ages = s.split(/[^0-9]+/).filter(x => x !== '').map(Number);
                        return ages.length > 0 && ages.every(a => a >= 0 && a < 100);
              },
      },
      equipment_level: {
              label: 'ski or snowboard, and the level',
              ask: 'For each person, would you like skis or a snowboard, and are they a beginner, intermediate or expert?',
              looksValid: v => String(v || '').trim().length >= 3,
      },
};

/**
 * needs: slots that must be satisfied before the capability may run.
 * flow:  the action flow that owns the topic, for the record.
 */
export const ROUTES = {
      DEPOT_SWITCH: {
              flow: 'Shop services (switch & depot)',
              needs: ['shop_name|resort_name'],
      },
      CANCELLATION: {
              flow: 'Cancellation Handler',
              needs: ['booking_ref'],
      },
      DATE_CHANGE: {
              flow: 'Date Change',
              needs: ['booking_ref', 'start_date', 'end_date'],
      },
      QUOTE: {
              flow: 'Quote Generator',
              needs: ['resort_name|shop_name', 'start_date', 'end_date', 'adults', 'children_ages', 'equipment_level'],
      },
      REQUOTE: {
              flow: 'Requote from booking',
              needs: ['booking_ref'],
      },
      VOUCHER_RESEND: {
              flow: 'Voucher Resend',
              needs: ['booking_ref'],
      },
      PARTIAL_CANCELLATION: {
              flow: 'Partial cancellation',
              needs: ['booking_ref'],
      },
      OTHER: {
              flow: null,
              needs: [],
      },
};

/**
 * Which declared slots are not satisfied, and the single question to ask next.
 *
 * Returns { missing, satisfied, nextQuestion, ready }.
 *
 * One question at a time, in the order the capability declares them. Asking a
 * customer for six things in one message is how you get two of them back.
 */
export function checkSlots(topic, slots) {
      const route = ROUTES[topic] || ROUTES.OTHER;
      const values = slots || {};
      const missing = [];
      const satisfied = [];

      for (const requirement of route.needs) {
              const alternatives = requirement.split('|');
              const met = alternatives.find(name => {
                        const def = SLOTS[name];
                        return def && def.looksValid(values[name]);
              });
              if (met) satisfied.push(met);
              else missing.push(requirement);
      }

      let nextQuestion = null;
      if (missing.length) {
              // For an either/or requirement, ask for the first alternative - it is
              // the one the capability prefers.
              const first = missing[0].split('|')[0];
              nextQuestion = SLOTS[first] ? SLOTS[first].ask : null;
      }

      return {
              missing,
              satisfied,
              nextQuestion,
              ready: missing.length === 0 && topic !== 'OTHER',
      };
}

export const TOPICS = Object.keys(ROUTES);
