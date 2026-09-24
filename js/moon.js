// moon.js — position, rise and set, phase, and phase events for the Moon.
//
// Position follows the truncated lunar theory in Montenbruck & Pfleger,
// "Astronomy on the Personal Computer" (the MiniMoon series): 14 longitude
// terms and 8 latitude terms, good to a few arcminutes. The Moon moves about
// its own diameter per hour, so a few arcminutes is a minute or two in
// rise/set time — well inside what anyone needs to know when to look up.
//
// Pure functions, no network, no DOM. Validated in test/moon.test.mjs against
// the geometry of two eclipses, where the answer is known exactly.

import { crossingsOf, solarLongitude } from './solar.js';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const ARCSEC_PER_RAD = 206264.806;
const TAU = 2 * Math.PI;
const DAY = 86400000;

/** Mean length of the synodic month, days. */
export const SYNODIC_MONTH = 29.530589;

/**
 * Geocentric altitude of the Moon's centre at the instant of apparent rise or
 * set: parallax lifts it (+0.95 deg x 0.7275) while refraction and the
 * semidiameter lower it (-34' - 15.5'). Using this threshold on geocentric
 * altitude avoids computing topocentric coordinates at every step.
 */
export const MOON_RISE_ALTITUDE = 0.7275 * 0.9507 - 34 / 60;

const frac = (x) => x - Math.floor(x);

function julianCenturies(ms) {
  return (ms / DAY + 2440587.5 - 2451545) / 36525;
}

/**
 * Ecliptic longitude and latitude of the Moon, degrees.
 * @returns {{lon: number, lat: number}}
 */
export function moonEcliptic(ms) {
  const T = julianCenturies(ms);

  const L0 = frac(0.606433 + 1336.855225 * T); // mean longitude, revolutions
  const l = TAU * frac(0.374897 + 1325.55241 * T); // Moon's mean anomaly
  const ls = TAU * frac(0.993133 + 99.997361 * T); // Sun's mean anomaly
  const D = TAU * frac(0.827361 + 1236.853086 * T); // mean elongation
  const F = TAU * frac(0.259086 + 1342.227825 * T); // argument of latitude

  const sin = Math.sin;
  const dL =
    22640 * sin(l) - 4586 * sin(l - 2 * D) + 2370 * sin(2 * D) + 769 * sin(2 * l) -
    668 * sin(ls) - 412 * sin(2 * F) - 212 * sin(2 * l - 2 * D) -
    206 * sin(l + ls - 2 * D) + 192 * sin(l + 2 * D) - 165 * sin(ls - 2 * D) -
    125 * sin(D) - 110 * sin(l + ls) + 148 * sin(l - ls) - 55 * sin(2 * F - 2 * D);

  const S = F + (dL + 412 * sin(2 * F) + 541 * sin(ls)) / ARCSEC_PER_RAD;
  const h = F - 2 * D;
  const N =
    -526 * sin(h) + 44 * sin(l + h) - 31 * sin(-l + h) - 23 * sin(ls + h) +
    11 * sin(-ls + h) - 25 * sin(-2 * l + F) + 21 * sin(-l + F);

  const lon = (frac(L0 + dL / 1296e3) * 360 + 360) % 360;
  const lat = ((18520 * sin(S) + N) / ARCSEC_PER_RAD) * DEG;
  return { lon, lat };
}

/** Right ascension and declination of the Moon, degrees. */
export function moonEquatorial(ms) {
  const T = julianCenturies(ms);
  const eps = RAD * (23.43929111 - (46.815 / 3600) * T);
  const { lon, lat } = moonEcliptic(ms);
  const L = RAD * lon;
  const B = RAD * lat;

  const x = Math.cos(B) * Math.cos(L);
  const y = Math.cos(eps) * Math.cos(B) * Math.sin(L) - Math.sin(eps) * Math.sin(B);
  const z = Math.sin(eps) * Math.cos(B) * Math.sin(L) + Math.cos(eps) * Math.sin(B);

  const ra = ((Math.atan2(y, x) * DEG) + 360) % 360;
  const dec = Math.asin(z) * DEG;
  return { ra, dec };
}

/** Greenwich mean sidereal time, degrees (Meeus 12.4). */
export function gmst(ms) {
  const JD = ms / DAY + 2440587.5;
  const T = (JD - 2451545) / 36525;
  const theta =
    280.46061837 + 360.98564736629 * (JD - 2451545) +
    0.000387933 * T * T - (T * T * T) / 38710000;
  return ((theta % 360) + 360) % 360;
}

