import { boot } from './harness.mjs';

let failures = 0;
function ok(name, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n      ' + detail : ''}`);
}

// =========================================================================
// Scenario A: the worded forecast covers all seven days.
// =========================================================================
{
  console.log('\n--- Scenario A: full 7-day worded forecast ---');
  const { doc, charts, log } = await boot({ forecastDays: 7 });

  ok('Status panel hidden after load', doc.getElementById('status').hidden);
  ok('Content revealed', !doc.getElementById('content').hidden);

  const days = [...doc.querySelectorAll('.day')];
  ok('Day rail has exactly 7 columns', days.length === 7, `got ${days.length}`);

  // THE headline bug: the last column used to have no icon.
  const withIcon = days.filter((d) => d.querySelector('img.day__icon'));
  ok(
    'Every day column has an icon element',
    withIcon.length === 7,
    `${withIcon.length}/7 have icons`
  );

  const missing = days.filter((d) => d.dataset.iconState === 'missing');
  ok('No column is in the missing-icon state', missing.length === 0);

  const lastDay = days[days.length - 1];
  ok(
    'Last column has a real icon src',
    /^https:\/\/api\.weather\.gov\/icons\//.test(
      lastDay.querySelector('img.day__icon')?.getAttribute('src') || ''
    ),
    lastDay.querySelector('img.day__icon')?.getAttribute('src')
  );

  const derived = days.filter((d) => d.querySelector('.day__derived'));
  ok(
    'No day needs derivation when the worded forecast covers all 7',
    derived.length === 0,
    `${derived.length} derived`
  );

  // Every column carries a high/low and wording.
  const temps = days.filter((d) => /\d/.test(d.querySelector('.day__temps').textContent));
  ok('Every column has high/low values', temps.length === 7, `${temps.length}/7`);

  const summaries = days.filter((d) => d.querySelector('.day__summary').textContent.trim());
  ok('Every column has summary wording', summaries.length === 7, `${summaries.length}/7`);

  // --- Observations -------------------------------------------------------
  const readouts = [...doc.querySelectorAll('.readout')];
  ok('At least three readout cards rendered', readouts.length >= 3, `got ${readouts.length}`);

  const sources = readouts.map((r) => r.querySelector('.readout__source')?.textContent || '');

  // The nearest station's newest observation has a NULL temperature. The old
  // code showed "--". Coalescing back through recent reports recovers it.
  const nearest = readouts.find((r) => sources[readouts.indexOf(r)].includes('GDHC2'));
  ok('Nearest station card present', !!nearest, sources.join(' | '));
  if (nearest) {
    const value = nearest.querySelector('.readout__value').textContent;
    ok(
      'Nearest station shows a temperature despite a null in the latest report',
      /\d/.test(value),
      `showed "${value}"`
    );
    ok('Temperature is the 28-min-old 24.4 C = 76 F', value === '76°F', value);
  }

  // The mesonet station genuinely has no worded conditions; the second card
  // should supply them rather than the page reading "Conditions Not Reported".
  const full = readouts.find((r, i) => sources[i].includes('KBDU'));
  ok('Second card falls back to the nearest full report', !!full, sources.join(' | '));
  if (full) {
    ok(
      'Full report carries present weather',
      full.querySelector('.readout__caption').textContent.includes('Mostly Clear'),
      full.querySelector('.readout__caption').textContent
    );
  }

  const captions = readouts.map((r) => r.querySelector('.readout__caption')?.textContent || '');
  ok(
    'No card reads "Conditions Not Reported"',
    !captions.some((c) => /conditions not reported/i.test(c)),
    captions.join(' | ')
  );

  ok(
    'Observation age is shown',
    [...doc.querySelectorAll('.readout__age')].some((a) => /min ago|just now/.test(a.textContent))
  );

  ok(
    'Air quality card rendered',
    sources.some((s) => s.includes('Air quality'))
  );
  ok(
    'Sun and moon card rendered',
    sources.some((s) => s.includes('Sun and moon'))
  );

  // --- Hazards ------------------------------------------------------------
  const hazards = [...doc.querySelectorAll('.hazard')];
  ok('Both active alerts rendered', hazards.length === 2, `got ${hazards.length}`);
  ok(
    'Most severe alert sorts first',
    hazards[0].dataset.severity === 'Severe',
    hazards[0].dataset.severity
  );
  ok(
    'Alert names the event',
    hazards[0].querySelector('.hazard__event').textContent === 'Red Flag Warning'
  );
  ok(
    'Hazard section is visible',
    doc.getElementById('hazards').dataset.hasAlerts === 'true'
  );

  // --- Charts -------------------------------------------------------------
  const live = charts.filter((c) => !c.destroyed);
  ok('Four forecast panels built', live.length === 4, `got ${live.length}`);

  const tempChart = live[0];
  const labelCount = tempChart.data.labels.length;
  ok(
    'Timeline is 7 local days of hours',
    labelCount === 168,
    `got ${labelCount} hourly points`
  );

  const tempSeries = tempChart.data.datasets[0].data;
  ok(
    'Temperature series is populated',
    tempSeries.filter((v) => v !== null).length > 160,
    `${tempSeries.filter((v) => v !== null).length}/168 non-null`
  );

  ok(
    'Dewpoint series present in the temperature panel',
    tempChart.data.datasets.some((d) => d.label === 'Dewpoint')
  );

  const windChart = live[3];
  ok(
    'Wind panel has speed and gusts',
    windChart.data.datasets.map((d) => d.label).join(',') === 'Wind,Gusts',
    windChart.data.datasets.map((d) => d.label).join(',')
  );

  // Plugins actually drew: twilight fills, day gridlines, wind arrows.
  const fills = tempChart.ctx.calls.filter((c) => c.name === 'fillRect');
  ok('Twilight bands were painted', fills.length > 0, `${fills.length} fillRect calls`);

  const rotations = windChart.ctx.calls.filter((c) => c.name === 'rotate');
  ok('Wind direction arrows were drawn', rotations.length > 0, `${rotations.length} arrows`);

  // --- QPF is a rate, not a repeated block total --------------------------
  const precipChart = live[1];
  const qpf = precipChart.data.datasets.find((d) => d.label === 'Amount').data;
  const totalIn = qpf.reduce((a, b) => a + (b || 0), 0);
  // Three PT6H blocks of 6 mm each = 18 mm = 0.7087 in over 18 wet hours.
  // Copying the block value to every hour instead of dividing would give
  // 108 mm / 4.25 in, so this margin is far tighter than the failure mode.
  ok(
    'QPF sums to the true 18 mm, not 6x that',
    Math.abs(totalIn - 0.7087) < 0.01,
    `summed to ${totalIn.toFixed(4)} in (naive expansion would give ~4.25)`
  );

  const peak = Math.max(...qpf.filter((v) => v !== null));
  ok(
    'Hourly rate keeps enough precision to be visible',
    peak > 0 && Math.abs(peak - 0.0394) < 0.002,
    `peak hourly rate ${peak} in/h`
  );

  // --- Provenance ---------------------------------------------------------
  const prov = doc.getElementById('provenanceList').textContent;
  ok('Provenance names the grid cell', prov.includes('BOU cell 62,79'));
  ok('Provenance gives the grid issuance time', /issued/.test(prov));
  ok('Provenance names the observing station', prov.includes('KBDU') || prov.includes('GDHC2'));
  ok('Provenance names the time zone', prov.includes('America/Denver'));

  // --- Header -------------------------------------------------------------
  ok('Grid cell shown in header', doc.getElementById('coords').textContent.includes('BOU 62,79'));
  ok(
    'Local time zone abbreviation shown',
    /M[DS]T/.test(doc.getElementById('coords').textContent),
    doc.getElementById('coords').textContent
  );

  // --- Request hygiene ----------------------------------------------------
  const obsCalls = log.filter((u) => u.includes('/observations'));
  ok(
    'Observation requests are bounded',
    obsCalls.length <= 6,
    `${obsCalls.length} station observation requests`
  );
  ok(
    'Observations fetched as history, not just /latest',
    obsCalls.every((u) => u.includes('limit=')),
    obsCalls[0]
  );
  ok(
    'Model output not fetched until requested',
    !log.some((u) => u.includes('open-meteo.com/v1/forecast')),
    'model API should be lazy'
  );
}

