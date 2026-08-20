// app.js — orchestration.

import {
  getPoint,
  getGrid,
  getForecast,
  getObservations,
  getAlerts,
  getForecastDiscussion,
  deriveIconUrl,
} from './nws.js';
import {
  geocode,
  getModelComparison,
  getAirQuality,
  aqiCategory,
  uvCategory,
} from './openmeteo.js';
import { hourlyMap, hourlyWeatherMap, sample, compass } from './grid.js';
import {
  dayKey,
  hourOfDay,
  startOfLocalDay,
  addLocalDays,
  formatHour,
  formatDayLabel,
  formatFull,
  zoneAbbrev,
  relativeAge,
} from './time.js';
import { sunriseSunset, moonPhase } from './solar.js';
import { Units, formatPercent, formatNumber } from './units.js';
import {
  buildCharts,
  buildModelChart,
  readTheme,
  pixelFor,
  computeTwilightBands,
} from './charts.js';

const HOUR = 3600 * 1000;
const DAYS = 7;

// A deliberately neutral placeholder, shown only until the visitor picks a
// location. Do not replace this with your own coordinates: this file is served
// to everyone who loads the page, so whatever sits here is public.
const DEFAULT_LOCATION = {
  lat: 38.8951,
  lon: -77.0364,
  name: 'Washington, D.C.',
};

// --- Element handles ------------------------------------------------------

const el = {
  status: document.getElementById('status'),
  statusText: document.getElementById('statusText'),
  statusDetail: document.getElementById('statusDetail'),
  statusAction: document.getElementById('statusAction'),
  content: document.getElementById('content'),

  place: document.getElementById('place'),
  coords: document.getElementById('coords'),
  searchInput: document.getElementById('searchInput'),
  searchResults: document.getElementById('searchResults'),
  unitToggle: document.getElementById('unitToggle'),
  themeToggle: document.getElementById('themeToggle'),

  hazards: document.getElementById('hazards'),
  readouts: document.getElementById('readouts'),
  observedNote: document.getElementById('observedNote'),

  forecastNote: document.getElementById('forecastNote'),
  plotFrame: document.getElementById('plotFrame'),
  dayRail: document.getElementById('dayRail'),
  probe: document.getElementById('probe'),
  canvases: {
    temp: document.getElementById('plotTemp'),
    precip: document.getElementById('plotPrecip'),
    cloud: document.getElementById('plotCloud'),
    wind: document.getElementById('plotWind'),
  },

  models: document.getElementById('models'),
  modelsToggle: document.getElementById('modelsToggle'),
  modelsPlot: document.getElementById('modelsPlot'),
  modelsLegend: document.getElementById('modelsLegend'),
  modelsNote: document.getElementById('modelsNote'),

  discussion: document.getElementById('discussion'),
  discussionText: document.getElementById('discussionText'),
  discussionNote: document.getElementById('discussionNote'),

  provenance: document.getElementById('provenanceList'),
};

// --- State ----------------------------------------------------------------

const units = new Units(localStorage.getItem('wx.units') || 'imperial');

/** Everything needed to re-render without refetching. */
let payload = null;
let charts = [];
let modelChart = null;
let renderContext = null;
let inflight = null;

// --- Theme ----------------------------------------------------------------

function applyTheme(next) {
  const theme = next || localStorage.getItem('wx.theme') || 'dark';
  document.documentElement.dataset.theme = theme;
  el.themeToggle.textContent = theme === 'dark' ? 'Light' : 'Dark';
  el.themeToggle.setAttribute(
    'aria-label',
    `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`
  );
  localStorage.setItem('wx.theme', theme);
  return theme;
}

el.themeToggle.addEventListener('click', () => {
  const now = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(now);
  if (payload) render();
});

// --- Units ----------------------------------------------------------------

function syncUnitButton() {
  el.unitToggle.textContent = units.name === 'imperial' ? '°F · kt' : '°C · km/h';
  el.unitToggle.setAttribute(
    'aria-label',
    `Switch to ${units.name === 'imperial' ? 'metric' : 'imperial'} units`
  );
}

el.unitToggle.addEventListener('click', () => {
  units.toggle();
  localStorage.setItem('wx.units', units.name);
  syncUnitButton();
  if (payload) render();
});

// --- Status ---------------------------------------------------------------

function showStatus(text, detail = '', action = null) {
  el.statusText.textContent = text;
  el.statusDetail.textContent = detail;
  el.statusAction.innerHTML = '';
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    el.statusAction.appendChild(btn);
  }
  el.status.hidden = false;
  el.content.hidden = true;
}

function hideStatus() {
  el.status.hidden = true;
  el.content.hidden = false;
}

// --- Location search ------------------------------------------------------

let searchTimer;
let searchAbort;