/** Geocentric altitude of the Moon's centre, degrees. */
export function moonAltitude(ms, lat, lon) {
  const { ra, dec } = moonEquatorial(ms);
  const H = RAD * (gmst(ms) + lon - ra);
  const sinAlt =
    Math.sin(RAD * lat) * Math.sin(RAD * dec) +
    Math.cos(RAD * lat) * Math.cos(RAD * dec) * Math.cos(H);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt))) * DEG;
}

/**
 * Moonrise and moonset within a local day.
 *
 * Either can be null: the Moon rises about 50 minutes later each day, so
 * roughly once a month a calendar day passes with no moonrise, and another
 * with no moonset. That is correct, not missing data.
 */
export function moonriseMoonset(dayStartMs, dayEndMs, lat, lon) {
  const c = crossingsOf(
    (ms) => moonAltitude(ms, lat, lon),
    dayStartMs,
    dayEndMs,
    MOON_RISE_ALTITUDE
  );
  const rise = c.find((x) => x.rising);
  const set = c.find((x) => !x.rising);
  return { rise: rise ? rise.ms : null, set: set ? set.ms : null };
}

/**
 * Elongation of the Moon from the Sun in ecliptic longitude, degrees [0, 360).
 * 0 = new, 90 = first quarter, 180 = full, 270 = last quarter. These are the
 * astronomical definitions of the principal phases.
 */
export function lunarElongation(ms) {
  return (((moonEcliptic(ms).lon - solarLongitude(ms)) % 360) + 360) % 360;
}

const PRINCIPAL = [
  { at: 0, name: 'New moon' },
  { at: 90, name: 'First quarter' },
  { at: 180, name: 'Full moon' },
  { at: 270, name: 'Last quarter' },
];

/**
 * Everything needed to describe the Moon at an instant.
 *
 * Principal phases are named only within about half a day of the exact
 * instant (7 deg of elongation); the Moon spends the rest of its month in the
 * intermediate phases, and labelling a 97% gibbous Moon "Full" overstates it.
 */
export function moonState(ms) {
  const E = lunarElongation(ms);
  const { lat } = moonEcliptic(ms);

  // Phase angle from the true 3-D elongation; the Sun-Earth distance ratio
  // correction is under 0.2 deg and ignored.
  const cosPsi = Math.cos(RAD * lat) * Math.cos(RAD * E);
  const illumination = (1 - cosPsi) / 2;

  const waxing = E < 180;
  const age = (E / 360) * SYNODIC_MONTH;

  let name;
  const near = PRINCIPAL.find((p) => {
    const d = Math.abs(((E - p.at + 540) % 360) - 180);
    return d < 7;
  });
  if (near) name = near.name;
  else if (E < 90) name = 'Waxing crescent';
  else if (E < 180) name = 'Waxing gibbous';
  else if (E < 270) name = 'Waning gibbous';
  else name = 'Waning crescent';

  return { illumination, elongation: E, waxing, age, name };
}

/**
 * Principal phase instants between two times: new, first quarter, full, last
 * quarter. Elongation advances about 12 deg/day and never reverses, so a
 * daily scan cannot skip a phase; bisection then pins each to the second.
 *
 * @returns {Array<{ms: number, type: 'new'|'first'|'full'|'last'}>}
 */
export function lunarPhaseEvents(startMs, endMs) {
  const TYPES = ['new', 'first', 'full', 'last'];
  const quadrant = (ms) => Math.floor(lunarElongation(ms) / 90) % 4;
  const events = [];

  let prevMs = startMs;
  let prevQ = quadrant(prevMs);
  for (let ms = startMs + DAY / 4; ms <= endMs + DAY / 4; ms += DAY / 4) {
    const q = quadrant(ms);
    if (q !== prevQ) {
      let lo = prevMs;
      let hi = ms;
      while (hi - lo > 1000) {
        const mid = (lo + hi) / 2;
        if (quadrant(mid) === prevQ) lo = mid;
        else hi = mid;
      }
      const t = Math.round(hi);
      if (t >= startMs && t <= endMs) events.push({ ms: t, type: TYPES[q] });
    }
    prevMs = ms;
    prevQ = q;
  }
  return events;
}

/** The next new and full moon after `fromMs`. */
export function nextNewAndFull(fromMs) {
  const events = lunarPhaseEvents(fromMs, fromMs + 32 * DAY);
  return {
    nextNew: events.find((e) => e.type === 'new')?.ms ?? null,
    nextFull: events.find((e) => e.type === 'full')?.ms ?? null,
  };
}
