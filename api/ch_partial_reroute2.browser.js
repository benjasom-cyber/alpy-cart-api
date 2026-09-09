// D-60 — Cancellation Handler, version « zéro step ajouté » (le flow est déjà à la limite de 60).
// 1) le lecteur (step_01KYYFW3XG3YQ60C0HT6FPQXYA) produit trois champs de plus :
//    notcancel_reroute (PARTIAL + HIGH), notcancel_note (note de run SKIBOT-RUN-PARTIAL_CANCELLATION,
//    sinon l'ancienne note de transfert), notcancel_tags (étiquettes selon le cas) ;
// 2) step_notcancel_update écrit notcancel_note, step_notcancel_tags pose notcancel_tags ;
// 3) step_start_untag (retire awaiting__cancellation) remonte AVANT step_notcancel_if : il couvre
//    ainsi les deux branches, ce que la note de transfert affirmait déjà sans le faire.
window.__PC_TAIL = "  out.notcancel_reroute = (String(out.intent || '').toUpperCase() === 'PARTIAL' && String(out.confidence || '').toUpperCase() === 'HIGH');\n  (function () {\n    var LF = String.fromCharCode(10);\n    var t = String((inputs && inputs.comment_text) || '');\n    var cut = t.indexOf(LF);\n    var msg = cut > -1 ? t.slice(cut + 1) : t;\n    if (out.notcancel_reroute && msg.trim().length > 0) {\n      // D-60: the same run note the gatekeeper writes - it is the door of the Partial cancellation flow.\n      out.notcancel_note = 'SKIBOT-RUN-PARTIAL_CANCELLATION' + LF + msg;\n      out.notcancel_tags = ['rerouted_to_partial', 'awaiting__partial_cancellation'];\n    } else {\n      out.notcancel_reroute = false;\n      out.notcancel_note = 'SKIBOT did not write to the customer. The gatekeeper routed this message as a cancellation, but the cancellation detection reads it as: ' + String(out.intent || '') + ' (confidence ' + String(out.confidence || '') + ').' + LF + LF + 'On ticket 581841 a customer asking to ADD boots back to her booking was handled as a cancellation six times in a row. This branch exists so that never happens again: nothing was read in Odin, nothing was cancelled, no reply was sent, and the awaiting__cancellation tag was removed so the next message is classified afresh. Since D-60 a PARTIAL read with HIGH confidence is handed to the Partial cancellation flow instead of landing here.' + LF + LF + 'Read the customer message above and answer it yourself.';\n      out.notcancel_tags = ['needs_human', 'handover_not_a_cancellation', 'skibot_handled'];\n    }\n  })();\n  return out;";
window.__applyPC2 = function (w) {
  const S = w.steps, W = w.wires, g = n => S.find(x => x.name === n), set = (st, n, v) => { const x = st.settings.find(y => y.name === n); if (x) x.value = v; else st.settings.push({ name: n, value: v }); };
  const P = g('step_01KYYFW3XG3YQ60C0HT6FPQXYA'), IF = g('step_notcancel_if'), UP = g('step_notcancel_update'), TG = g('step_notcancel_tags'), UN = g('step_start_untag');
  if (!P || !IF || !UP || !TG || !UN) throw new Error('anchors missing');
  // 1. parser
  let code = String(P.settings.find(x => x.name === 'code').value);
  if (code.includes('notcancel_reroute')) throw new Error('already applied');
  const k = code.lastIndexOf('return out;');
  if (k < 0) throw new Error('return out; not found');
  code = code.slice(0, k) + window.__PC_TAIL + code.slice(k + 'return out;'.length);
  if (code.includes('${')) throw new Error('template literal hazard');
  set(P, 'code', code);
  let os = String(P.settings.find(x => x.name === 'output_schema').value);
  if (!os.includes('"refs_to_cancel"')) throw new Error('schema anchor missing');
  os = os.replace('"refs_to_cancel":', '"notcancel_reroute":{"type":"boolean"},"notcancel_note":{"type":"string"},"notcancel_tags":{"type":"array","items":{"type":"string"}},"refs_to_cancel":');
  os = os.replace('"required":[', '"required":["notcancel_reroute","notcancel_note","notcancel_tags",');
  if (!os.includes('notcancel_tags","')) throw new Error('required patch failed');
  set(P, 'output_schema', os);
  // 2. note + tags become computed
  set(UP, 'comment_plain_body', '`${step_01KYYFW3XG3YQ60C0HT6FPQXYA.output.notcancel_note}`');
  set(TG, 'tags', 'step_01KYYFW3XG3YQ60C0HT6FPQXYA.output.notcancel_tags');
  // 3. untag moves in front of the fork
  const into = W.find(x => x.toName === 'step_notcancel_if');
  const thenW = W.find(x => x.fromName === 'step_notcancel_if' && x.fromOutcome === 'then');
  const unOut = W.find(x => x.fromName === 'step_start_untag');
  if (!into || !thenW || thenW.toName !== 'step_start_untag' || !unOut) throw new Error('wires not as expected ' + JSON.stringify([into, thenW, unOut]));
  const afterUntag = unOut.toName;
  into.toName = 'step_start_untag';
  unOut.toName = 'step_notcancel_if';
  thenW.toName = afterUntag;
  return 'ok steps=' + S.length + ' wires=' + W.length + ' afterUntag=' + afterUntag;
};
'ready-pc2'
