import {
  moonEcliptic,
  moonAltitude,
  moonriseMoonset,
  moonState,
  lunarPhaseEvents,
  nextNewAndFull,
  SYNODIC_MONTH,
} from '../js/moon.js';
import {
  solarLongitude,
  solarNoon,
  dayLengthAnalytic,
  nextSeasonEvent,
  sunriseSunset,
  darkIntervals,
  HORIZON,
} from '../js/solar.js';

let failures = 0;
function check(name, actual, expected, tol, unit = '') {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}\n      got ${actual.toFixed(3)}${unit}, expected ${expected}${unit} ±${tol}`
  );
}
function ok(name, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n      ' + detail : ''}`);
}
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const angleDiff = (a, b) => ((a - b + 540) % 360) - 180;

// --- Eclipse geometry ------------------------------------------------------
// At the greatest phase of an eclipse the Sun, Earth and Moon are aligned,
// so the lunar theory has to put the Moon at the Sun's longitude (solar) or
// opposite it (lunar), and within a fraction of a degree of the ecliptic.

{
  // Total lunar eclipse, 2000-01-21, greatest eclipse 04:44 UTC.
  const t = Date.UTC(2000, 0, 21, 4, 44);
  const m = moonEcliptic(t);
  const s = solarLongitude(t);
  check('Lunar eclipse 2000: Moon opposite Sun', Math.abs(angleDiff(m.lon, s)), 180, 0.5, '°');
  check('Lunar eclipse 2000: Moon on the ecliptic', Math.abs(m.lat), 0, 0.5, '°');
}

{
  // Total solar eclipse, 2017-08-21, greatest eclipse 18:26 UTC.
  // Geocentric separation can reach ~0.9 deg because of parallax.
  const t = Date.UTC(2017, 7, 21, 18, 26);
  const m = moonEcliptic(t);
  const s = solarLongitude(t);
  check('Solar eclipse 2017: Moon at Sun longitude', Math.abs(angleDiff(m.lon, s)), 0, 0.5, '°');
  check('Solar eclipse 2017: Moon near ecliptic', Math.abs(m.lat), 0, 1.0, '°');
}

// --- Phase instants ---------------------------------------------------------
{
  // Full moon of 2000-01-21 was at 04:40 UTC.
  const { nextFull } = nextNewAndFull(Date.UTC(2000, 0, 15));
  check(
    'Full moon Jan 2000 (min from 04:40 UTC)',
    (nextFull - Date.UTC(2000, 0, 21, 4, 40)) / MIN,
    0,
    20,
    ' min'
  );
}

{
  // New moon of 2017-08-21 was at 18:30 UTC.
  const { nextNew } = nextNewAndFull(Date.UTC(2017, 7, 15));
  check(
    'New moon Aug 2017 (min from 18:30 UTC)',
    (nextNew - Date.UTC(2017, 7, 21, 18, 30)) / MIN,
    0,
    20,
    ' min'
  );
}

{
  const events = lunarPhaseEvents(Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31));
  const counts = events.reduce((a, e) => ((a[e.type] = (a[e.type] || 0) + 1), a), {});
  ok(
    '2026 has 12-13 of each principal phase',
    ['new', 'first', 'full', 'last'].every((k) => counts[k] >= 12 && counts[k] <= 13),
    JSON.stringify(counts)
  );

  const order = ['new', 'first', 'full', 'last'];
  const cyclic = events.every(
    (e, i) => i === 0 || order.indexOf(e.type) === (order.indexOf(events[i - 1].type) + 1) % 4
  );
  ok('Phases occur in cyclic order', cyclic);

  const fulls = events.filter((e) => e.type === 'full');
  const gaps = fulls.slice(1).map((e, i) => (e.ms - fulls[i].ms) / DAY);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  check('Mean full-to-full interval is the synodic month', mean, SYNODIC_MONTH, 0.15, ' d');
}