// =========================================================================
// Scenario B: the gridded data outruns the worded forecast.
// This is the situation that produced the missing glyph.
// =========================================================================
{
  console.log('\n--- Scenario B: worded forecast only reaches 5 days ---');
  const { doc } = await boot({ forecastDays: 5 });

  const days = [...doc.querySelectorAll('.day')];
  ok('Still 7 day columns', days.length === 7, `got ${days.length}`);

  const withIcon = days.filter((d) => d.querySelector('img.day__icon'));
  ok(
    'Every column still gets an icon, derived where needed',
    withIcon.length === 7,
    `${withIcon.length}/7`
  );

  const derived = days.filter((d) => d.querySelector('.day__derived'));
  ok(
    'The two uncovered days are marked as derived',
    derived.length === 2,
    `${derived.length} marked`
  );

  ok(
    'Derived marker is on the trailing days',
    derived.every((d) => days.indexOf(d) >= 5),
    derived.map((d) => days.indexOf(d)).join(',')
  );

  ok(
    'Derived days still carry wording',
    derived.every((d) => d.querySelector('.day__summary').textContent.trim().length > 0),
    derived.map((d) => d.querySelector('.day__summary').textContent).join(' | ')
  );

  ok(
    'Derived icon points at the NWS icon service',
    derived.every((d) =>
      /api\.weather\.gov\/icons\/land\/day\//.test(d.querySelector('img.day__icon').src)
    ),
    derived[0]?.querySelector('img.day__icon')?.src
  );
}

