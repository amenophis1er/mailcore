// Daemon side of the calendar: keeps a snapshot of the next `lookaheadDays`
// of one Exchange account's default calendar, refreshed on push
// (ews-stream calendar subscription) and every `pollMinutes`, and
//
//   - emits `calendar` events on the bus when an event is created, updated,
//     cancelled or deleted (new invitations and cancellations also notify),
//   - fires `reminder` events `remindMinutes` before each event starts
//     (desktop notification + sound, quiet hours respected).
//
// Snapshot: ~/.mailwatcher/calendar-<account>.json — survives restarts so a
// daemon restart neither re-announces every event nor repeats reminders.

import fs from 'node:fs';
import path from 'node:path';
import { withAuthRetry } from './client.js';
import { HOME_DIR, loadConfig, loadRulesDoc } from './config.js';
import { inQuietHours } from './rules.js';
import { playSound, notifyMac } from './notify.js';

const KEY_FIELDS = ['subject', 'start', 'end', 'location', 'isCancelled', 'organizerEmail'];
const MAX_NOTIFY_PER_REFRESH = 3;

export function startCalendarWatch({ account, bus, log }) {
  const snapPath = path.join(HOME_DIR, `calendar-${account}.json`);
  let snap = { baselined: false, events: {}, fired: {} };
  try { snap = { ...snap, ...JSON.parse(fs.readFileSync(snapPath, 'utf8')) }; } catch {}
  const save = () => { try { fs.writeFileSync(snapPath, JSON.stringify(snap), { mode: 0o600 }); } catch {} };
  const settings = () => loadConfig().accounts[account]?.calendar || {};
  const quiet = () => inQuietHours(loadRulesDoc().quietHours);

  let refreshing = false;
  let again = false;
  const refresh = async () => {
    if (refreshing) { again = true; return; }
    refreshing = true;
    try {
      const cfg = settings();
      const start = new Date(Date.now() - 3600e3);
      const end = new Date(Date.now() + (cfg.lookaheadDays || 7) * 86400e3);
      const list = await withAuthRetry((c) => c.findEvents({ start, end, limit: 500 }), null, account);
      const next = {};
      for (const e of list) next[e.id] = pick(e);
      const changes = snap.baselined ? diff(snap.events, next) : [];
      snap.events = next;
      snap.baselined = true;
      // forget reminder marks of events that are gone
      for (const k of Object.keys(snap.fired)) if (!next[k.split('|')[0]]) delete snap.fired[k];
      save();
      if (changes.length) announce(changes, cfg);
      else if (!changes.length && list.length) log(`[${account}] calendar: ${list.length} upcoming event(s), no change`);
    } catch (e) {
      log(`[${account}] calendar refresh failed: ${e.message}`);
    } finally {
      refreshing = false;
      if (again) { again = false; setTimeout(refresh, 1000); }
    }
  };

  const announce = (changes, cfg) => {
    const q = quiet();
    let notified = 0;
    for (const ch of changes) {
      const ev = ch.event;
      log(`[${account}] calendar ${ch.action}: ${ev.subject} (${ev.start})`);
      bus.emit('calendar', { action: ch.action, account, ...ev, ...(ch.previous ? { previous: ch.previous } : {}), quiet: q });
      // only invitations and cancellations deserve an interruption
      // an invitation from someone else (not my own appointment, which Google/CalDAV also label with an organizer)
      const loud = (ch.action === 'created' && ev.isMeeting && ev.myResponse !== 'Organizer' && !ch.event.isCancelled) || ch.action === 'cancelled';
      if (!loud || q || cfg.notify === false || notified >= MAX_NOTIFY_PER_REFRESH) continue;
      notified++;
      if (notified === 1 && cfg.sound !== false) playSound(cfg.sound || 'ding');
      notifyMac(ch.action === 'cancelled' ? '📅 Cancelled' : '📅 New invitation', `${ev.subject}\n${when(ev)}`);
    }
  };

  // --- reminders: one check per minute over the snapshot --------------------
  const tickReminders = () => {
    const cfg = settings();
    const minutesList = (Array.isArray(cfg.remindMinutes) ? cfg.remindMinutes : [cfg.remindMinutes]).map(Number).filter((n) => n >= 0);
    if (!minutesList.length) return;
    const now = Date.now();
    const q = quiet();
    let dirty = false;
    for (const ev of Object.values(snap.events)) {
      if (ev.isCancelled || ev.allDay) continue;
      const startMs = Date.parse(ev.start);
      if (!startMs || startMs < now) continue;
      for (const m of minutesList) {
        const key = `${ev.id}|${m}`;
        const due = startMs - m * 60e3;
        // fire once, within a 2-minute window after the due moment (covers sleep/wake)
        if (snap.fired[key] || now < due || now - due > 2 * 60e3) continue;
        snap.fired[key] = now;
        dirty = true;
        log(`[${account}] reminder (${m} min): ${ev.subject}`);
        bus.emit('reminder', { account, minutes: m, ...ev, quiet: q });
        if (q || cfg.notify === false) continue;
        if (cfg.sound !== false) playSound(cfg.sound || 'ding');
        notifyMac(`⏰ In ${m} min: ${ev.subject}`, `${when(ev)}${ev.location ? '\n' + ev.location : ''}`);
      }
    }
    if (dirty) save();
  };

  refresh();
  const pollTimer = setInterval(refresh, Math.max(1, Number(settings().pollMinutes) || 5) * 60e3);
  const remindTimer = setInterval(tickReminders, 60e3);
  return {
    refresh: () => setTimeout(refresh, 1500), // let the server settle after a push
    stop() { clearInterval(pollTimer); clearInterval(remindTimer); }
  };
}

function pick(e) {
  return {
    id: e.id, subject: e.subject, start: e.start, end: e.end, allDay: e.allDay, location: e.location,
    organizerName: e.organizerName, organizerEmail: e.organizerEmail, isMeeting: e.isMeeting,
    isCancelled: e.isCancelled, myResponse: e.myResponse, changeKey: e.changeKey
  };
}

function diff(before, after) {
  const out = [];
  for (const [id, ev] of Object.entries(after)) {
    const old = before[id];
    if (!old) out.push({ action: ev.isCancelled ? 'cancelled' : 'created', event: ev });
    else if (ev.isCancelled && !old.isCancelled) out.push({ action: 'cancelled', event: ev });
    else if (KEY_FIELDS.some((k) => old[k] !== ev[k])) out.push({ action: 'updated', event: ev, previous: { start: old.start, end: old.end, location: old.location, subject: old.subject } });
  }
  for (const [id, ev] of Object.entries(before)) if (!after[id]) out.push({ action: 'deleted', event: ev });
  return out;
}

function when(ev) {
  const d = new Date(ev.start);
  if (isNaN(d)) return ev.start;
  if (ev.allDay) return d.toLocaleDateString();
  return d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
