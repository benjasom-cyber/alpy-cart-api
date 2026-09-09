// D-61 — General questions : section UPGRADE (montée en gamme) dans le prompt de step_ask.
// Règle de Benjamin : requote au niveau demandé, proposer l'annulation totale OU partielle
// (l'article de la personne concernée) et attendre la réaction du client.
window.__GQ_UPGRADE = [
  '=== UPGRADE - A HIGHER PRODUCT FOR A PERSON WHO ALREADY HAS ONE (D-61) ===',
  'The same two things (cart link + note) also serve a customer who wants BETTER',
  'equipment than what they booked ("upgrade to the Diamond skis", "passer en gamme',
  'superieure", "hoeherwertige Ski", "black instead of red for Paul"). Then, and',
  'only then:',
  '- If the note contains a line beginning "UPGRADE:", the reply says, in this order:',
  '  (1) an item on a paid booking cannot be exchanged for another product in place -',
  '  once, plainly; (2) the way to do it: THE LINK ABOVE is their booking rebuilt',
  '  with the higher product for the person(s) named on the UPGRADE line (name them',
  '  and the product they move to, copied from that line), same shop, same dates,',
  '  and its price ONLY if the note states one; (3) once that new booking is made,',
  '  we cancel EITHER only the current item(s) of the person(s) concerned - the rest',
  '  of the booking stays as it is - OR the whole current booking, whichever they',
  '  prefer; (4) what cancelling costs, copied from the "COST OF CANCELLING THE',
  '  CURRENT BOOKING" lines of the note - never guessed, nothing when the note has',
  '  no figure; (5) ONE question: which of the two they want, and their go-ahead.',
  '  Nothing is cancelled before they answer. Never say the upgrade is "done",',
  '  "changed" or "confirmed": nothing has changed yet.',
  '- If the note says "UPGRADE APPLIED TO EVERYONE", the customer named nobody: say',
  '  the link upgrades every skier, and ask them to tell us if it concerns only some',
  '  of them (the cart can be adjusted).',
  '- If the note contains "UPGRADE NOT APPLIED TO", mention those persons in one',
  '  sentence, with the reason from the note (already at the top level the shop',
  '  stocks, ...), and nothing more.',
  '- If the note contains "UPGRADE NOT POSSIBLE", return the single word HANDOVER.',
  'Never invent a tier, a name or a price that the UPGRADE line does not carry.',
  '',
].join('\n');
window.__applyGQU = function (w) {
  const st = w.steps.find(s => s.name === 'step_ask');
  if (!st) throw new Error('step_ask missing');
  const ps = st.settings.find(x => x.name === 'prompt');
  let p = String(ps.value);
  if (p.includes('UPGRADE - A HIGHER PRODUCT')) throw new Error('already applied');
  const anchor = '=== THIS RULE WINS OVER EVERYTHING ABOVE ===';
  const k = p.indexOf(anchor);
  if (k < 0) throw new Error('anchor missing');
  p = p.slice(0, k) + window.__GQ_UPGRADE + '\n' + p.slice(k);
  const old = 'Use them ONLY when the customer asks to add something to an existing booking - a\nprotection, a helmet, boots, any paid option.';
  if (!p.includes(old)) throw new Error('scope sentence missing');
  p = p.replace(old, 'Use them ONLY when the customer asks to add something to an existing booking - a\nprotection, a helmet, boots, any paid option - or to move a person to a HIGHER\nproduct (see UPGRADE below), or to collect at another shop (see SHOP CHANGE).');
  ps.value = p;
  return 'ok prompt=' + p.length;
};
'ready-gqu'
