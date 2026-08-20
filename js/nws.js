// nws.js — National Weather Service API client.
//
// Docs: https://www.weather.gov/documentation/services-web-api
// The API is CORS-enabled and needs no key, which is what makes this whole
// dashboard possible as a static page.

import { haversineKm } from './grid.js';

const BASE = 'https://api.weather.gov';

async function getJSON(url, { signal } = {}) {
  const res = await fetch(url, {
    signal,
    headers: { Accept: 'application/geo+json' },
  });
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Resolve a coordinate to an NWS forecast office, grid cell, and time zone.
 * Grid assignments almost never change, so this is worth caching.
 */
export async function getPoint(lat, lon, opts) {
  // The API rejects more than four decimal places.
  const la = Number(lat).toFixed(4);
  const lo = Number(lon).toFixed(4);
  const data = await getJSON(`${BASE}/points/${la},${lo}`, opts);
  const p = data.properties;
  return {
    office: p.gridId,
    gridX: p.gridX,
    gridY: p.gridY,
    timeZone: p.timeZone,
    city: p.relativeLocation?.properties?.city ?? null,
    state: p.relativeLocation?.properties?.state ?? null,
    forecastUrl: p.forecast,
    gridUrl: p.forecastGridData,
    stationsUrl: p.observationStations,
    forecastZone: p.forecastZone,
    fireWeatherZone: p.fireWeatherZone,
    radarStation: p.radarStation,
  };
}

/** Raw numerical gridpoint forecast — the source for every chart series. */
export async function getGrid(url, opts) {
  const data = await getJSON(url, opts);
  return data.properties;
}

/** The 12-hour worded forecast, which is where the day icons come from. */
export async function getForecast(url, opts) {
  const data = await getJSON(url, opts);
  return data.properties;
}

/** Active watches, warnings, and advisories for a point. */
export async function getAlerts(lat, lon, opts) {
  const la = Number(lat).toFixed(4);
  const lo = Number(lon).toFixed(4);
  try {
    const data = await getJSON(`${BASE}/alerts/active?point=${la},${lo}`, opts);
    return (data.features || [])
      .map((f) => f.properties)
      .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  } catch {
    return [];
  }
}

function severityRank(s) {
  return { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 }[s] ?? 5;
}

/**
 * The Area Forecast Discussion: the forecaster's own written reasoning,
 * including which model guidance they trusted and where their confidence is
 * low. This is the thing no consumer weather site surfaces.
 */
export async function getForecastDiscussion(office, opts) {
  try {
    const list = await getJSON(
      `${BASE}/products/types/AFD/locations/${office}`,
      opts
    );
    const first = list['@graph']?.[0];
    if (!first) return null;
    const product = await getJSON(first['@id'], opts);
    return {
      issued: product.issuanceTime,
      office: product.issuingOffice,
      text: product.productText,
    };
  } catch {
    return null;
  }
}

// --- Observations ---------------------------------------------------------
//
// Why the original "Nearest Station" panel kept reading "Conditions Not
// Reported" with no temperature:
//
//  1. features[0] from the /stations endpoint is the *geometrically* nearest
//     station, which is frequently a mesonet, RAWS, or co-op site. Those
//     report a thin slice of variables — often temperature and wind only —
//     and they never populate textDescription, because that field is derived
//     from the present-weather group of a METAR. No METAR, no description.
//
//  2. /observations/latest returns the most recent record even if it is
//     hours or days old, and even if every field in it is null. A station
//     that reported at 03:14 and then dropped offline still "has" a latest
//     observation.
//
//  3. Individual fields go null intermittently on healthy stations. One
//     sensor glitching for a cycle blanks the whole panel.
//
// The fix is to stop treating one observation from one station as the answer.
// We pull the last several observations from the several nearest stations and
// coalesce field by field, taking the most recent non-null value for each and
// remembering how old it is.

const OBS_FIELDS = [
  'temperature',
  'dewpoint',
  'relativeHumidity',
  'windSpeed',
  'windDirection',
  'windGust',
  'barometricPressure',
  'seaLevelPressure',
  'visibility',
  'heatIndex',
  'windChill',
  'precipitationLastHour',
];

/**
 * Merge a station's recent observations into one record, per field.
 * @param {Array} features newest-first observation features
 */
function coalesce(features) {
  const out = { fields: {}, textDescription: null, icon: null, newest: null };
  if (!features.length) return out;

  for (const f of features) {
    const ts = Date.parse(f.properties?.timestamp);
    if (Number.isFinite(ts) && (out.newest === null || ts > out.newest)) {
      out.newest = ts;
    }
  }

  for (const field of OBS_FIELDS) {
    for (const f of features) {
      const q = f.properties?.[field];
      if (q && q.value !== null && q.value !== undefined) {
        out.fields[field] = {
          value: q.value,
          unitCode: q.unitCode,
          quality: q.qualityControl,
          timestamp: Date.parse(f.properties.timestamp),
        };
        break;
      }
    }
  }

  for (const f of features) {
    const d = f.properties?.textDescription;
    if (d && d.trim()) {
      out.textDescription = d.trim();
      out.icon = f.properties.icon || null;
      out.descriptionTime = Date.parse(f.properties.timestamp);
      break;
    }
  }

  // Cloud layers are a usable fallback when there is no worded description.
  if (!out.textDescription) {
    for (const f of features) {
      const layers = f.properties?.cloudLayers;
      if (Array.isArray(layers) && layers.length) {
        out.cloudLayers = layers;
        break;
      }
    }
  }

  return out;
}

const MAX_AGE_MS = 3 * 3600 * 1000;

/**
 * Observations for a point, drawn from the nearest stations that actually
 * have data.
 *
 * @returns {{primary: object|null, conditions: object|null, considered: number}}
 *   `primary` is the nearest station with a usable recent temperature.
 *   `conditions` is the nearest station reporting worded present weather,
 *   returned separately only when it is a different station.
 */
export async function getObservations(stationsUrl, lat, lon, opts = {}) {
  const stationData = await getJSON(stationsUrl, opts);
  const features = stationData.features || [];
  if (!features.length) return { primary: null, conditions: null, considered: 0 };

  // Look at more than one candidate, but not so many that we hammer the API.
  const candidates = features.slice(0, 6).map((f) => {
    const [slon, slat] = f.geometry?.coordinates ?? [null, null];
    return {
      id: f.id,
      identifier: f.properties.stationIdentifier,
      name: f.properties.name,
      elevationM: f.properties.elevation?.value ?? null,
      lat: slat,
      lon: slon,
      distanceKm:
        slat !== null ? haversineKm(lat, lon, slat, slon) : null,
    };
  });

  // Fetch all candidates concurrently. The original code awaited each station
  // in a loop, so a slow or dead station stalled the whole panel.
  const results = await Promise.all(
    candidates.map(async (station) => {
      try {
        const data = await getJSON(
          `${station.id}/observations?limit=6`,
          opts
        );
        return { station, obs: coalesce(data.features || []) };
      } catch {
        return { station, obs: null };
      }
    })
  );

  const now = Date.now();
  const usable = results.filter((r) => r.obs && r.obs.newest !== null);

  const fresh = (r, field) => {
    const f = r.obs.fields[field];
    return f && now - f.timestamp < MAX_AGE_MS;
  };

  // Candidates are already in distance order, so the first match is nearest.
  const primary =
    usable.find((r) => fresh(r, 'temperature')) ??
    usable.find((r) => r.obs.fields.temperature) ??
    usable[0] ??
    null;

  const withConditions =
    usable.find(
      (r) =>
        r.obs.textDescription &&
        now - r.obs.descriptionTime < MAX_AGE_MS
    ) ?? usable.find((r) => r.obs.textDescription) ?? null;

  const conditions =
    withConditions && withConditions.station.identifier !== primary?.station.identifier
      ? withConditions
      : null;

  return { primary, conditions, considered: usable.length };
}

/**
 * Build an NWS icon URL from grid data, for days the worded forecast has not
 * reached yet. Uses the same icon vocabulary the API itself serves, so the
 * result is visually consistent with forecaster-issued icons.
 */
export function deriveIconUrl({ skyCover, pop, weather, isDaytime }) {
  const period = isDaytime ? 'day' : 'night';
  const types = new Set((weather || []).map((w) => w.weather));

  let code;
  if (types.has('thunderstorms')) code = 'tsra';
  else if (types.has('snow') || types.has('snow_showers')) code = 'snow';
  else if (types.has('freezing_rain') || types.has('sleet')) code = 'fzra';
  else if (types.has('fog')) code = 'fog';
  else if (types.has('rain') || types.has('rain_showers')) code = 'rain';
  else if (pop >= 50) code = 'rain';
  else if (skyCover >= 88) code = 'ovc';
  else if (skyCover >= 63) code = 'bkn';
  else if (skyCover >= 38) code = 'sct';
  else if (skyCover >= 13) code = 'few';
  else code = 'skc';

  // The NWS icon service accepts a probability suffix only on precipitation
  // icons: `rain,40` is valid, `skc,40` is not and returns a 404.
  const PRECIP_CODES = ['rain', 'snow', 'tsra', 'fzra'];
  const suffix =
    PRECIP_CODES.includes(code) && pop >= 10
      ? `${code},${Math.min(100, Math.round(pop / 10) * 10)}`
      : code;

  return `${BASE}/icons/land/${period}/${suffix}?size=medium`;
}
