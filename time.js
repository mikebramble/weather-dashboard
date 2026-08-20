// time.js — day bucketing in the *forecast location's* time zone.
//
// The original dashboard used the browser's local time to decide where one
// forecast day ended and the next began. That is correct only when you are
// looking up your own city. Check the forecast for somewhere three time zones
// away and the day columns silently shear against the day/night cycle.
//
// NWS /points hands back an IANA zone in properties.timeZone, so we use it.

const dateKeyCache = new Map();

function fmt(timeZone, opts) {
  const key = timeZone + JSON.stringify(opts);
  let f = dateKeyCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, ...opts });
    dateKeyCache.set(key, f);
  }
  return f;
}

/**
 * Calendar day key (YYYY-MM-DD) for an instant, in the given zone.
 * en-CA gives ISO-ordered output, which sorts lexicographically.
 */
export function dayKey(ms, timeZone) {
  return fmt(timeZone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/** Hour of day (0–23) for an instant, in the given zone. */
export function hourOfDay(ms, timeZone) {
  return Number(
    fmt(timeZone, { hour: '2-digit', hour12: false }).format(new Date(ms))
  ) % 24;
}

/**
 * The UTC instant corresponding to local midnight of the day containing `ms`.
 *
 * Done by search rather than arithmetic so that DST transitions and offsets
 * that are not whole hours (Newfoundland, Chatham Island) come out right.
 */
export function startOfLocalDay(ms, timeZone) {
  const key = dayKey(ms, timeZone);
  // Floor to a whole minute first. Without this the result carries whatever
  // sub-minute component `ms` had, every derived hourly label inherits it,
  // and nothing lines up with the gridpoint's hour-aligned blocks.
  let t = Math.floor((ms - 30 * 3600 * 1000) / 60000) * 60000;
  while (dayKey(t, timeZone) !== key) t += 3600 * 1000;
  // t is now within the right day; back off to the boundary.
  while (dayKey(t - 60000, timeZone) === key) t -= 60000;
  return t;
}

/** Local midnight `n` days after the local day containing `ms`. */
export function addLocalDays(ms, timeZone, n) {
  // Adding 24 h repeatedly then re-snapping handles DST-length days.
  return startOfLocalDay(ms + n * 24 * 3600 * 1000 + 2 * 3600 * 1000, timeZone);
}

/** Formatted wall-clock time at the forecast location, e.g. "4 PM". */
export function formatHour(ms, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: true,
  }).format(new Date(ms));
}

/** e.g. "Thu 21" for a day-column heading. */
export function formatDayLabel(ms, timeZone) {
  const d = new Date(ms);
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).format(d);
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone,
    day: 'numeric',
  }).format(d);
  return { weekday, day };
}

/** e.g. "Thu, Aug 20, 4:00 PM" for tooltips. */
export function formatFull(ms, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms));
}

/** Short zone abbreviation, e.g. "PDT". */
export function zoneAbbrev(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'short',
  }).formatToParts(new Date(ms));
  const p = parts.find((x) => x.type === 'timeZoneName');
  return p ? p.value : '';
}

/** "14 min ago" / "3 h 20 min ago" — for observation age. */
export function relativeAge(ms, now = Date.now()) {
  const min = Math.round((now - ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h} h ${m} min ago` : `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h ago`;
}