el.searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const query = el.searchInput.value.trim();
  if (query.length < 2) {
    el.searchResults.innerHTML = '';
    return;
  }
  searchTimer = setTimeout(async () => {
    searchAbort?.abort();
    searchAbort = new AbortController();
    try {
      const results = await geocode(query, { signal: searchAbort.signal });
      renderSearchResults(results);
    } catch (e) {
      if (e.name !== 'AbortError') el.searchResults.innerHTML = '';
    }
  }, 250);
});

function renderSearchResults(results) {
  el.searchResults.innerHTML = '';
  for (const r of results) {
    const li = document.createElement('li');
    li.className = 'search__result';
    li.setAttribute('role', 'option');
    li.tabIndex = 0;

    const label = document.createElement('span');
    label.textContent = [r.name, r.admin1, r.countryCode].filter(Boolean).join(', ');

    const coords = document.createElement('span');
    coords.className = 'search__result-coords';
    coords.textContent = `${r.latitude.toFixed(2)}, ${r.longitude.toFixed(2)}`;

    li.append(label, coords);

    const choose = () => {
      el.searchInput.value = label.textContent;
      el.searchResults.innerHTML = '';
      load(r.latitude, r.longitude, label.textContent);
    };
    li.addEventListener('click', choose);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        choose();
      }
    });

    el.searchResults.appendChild(li);
  }
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search')) el.searchResults.innerHTML = '';
});

el.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') el.searchResults.innerHTML = '';
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    el.searchResults.querySelector('.search__result')?.focus();
  }
});

// --- Loading --------------------------------------------------------------

async function load(lat, lon, name) {
  inflight?.abort();
  inflight = new AbortController();
  const { signal } = inflight;

  showStatus('Loading forecast', `${lat.toFixed(4)}, ${lon.toFixed(4)}`);

  try {
    const point = await getPoint(lat, lon, { signal });

    // The grid and worded forecast are required; everything else is optional
    // and must not be able to take the page down with it.
    const [grid, forecast, observations, alerts, air] = await Promise.all([
      getGrid(point.gridUrl, { signal }),
      getForecast(point.forecastUrl, { signal }),
      getObservations(point.stationsUrl, lat, lon, { signal }).catch(() => ({
        primary: null,
        conditions: null,
        considered: 0,
      })),
      getAlerts(lat, lon, { signal }),
      getAirQuality(lat, lon, { signal }),
    ]);

    payload = { lat, lon, name, point, grid, forecast, observations, alerts, air };

    persist(lat, lon, name);
    hideStatus();
    render();

    // Non-blocking extras.
    loadDiscussion(point.office, signal);
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error(error);

    const outside = error.status === 404;
    showStatus(
      outside ? 'No NWS coverage for this location' : 'Could not load the forecast',
      outside
        ? 'The National Weather Service only issues gridded forecasts for the United States and its territories. Try a US location.'
        : `${error.message}. The NWS API may be briefly unavailable.`,
      outside ? null : { label: 'Try again', onClick: () => load(lat, lon, name) }
    );
  }
}

function persist(lat, lon, name) {
  localStorage.setItem('wx.location', JSON.stringify({ lat, lon, name }));

  const params = new URLSearchParams({
    lat: lat.toFixed(4),
    lon: lon.toFixed(4),
    name,
  });

  // Deliberately the fragment, not the query string. Fragments are never put
  // on the wire, so reloading the page does not hand your coordinates to the
  // host's access logs. A query string would.
  window.history.replaceState(null, '', `${window.location.pathname}#${params}`);
}

// --- Series assembly ------------------------------------------------------

/**
 * Build the hourly timeline: seven whole days in the forecast location's own
 * time zone, starting at local midnight today.
 *
 * The original walked 168 hours forward from the current hour, which always
 * spilled into an eighth calendar day. That eighth column had grid data but
 * no worded forecast behind it, which is exactly why its icon was missing.
 * Anchoring to local midnight makes the window line up with what the worded
 * forecast actually covers.
 */
function buildTimeline(timeZone) {
  const start = startOfLocalDay(Date.now(), timeZone);
  const end = addLocalDays(start, timeZone, DAYS);
  const labels = [];
  for (let t = start; t < end; t += HOUR) labels.push(t);
  return { labels, start, end };
}

