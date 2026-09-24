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
  formatClock,
  zoneAbbrev,
  relativeAge,
} from './time.js';
import { Units, formatPercent, formatNumber } from './units.js';
import {
  buildCharts,
  buildModelChart,
  readTheme,
  pixelFor,
  computeTwilightBands,
  panelSpec,
  plotMisalignment,
} from './charts.js';
import { sunCard, moonCard } from './sky.js';

const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;
const DAYS = 7;

// Background refresh. The NWS grid is typically reissued hourly; checking
// every 20 minutes keeps a page left open on a second monitor current without
// being a nuisance to the API.
const REFRESH_EVERY = 20 * MINUTE;
const REFRESH_RETRY = 5 * MINUTE;

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
  refreshBtn: document.getElementById('refreshBtn'),
  freshness: document.getElementById('freshness'),

  hazards: document.getElementById('hazards'),
  readouts: document.getElementById('readouts'),
  observedNote: document.getElementById('observedNote'),
  sky: document.getElementById('sky'),

  forecastNote: document.getElementById('forecastNote'),
  plotFrame: document.getElementById('plotFrame'),
  dayRail: document.getElementById('dayRail'),
  dayDetail: document.getElementById('dayDetail'),
  probe: document.getElementById('probe'),
  legends: {
    temp: document.getElementById('legendTemp'),
    precip: document.getElementById('legendPrecip'),
    cloud: document.getElementById('legendCloud'),
    wind: document.getElementById('legendWind'),
  },
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

/** When the current payload was fetched, and when a refresh last failed. */
let fetchedAt = null;
let refreshFailedAt = null;

/** Series the visitor has switched off in the legends, as "panel.key". */
const hiddenSeries = new Set(readJSON('wx.hidden', []));

/** Selected range for the Sun card's sparkline. */
let sunRange = localStorage.getItem('wx.sunRange') || '2w';

function readJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

// --- Theme ----------------------------------------------------------------

function applyTheme(next) {
  const theme =
    next ||
    localStorage.getItem('wx.theme') ||
    (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
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

/**
 * Fetch everything for a location and render it.
 *
 * With `silent`, this is a background refresh: the current page stays up
 * while the request runs, and a failure leaves it in place with a note rather
 * than replacing it with an error screen.
 */
async function load(lat, lon, name, { silent = false } = {}) {
  inflight?.abort();
  inflight = new AbortController();
  const { signal } = inflight;

  if (silent) {
    el.freshness.dataset.state = 'refreshing';
    el.freshness.textContent = 'Refreshing…';
  } else {
    showStatus('Loading forecast', `${lat.toFixed(4)}, ${lon.toFixed(4)}`);
  }

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
    fetchedAt = Date.now();
    refreshFailedAt = null;

    persist(lat, lon, name);
    hideStatus();
    render();
    updateFreshness();

    // Non-blocking extras.
    loadDiscussion(point.office, signal);
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error(error);

    if (silent && payload) {
      refreshFailedAt = Date.now();
      updateFreshness();
      return;
    }

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
  renderSky(lat, lon, timeZone);
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
  if (obs.newest) age.dataset.ageFrom = obs.newest;
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
  age.dataset.ageFrom = air.time;
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

// --- Sky ------------------------------------------------------------------

const skyDrawers = new WeakMap();
const skyResize = new ResizeObserver((entries) => {
  for (const entry of entries) skyDrawers.get(entry.target)?.();
});

function renderSky(lat, lon, timeZone) {
  skyResize.disconnect();
  el.sky.innerHTML = '';

  const cards = [
    sunCard({
      lat,
      lon,
      timeZone,
      range: sunRange,
      onRange: (r) => {
        sunRange = r;
        localStorage.setItem('wx.sunRange', r);
      },
    }),
    moonCard({ lat, lon, timeZone }),
  ];

  for (const { element, draw } of cards) {
    el.sky.appendChild(element);
    skyDrawers.set(element, draw);
    skyResize.observe(element);
  }
  // Sparklines measure their width, so draw once the cards are in the page.
  requestAnimationFrame(() => cards.forEach((c) => c.draw()));
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
    cell.tabIndex = 0;
    cell.setAttribute('role', 'button');
    cell.setAttribute('aria-expanded', 'false');
    cell.setAttribute('aria-controls', 'dayDetail');
    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDayDetail(day, cell);
    });
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleDayDetail(day, cell);
      }
    });

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

  closeDayDetail();
  alignOverlays();
}