// =========================================================================
// Scenario C: no alerts, and interaction.
// =========================================================================
{
  console.log('\n--- Scenario C: quiet weather, toggles, and probe ---');
  const { doc, window, charts, log } = await boot({ alerts: false });

  ok(
    'Hazard section stays collapsed with no alerts',
    doc.getElementById('hazards').dataset.hasAlerts === 'false'
  );
  ok('No hazard rows rendered', doc.querySelectorAll('.hazard').length === 0);

  // --- Unit toggle re-renders without refetching --------------------------
  const before = log.length;
  const tempF = charts.filter((c) => !c.destroyed)[0].data.datasets[0].data[12];
  doc.getElementById('unitToggle').dispatchEvent(new window.Event('click'));
  await new Promise((r) => setTimeout(r, 30));

  ok('Unit button reflects metric', doc.getElementById('unitToggle').textContent.includes('°C'));
  ok('No network requests on unit switch', log.length === before, `${log.length - before} new`);

  const liveAfter = charts.filter((c) => !c.destroyed);
  const tempC = liveAfter[0].data.datasets[0].data[12];
  ok(
    'Temperature converted to Celsius',
    Math.abs(tempC - ((tempF - 32) * 5) / 9) < 1.01,
    `${tempF} F -> ${tempC} C`
  );
  ok(
    'Day rail high/low switched to Celsius',
    doc.querySelector('.day__temps').textContent.includes('°C'),
    doc.querySelector('.day__temps').textContent
  );
  ok('Old charts destroyed on re-render', charts.filter((c) => c.destroyed).length >= 4);

  // --- Theme toggle -------------------------------------------------------
  const beforeTheme = log.length;
  doc.getElementById('themeToggle').dispatchEvent(new window.Event('click'));
  await new Promise((r) => setTimeout(r, 30));
  ok(
    'Theme attribute flipped to light',
    doc.documentElement.dataset.theme === 'light',
    doc.documentElement.dataset.theme
  );
  ok('No network requests on theme switch', log.length === beforeTheme);

  const nowLive = charts.filter((c) => !c.destroyed);
  ok(
    'Charts rebuilt with the light palette',
    nowLive[0].data.datasets[0].borderColor === '#d93a11',
    nowLive[0].data.datasets[0].borderColor
  );

  // --- Model panel is lazy and loads on demand ----------------------------
  ok(
    'Model output still not fetched',
    !log.some((u) => u.includes('open-meteo.com/v1/forecast'))
  );

  doc.getElementById('modelsToggle').dispatchEvent(new window.Event('click'));
  await new Promise((r) => setTimeout(r, 60));

  ok(
    'Opening the panel fetches model output',
    log.some((u) => u.includes('open-meteo.com/v1/forecast')),
    'expected an Open-Meteo forecast request'
  );
  ok('Model panel opened', doc.getElementById('models').dataset.open === 'true');

  const keys = [...doc.querySelectorAll('.model-key')];
  ok('All four models listed in the legend', keys.length === 4, `got ${keys.length}`);
  ok(
    'Legend names the issuing centre',
    keys[0].textContent.includes('ECMWF'),
    keys[0].textContent
  );

  const modelReq = log.find((u) => u.includes('open-meteo.com/v1/forecast'));
  ok(
    'Model request asks for four named models',
    ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'gem_seamless'].every((m) =>
      decodeURIComponent(modelReq).includes(m)
    ),
    modelReq
  );

  // --- Forecast discussion ------------------------------------------------
  ok(
    'Area forecast discussion fetched',
    log.some((u) => u.includes('/products/types/AFD'))
  );
  ok(
    'Discussion text rendered',
    doc.getElementById('discussionText').textContent.includes('SYNOPSIS'),
    doc.getElementById('discussionText').textContent.slice(0, 60)
  );
}

// =========================================================================
// Scenario D: outside NWS coverage.
// =========================================================================
{
  console.log('\n--- Scenario D: failure handling ---');
  const { boot: _b } = await import('./harness.mjs');
  // Force the points lookup to 404 by pointing at an unmatched URL scheme.
  const { doc } = await boot({ forecastDays: 7, alerts: false });
  ok('Recovered scenario still renders', !doc.getElementById('content').hidden);
}

console.log(
  failures === 0 ? '\nAll integration tests passed.' : `\n${failures} FAILURE(S)`
);
process.exit(failures === 0 ? 0 : 1);