function buildSeries(grid, labels) {
  const maps = {
    temperature: hourlyMap(grid.temperature),
    apparent: hourlyMap(grid.apparentTemperature),
    dewpoint: hourlyMap(grid.dewpoint),
    pop: hourlyMap(grid.probabilityOfPrecipitation),
    qpf: hourlyMap(grid.quantitativePrecipitation, { accumulation: true }),
    snow: hourlyMap(grid.snowfallAmount, { accumulation: true }),
    skyCover: hourlyMap(grid.skyCover),
    humidity: hourlyMap(grid.relativeHumidity),
    windSpeed: hourlyMap(grid.windSpeed),
    windGust: hourlyMap(grid.windGust),
    windDirection: hourlyMap(grid.windDirection),
    thunder: hourlyMap(grid.probabilityOfThunder),
    weather: hourlyWeatherMap(grid.weather),
  };

  return {
    raw: maps,
    temperature: sample(maps.temperature, labels),
    apparent: sample(maps.apparent, labels),
    dewpoint: sample(maps.dewpoint, labels),
    pop: sample(maps.pop, labels),
    qpf: sample(maps.qpf, labels),
    snow: sample(maps.snow, labels),
    skyCover: sample(maps.skyCover, labels),
    humidity: sample(maps.humidity, labels),
    windSpeed: sample(maps.windSpeed, labels),
    windGust: sample(maps.windGust, labels),
    windDirection: sample(maps.windDirection, labels),
    thunder: sample(maps.thunder, labels),
  };
}

/**
 * Per-day summary for the rail: high, low, icon, wording.
 *
 * Icons come from the worded forecast where it reaches. Where it does not, we
 * synthesise one from the grid rather than leaving a hole, and mark the day so
 * the difference stays visible.
 */
function buildDays(forecast, series, labels, timeZone) {
  const periods = forecast.periods || [];
  const worded = new Map();

  for (const p of periods) {
    const key = dayKey(Date.parse(p.startTime), timeZone);
    const existing = worded.get(key);
    // Prefer the daytime period's wording and icon for a day's summary.
    if (!existing || (p.isDaytime && !existing.isDaytime)) {
      worded.set(key, {
        text: p.shortForecast,
        icon: p.icon,
        isDaytime: p.isDaytime,
      });
    }
  }

  const byDay = new Map();
  labels.forEach((ms, i) => {
    const key = dayKey(ms, timeZone);
    let d = byDay.get(key);
    if (!d) {
      d = { key, start: ms, end: ms, indices: [], high: null, low: null };
      byDay.set(key, d);
    }
    d.end = ms;
    d.indices.push(i);
    const t = series.temperature[i];
    if (t !== null) {
      if (d.high === null || t > d.high) d.high = t;
      if (d.low === null || t < d.low) d.low = t;
    }
  });

  const todayKey = dayKey(Date.now(), timeZone);

  return [...byDay.values()].map((d) => {
    const w = worded.get(d.key);

    let icon = w?.icon ?? null;
    let text = w?.text ?? null;
    let derived = false;

    if (!icon) {
      // Sample mid-afternoon, when a day's character is most representative.
      const midday =
        d.indices.find((i) => hourOfDay(labels[i], timeZone) === 15) ??
        d.indices[Math.floor(d.indices.length / 2)];

      const sky = series.skyCover[midday];
      const pop = series.pop[midday] ?? 0;
      const wx = series.raw.weather.get(labels[midday]) || [];

      if (sky !== null) {
        icon = deriveIconUrl({
          skyCover: sky,
          pop,
          weather: wx,
          isDaytime: true,
        });
        text = describeFromGrid(sky, pop, wx);
        derived = true;
      }
    }

    return {
      ...d,
      icon,
      text,
      derived,
      isToday: d.key === todayKey,
      hours: d.indices.length,
      complete: d.indices.some((i) => series.temperature[i] !== null),
    };
  });
}

/** Plain wording for a day we had to synthesise. */
function describeFromGrid(skyCover, pop, weather) {
  const types = new Set(weather.map((w) => w.weather));
  let sky;
  if (skyCover >= 88) sky = 'Cloudy';
  else if (skyCover >= 63) sky = 'Mostly cloudy';
  else if (skyCover >= 38) sky = 'Partly sunny';
  else if (skyCover >= 13) sky = 'Mostly sunny';
  else sky = 'Sunny';

  if (types.has('thunderstorms')) return `${sky}, thunderstorms possible`;
  if (types.has('snow') || types.has('snow_showers')) return `${sky}, snow possible`;
  if (types.has('rain') || types.has('rain_showers')) return `${sky}, showers possible`;
  if (pop >= 30) return `${sky}, ${Math.round(pop)}% chance of precipitation`;
  return sky;
}

// --- Render ---------------------------------------------------------------

function render() {
  const { point, grid, forecast, observations, alerts, air, lat, lon, name } = payload;
  const timeZone = point.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const theme = readTheme();

  const { labels } = buildTimeline(timeZone);
  const series = buildSeries(grid, labels);
  const days = buildDays(forecast, series, labels, timeZone);

  renderHeader(name, lat, lon, point, timeZone);
  renderHazards(alerts, timeZone);
  renderObservations(observations, air, lat, lon, timeZone);
  renderDayRail(days, labels, timeZone);
  renderCharts(series, labels, days, timeZone, theme, lat, lon);
  renderProvenance(point, grid, forecast, observations, air, timeZone);
}

