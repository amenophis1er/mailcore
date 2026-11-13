// Whether a message is an automatic answer (an out-of-office, a rule's
// reply): by its headers when they say so, else by the subject the usual
// clients give it.

const SUBJECT = /^\s*(?:auto(?:matic)?[- ]?(?:reply|response|answer)|auto:|out of (?:the )?office|abwesenheit|abwesenheitsnotiz|r[ée]ponse automatique|absence|respuesta autom[áa]tica|risposta automatica|resposta autom[áa]tica|autosvar|automatisch antwoord|automatische antwort)\b/i;

/** The headers that tell, as AUTO_REPLY_HEADERS names them (lower case). */
export const AUTO_REPLY_HEADERS = ['auto-submitted', 'x-autoreply', 'x-autorespond', 'x-auto-response-suppress', 'precedence'];

/**
 * `subject`, and `headers`: the raw text of whatever of AUTO_REPLY_HEADERS was
 * fetched (any case, one per line). Auto-Submitted other than "no", an
 * X-Autoreply or X-Autorespond, Precedence auto_reply, or Outlook's
 * X-Auto-Response-Suppress (set on its out-of-office and rule replies).
 */
export function isAutoReply(subject, headers = '') {
  if (SUBJECT.test(String(subject || ''))) return true;
  const h = String(headers || '').toLowerCase();
  const auto = /^auto-submitted:\s*(\S+)/m.exec(h);
  if (auto && auto[1] !== 'no') return true;
  if (/^precedence:\s*auto[_-]reply\b/m.test(h)) return true;
  if (/^x-auto-response-suppress:\s*\S/m.test(h)) return true;
  return /^x-autore(?:ply|spond):/m.test(h);
}
