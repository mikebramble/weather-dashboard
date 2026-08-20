// solar.js — solar position and twilight boundaries.
//
// Implements the NOAA solar position algorithm (after Meeus, "Astronomical
// Algorithms"). Accurate to well under a minute for sunrise/sunset at the
// latitudes this dashboard cares about, which is far better than the hourly
// resolution of the forecast grid it shades.
//
// Everything here is pure: no network, no DOM. That makes it testable.

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

// Refraction-corrected geometric altitude of the solar disc's upper limb at
// the moment of sunrise/sunset. The other thresholds are the standard
// twilight definitions.
export const HORIZON = -0.833;
export const CIVIL = -6;
export const NAUTICAL = -12;
export const ASTRONOMICAL = -18;

function julianCentury(ms) {
  const jd = ms / 86400000 + 2440587.5;
  return (jd - 2451545) / 36525;
}

/**
 * Solar declination and the equation of time for a given instant.
 * @param {number} ms epoch milliseconds
 * @returns {{declination: number, eqTime: number}} degrees, minutes
 */
function solarParams(ms) {
  const t = julianCentury(ms);

  const meanLong = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const meanAnom = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccent = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  const eqCtr =
    Math.sin(RAD * meanAnom) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(RAD * 2 * meanAnom) * (0.019993 - 0.000101 * t) +
    Math.sin(RAD * 3 * meanAnom) * 0.000289;

  const trueLong = meanLong + eqCtr;
  const appLong =
    trueLong - 0.00569 - 0.00478 * Math.sin(RAD * (125.04 - 1934.136 * t));

  const meanObliq =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliqCorr =
    meanObliq + 0.00256 * Math.cos(RAD * (125.04 - 1934.136 * t));

  const declination =
    Math.asin(Math.sin(RAD * obliqCorr) * Math.sin(RAD * appLong)) * DEG;

  const y = Math.tan((RAD * obliqCorr) / 2) ** 2;
  const eqTime =
    4 *
    DEG *
    (y * Math.sin(2 * RAD * meanLong) -
      2 * eccent * Math.sin(RAD * meanAnom) +
      4 * eccent * y * Math.sin(RAD * meanAnom) * Math.cos(2 * RAD * meanLong) -
      0.5 * y * y * Math.sin(4 * RAD * meanLong) -
      1.25 * eccent * eccent * Math.sin(2 * RAD * meanAnom));

  return { declination, eqTime };
}

/**
 * Solar elevation above the horizon, in degrees.
 * Negative values are below the horizon; see the twilight constants above.
 * @param {number} ms epoch milliseconds
 * @param {number} lat degrees north
 * @param {number} lon degrees east (western hemisphere is negative)
 */
export function solarElevation(ms, lat, lon) {
  const { declination, eqTime } = solarParams(ms);
  const d = new Date(ms);
  const utcMinutes =
    d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;

  let trueSolarTime = (utcMinutes + eqTime + 4 * lon) % 1440;
  if (trueSolarTime < 0) trueSolarTime += 1440;

  let hourAngle = trueSolarTime / 4 - 180;
  if (hourAngle < -180) hourAngle += 360;

  const cosZenith =
    Math.sin(RAD * lat) * Math.sin(RAD * declination) +
    Math.cos(RAD * lat) * Math.cos(RAD * declination) * Math.cos(RAD * hourAngle);

  return 90 - Math.acos(Math.min(1, Math.max(-1, cosZenith))) * DEG;
}

/**
 * Find every instant in [startMs, endMs] where the solar elevation crosses a
 * threshold, by coarse scan plus bisection.
 *
 * Returned as {ms, rising} so callers can pair them into intervals. Handles
 * polar day and polar night correctly by simply returning no crossings —
 * callers should fall back to the sign of the elevation at the midpoint.
 */