function renderHeader(name, lat, lon, point, timeZone) {
  el.place.textContent = name;
  const parts = [
    `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`,
    `NWS ${point.office} ${point.gridX},${point.gridY}`,
    zoneAbbrev(Date.now(), timeZone),
  ];
  el.coords.innerHTML = '';
  for (const p of parts) {
    const span = document.createElement('span');
    span.textContent = p;
    el.coords.appendChild(span);
  }
  document.title = `${name} — meteogram`;
}

function renderHazards(alerts, timeZone) {
  el.hazards.innerHTML = '';
  el.hazards.dataset.hasAlerts = alerts.length > 0 ? 'true' : 'false';
  if (!alerts.length) return;

  for (const a of alerts) {
    const details = document.createElement('details');
    details.className = 'hazard';
    details.dataset.severity = a.severity || 'Unknown';

    const summary = document.createElement('summary');
    summary.className = 'hazard__summary';

    const event = document.createElement('span');
    event.className = 'hazard__event';
    event.textContent = a.event;

    const window_ = document.createElement('span');
    window_.className = 'hazard__window';
    const from = a.onset || a.effective;
    const to = a.ends || a.expires;
    window_.textContent = [
      from ? `from ${formatFull(Date.parse(from), timeZone)}` : null,
      to ? `until ${formatFull(Date.parse(to), timeZone)}` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    const more = document.createElement('span');
    more.className = 'hazard__more';
    more.textContent = 'Full text';

    summary.append(event, window_, more);

    const body = document.createElement('div');
    body.className = 'hazard__body';
    body.textContent = [a.headline, a.description, a.instruction]
      .filter(Boolean)
      .join('\n\n');

    details.append(summary, body);
    el.hazards.appendChild(details);
  }
}

function renderObservations(observations, air, lat, lon, timeZone) {
  el.readouts.innerHTML = '';
  const now = Date.now();

  const { primary, conditions, considered } = observations;

  if (primary) {
    el.readouts.appendChild(observationCard(primary, lat, lon, 'Nearest station'));
  } else {
    el.readouts.appendChild(
      emptyCard(
        'Nearest station',
        considered === 0
          ? 'No reporting stations found for this grid cell.'
          : 'Stations nearby are not reporting usable data right now.'
      )
    );
  }

  if (conditions) {
    el.readouts.appendChild(
      observationCard(conditions, lat, lon, 'Nearest full report')
    );
  }

  if (air) el.readouts.appendChild(airCard(air));
  el.readouts.appendChild(skyCard(lat, lon, timeZone));

  el.observedNote.textContent = primary
    ? `Coalesced from the last 6 reports at ${considered} nearby station${considered === 1 ? '' : 's'}`
    : 'No usable observations';
}

function observationCard(entry, lat, lon, role) {
  const { station, obs } = entry;
  const f = obs.fields;
  const now = Date.now();

  const card = document.createElement('article');
  card.className = 'readout';

  const head = document.createElement('div');
  head.className = 'readout__head';

  const source = document.createElement('span');
  source.className = 'readout__source';
  source.textContent = `${role} · ${station.identifier}`;
  source.title = station.name;

  const age = document.createElement('span');
  age.className = 'readout__age';
  age.textContent = obs.newest ? relativeAge(obs.newest, now) : '—';
  age.dataset.stale = obs.newest && now - obs.newest > 2 * HOUR ? 'true' : 'false';

  head.append(source, age);

  const primary = document.createElement('div');
  primary.className = 'readout__primary';

  if (obs.icon) {
    const img = document.createElement('img');
    img.className = 'readout__icon';
    img.src = obs.icon;
    img.alt = obs.textDescription || '';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.remove());
    primary.appendChild(img);
  }

  const value = document.createElement('div');
  value.className = 'readout__value';
  value.textContent = units.formatTemp(f.temperature?.value ?? null);
  primary.appendChild(value);

  const caption = document.createElement('div');
  caption.className = 'readout__caption';
  caption.textContent =
    obs.textDescription ||
    (obs.cloudLayers?.length
      ? obs.cloudLayers.map((l) => l.amount).join(', ')
      : 'No present-weather report');
  primary.appendChild(caption);

  const fields = document.createElement('div');
  fields.className = 'readout__fields';

  const windText =
    f.windSpeed?.value === null || f.windSpeed === undefined
      ? '—'
      : f.windSpeed.value === 0
        ? 'Calm'
        : `${units.format('speed', f.windSpeed.value)} ${compass(f.windDirection?.value)}`.trim();

  const distance =
    station.distanceKm !== null
      ? units.format('distance', station.distanceKm * 1000)
      : '—';

  addField(fields, 'Dewpoint', units.format('temp', f.dewpoint?.value ?? null));
  addField(fields, 'Humidity', formatPercent(f.relativeHumidity?.value));
  addField(fields, 'Wind', windText);
  if (f.windGust?.value) {
    addField(fields, 'Gust', units.format('speed', f.windGust.value));
  }
  addField(
    fields,
    'Pressure',
    units.format('pressure', f.barometricPressure?.value ?? f.seaLevelPressure?.value ?? null)
  );
  addField(fields, 'Distance', distance);

  card.append(head, primary, fields);
  return card;
}