// --- Day detail -------------------------------------------------------------
//
// The rail can only show a two-line summary. The NWS worded forecast carries a
// full paragraph per period — wind, timing, amounts — so clicking a day opens
// it in place.

let openDayKey = null;

function toggleDayDetail(day, cell) {
  if (openDayKey === day.key) {
    closeDayDetail();
    return;
  }
  closeDayDetail();
  clearProbe();
  openDayKey = day.key;
  cell.setAttribute('aria-expanded', 'true');
  cell.dataset.open = 'true';

  const timeZone = payload.point.timeZone;
  const periods = (payload.forecast.periods || []).filter(
    (p) => dayKey(Date.parse(p.startTime), timeZone) === day.key
  );

  const d = el.dayDetail;
  d.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'day-detail__head';
  const title = document.createElement('span');
  title.className = 'day-detail__title';
  title.textContent = formatFull(day.start, timeZone).replace(/,? \d+:\d+.*$/, '');
  const close = document.createElement('button');
  close.className = 'day-detail__close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Close forecast details');
  close.textContent = '×';
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    closeDayDetail();
  });
  head.append(title, close);
  d.appendChild(head);

  if (!periods.length) {
    const p = document.createElement('p');
    p.className = 'day-detail__empty';
    p.textContent =
      'The NWS worded forecast does not reach this day yet. The icon and summary above are derived from the numerical grid.';
    d.appendChild(p);
  }

  for (const period of periods) {
    const row = document.createElement('div');
    row.className = 'day-detail__period';
    if (period.icon) {
      const img = document.createElement('img');
      img.src = period.icon;
      img.alt = '';
      img.width = 36;
      img.height = 36;
      img.addEventListener('error', () => img.remove());
      row.appendChild(img);
    }
    const body = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'day-detail__name';
    name.textContent = `${period.name} · ${period.isDaytime ? 'High' : 'Low'} ${
      period.temperature ?? '—'
    }°${period.temperatureUnit || 'F'}`;
    const text = document.createElement('p');
    text.className = 'day-detail__text';
    text.textContent = period.detailedForecast || period.shortForecast || '';
    body.append(name, text);
    row.appendChild(body);
    d.appendChild(row);
  }

  d.hidden = false;
  positionDayDetail();
}

function closeDayDetail() {
  openDayKey = null;
  el.dayDetail.hidden = true;
  el.dayRail.querySelectorAll('.day[data-open="true"]').forEach((c) => {
    c.dataset.open = 'false';
    c.setAttribute('aria-expanded', 'false');
  });
}

function positionDayDetail() {
  if (!openDayKey) return;
  const cell = el.dayRail.querySelector(`.day[data-key="${openDayKey}"]`);
  if (!cell) return;
  const frameWidth = el.plotFrame.clientWidth || 900;
  const width = Math.min(400, frameWidth - 16);
  const centre = cell.offsetLeft + cell.offsetWidth / 2;
  const left = Math.max(8, Math.min(frameWidth - width - 8, centre - width / 2));
  el.dayDetail.style.width = `${width}px`;
  el.dayDetail.style.left = `${left}px`;
  el.dayDetail.style.top = `${el.dayRail.offsetHeight + 6}px`;
}

document.addEventListener('click', (e) => {
  if (openDayKey && !e.target.closest('#dayDetail')) closeDayDetail();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openDayKey) closeDayDetail();
});

/**
 * Align the HTML overlays — day rail and panel legends — to the charts'
 * shared plot area.
 *
 * Doing this in the DOM rather than painting into canvas padding is what makes
 * the icons real images with a visible fallback state, and the legends real
 * buttons.
 */