export function findCrossings(startMs, endMs, lat, lon, threshold = HORIZON) {
  const step = 10 * 60 * 1000; // 10-minute coarse scan
  const crossings = [];
  let prevMs = startMs;
  let prevEl = solarElevation(prevMs, lat, lon) - threshold;

  for (let ms = startMs + step; ms <= endMs; ms += step) {
    const el = solarElevation(ms, lat, lon) - threshold;
    if (prevEl === 0 || (prevEl < 0) !== (el < 0)) {
      // Bisect to the second.
      let lo = prevMs;
      let hi = ms;
      for (let i = 0; i < 24 && hi - lo > 1000; i++) {
        const mid = (lo + hi) / 2;
        const midEl = solarElevation(mid, lat, lon) - threshold;
        if ((midEl < 0) === (prevEl < 0)) lo = mid;
        else hi = mid;
      }
      crossings.push({ ms: Math.round((lo + hi) / 2), rising: el > prevEl });
    }
    prevMs = ms;
    prevEl = el;
  }
  return crossings;
}

/**
 * Build a list of below-threshold intervals across a window, suitable for
 * painting onto a chart background.
 *
 * @returns {Array<{start: number, end: number}>} clipped to [startMs, endMs]
 */
export function darkIntervals(startMs, endMs, lat, lon, threshold = HORIZON) {
  const crossings = findCrossings(startMs, endMs, lat, lon, threshold);
  const intervals = [];

  if (crossings.length === 0) {
    // No crossing in the window: either continuously up or continuously down.
    const el = solarElevation((startMs + endMs) / 2, lat, lon);
    if (el < threshold) intervals.push({ start: startMs, end: endMs });
    return intervals;
  }

  // Walk crossings, opening an interval at each set and closing at each rise.
  let openAt = solarElevation(startMs, lat, lon) < threshold ? startMs : null;
  for (const c of crossings) {
    if (c.rising) {
      if (openAt !== null) {
        intervals.push({ start: openAt, end: c.ms });
        openAt = null;
      }
    } else if (openAt === null) {
      openAt = c.ms;
    }
  }
  if (openAt !== null) intervals.push({ start: openAt, end: endMs });

  return intervals;
}

/**
 * Sunrise and sunset for the local day containing `dayStartMs`.
 * @returns {{sunrise: number|null, sunset: number|null}} epoch ms, or null
 *          if the sun does not cross the horizon that day.
 */
export function sunriseSunset(dayStartMs, lat, lon) {
  const crossings = findCrossings(
    dayStartMs,
    dayStartMs + 24 * 3600 * 1000,
    lat,
    lon,
    HORIZON
  );
  const rise = crossings.find((c) => c.rising);
  const set = crossings.find((c) => !c.rising);
  return { sunrise: rise ? rise.ms : null, sunset: set ? set.ms : null };
}

/**
 * Illuminated fraction and phase angle of the Moon.
 * Low-precision method (Meeus ch. 48), good to ~0.5% illumination — plenty
 * for naming a phase.
 * @returns {{illumination: number, phase: number, name: string}}
 *          illumination 0–1; phase 0–1 where 0 = new, 0.5 = full
 */
export function moonPhase(ms) {
  const t = julianCentury(ms);
  const D = 297.8501921 + 445267.1114034 * t - 0.0018819 * t * t; // mean elongation
  const M = 357.5291092 + 35999.0502909 * t; // sun mean anomaly
  const Mp = 134.9633964 + 477198.8675055 * t; // moon mean anomaly

  // Phase angle of the Moon (Meeus 48.4)
  const i =
    180 -
    D -
    6.289 * Math.sin(RAD * Mp) +
    2.1 * Math.sin(RAD * M) -
    1.274 * Math.sin(RAD * (2 * D - Mp)) -
    0.658 * Math.sin(RAD * 2 * D) -
    0.214 * Math.sin(RAD * 2 * Mp) -
    0.11 * Math.sin(RAD * D);

  const illumination = (1 + Math.cos(RAD * i)) / 2;

  // Normalised elongation gives waxing/waning and a 0–1 phase.
  let phase = (((D % 360) + 360) % 360) / 360;

  const names = [
    'New moon',
    'Waxing crescent',
    'First quarter',
    'Waxing gibbous',
    'Full moon',
    'Waning gibbous',
    'Last quarter',
    'Waning crescent',
  ];
  const name = names[Math.round(phase * 8) % 8];

  return { illumination, phase, name };
}
