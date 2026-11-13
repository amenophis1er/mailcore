// Calendar watcher for one account: keeps a snapshot of the next
// `lookaheadDays` of the default calendar, refreshed on demand (call
// refresh() on a push, e.g. the EWS stream's calendar notifications) and
// every `pollMinutes`, and
//
//   - emits 'changes' with the events created, updated, cancelled or deleted
//     since the last refresh (`loud` marks new invitations from others and
//     cancellations, the ones worth interrupting someone for),
//   - emits 'reminder' `remindMinutes` before each event starts.
//
// Snapshot: a { load(), save() } store (default <dataDir>/calendar-<account>.json)
// so a restart neither re-announces every event nor repeats reminders.
// Notifications, sounds and quiet hours are the caller's.

import path from 'node:path';
import { EventEmitter } from 'node:events';
import { jsonFileStore, memoryStore } from './store.js';
import { isAuthError } from './client.js';

const KEY_FIELDS = ['subject', 'start', 'end', 'location', 'isCancelled', 'organizerEmail'];

/**
 * watchCalendar(core, { account, snapshot?, settings?, log?, authGate? }) → EventEmitter & { refresh(), stop() }
 *   settings: () => { lookaheadDays, pollMinutes, remindMinutes } (default: the account's calendar block)
 *   authGate: { blocked(), ok(), failed(err) } shared with the caller's other
 *     users of this account: no refresh while blocked() (a sign-in known to
 *     fail is not tried again and again), ok() after a refresh that went
 *     through, failed(err) on an auth error
 */
export function watchCalendar(core, { account, snapshot, settings, log = () => {}, start = true, authGate } = {}) {
  const fresh = () => ({ baselined: false, events: {}, fired: {} });
  const store = snapshot || (core.dataDir ? jsonFileStore(path.join(core.dataDir, `calendar-${account}.json`), fresh) : memoryStore(fresh));
  let snap = { ...fresh(), ...(store.load() ?? {}) };
  const save = () => { try { store.save(snap); } catch {} };
  const cfgOf = settings || (() => core.accounts[account]?.calendar || {});
  const out = new EventEmitter();
  // stop() bumps the generation: work started before it (a refresh in flight,
  // a queued retry or start) sees the change after its await and does nothing
  let gen = 0;
  let running = false;
  const timeouts = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timeouts.delete(t); fn(); }, ms); timeouts.add(t); return t; };

  let refreshing = false;
  let again = false;
  const refresh = async () => {
    if (authGate?.blocked()) return;
    if (refreshing) { again = true; return; }
    const mine = gen;
    refreshing = true;
    try {
      const cfg = cfgOf();
      const from = new Date(Date.now() - 3600e3);
      const to = new Date(Date.now() + (cfg.lookaheadDays || 7) * 86400e3);
      const list = await core.withClient(account, (c) => c.findEvents({ start: from, end: to, limit: 500 }));
      if (mine !== gen) return; // stopped meanwhile
      authGate?.ok();
      const next = {};
      for (const e of list) next[e.id] = pick(e);
      const changes = snap.baselined ? diff(snap.events, next) : [];
      snap.events = next;
      snap.baselined = true;
      // forget reminder marks of events that are gone
      for (const k of Object.keys(snap.fired)) if (!next[k.split('|')[0]]) delete snap.fired[k];
      save();
      if (changes.length) {
        for (const ch of changes) {
          const ev = ch.event;
          // an invitation from someone else (not my own appointment, which Google/CalDAV also label with an organizer), or a cancellation
          ch.loud = (ch.action === 'created' && ev.isMeeting && ev.myResponse !== 'Organizer' && !ev.isCancelled) || ch.action === 'cancelled';
          log(`[${account}] calendar ${ch.action}: ${ev.subject} (${ev.start})`);
        }
        out.emit('changes', changes);
      } else if (list.length) log(`[${account}] calendar: ${list.length} upcoming event(s), no change`);
    } catch (e) {
      if (mine !== gen) return;
      log(`[${account}] calendar refresh failed: ${e.message}`);
      if (isAuthError(e)) authGate?.failed(e);
      out.emit('failure', e);
    } finally {
      refreshing = false;
      if (again) { again = false; if (mine === gen) later(refresh, 1000); }
    }
  };

  // --- reminders: one check per minute over the snapshot --------------------
  const tickReminders = () => {
    const cfg = cfgOf();
    const minutesList = (Array.isArray(cfg.remindMinutes) ? cfg.remindMinutes : [cfg.remindMinutes]).map(Number).filter((n) => n >= 0);
    if (!minutesList.length) return;
    const now = Date.now();
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
        out.emit('reminder', { account, minutes: m, ...ev });
      }
    }
    if (dirty) save();
  };

  let pollTimer = null;
  let remindTimer = null;
  let queued = null;
  out.start = () => {
    if (queued) { clearImmediate(queued); queued = null; }
    if (running) return out;
    running = true;
    refresh();
    pollTimer = setInterval(refresh, Math.max(1, Number(cfgOf().pollMinutes) || 5) * 60e3);
    remindTimer = setInterval(tickReminders, 60e3);
    return out;
  };
  out.refresh = () => { if (running) later(refresh, 1500); }; // let the server settle after a push
  out.refreshNow = refresh;
  out.checkReminders = tickReminders;
  out.stop = () => {
    gen++;
    running = false;
    if (queued) { clearImmediate(queued); queued = null; }
    clearInterval(pollTimer); clearInterval(remindTimer); pollTimer = remindTimer = null;
    for (const t of timeouts) clearTimeout(t);
    timeouts.clear();
    again = false;
  };
  if (start) queued = setImmediate(() => { queued = null; out.start(); }); // listeners attach first
  return out;
}

export function pick(e) {
  return {
    id: e.id, subject: e.subject, start: e.start, end: e.end, allDay: e.allDay, location: e.location,
    organizerName: e.organizerName, organizerEmail: e.organizerEmail, isMeeting: e.isMeeting,
    isCancelled: e.isCancelled, myResponse: e.myResponse, changeKey: e.changeKey
  };
}

export function diff(before, after) {
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
