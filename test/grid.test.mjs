import {
  parseValidTime,
  hourlyMap,
  hourlyWeatherMap,
  sample,
  lastValidHour,
  cToF,
  compass,
  haversineKm,
} from '../js/grid.js';
import { dayKey, startOfLocalDay, addLocalDays, hourOfDay } from '../js/time.js';

let failures = 0;
function ok(name, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n      ' + detail : ''}`);
}
function eq(name, a, b, tol = 1e-9) {
  ok(name, Math.abs(a - b) <= tol, `got ${a}, expected ${b}`);
}

const HOUR = 3600000;

// --- validTime parsing ----------------------------------------------------
{
  const a = parseValidTime('2026-08-20T06:00:00+00:00/PT6H');
  eq('PT6H duration', a.hours, 6);
  eq('PT6H start', a.start, Date.UTC(2026, 7, 20, 6));

  eq('PT1H duration', parseValidTime('2026-08-20T06:00:00+00:00/PT1H').hours, 1);
  eq('P1D duration', parseValidTime('2026-08-20T06:00:00+00:00/P1D').hours, 24);
  eq('P1DT6H duration', parseValidTime('2026-08-20T06:00:00+00:00/P1DT6H').hours, 30);
  eq('PT30M duration', parseValidTime('2026-08-20T06:00:00+00:00/PT30M').hours, 0.5);
}

// --- STATE variables copy across the block --------------------------------
{
  const temp = {
    values: [
      { validTime: '2026-08-20T00:00:00+00:00/PT3H', value: 20 },
      { validTime: '2026-08-20T03:00:00+00:00/PT2H', value: 22 },
    ],
  };
  const m = hourlyMap(temp, { transform: cToF });
  eq('state var hour 0', m.get(Date.UTC(2026, 7, 20, 0)), 68);
  eq('state var hour 2', m.get(Date.UTC(2026, 7, 20, 2)), 68);
  eq('state var hour 3', m.get(Date.UTC(2026, 7, 20, 3)), 71.6, 1e-9);
  ok('state var stops at block end', m.get(Date.UTC(2026, 7, 20, 5)) === undefined);
  eq('state var hour count', m.size, 5);
}

// --- ACCUMULATION variables divide across the block -----------------------
// This is the bug that bites when adding QPF: 12 mm over PT6H must become
// 2 mm/h, not 12 mm on each of six hours.
{
  const qpf = {
    values: [{ validTime: '2026-08-20T00:00:00+00:00/PT6H', value: 12 }],
  };

  const wrong = hourlyMap(qpf);
  const wrongTotal = [...wrong.values()].reduce((a, b) => a + b, 0);
  eq('naive expansion inflates the 6 h total to 72 mm', wrongTotal, 72);

  const right = hourlyMap(qpf, { accumulation: true });
  const rightTotal = [...right.values()].reduce((a, b) => a + b, 0);
  eq('accumulation expansion preserves the 12 mm total', rightTotal, 12);
  eq('accumulation hourly rate', right.get(Date.UTC(2026, 7, 20, 3)), 2);
}

// --- Accumulation totals survive mixed block lengths ----------------------
{
  const qpf = {
    values: [
      { validTime: '2026-08-20T00:00:00+00:00/PT1H', value: 0.5 },
      { validTime: '2026-08-20T01:00:00+00:00/PT6H', value: 9 },
      { validTime: '2026-08-20T07:00:00+00:00/PT12H', value: 6 },
    ],
  };
  const m = hourlyMap(qpf, { accumulation: true });
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  eq('mixed-length QPF total', total, 15.5, 1e-9);
  eq('19 hours covered', m.size, 19);
}

// --- Nulls are skipped, not coerced to zero -------------------------------
{
  const v = {
    values: [
      { validTime: '2026-08-20T00:00:00+00:00/PT1H', value: null },
      { validTime: '2026-08-20T01:00:00+00:00/PT1H', value: 5 },
    ],
  };
  const m = hourlyMap(v);
  ok('null block omitted', m.get(Date.UTC(2026, 7, 20, 0)) === undefined);
  eq('following block kept', m.get(Date.UTC(2026, 7, 20, 1)), 5);
}