function emptyCard(role, message) {
  const card = document.createElement('article');
  card.className = 'readout';

  const head = document.createElement('div');
  head.className = 'readout__head';
  const source = document.createElement('span');
  source.className = 'readout__source';
  source.textContent = role;
  head.appendChild(source);

  const caption = document.createElement('p');
  caption.className = 'readout__caption';
  caption.textContent = message;

  card.append(head, caption);
  return card;
}

function airCard(air) {
  const card = document.createElement('article');
  card.className = 'readout';

  const head = document.createElement('div');
  head.className = 'readout__head';
  const source = document.createElement('span');
  source.className = 'readout__source';
  source.textContent = 'Air quality · modelled';
  const age = document.createElement('span');
  age.className = 'readout__age';
  age.textContent = relativeAge(air.time);
  head.append(source, age);

  const primary = document.createElement('div');
  primary.className = 'readout__primary';

  const cat = aqiCategory(air.aqi);
  const value = document.createElement('div');
  value.className = 'readout__value readout__value--small';
  if (cat) value.classList.add(`tone-${cat.tone}`);
  value.textContent = air.aqi === null ? '—' : Math.round(air.aqi);
  primary.appendChild(value);

  const caption = document.createElement('div');
  caption.className = 'readout__caption';
  caption.textContent = cat ? `US AQI · ${cat.label}` : 'US AQI unavailable';
  primary.appendChild(caption);

  const fields = document.createElement('div');
  fields.className = 'readout__fields';
  addField(fields, 'PM2.5', air.pm25 === null ? '—' : `${formatNumber(air.pm25, 1)} µg/m³`);
  addField(fields, 'PM10', air.pm10 === null ? '—' : `${formatNumber(air.pm10, 1)} µg/m³`);
  addField(fields, 'Ozone', air.ozone === null ? '—' : `${formatNumber(air.ozone, 0)} µg/m³`);

  const uvCat = uvCategory(air.uv);
  addField(
    fields,
    'UV index',
    air.uv === null ? '—' : `${formatNumber(air.uv, 1)} ${uvCat ? uvCat.label : ''}`.trim(),
    uvCat ? `tone-${uvCat.tone}` : null
  );

  card.append(head, primary, fields);
  return card;
}

function skyCard(lat, lon, timeZone) {
  const card = document.createElement('article');
  card.className = 'readout';

  const head = document.createElement('div');
  head.className = 'readout__head';
  const source = document.createElement('span');
  source.className = 'readout__source';
  source.textContent = 'Sun and moon · computed';
  head.appendChild(source);

  const todayStart = startOfLocalDay(Date.now(), timeZone);
  const { sunrise, sunset } = sunriseSunset(todayStart, lat, lon);
  const moon = moonPhase(Date.now());

  const primary = document.createElement('div');
  primary.className = 'readout__primary';

  const value = document.createElement('div');
  value.className = 'readout__value readout__value--small';
  if (sunrise && sunset) {
    const daylight = sunset - sunrise;
    const h = Math.floor(daylight / HOUR);
    const m = Math.round((daylight % HOUR) / 60000);
    value.textContent = `${h}h ${String(m).padStart(2, '0')}m`;
  } else {
    value.textContent = sunrise || sunset ? '—' : '24h';
  }
  primary.appendChild(value);

  const caption = document.createElement('div');
  caption.className = 'readout__caption';
  caption.textContent = 'of daylight today';
  primary.appendChild(caption);

  const fields = document.createElement('div');
  fields.className = 'readout__fields';
  addField(fields, 'Sunrise', sunrise ? formatClock(sunrise, timeZone) : 'None');
  addField(fields, 'Sunset', sunset ? formatClock(sunset, timeZone) : 'None');
  addField(fields, 'Moon', `${Math.round(moon.illumination * 100)}%`);
  addField(fields, 'Phase', moon.name);

  card.append(head, primary, fields);
  return card;
}

function addField(container, label, value, extraClass) {
  const wrap = document.createElement('div');
  wrap.className = 'field';

  const l = document.createElement('span');
  l.className = 'field__label';
  l.textContent = label;

  const v = document.createElement('span');
  v.className = 'field__value';
  if (extraClass) v.classList.add(extraClass);
  v.textContent = value;

  wrap.append(l, v);
  container.appendChild(wrap);
}

function formatClock(ms, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms));
}

// --- Day rail -------------------------------------------------------------

let railDays = [];
let railLabels = [];

