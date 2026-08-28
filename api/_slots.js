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
              label: 'skis or snowboard and the level, person by person',
              ask: 'For each person separately, would they like skis or a snowboard, and are they a beginner, intermediate or expert? A group rarely rents the same tier throughout, and the tier is what sets the price.',
              looksValid: v => String(v || '').trim().length >= 3,
      },
      // The three accessories below are asked for one reason: they are priced,
      // and until v5 the quote silently assumed boots-and-helmets-for-everyone
      // and no protection at all. The customer then opened the basket and found
      // a different total. Asking is cheaper than explaining afterwards.
      //
      // "Nobody" is a complete answer for all three. What is not acceptable is
      // silence, because silence used to mean "charge for it anyway".
      //
      // Each carries a `fallback`: the value we take when the customer has not
      // said, and the sentence we print so they know we took it. See the QUOTE
      // route below for why these are assumed rather than asked.
      boots: {
              label: 'who needs boots',
              ask: 'Does everyone need boots as well, or is anyone bringing their own? Tell us who — boots are charged per person.',
              looksValid: v => ACCESSORY_ANSWER(v),
              fallback: { value: 'everyone', announce: 'boots for everyone' },
      },
      helmets: {
              label: 'who needs a helmet',
              ask: 'Would you like helmets, and for whom? They are charged per person, and nobody is obliged to take one.',
              looksValid: v => ACCESSORY_ANSWER(v),
              fallback: { value: 'nobody', announce: 'no helmets' },
      },
      insurance: {
              label: 'damage & theft protection',
              ask: 'Would you like damage & theft protection? It costs 15% of the rental price and covers breakage and theft of the equipment. Yes or no is enough.',
              looksValid: v => ACCESSORY_ANSWER(v),
              fallback: { value: 'no', announce: 'no damage & theft protection' },
      },
};

/**
 * An accessory answer is valid when it says something - "everyone", "nobody",
 * "just the two adults", "yes", "non". It is invalid only when empty.
 *
 * Deliberately lenient. A strict validator on a free-text answer would leave
 * the flow blocked forever on a customer who did answer, just not in the shape
 * we expected; the model downstream reads the sentence anyway.
 */
