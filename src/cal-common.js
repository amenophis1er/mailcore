// Bits shared by the non-Exchange calendar backends.

export function b64url(s) {
  return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

export function localZone(configured) {
  return configured || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const CODE = { Free: '0', Tentative: '1', Busy: '2', OOF: '3', WorkingElsewhere: '4' };

/**
 * The Exchange-style merged free/busy grid: one character per interval over
 * [from, to) — 0 free, 1 tentative, 2 busy, 3 out of office — from busy
 * periods [{ start, end, status }]. The busiest status wins per interval.
 */
export function freeBusyGrid(periods, from, to, intervalMinutes = 30) {
  const step = Math.max(5, intervalMinutes) * 60e3;
  const n = Math.max(0, Math.ceil((to.getTime() - from.getTime()) / step));
  const grid = new Array(n).fill('0');
  for (const p of periods) {
    const s = new Date(p.start).getTime();
    const e = new Date(p.end).getTime();
    if (isNaN(s) || isNaN(e) || e <= s) continue;
    const code = CODE[p.status] ?? '2';
    const first = Math.max(0, Math.floor((s - from.getTime()) / step));
    const last = Math.min(n - 1, Math.ceil((e - from.getTime()) / step) - 1);
    for (let i = first; i <= last; i++) if (Number(code) > Number(grid[i])) grid[i] = code;
  }
  return grid.join('');
}

/** A free/busy result row in the shape the EWS backend returns. */
export function freeBusyRow({ email, ok = true, error = null, periods = [], from, to, intervalMinutes, view = 'Detailed' }) {
  return {
    email, ok, error,
    view: ok ? view : null,
    merged: ok ? freeBusyGrid(periods, from, to, intervalMinutes) : '',
    intervalMinutes, start: from.toISOString(), end: to.toISOString(),
    events: periods.map((p) => ({ start: p.start, end: p.end, status: p.status || 'Busy', subject: p.subject || null, location: p.location || null, isMeeting: !!p.isMeeting }))
  };
}

/** The event fields the Exchange backend lists; every backend fills the same ones. */
export function eventShape(e) {
  return {
    id: e.id, changeKey: e.changeKey || '', subject: e.subject || '', start: e.start, end: e.end, allDay: !!e.allDay, location: e.location || '',
    organizerName: e.organizerName || '', organizerEmail: e.organizerEmail || '', showAs: e.showAs || 'Busy', myResponse: e.myResponse || 'Unknown',
    isMeeting: !!e.isMeeting, isCancelled: !!e.isCancelled, isRecurring: !!e.isRecurring, type: e.type || 'Single', private: !!e.private,
    hasAttachments: !!e.hasAttachments, reminderMinutes: e.reminderMinutes ?? null, modified: e.modified || '', mailbox: e.mailbox || null,
    calendarName: e.calendarName || undefined, calendarId: e.calendarId || undefined, link: e.link || undefined
  };
}