function renderDayRail(days, labels, timeZone) {
  railDays = days;
  railLabels = labels;

  el.dayRail.innerHTML = '';

  for (const day of days) {
    const cell = document.createElement('div');
    cell.className = 'day';
    cell.dataset.today = day.isToday ? 'true' : 'false';
    cell.dataset.key = day.key;

    const { weekday, day: dayNum } = formatDayLabel(day.start, timeZone);
    const label = document.createElement('div');
    label.className = 'day__label';
    label.textContent = `${weekday} ${dayNum}`;

    const slot = document.createElement('div');
    slot.className = 'day__icon-slot';

    const fallback = document.createElement('span');
    fallback.className = 'day__icon-fallback';
    fallback.textContent = '?';
    fallback.title = 'No forecast icon available for this day';

    if (day.icon) {
      const img = document.createElement('img');
      img.className = 'day__icon';
      img.src = day.icon;
      img.alt = day.text || '';
      img.loading = 'eager';
      img.decoding = 'async';
      // If the icon 404s or the network drops it, show the placeholder
      // instead of a silent gap.
      img.addEventListener('error', () => {
        cell.dataset.iconState = 'missing';
      });
      slot.append(img, fallback);
    } else {
      cell.dataset.iconState = 'missing';
      slot.appendChild(fallback);
    }

    const temps = document.createElement('div');
    temps.className = 'day__temps';
    const hi = document.createElement('span');
    hi.className = 'day__high';
    hi.textContent = units.formatTemp(day.high);
    const sep = document.createTextNode(' / ');
    const lo = document.createElement('span');
    lo.className = 'day__low';
    lo.textContent = units.formatTemp(day.low);
    temps.append(hi, sep, lo);

    const summary = document.createElement('div');
    summary.className = 'day__summary';
    summary.textContent = day.text || '';
    if (day.text) summary.title = day.text;

    cell.append(label, slot, temps, summary);

    if (day.derived) {
      const tag = document.createElement('span');
      tag.className = 'day__derived';
      tag.textContent = 'from grid';
      tag.title =
        'The worded forecast does not reach this day yet. Icon and wording derived from the numerical grid.';
      cell.appendChild(tag);
    }

    el.dayRail.appendChild(cell);
  }

  positionDayRail();
}

/**
 * Align the day cells to the charts' plot area.
 *
 * Doing this in the DOM rather than painting into canvas padding is what makes
 * the icons real images with a visible fallback state.
 */
function positionDayRail() {
  if (!charts.length || !railDays.length) return;
  const area = charts[0].chartArea;
  if (!area) return;

  const cells = el.dayRail.querySelectorAll('.day');
  railDays.forEach((day, i) => {
    const cell = cells[i];
    if (!cell) return;
    const startPx = pixelFor(day.start, railLabels, area);
    const nextStart = railDays[i + 1]?.start ?? railLabels[railLabels.length - 1] + HOUR;
    const endPx = pixelFor(nextStart, railLabels, area);
    cell.style.left = `${startPx}px`;
    cell.style.width = `${Math.max(0, endPx - startPx)}px`;
  });
}

// --- Charts ---------------------------------------------------------------

function renderCharts(series, labels, days, timeZone, theme, lat, lon) {
  charts.forEach((c) => c.destroy());
  charts = [];

  const converted = {
    temperature: units.series('temp', series.temperature),
    apparent: units.series('temp', series.apparent),
    dewpoint: units.series('temp', series.dewpoint),
    pop: series.pop,
    qpf: units.series('precipRate', series.qpf),
    skyCover: series.skyCover,
    humidity: series.humidity,
    windSpeed: units.series('speed', series.windSpeed),
    windGust: units.series('speed', series.windGust),
  };

  renderContext = {
    labels,
    lat,
    lon,
    theme,
    // Computed once here rather than inside the draw hook; see
    // computeTwilightBands for why that matters.
    twilightBands: computeTwilightBands(
      labels[0],
      labels[labels.length - 1] + HOUR,
      lat,
      lon
    ),
    timeZone,
    dayBoundaries: days.map((d) => d.start),
    windDirections: series.windDirection,
    probeIndex: null,
    raw: series,
    converted,
  };

  charts = buildCharts({
    canvases: el.canvases,
    getContext: () => renderContext,
    data: converted,
    units,
    timeZone,
    formatHour: (ms) => formatHour(ms, timeZone),
  });

  el.forecastNote.textContent = `${DAYS} days · hourly · arrows show wind direction (downwind)`;

  requestAnimationFrame(positionDayRail);
  attachProbe();
}

// --- Probe ----------------------------------------------------------------

let probeFrame = null;