// --- Illumination and naming -------------------------------------------------
{
  const full = moonState(Date.UTC(2000, 0, 21, 4, 44));
  check('Illumination at lunar eclipse', full.illumination, 1, 0.001);
  ok('Named "Full moon" at the eclipse', full.name === 'Full moon', full.name);

  const nu = moonState(Date.UTC(2017, 7, 21, 18, 26));
  check('Illumination at solar eclipse', nu.illumination, 0, 0.001);
  ok('Named "New moon" at the eclipse', nu.name === 'New moon', nu.name);

  const later = moonState(Date.UTC(2000, 0, 21, 4, 44) + 3 * DAY);
  ok('Three days after full: waning gibbous', later.name === 'Waning gibbous', later.name);
  ok('Waning flag set after full', later.waxing === false);

  const before = moonState(Date.UTC(2000, 0, 21, 4, 44) - 5 * DAY);
  ok('Five days before full: waxing gibbous', before.name === 'Waxing gibbous', before.name);
  check('Age at full is half a synodic month', full.age, SYNODIC_MONTH / 2, 0.1, ' d');
}

// --- Moonrise / moonset -------------------------------------------------------
// A full Moon is opposite the Sun, so it rises near sunset. Boulder, CO on
// 2000-01-20 (MST, UTC-7): full moon was 21:40 MST that evening.
{
  const lat = 40.015;
  const lon = -105.27;
  const dayStart = Date.UTC(2000, 0, 20, 7);
  const { rise } = moonriseMoonset(dayStart, dayStart + DAY, lat, lon);
  const { sunset } = sunriseSunset(dayStart, lat, lon);
  ok('Moonrise found on a full-moon day', rise !== null);
  check('Full moon rises near sunset (min)', (rise - sunset) / MIN, 0, 45, ' min');

  // At the rise instant the geocentric altitude sits at the rise threshold,
  // and a few hours later the Moon is well up.
  ok(
    'Moon is above the horizon 3 h after moonrise',
    moonAltitude(rise + 3 * HOUR, lat, lon) > 15,
    `${moonAltitude(rise + 3 * HOUR, lat, lon).toFixed(1)}°`
  );
}

{
  // Once a month a calendar day has no moonrise. Over a lunar month at
  // mid-latitude, exactly one or two days should come back null.
  const lat = 40.015;
  const lon = -105.27;
  let noRise = 0;
  let noSet = 0;
  for (let d = 0; d < 30; d++) {
    const start = Date.UTC(2026, 8, 1, 6) + d * DAY;
    const r = moonriseMoonset(start, start + DAY, lat, lon);
    if (r.rise === null) noRise++;
    if (r.set === null) noSet++;
  }
  ok('One day a month without moonrise', noRise >= 1 && noRise <= 2, `${noRise} day(s)`);
  ok('One day a month without moonset', noSet >= 1 && noSet <= 2, `${noSet} day(s)`);
}

// --- Solar noon, day length, seasons ------------------------------------------
{
  // Los Angeles, June solstice: published solar noon 12:55 PDT, and the
  // transit elevation 90 - (34.05 - 23.44) = 79.39 deg.
  const dayStart = Date.UTC(2026, 5, 21, 7);
  const { ms, elevation } = solarNoon(dayStart, 34.05, -118.24);
  check('LA solstice solar noon (min after local midnight)', (ms - dayStart) / MIN, 12 * 60 + 55, 1.5, ' min');
  check('LA solstice transit elevation', elevation, 79.39, 0.1, '°');
}

{
  // The analytic day length should agree with the exact crossing search.
  const lat = 34.05;
  const lon = -118.24;
  for (const [label, month, day] of [['solstice', 5, 21], ['equinox', 8, 22], ['winter', 11, 21]]) {
    const dayStart = Date.UTC(2026, month, day, 8);
    const dark = darkIntervals(dayStart, dayStart + DAY, lat, lon, HORIZON)
      .reduce((a, iv) => a + iv.end - iv.start, 0);
    const exact = DAY - dark;
    const approx = dayLengthAnalytic(solarNoon(dayStart, lat, lon).ms, lat);
    check(`Analytic day length matches exact (${label})`, (approx - exact) / MIN, 0, 2, ' min');
  }
}

{
  ok('Polar night gives zero day length', dayLengthAnalytic(Date.UTC(2026, 11, 21, 21), 71.29) === 0);
  ok('Polar day gives 24 h', dayLengthAnalytic(Date.UTC(2026, 5, 21, 21), 71.29) === DAY);
}