// --- A zero value is preserved (not confused with absent) -----------------
{
  const v = { values: [{ validTime: '2026-08-20T00:00:00+00:00/PT1H', value: 0 }] };
  const m = hourlyMap(v);
  eq('zero preserved', m.get(Date.UTC(2026, 7, 20, 0)), 0);
  const s = sample(m, [Date.UTC(2026, 7, 20, 0), Date.UTC(2026, 7, 20, 1)]);
  ok('sample keeps 0 and nulls the gap', s[0] === 0 && s[1] === null, JSON.stringify(s));
}

// --- weather array expansion ---------------------------------------------
{
  const w = {
    values: [
      {
        validTime: '2026-08-20T00:00:00+00:00/PT2H',
        value: [{ coverage: 'likely', weather: 'rain_showers', intensity: 'light' }],
      },
      { validTime: '2026-08-20T02:00:00+00:00/PT1H', value: [{ weather: null }] },
    ],
  };
  const m = hourlyWeatherMap(w);
  eq('weather hour 0 entries', m.get(Date.UTC(2026, 7, 20, 0)).length, 1);
  ok('weather hour 0 type', m.get(Date.UTC(2026, 7, 20, 0))[0].weather === 'rain_showers');
  eq('null weather filtered out', m.get(Date.UTC(2026, 7, 20, 2)).length, 0);
}

// --- lastValidHour --------------------------------------------------------
{
  const m = hourlyMap({
    values: [{ validTime: '2026-08-20T00:00:00+00:00/PT6H', value: 1 }],
  });
  eq('lastValidHour', lastValidHour(m), Date.UTC(2026, 7, 20, 5));
  ok('lastValidHour of empty map is null', lastValidHour(new Map()) === null);
}

// --- compass --------------------------------------------------------------
{
  ok('compass 0', compass(0) === 'N');
  ok('compass 90', compass(90) === 'E');
  ok('compass 350', compass(350) === 'N');
  ok('compass 348.75 rounds to N', compass(349) === 'N');
  ok('compass 22.5', compass(22.5) === 'NNE');
  ok('compass 247.5', compass(247.5) === 'WSW');
  ok('compass -10 wraps', compass(-10) === 'N');
  ok('compass null', compass(null) === '');
}

// --- haversine ------------------------------------------------------------
{
  // LAX to JFK is about 3974 km.
  const d = haversineKm(33.9416, -118.4085, 40.6413, -73.7781);
  ok('LAX-JFK distance', Math.abs(d - 3974) < 15, `got ${d.toFixed(1)} km`);
  eq('zero distance', haversineKm(34, -118, 34, -118), 0);
}

// --- Day bucketing in the forecast location's zone ------------------------
{
  // 2026-08-20T03:00Z is still 2026-08-19 in Los Angeles (UTC-7).
  const t = Date.UTC(2026, 7, 20, 3, 0);
  ok(
    'LA day key rolls back across UTC midnight',
    dayKey(t, 'America/Los_Angeles') === '2026-08-19',
    dayKey(t, 'America/Los_Angeles')
  );
  ok(
    'UTC day key for the same instant',
    dayKey(t, 'UTC') === '2026-08-20',
    dayKey(t, 'UTC')
  );
  ok(
    'Tokyo day key rolls forward',
    dayKey(t, 'Asia/Tokyo') === '2026-08-20',
    dayKey(t, 'Asia/Tokyo')
  );
}

{
  const t = Date.UTC(2026, 7, 20, 20, 34);
  const start = startOfLocalDay(t, 'America/Los_Angeles');
  ok(
    'local midnight is 07:00Z in PDT',
    start === Date.UTC(2026, 7, 20, 7, 0),
    new Date(start).toISOString()
  );
  eq('hour at local midnight', hourOfDay(start, 'America/Los_Angeles'), 0);
}