function attachProbe() {
  el.plotFrame.onpointermove = (e) => {
    if (!charts.length) return;
    const area = charts[0].chartArea;
    if (!area) return;

    const rect = charts[0].canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;

    if (x < area.left || x > area.right) {
      clearProbe();
      return;
    }

    const frac = (x - area.left) / (area.right - area.left);
    const index = Math.min(
      renderContext.labels.length - 1,
      Math.max(0, Math.round(frac * (renderContext.labels.length - 1)))
    );

    if (index === renderContext.probeIndex) {
      positionProbe(e);
      return;
    }
    renderContext.probeIndex = index;

    if (probeFrame) cancelAnimationFrame(probeFrame);
    probeFrame = requestAnimationFrame(() => {
      charts.forEach((c) => c.render());
      updateProbe(index);
      positionProbe(e);
    });
  };

  el.plotFrame.onpointerleave = clearProbe;
}

function clearProbe() {
  if (!renderContext || renderContext.probeIndex === null) return;
  renderContext.probeIndex = null;
  el.probe.dataset.visible = 'false';
  charts.forEach((c) => c.render());
}

function updateProbe(index) {
  const c = renderContext;
  const t = c.theme;
  const conv = c.converted;
  const raw = c.raw;

  const rows = [
    ['Temp', t.temp, fmt(conv.temperature[index], units.symbol('temp'))],
    ['Feels', t.apparent, fmt(conv.apparent[index], units.symbol('temp'))],
    ['Dewpt', t.dewpoint, fmt(conv.dewpoint[index], units.symbol('temp'))],
    null,
    ['Chance', t.precip, fmt(conv.pop[index], '%')],
    ['Amount', t.qpf, fmt(conv.qpf[index], units.symbol('precipRate') + '/h')],
    null,
    ['Sky', t.sky, fmt(conv.skyCover[index], '%')],
    ['RH', t.rh, fmt(conv.humidity[index], '%')],
    null,
    ['Wind', t.wind, windSummary(index)],
    ['Gust', t.gust, fmt(conv.windGust[index], units.symbol('speed'))],
  ];

  if (raw.thunder[index] !== null && raw.thunder[index] > 0) {
    rows.push(['Thunder', t.apparent, fmt(raw.thunder[index], '%')]);
  }

  const time = document.createElement('div');
  time.className = 'probe__time';
  time.textContent = formatFull(c.labels[index], c.timeZone);

  el.probe.innerHTML = '';
  el.probe.appendChild(time);

  let gapNext = false;
  for (const row of rows) {
    if (row === null) {
      gapNext = true;
      continue;
    }
    const [label, color, value] = row;
    const line = document.createElement('div');
    line.className = gapNext ? 'probe__row probe__row--gap' : 'probe__row';
    gapNext = false;

    const key = document.createElement('span');
    key.className = 'probe__key';
    const swatch = document.createElement('span');
    swatch.className = 'probe__swatch';
    swatch.style.background = color;
    key.append(swatch, document.createTextNode(label));

    const val = document.createElement('span');
    val.className = 'probe__val';
    val.textContent = value;

    line.append(key, val);
    el.probe.appendChild(line);
  }

  el.probe.dataset.visible = 'true';
}

function windSummary(index) {
  const speed = renderContext.converted.windSpeed[index];
  const dir = renderContext.windDirections[index];
  if (speed === null) return '—';
  const d = compass(dir);
  return `${speed} ${units.symbol('speed')}${d ? ' ' + d : ''}`;
}

function fmt(value, symbol) {
  return value === null || value === undefined ? '—' : `${value} ${symbol}`;
}

function positionProbe(e) {
  const frameRect = el.plotFrame.getBoundingClientRect();
  const width = el.probe.offsetWidth;
  const height = el.probe.offsetHeight;

  let left = e.clientX - frameRect.left + 16;
  if (left + width > frameRect.width - 8) {
    left = e.clientX - frameRect.left - width - 16;
  }

  let top = e.clientY - frameRect.top + 16;
  if (top + height > frameRect.height - 8) {
    top = Math.max(8, e.clientY - frameRect.top - height - 16);
  }

  el.probe.style.left = `${left}px`;
  el.probe.style.top = `${top}px`;
}

// --- Model comparison -----------------------------------------------------

el.modelsToggle.addEventListener('click', async () => {
  const open = el.models.dataset.open === 'true';
  el.models.dataset.open = open ? 'false' : 'true';
  el.modelsToggle.setAttribute('aria-expanded', String(!open));
  el.modelsToggle.textContent = open ? 'Show' : 'Hide';
  if (!open && !modelChart) await loadModels();
});

