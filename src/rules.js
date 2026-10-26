// Rule matching: comma/semicolon
// separated case-insensitive substrings; senders match name OR address.

export function splitList(value) {
  return String(value || '')
    .split(/[;,\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function ruleMatches(rule, item) {
  const senders = splitList(Array.isArray(rule.senders) ? rule.senders.join(',') : rule.senders);
  const subjects = splitList(Array.isArray(rule.subjects) ? rule.subjects.join(',') : rule.subjects);
  if (senders.length === 0 && subjects.length === 0) return false;

  const from = `${item.fromName} ${item.fromEmail}`.toLowerCase();
  const subject = (item.subject || '').toLowerCase();

  const senderOk = senders.length === 0 || senders.some((s) => from.includes(s));
  const subjectOk = subjects.length === 0 || subjects.some((s) => subject.includes(s));
  return senderOk && subjectOk;
}

export function inQuietHours(q) {
  if (!q || !q.enabled) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = String(q.start || '18:00').split(':').map(Number);
  const [eh, em] = String(q.end || '08:00').split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** rule.account (a name, a list, or "a, b") scopes a rule to those accounts; none = every account. */
export function accountOk(rule, account) {
  if (!rule.account) return true;
  const list = Array.isArray(rule.account) ? rule.account : String(rule.account).split(/[,;]/);
  return list.map((s) => String(s).trim()).includes(account);
}

/** The first enabled rule that matches `item` of `account`, or null. */
export function matchRule(rules, item, account) {
  return (rules || []).find((r) => r && r.enabled !== false && accountOk(r, account) && ruleMatches(r, item)) || null;
}