// --- DST: the spring-forward day is 23 hours long -------------------------
{
  // US DST begins 2026-03-08.
  const sat = startOfLocalDay(Date.UTC(2026, 2, 7, 20), 'America/Los_Angeles');
  const sun = addLocalDays(sat, 'America/Los_Angeles', 1);
  const mon = addLocalDays(sat, 'America/Los_Angeles', 2);
  eq('Sat -> Sun is 24 h (before transition)', (sun - sat) / HOUR, 24);
  eq('Sun -> Mon is 23 h (spring forward)', (mon - sun) / HOUR, 23);
  eq('midnight is still hour 0 after DST', hourOfDay(mon, 'America/Los_Angeles'), 0);
}

// --- DST: the fall-back day is 25 hours long ------------------------------
{
  // US DST ends 2026-11-01.
  const sat = startOfLocalDay(Date.UTC(2026, 9, 31, 20), 'America/Los_Angeles');
  const sun = addLocalDays(sat, 'America/Los_Angeles', 1);
  const mon = addLocalDays(sat, 'America/Los_Angeles', 2);
  eq('Sun -> Mon is 25 h (fall back)', (mon - sun) / HOUR, 25);
  eq('midnight is still hour 0 after DST', hourOfDay(mon, 'America/Los_Angeles'), 0);
}

// --- Half-hour and 45-minute offset zones ---------------------------------
{
  const t = Date.UTC(2026, 7, 20, 12, 0);
  const kolkata = startOfLocalDay(t, 'Asia/Kolkata'); // UTC+5:30
  eq('Kolkata midnight offset', hourOfDay(kolkata, 'Asia/Kolkata'), 0);
  ok(
    'Kolkata midnight is 18:30Z the previous day',
    kolkata === Date.UTC(2026, 7, 19, 18, 30),
    new Date(kolkata).toISOString()
  );

  const kathmandu = startOfLocalDay(t, 'Asia/Kathmandu'); // UTC+5:45
  eq('Kathmandu midnight offset', hourOfDay(kathmandu, 'Asia/Kathmandu'), 0);
}

// --- Seven local days is exactly 7 columns --------------------------------
{
  const tz = 'America/Los_Angeles';
  const day0 = startOfLocalDay(Date.UTC(2026, 7, 20, 16), tz);
  const keys = new Set();
  const end = addLocalDays(day0, tz, 7);
  for (let t = day0; t < end; t += HOUR) keys.add(dayKey(t, tz));
  eq('seven local days yields seven day keys', keys.size, 7);
  eq('span is 168 hours', (end - day0) / HOUR, 168);
}


// --- Regression: local midnight must land on a whole minute ---------------
// If startOfLocalDay carries the caller's milliseconds, every hourly label
// derived from it is offset and no gridpoint lookup ever matches.
{
  const tz = 'America/Los_Angeles';
  const messy = Date.UTC(2026, 7, 20, 16, 42, 37, 419);
  const start = startOfLocalDay(messy, tz);
  eq('local midnight has zero seconds', new Date(start).getUTCSeconds(), 0);
  eq('local midnight has zero ms', new Date(start).getUTCMilliseconds(), 0);
  ok(
    'local midnight is hour-aligned in a whole-hour zone',
    start % HOUR === 0,
    new Date(start).toISOString()
  );
}

// --- Regression: sampling tolerates a non-hour-aligned timeline -----------
// Kolkata local midnight is 18:30Z. Gridpoint blocks start on the hour, so
// the sampler has to floor before looking up.
{
  const m = hourlyMap({
    values: [{ validTime: '2026-08-19T18:00:00+00:00/PT6H', value: 21 }],
  });
  const tz = 'Asia/Kolkata';
  const start = startOfLocalDay(Date.UTC(2026, 7, 20, 6), tz);
  const labels = [start, start + HOUR, start + 2 * HOUR];
  const s = sample(m, labels);
  ok(
    'half-hour-offset timeline still samples the grid',
    s.every((v) => v === 21),
    JSON.stringify(s)
  );
}

console.log(failures === 0 ? '\nAll grid/time tests passed.' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