function ACCESSORY_ANSWER(v) {
      const s = String(v == null ? '' : v).trim();
      if (s === '') return false;
      if (/^(none|no|nobody|no one|non|aucun|personne|0)$/i.test(s)) return true;   // explicit "nobody"
      return s.length >= 2;
}

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
      // The paid extras are gates again - asked once, and only once.
      //
      // They were removed from this list after 581739, and the reasoning was
      // sound but the diagnosis was not. What actually broke 581739 was never
      // that insurance was required: the customer wrote "No one needs insurance
      // as we have our own insurance also", the extractor failed to record that
      // negation, insurance read as missing, and the repeat-ask guard escalated
      // over a sentence that answered the question outright. The gate was
      // blamed for an extraction bug.
      //
      // Both halves of that are now fixed. The gatekeeper's extractor names all
      // three extras, hasSlot() in intent.js counts an explicit refusal as an
      // answer, and - the part that makes gating safe - a second pass with the
      // extras still unstated declines them and quotes anyway rather than
      // escalating (see declineUnstatedExtras in intent.js).
      //
      // So the customer is asked before the price is built, which is what they
      // are owed: AlpinGuaranty is 15% of the rental, and on a group of fifteen
      // that is not a detail to discover in the basket. Asked once. Silence the
      // second time means no, and the quote goes out.
      //
      // WHAT CHANGED, AND WHY (581658 and the whole family of tickets like it).
      //
      // The three extras above are priced, but none of them stops us from
      // computing a price: every one has an answer we can take by default and
      // say out loud. Requiring them meant a customer who told us the resort,
      // the dates, the group and the level - everything that actually sets the
      // price - still got a question instead of a quote. That is the slow,
      // robotic exchange people complain about, and it is what earned us the
      // bad rating on 581658.
      //
      // So they move from `needs` to `assumes`. The quote is built on a stated
      // assumption and the assumption is printed in the reply, where the
      // customer can correct it in one word. Boots yes, because someone renting
      // skis nearly always needs them and leaving them out understates the
      // price; helmets and protection no, because charging for something nobody
      // asked for is the worse error of the two.
      //
      // A stated assumption the customer can refuse is honest. A question that
      // holds the whole quote hostage is not helpfulness, it is a queue.
      QUOTE: {
              flow: 'Quote Generator',
              needs: ['resort_name|shop_name', 'start_date', 'end_date', 'adults', 'children_ages', 'equipment_level'],
              assumes: ['boots', 'helmets', 'insurance'],
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
      // The rental has already started: injury, illness, an early return.
      //
      // There is no automatic outcome here and there must not be one. The fee is
      // 100%, a goodwill gesture is discretionary, and it depends on two
      // documents a customer almost never sends unprompted - a medical
      // certificate dated inside the rental period, and the shop's written
      // confirmation of the early return. So the flow's whole job is to ask for
      // those two documents, say what happens next, and put the booking facts in
      // front of an agent. It never touches the booking and never creates a
      // coupon.
      //
      // booking_ref is required because everything the agent needs to decide -
      // the dates, whether Alpinsafety or Alpinsafety Plus is on the booking,
      // what the unused days are worth - is only knowable from the booking.
      CANCELLATION_AFTER: {
              flow: 'Cancellation after start',
              needs: ['booking_ref'],
      },
      // Questions that need knowledge and no action at all.
      //
      // "Can I have an invoice?" "Are poles included?" "Do you take AMEX?" "Is a
      // helmet compulsory in Italy?" - none of these touch a booking, and every
      // one of them has a settled answer written down. They are a large part of
      // the 21% of tickets that carry no topic tag, and today every one of them
      // costs an agent a full reply.
      //
      // needs is deliberately empty. There is nothing to collect: the question
      // is the whole request, so this route is ready on the first comment and
      // never asks the customer anything.
      GENERAL_QUESTION: {
              flow: 'General questions',
              needs: [],
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
      let nextQuestionAll = null;
      if (missing.length) {
              // For an either/or requirement, ask for the first alternative - it is
              // the one the capability prefers.
              const first = missing[0].split('|')[0];
              nextQuestion = SLOTS[first] ? SLOTS[first].ask : null;

              // With several holes, ask for all of them in ONE message.
              //
              // This is not a style choice. A flow has no memory between comments:
              // if we ask one question per turn, the answer to turn 1 is gone by
              // turn 3. A quote needs six things; asked one at a time they would
              // never all be present at once and the flow could never run.
              // Asked together, the customer's single reply carries them all and
              // the accumulation problem disappears instead of being solved.
              if (missing.length === 1) {
                        nextQuestionAll = nextQuestion;
              } else {
                        const labels = missing.map(req => {
                                  const alternatives = req.split('|');
                                  return alternatives.map(n => SLOTS[n] ? SLOTS[n].label : n).join(' or ');
                        });
                        const last = labels.pop();
                        nextQuestionAll = 'To prepare this we need ' + labels.join(', ') + ' and ' + last + '.';
                        // The ages carry their own warning wherever they appear: a
                        // quote priced without them is wrong and the customer finds
                        // out at the till.
                        // Accessories are priced per person and were previously
                        // assumed rather than asked. Name them explicitly so the
                        // composed reply cannot reduce them to "any extras?".
                        if (missing.includes('boots') || missing.includes('helmets') || missing.includes('insurance')) {
                                  nextQuestionAll += ' Tell us person by person who needs boots and who needs a helmet — both are charged individually — and whether you want damage & theft protection, which adds 15% of the rental price.';
                        }
                        if (missing.includes('children_ages')) {
                                  nextQuestionAll += ' We need the age of every child skiing with you — a child is priced on their age, so a quote without them would be wrong. If there are no children, just say so.';
                        }
              }
      }

      // Assumed slots: never block, always announced.
      //
      // If the customer stated one, we use what they said and there is nothing
      // to announce. If they did not, we take the declared fallback and add it
      // to `assumedSentence`, which the reply must print verbatim so the
      // customer can correct it in one word.
      const assumed = [];
      const values2 = values;
      for (const name of (route.assumes || [])) {
              const def = SLOTS[name];
              if (!def || !def.fallback) continue;
              if (def.looksValid(values2[name])) continue;
              assumed.push({ slot: name, value: def.fallback.value, announce: def.fallback.announce });
      }

      let assumedSentence = null;
      if (assumed.length) {
              const parts = assumed.map(a => a.announce);
              const last = parts.pop();
              assumedSentence = 'We have assumed ' +
                        (parts.length ? parts.join(', ') + ' and ' + last : last) +
                        '. Tell us if that is wrong and we will re-price it.';
      }

      return {
              missing,
              satisfied,
              nextQuestion,
              nextQuestionAll,
              assumed,
              assumedSentence,
              ready: missing.length === 0 && topic !== 'OTHER',
      };
}

export const TOPICS = Object.keys(ROUTES);
