// Whether a message is an automatic answer (an out-of-office, a rule's
// reply): by its headers when they say so, else by the subject the usual
// clients give it.

const SUBJECT = /^\s*(?:auto(?:matic)?[- ]?(?:reply|response|answer)|auto:|out of (?:the )?office|abwesenheit|abwesenheitsnotiz|r[ée]ponse automatique|absence|respuesta autom[áa]tica|risposta automatica|resposta autom[áa]tica|autosvar|automatisch antwoord|automatische antwort)\b/i;

/** `subject`, and `headers`: the raw text of whatever of Auto-Submitted, X-Autoreply, X-Autorespond was fetched (any case). */
export function isAutoReply(subject, headers = '') {
  if (SUBJECT.test(String(subject || ''))) return true;
  const h = String(headers || '').toLowerCase();
  const auto = /^auto-submitted:\s*(\S+)/m.exec(h);
  if (auto && auto[1] !== 'no') return true;
  return /^x-autore(?:ply|spond):/m.test(h);
}
