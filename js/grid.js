// grid.js — turning NWS gridpoint data into hourly series.
//
// The gridpoint payload is a set of variable-length time blocks:
//
//   { "validTime": "2026-08-20T06:00:00+00:00/PT6H", "value": 12.7 }
//
// Expanding those to hourly needs care, because the blocks mean two different
// things depending on the variable:
//
//   STATE variables (temperature, sky cover, probability of precipitation)
//     describe a condition that holds throughout the block. Copying the value
//     to every hour is correct.
//
//   ACCUMULATION variables (quantitativePrecipitation, snowfallAmount,
//     iceAccumulation) are a *total over the block*. Copying 12 mm of QPF from
//     a PT6H block onto all six hours implies 72 mm. The value has to be
//     divided by the block length to get an hourly rate.
//
// Getting this wrong inflates precipitation by up to 6x, and it fails quietly
// because the shape of the curve still looks plausible.

const HOUR = 3600 * 1000;

/**
 * Parse an ISO 8601 interval into a start instant and a duration in hours.
 * Durations seen in NWS data run from PT1H to P1DT6H.
 */
export function parseValidTime(validTime) {
  const [startStr, durStr] = validTime.split('/');
  const start = Date.parse(startStr);

  const m = durStr.match(
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
  );
  if (!m) return { start, hours: 1 };

  const [, , , days, hours, minutes, seconds] = m;
  const total =
    (Number(days || 0) * 24) +
    Number(hours || 0) +
    Number(minutes || 0) / 60 +
    Number(seconds || 0) / 3600;

  return { start, hours: total > 0 ? total : 1 };
}

/**
 * Expand a gridpoint variable to a Map of hour-start epoch ms -> value.
 *
 * @param {object} variable  the gridpoint property, e.g. props.temperature
 * @param {object} [opts]
 * @param {boolean} [opts.accumulation=false]  divide by block length
 * @param {(v:number)=>number} [opts.transform]  unit conversion
 */
export function hourlyMap(variable, opts = {}) {
  const map = new Map();
  const values = variable && variable.values;
  if (!Array.isArray(values)) return map;

  const { accumulation = false, transform } = opts;

  for (const item of values) {
    if (item.value === null || item.value === undefined) continue;
    const { start, hours } = parseValidTime(item.validTime);
    const span = Math.max(1, Math.round(hours));
    let v = accumulation ? item.value / span : item.value;
    if (transform) v = transform(v);

    const base = Math.floor(start / HOUR) * HOUR;
    for (let i = 0; i < span; i++) map.set(base + i * HOUR, v);
  }
  return map;
}

/**
 * Expand the `weather` variable, which carries an array of coded conditions
 * per block rather than a scalar.
 * @returns {Map<number, Array<object>>}
 */
export function hourlyWeatherMap(variable) {
  const map = new Map();
  const values = variable && variable.values;
  if (!Array.isArray(values)) return map;

  for (const item of values) {
    const { start, hours } = parseValidTime(item.validTime);
    const span = Math.max(1, Math.round(hours));
    const base = Math.floor(start / HOUR) * HOUR;
    const entries = Array.isArray(item.value)
      ? item.value.filter((w) => w && w.weather)
      : [];
    for (let i = 0; i < span; i++) map.set(base + i * HOUR, entries);
  }
  return map;
}

/**
 * Sample a Map series onto an array of timestamps, filling gaps with null.
 *
 * Lookups are floored to the hour. Gridpoint blocks always start on the hour
 * in UTC, but a timeline anchored to local midnight does not: in India or
 * Nepal, local midnight falls at :30 or :45 past the hour. Flooring here keeps
 * the two aligned without forcing the timeline off the day boundary.
 */
export function sample(map, timestamps) {
  return timestamps.map((t) => {
    const v = map.get(Math.floor(t / HOUR) * HOUR);
    return v === undefined ? null : v;
  });
}

/**
 * The last hour for which a variable actually has data. Used to trim the
 * chart to the real extent of the forecast rather than assuming 168 hours.
 */
export function lastValidHour(map) {
  let max = -Infinity;
  for (const k of map.keys()) if (k > max) max = k;
  return Number.isFinite(max) ? max : null;
}

// --- Unit conversions applied at parse time -------------------------------
// NWS gridpoint data is metric regardless of the unitCode string, but we read
// the unitCode where it matters rather than assuming.

export const cToF = (c) => (c * 9) / 5 + 32;
export const kmhToKt = (k) => k * 0.5399568;
export const kmhToMph = (k) => k * 0.6213712;
export const mmToIn = (mm) => mm / 25.4;
export const mToFt = (m) => m * 3.2808399;

/** Compass point from a bearing in degrees. */
const POINTS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];
export function compass(deg) {
  if (deg === null || deg === undefined || Number.isNaN(deg)) return '';
  return POINTS[Math.floor((((deg % 360) + 360) % 360) / 22.5 + 0.5) % 16];
}

/** Great-circle distance in km, for labelling how far a station is. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
