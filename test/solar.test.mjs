import {
  solarElevation,
  sunriseSunset,
  darkIntervals,
  moonPhase,
  HORIZON,
  CIVIL,
} from '../js/solar.js';

let failures = 0;
function check(name, actual, expected, tol) {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}\n      got ${actual}, expected ${expected} ±${tol}`
  );
}

// --- 1. Solar noon elevation, Los Angeles, summer solstice -----------------
// At local solar noon on the solstice, elevation = 90 - |lat - declination|,
// and declination is at its maximum of +23.44 deg.
// LA: 34.05 N  ->  90 - (34.05 - 23.44) = 79.39 deg
{
  const lat = 34.05;
  const lon = -118.24;
  let best = -90;
  const day = Date.UTC(2026, 5, 21, 0, 0, 0);
  for (let m = 0; m < 1440; m++) {
    const el = solarElevation(day + m * 60000, lat, lon);
    if (el > best) best = el;
  }
  check('LA solstice solar-noon elevation', best, 79.39, 0.1);
}

// --- 2. Equator at equinox: sun passes essentially overhead ----------------
{
  let best = -90;
  const day = Date.UTC(2026, 2, 20, 0, 0, 0);
  for (let m = 0; m < 1440; m++) {
    const el = solarElevation(day + m * 60000, 0, 0);
    if (el > best) best = el;
  }
  check('Equator equinox max elevation', best, 90, 0.5);
}

// --- 3. Sunrise / sunset, Los Angeles, summer solstice ---------------------
// Published values for LA on 21 Jun: sunrise 05:42 PDT, sunset 20:08 PDT.
// PDT = UTC-7, so 12:42 UTC and 03:08 UTC on the 22nd.
{
  const lat = 34.05;
  const lon = -118.24;
  const localMidnight = Date.UTC(2026, 5, 21, 7, 0, 0); // 00:00 PDT
  const { sunrise, sunset } = sunriseSunset(localMidnight, lat, lon);

  const riseMin = (sunrise - localMidnight) / 60000;
  const setMin = (sunset - localMidnight) / 60000;

  check('LA solstice sunrise (min after local midnight)', riseMin, 5 * 60 + 42, 3);
  check('LA solstice sunset (min after local midnight)', setMin, 20 * 60 + 8, 3);
}

// --- 4. Polar day: Utqiagvik, Alaska in late June never sets ---------------
{
  const start = Date.UTC(2026, 5, 21, 0, 0, 0);
  const nights = darkIntervals(start, start + 86400000, 71.29, -156.79, HORIZON);
  const total = nights.reduce((s, n) => s + (n.end - n.start), 0);
  check('Utqiagvik midsummer dark hours', total / 3600000, 0, 0.01);
}

// --- 5. Polar night: same site in late December never rises ---------------
{
  const start = Date.UTC(2026, 11, 21, 0, 0, 0);
  const nights = darkIntervals(start, start + 86400000, 71.29, -156.79, HORIZON);
  const total = nights.reduce((s, n) => s + (n.end - n.start), 0);
  check('Utqiagvik midwinter dark hours', total / 3600000, 24, 0.01);
}

// --- 6. Night length sanity at LA on the solstice --------------------------
// Sunset to sunrise should be roughly 24 - 14.4 = 9.6 h of sub-horizon time.
{
  const start = Date.UTC(2026, 5, 21, 7, 0, 0);
  const nights = darkIntervals(start, start + 86400000, 34.05, -118.24, HORIZON);
  const total = nights.reduce((s, n) => s + (n.end - n.start), 0);
  check('LA solstice sub-horizon hours', total / 3600000, 9.57, 0.15);
}

// --- 7. Civil twilight is a strictly shorter dark window than night --------
{
  const start = Date.UTC(2026, 5, 21, 7, 0, 0);
  const night = darkIntervals(start, start + 86400000, 34.05, -118.24, HORIZON);
  const civil = darkIntervals(start, start + 86400000, 34.05, -118.24, CIVIL);
  const nh = night.reduce((s, n) => s + (n.end - n.start), 0) / 3600000;
  const ch = civil.reduce((s, n) => s + (n.end - n.start), 0) / 3600000;
  const ok = ch < nh && ch > 0;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  Civil-dark (${ch.toFixed(2)} h) shorter than night (${nh.toFixed(2)} h)`
  );
}

// --- 8. Moon phase at the total lunar eclipse of 21 Jan 2000 --------------
// A total lunar eclipse is by definition a full moon: illumination -> 1.
{
  const eclipse = Date.UTC(2000, 0, 21, 4, 44, 0);
  const { illumination, name } = moonPhase(eclipse);
  check('Moon illumination at 2000-01-21 eclipse', illumination, 1.0, 0.01);
  const ok = name === 'Full moon';
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  Moon phase name at eclipse: got "${name}"`);
}

// --- 9. New moon: solar eclipse of 21 Aug 2017 ---------------------------
{
  const eclipse = Date.UTC(2017, 7, 21, 18, 26, 0);
  const { illumination } = moonPhase(eclipse);
  check('Moon illumination at 2017-08-21 solar eclipse', illumination, 0.0, 0.01);
}

console.log(failures === 0 ? '\nAll solar tests passed.' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
