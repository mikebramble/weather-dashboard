# Weather dashboard

A seven-day hourly meteogram built on National Weather Service gridded
forecast data. Static page, no build step, no API keys, no tracking. Deploys
to GitHub Pages as-is.

---

## Running it

Nothing to compile. ES modules need to be served over HTTP rather than opened
from `file://`, so for local work:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

### Tests

```bash
npm install          # jsdom, the only dependency, and only for tests
node test/solar.test.mjs   # solar geometry vs. published values
node test/grid.test.mjs    # gridpoint parsing, time zones, DST
node test/app.test.mjs     # boots the real app against mocked APIs
```

`test/app.test.mjs` loads `index.html` and `js/app.js` in jsdom with a
recording Chart.js stub that still fires every plugin hook, so the canvas
drawing code genuinely runs. `test/mocks.mjs` reproduces the specific API
failure modes described below, so the fixes stay fixed.

---

## Layout

```
index.html          markup only
styles.css          design tokens + components; light and dark themes
favicon.svg
js/
  app.js            orchestration, rendering, interaction
  nws.js            National Weather Service client
  openmeteo.js      Open-Meteo client (models, air quality, geocoding)
  grid.js           gridpoint block -> hourly series
  solar.js          solar position, twilight, moon phase (pure, no network)
  time.js           day bucketing in the forecast location's time zone
  units.js          imperial/metric conversion at the display layer
  charts.js         Chart.js config and canvas plugins
test/
  solar.test.mjs  grid.test.mjs  app.test.mjs  mocks.mjs  harness.mjs
```

Everything upstream of `units.js` stays in SI, matching what the NWS
gridpoint actually serves. Conversion happens once at render time, so
switching units never refetches.

---

## What was added

| | |
|---|---|
| **Hazards** | `/alerts/active?point=` — watches, warnings, advisories, sorted by severity, with full text |
| **Dewpoint** | In the temperature panel, following Skew-T convention (temperature warm, dewpoint green) |
| **Wind direction** | Downwind arrows along the wind panel; direction was absent entirely before |
| **Precipitation amount** | QPF bars alongside probability, on their own panel |
| **Twilight shading** | Civil, nautical, and full night from real solar elevation, replacing alternating grey blocks |
| **Model spread** | Four deterministic models from Open-Meteo (ECMWF IFS, GFS/HRRR, ICON, GEM), lazily loaded |
| **Air quality and UV** | Open-Meteo CAMS, US EPA AQI |
| **Forecast discussion** | The AFD — the forecaster's own reasoning about which guidance they trusted |
| **Provenance rail** | Every source named, with grid cell, issuance time, station distance and elevation |
| **Location time zones** | All day bucketing uses `properties.timeZone`, not the browser's |
| **Units and theme** | Imperial/metric and light/dark, both re-rendering without refetching |
| **URL state** | `#lat=&lon=&name=` for bookmarking, in the fragment so coordinates stay off the wire |

---

## Privacy

Static page, no analytics, no cookies, no third-party scripts beyond Chart.js
from a CDN (pinned with an integrity hash).

Where your coordinates go:

- **To `api.weather.gov` and Open-Meteo**, in the query string of each API
  request. Unavoidable — they are what the forecast is *for*. Neither requires
  an account, and Open-Meteo states it does not track or set cookies.
- **To `localStorage`** on your own machine, so the page reopens where you
  left it. Never leaves the browser. Clear it with `localStorage.clear()` from
  the console.
- **Into the URL fragment** after `#`, which stays in your browser and is not
  sent to the server hosting the page.

They are *not* baked into any file in this repository. Anything you type into
the location box stays on your machine.

## Sources

- [National Weather Service API](https://www.weather.gov/documentation/services-web-api) — public domain
- [Open-Meteo](https://open-meteo.com/) — CC BY 4.0, non-commercial use, no key
- Solar position: NOAA algorithm, after Meeus, *Astronomical Algorithms* —
  implemented locally in `js/solar.js`, validated in tests against published
  sunrise/sunset times and two eclipses
- [Chart.js](https://www.chartjs.org/) — MIT