function alignOverlays() {
  if (!charts.length) return;
  const area = charts[0].chartArea;
  if (!area) return;

  const canvasWidth = charts[0].width || charts[0].canvas.clientWidth || 0;
  el.plotFrame.style.setProperty('--plot-left', `${area.left}px`);
  el.plotFrame.style.setProperty('--plot-right', `${Math.max(0, canvasWidth - area.right)}px`);
  positionDayDetail();

  if (!railDays.length) return;

  const cells = el.dayRail.querySelectorAll('.day');
  railDays.forEach((day, i) => {
    const cell = cells[i];
    if (!cell) return;
    const startPx = pixelFor(day.start, railLabels, area);
    const nextStart = railDays[i + 1]?.start ?? railLabels[railLabels.length - 1] + HOUR;
    const endPx = Math.min(area.right, pixelFor(nextStart, railLabels, area));
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
    hidden: hiddenSeries,
  };

  charts = buildCharts({
    canvases: el.canvases,
    getContext: () => renderContext,
    data: converted,
    units,
    timeZone,
    formatHour: (ms) => formatHour(ms, timeZone),
    // Align in the same pass Chart.js lays out, so there is not even a
    // one-frame lag after a resize; the scheduled pass then re-checks drift
    // once every panel has laid out.
    onLayout: () => {
      alignOverlays();
      scheduleAlign();
    },
  });

  el.forecastNote.textContent = `${DAYS} days · hourly · select a day for the full worded forecast`;

  renderLegends();
  scheduleAlign();
  attachProbe();
}

let alignFrame = null;

/**
 * Coalesce overlay alignment into one frame. Called from Chart.js' layout
 * hook (so it always sees the post-resize plot area) and from the frame's
 * ResizeObserver.
 */
function scheduleAlign() {
  if (alignFrame) return;
  alignFrame = requestAnimationFrame(() => {
    alignFrame = null;
    alignOverlays();
    // Guard against the precipitation-panel regression: every panel must
    // share one plot area, or the time axis silently stops being common.
    const drift = plotMisalignment(charts);
    if (drift > 1) console.warn(`Meteogram panels misaligned by ${drift.toFixed(1)} px`);
  });
}

// --- Legends --------------------------------------------------------------

/**
 * One legend row above each panel: the panel title and units, then a toggle
 * for each series with a swatch drawn in the series' own line style.
 * Choices persist, so a series you never look at stays off.
 */
function renderLegends() {
  const theme = renderContext.theme;
  const panelIndex = { temp: 0, precip: 1, cloud: 2, wind: 3 };

  for (const panel of panelSpec(units)) {
    const row = el.legends[panel.id];
    if (!row) continue;
    row.innerHTML = '';

    const title = document.createElement('span');
    title.className = 'legend__title';
    title.textContent = panel.title;
    const unit = document.createElement('span');
    unit.className = 'legend__unit';
    unit.textContent = panel.unit;
    title.appendChild(unit);
    row.appendChild(title);

    for (const s of panel.series) {
      const id = `${panel.id}.${s.key}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'legend__item';
      btn.setAttribute('aria-pressed', String(!hiddenSeries.has(id)));
      btn.title = `Show or hide ${s.label.toLowerCase()}`;

      const swatch = document.createElement('span');
      swatch.className = `swatch swatch--${s.style}`;
      swatch.style.setProperty('--swatch', theme[s.color]);

      btn.append(swatch, document.createTextNode(s.label));
      btn.addEventListener('click', () => {
        const nowHidden = !hiddenSeries.has(id);
        if (nowHidden) hiddenSeries.add(id);
        else hiddenSeries.delete(id);
        localStorage.setItem('wx.hidden', JSON.stringify([...hiddenSeries]));
        btn.setAttribute('aria-pressed', String(!nowHidden));

        const chart = charts[panelIndex[panel.id]];
        const i = chart.data.datasets.findIndex((d) => d.key === s.key);
        if (i >= 0) {
          chart.setDatasetVisibility(i, !nowHidden);
          chart.update('none');
        } else {
          chart.render(); // plugin-drawn series, e.g. wind arrows
        }
      });
      row.appendChild(btn);
    }
  }
}

// --- Probe ----------------------------------------------------------------

let probeFrame = null;

function attachProbe() {
  el.plotFrame.onpointermove = (e) => {
    if (!charts.length) return;
    // The day rail, legends and popover are controls, not data: no crosshair.
    if (e.target.closest('.legend, .day-rail, .day-detail')) {
      clearProbe();
      return;
    }
    const area = charts[0].chartArea;
    if (!area) return;

    const rect = charts[0].canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;

    if (x < area.left || x > area.right) {
      clearProbe();
      return;
    }

    const frac = (x - area.left) / (area.right - area.left);
    const index = Math.round(frac * (renderContext.labels.length - 1));
    const frame = el.plotFrame.getBoundingClientRect();
    setProbe(index, e.clientX - frame.left, e.clientY - frame.top);
  };

  el.plotFrame.onpointerleave = clearProbe;

  // Keyboard: arrows step an hour, Shift+arrows six, Page Up/Down a day.
  el.plotFrame.onkeydown = (e) => {
    if (!charts.length || e.target.closest('.legend, .day, .day-detail')) return;
    const n = renderContext.labels.length;
    const current = renderContext.probeIndex ?? nowIndex();
    const steps = {
      ArrowRight: e.shiftKey ? 6 : 1,
      ArrowLeft: e.shiftKey ? -6 : -1,
      PageDown: 24,
      PageUp: -24,
    };
    let next;
    if (e.key in steps) next = current + steps[e.key];
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape') {
      clearProbe();
      return;
    } else return;

    e.preventDefault();
    next = Math.max(0, Math.min(n - 1, next));
    const area = charts[0].chartArea;
    const x = pixelFor(renderContext.labels[next], renderContext.labels, area);
    setProbe(next, x, el.dayRail.offsetHeight + 60);
  };
}

function nowIndex() {
  const labels = renderContext.labels;
  const i = labels.findIndex((t) => t > Date.now()) - 1;
  return Math.max(0, i < 0 ? labels.length - 1 : i);
}

/** Move the crosshair to an hour and place the readout near (x, y) in frame px. */
function setProbe(index, x, y) {
  index = Math.max(0, Math.min(renderContext.labels.length - 1, index));
  if (index === renderContext.probeIndex) {
    positionProbe(x, y);
    return;
  }
  renderContext.probeIndex = index;

  if (probeFrame) cancelAnimationFrame(probeFrame);
  probeFrame = requestAnimationFrame(() => {
    charts.forEach((c) => c.render());
    updateProbe(index);
    positionProbe(x, y);
  });
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
    ['Chance', t.precip, pct(conv.pop[index])],
    ['Amount', t.qpf, fmt(conv.qpf[index], units.symbol('precipRate') + '/h')],
    null,
    ['Sky', t.sky, pct(conv.skyCover[index])],
    ['RH', t.rh, pct(conv.humidity[index])],
    null,
    ['Wind', t.wind, windSummary(index)],
    ['Gust', t.gust, fmt(conv.windGust[index], units.symbol('speed'))],
  ];

  if (raw.thunder[index] !== null && raw.thunder[index] > 0) {
    rows.push(['Thunder', t.apparent, pct(raw.thunder[index])]);
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

/** Percentages skip the units layer, so they are rounded here. */
function pct(value) {
  return value === null || value === undefined ? '—' : `${Math.round(value)} %`;
}

function positionProbe(x, y) {
  const frameWidth = el.plotFrame.clientWidth;
  const frameHeight = el.plotFrame.clientHeight;
  const width = el.probe.offsetWidth;
  const height = el.probe.offsetHeight;

  let left = x + 16;
  if (left + width > frameWidth - 8) left = x - width - 16;

  let top = y + 16;
  if (top + height > frameHeight - 8) top = Math.max(8, y - height - 16);

  el.probe.style.left = `${Math.max(0, left)}px`;
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

const resizeObserver = new ResizeObserver(() => scheduleAlign());
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

// --- Freshness and background refresh ----------------------------------------
//
// The page is often left open all day. Every 30 s: update the "x min ago"
// labels in place (no re-render), and if the data are older than the refresh
// interval, fetch again quietly. Refreshes wait while you are reading — the
// tab hidden, the crosshair out, or a day's detail open — so the page never
// rebuilds under your cursor.

function updateFreshness() {
  if (!fetchedAt) return;
  const age = relativeAge(fetchedAt);
  if (refreshFailedAt) {
    el.freshness.dataset.state = 'stale';
    el.freshness.textContent = `Refresh failed · showing data fetched ${age}`;
  } else {
    el.freshness.dataset.state = 'fresh';
    el.freshness.textContent = `Fetched ${age}`;
  }
  el.freshness.title = `Fetched ${new Date(fetchedAt).toLocaleString()}`;
}

function refreshAges() {
  for (const node of document.querySelectorAll('[data-age-from]')) {
    node.textContent = relativeAge(Number(node.dataset.ageFrom));
  }
  updateFreshness();
}

function userIsReading() {
  return (
    document.visibilityState !== 'visible' ||
    renderContext?.probeIndex != null ||
    openDayKey !== null ||
    el.plotFrame.contains(document.activeElement)
  );
}

function maybeRefresh() {
  if (!payload || !fetchedAt || userIsReading()) return;
  const now = Date.now();
  if (refreshFailedAt && now - refreshFailedAt < REFRESH_RETRY) return;
  if (now - fetchedAt < REFRESH_EVERY) return;
  load(payload.lat, payload.lon, payload.name, { silent: true });
}

function refreshNow() {
  if (!payload) return;
  load(payload.lat, payload.lon, payload.name, { silent: true });
}

el.refreshBtn.addEventListener('click', refreshNow);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refreshAges();
    maybeRefresh();
  }
});

setInterval(() => {
  refreshAges();
  maybeRefresh();
}, 30000);