async function loadModels() {
  if (!payload) return;
  el.modelsNote.textContent = 'Loading model output…';

  try {
    const { time, series } = await getModelComparison(payload.lat, payload.lon, {
      days: DAYS,
    });
    if (!series.length) {
      el.modelsNote.textContent = 'No model output available for this location.';
      return;
    }

    const theme = readTheme();
    const colors = [theme.temp, theme.precip, theme.dewpoint, theme.apparent];
    const timeZone = payload.point.timeZone;

    modelChart = buildModelChart(el.modelsPlot, {
      time,
      series,
      theme,
      colors,
      units,
      timeZone,
      formatFull: (ms) => formatFull(ms, timeZone),
      formatDayShort: (ms) => {
        const { weekday, day } = formatDayLabel(ms, timeZone);
        return `${weekday} ${day}`;
      },
    });

    el.modelsLegend.innerHTML = '';
    series.forEach((s, i) => {
      const key = document.createElement('span');
      key.className = 'model-key';
      const swatch = document.createElement('span');
      swatch.className = 'model-key__swatch';
      swatch.style.background = colors[i % colors.length];
      const label = document.createElement('span');
      label.textContent = s.label;
      const centre = document.createElement('span');
      centre.className = 'model-key__centre';
      centre.textContent = `${s.centre} · ${s.resolution}`;
      key.append(swatch, label, centre);
      el.modelsLegend.appendChild(key);
    });

    el.modelsNote.textContent =
      'Raw model output, unedited. Where the lines fan out, forecaster confidence is low.';
  } catch (e) {
    console.error(e);
    el.modelsNote.textContent = 'Could not reach Open-Meteo.';
  }
}

// --- Forecast discussion --------------------------------------------------

async function loadDiscussion(office, signal) {
  el.discussionText.textContent = 'Loading…';
  const afd = await getForecastDiscussion(office, { signal });

  if (!afd) {
    el.discussionText.textContent =
      'No area forecast discussion is currently posted for this office.';
    el.discussionNote.textContent = '';
    return;
  }

  el.discussionText.textContent = afd.text.trim();
  el.discussionNote.textContent = `${afd.office} · issued ${formatFull(
    Date.parse(afd.issued),
    payload.point.timeZone
  )}`;
}

// --- Provenance -----------------------------------------------------------

function renderProvenance(point, grid, forecast, observations, air, timeZone) {
  const entries = [];

  entries.push([
    'Gridded forecast',
    `NWS ${point.office} cell ${point.gridX},${point.gridY} · issued ${
      grid.updateTime ? formatFull(Date.parse(grid.updateTime), timeZone) : 'unknown'
    }`,
  ]);

  entries.push([
    'Worded forecast',
    forecast.updated
      ? `NWS ${point.office} · updated ${formatFull(Date.parse(forecast.updated), timeZone)}`
      : `NWS ${point.office}`,
  ]);

  if (observations.primary) {
    const s = observations.primary.station;
    entries.push([
      'Observations',
      `${s.identifier} ${s.name}${
        s.distanceKm !== null ? ` · ${s.distanceKm.toFixed(1)} km` : ''
      }${s.elevationM !== null ? ` · ${Math.round(s.elevationM)} m` : ''}`,
    ]);
  }

  if (air) entries.push(['Air quality', 'Open-Meteo CAMS · modelled, not observed']);

  entries.push(['Sun, moon, twilight', 'Computed locally (NOAA solar position algorithm)']);
  entries.push(['Geocoding', 'Open-Meteo geocoding API']);
  entries.push(['Time zone', `${timeZone} · all times shown local to the forecast point`]);

  el.provenance.innerHTML = '';
  for (const [term, def] of entries) {
    const wrap = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = def;
    wrap.append(dt, dd);
    el.provenance.appendChild(wrap);
  }
}

// --- Resize ---------------------------------------------------------------

const resizeObserver = new ResizeObserver(() => {
  requestAnimationFrame(positionDayRail);
});
resizeObserver.observe(el.plotFrame);

// --- Boot -----------------------------------------------------------------

function readLocationParams(source) {
  if (!source) return null;
  const params = new URLSearchParams(source);
  if (!params.get('lat') || !params.get('lon')) return null;

  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    lat,
    lon,
    name: params.get('name') || `${lat.toFixed(3)}, ${lon.toFixed(3)}`,
  };
}

function initialLocation() {
  // Fragment first; query string is still read so older bookmarks keep working.
  return (
    readLocationParams(window.location.hash.replace(/^#/, '')) ??
    readLocationParams(window.location.search) ??
    savedLocation() ??
    DEFAULT_LOCATION
  );
}

function savedLocation() {
  try {
    const saved = JSON.parse(localStorage.getItem('wx.location'));
    return saved && Number.isFinite(saved.lat) ? saved : null;
  } catch {
    return null;
  }
}

applyTheme();
syncUnitButton();

const start = initialLocation();
el.searchInput.value = start.name;
load(start.lat, start.lon, start.name);

// Keep observation ages honest without refetching.
setInterval(() => {
  if (payload) renderObservations(
    payload.observations,
    payload.air,
    payload.lat,
    payload.lon,
    payload.point.timeZone
  );
}, 60000);