{
  // 2024 equinoxes and solstices, UTC.
  const refs = [
    ['March equinox', Date.UTC(2024, 2, 20, 3, 6), Date.UTC(2024, 2, 1)],
    ['June solstice', Date.UTC(2024, 5, 20, 20, 51), Date.UTC(2024, 5, 1)],
    ['September equinox', Date.UTC(2024, 8, 22, 12, 44), Date.UTC(2024, 8, 1)],
    ['December solstice', Date.UTC(2024, 11, 21, 9, 21), Date.UTC(2024, 11, 1)],
  ];
  for (const [name, expected, from] of refs) {
    const ev = nextSeasonEvent(from);
    ok(`Next event after ${new Date(from).toISOString().slice(0, 10)} is the ${name}`, ev.name === name, ev.name);
    check(`${name} 2024 timing`, (ev.ms - expected) / MIN, 0, 20, ' min');
  }
}


// --- Published almanac cross-checks, Denver ----------------------------------
// Independent published tables, rounded to the minute by their sources. MDT is
// UTC-6. Sources: timeanddate.com (2025-05-22), sunrisesunset.com (2026-09-01),
// phases-moon.com (September 2026 phases).
{
  const lat = 39.7392;
  const lon = -104.9847;
  const mdt = (y, mo, d, h, mi) => Date.UTC(y, mo, d, h + 6, mi);

  const may22 = mdt(2025, 4, 22, 0, 0);
  const m1 = moonriseMoonset(may22, may22 + DAY, lat, lon);
  check('Denver 2025-05-22 moonrise vs timeanddate 02:49', (m1.rise - mdt(2025, 4, 22, 2, 49)) / MIN, 0, 4, ' min');
  check('Denver 2025-05-22 moonset vs timeanddate 15:11', (m1.set - mdt(2025, 4, 22, 15, 11)) / MIN, 0, 4, ' min');

  const s1 = sunriseSunset(may22, lat, lon);
  check('Denver 2025-05-22 sunrise vs 05:39', (s1.sunrise - mdt(2025, 4, 22, 5, 39)) / MIN, 0, 1.5, ' min');
  check('Denver 2025-05-22 sunset vs 20:14', (s1.sunset - mdt(2025, 4, 22, 20, 14)) / MIN, 0, 1.5, ' min');
  check('Denver 2025-05-22 day length vs 14h 35m 02s', (s1.sunset - s1.sunrise) / 1000, 14 * 3600 + 35 * 60 + 2, 60, ' s');

  const s0 = sunriseSunset(may22 - DAY, lat, lon);
  const delta = (s1.sunset - s1.sunrise) - (s0.sunset - s0.sunrise);
  check('Denver day-length change vs +1m 35s', delta / 1000, 95, 10, ' s');

  const noon = solarNoon(may22, lat, lon);
  check('Denver 2025-05-22 solar noon vs 12:56', (noon.ms - mdt(2025, 4, 22, 12, 56)) / MIN, 0, 1, ' min');
  check('Denver 2025-05-22 noon elevation vs 70.8', noon.elevation, 70.8, 0.15, '°');

  const sep1 = mdt(2026, 8, 1, 0, 0);
  const m2 = moonriseMoonset(sep1, sep1 + DAY, lat, lon);
  check('Denver 2026-09-01 moonrise vs sunrisesunset.com 21:35', (m2.rise - mdt(2026, 8, 1, 21, 35)) / MIN, 0, 4, ' min');
  check('Denver 2026-09-01 moonset vs sunrisesunset.com 11:24', (m2.set - mdt(2026, 8, 1, 11, 24)) / MIN, 0, 4, ' min');

  const events = lunarPhaseEvents(mdt(2026, 8, 1, 0, 0), mdt(2026, 8, 30, 0, 0));
  const refs = {
    last: mdt(2026, 8, 4, 1, 52),
    new: mdt(2026, 8, 10, 21, 27),
    first: mdt(2026, 8, 18, 14, 44),
    full: mdt(2026, 8, 26, 10, 50),
  };
  for (const [type, expected] of Object.entries(refs)) {
    const e = events.find((x) => x.type === type);
    check(`Sept 2026 ${type} phase vs phases-moon.com`, (e.ms - expected) / MIN, 0, 5, ' min');
  }
}

console.log(failures === 0 ? '\nAll moon/sky tests passed.' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
