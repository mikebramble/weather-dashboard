// openmeteo.js — Open-Meteo clients.
//
// Open-Meteo redistributes raw output from national weather services under
// CC-BY 4.0. No key, CORS enabled, no tracking. Two things it gives us that
// the NWS API cannot:
//
//   1. Named model output. The NWS gridpoint is a *forecaster-edited* product:
//      a human has blended guidance and imposed their judgement on it. That is
//      usually an improvement, but it means you cannot see the raw model
//      disagreement underneath. Requesting GFS, ECMWF, ICON, and GEM
//      separately shows you where the models diverge — which is the honest
//      measure of how much to trust a day-six forecast.
//
//   2. Air quality and UV, which NWS does not serve through this API at all.

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';

// Model identifiers and how to present them. Resolutions are the native grid
// spacing of each model as Open-Meteo serves it.
export const MODELS = [
  { id: 'ecmwf_ifs025', label: 'ECMWF IFS', centre: 'ECMWF', resolution: '25 km' },
  { id: 'gfs_seamless', label: 'GFS / HRRR', centre: 'NOAA NCEP', resolution: '3–13 km' },
  { id: 'icon_seamless', label: 'ICON', centre: 'DWD', resolution: '2–13 km' },
  { id: 'gem_seamless', label: 'GEM', centre: 'ECCC', resolution: '2.5–15 km' },
];

async function getJSON(url, { signal } = {}) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/** Place search for the location box. */
export async function geocode(query, opts) {
  const url =
    `${GEOCODE}?name=${encodeURIComponent(query)}&count=8&language=en&format=json`;
  const data = await getJSON(url, opts);
  return (data.results || []).map((r) => ({
    name: r.name,
    admin1: r.admin1 ?? null,
    country: r.country ?? null,
    countryCode: r.country_code ?? null,
    latitude: r.latitude,
    longitude: r.longitude,
    elevation: r.elevation ?? null,
    timezone: r.timezone ?? null,
  }));
}

/**
 * Temperature from several deterministic models on a common hourly axis.
 * Open-Meteo suffixes each variable with the model id when more than one
 * model is requested.
 *
 * @returns {{time: number[], series: Array<{id,label,centre,resolution,values}>}}
 */
export async function getModelComparison(lat, lon, { days = 7, signal } = {}) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: 'temperature_2m',
    models: MODELS.map((m) => m.id).join(','),
    forecast_days: String(days),
    temperature_unit: 'celsius',
    timeformat: 'unixtime',
    timezone: 'GMT',
  });

  const data = await getJSON(`${FORECAST}?${params}`, { signal });
  const time = (data.hourly?.time || []).map((s) => s * 1000);

  const series = MODELS.map((m) => ({
    ...m,
    values: data.hourly?.[`temperature_2m_${m.id}`] ?? null,
  })).filter((s) => Array.isArray(s.values) && s.values.some((v) => v !== null));

  return { time, series };
}

/**
 * Current air quality and UV. `us_aqi` is the EPA index, so the category
 * breakpoints below are the official ones.
 */
export async function getAirQuality(lat, lon, { signal } = {}) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: 'us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,uv_index',
    timeformat: 'unixtime',
    timezone: 'GMT',
  });

  try {
    const data = await getJSON(`${AIR}?${params}`, { signal });
    const c = data.current;
    if (!c) return null;
    return {
      time: c.time * 1000,
      aqi: c.us_aqi ?? null,
      pm25: c.pm2_5 ?? null,
      pm10: c.pm10 ?? null,
      ozone: c.ozone ?? null,
      no2: c.nitrogen_dioxide ?? null,
      uv: c.uv_index ?? null,
    };
  } catch {
    return null;
  }
}

/** EPA AQI category for a value. */
export function aqiCategory(aqi) {
  if (aqi === null || aqi === undefined) return null;
  if (aqi <= 50) return { label: 'Good', tone: 'good' };
  if (aqi <= 100) return { label: 'Moderate', tone: 'moderate' };
  if (aqi <= 150) return { label: 'Unhealthy for sensitive groups', tone: 'usg' };
  if (aqi <= 200) return { label: 'Unhealthy', tone: 'unhealthy' };
  if (aqi <= 300) return { label: 'Very unhealthy', tone: 'very' };
  return { label: 'Hazardous', tone: 'hazardous' };
}

/** WHO/ICNIRP UV exposure category. */
export function uvCategory(uv) {
  if (uv === null || uv === undefined) return null;
  if (uv < 3) return { label: 'Low', tone: 'good' };
  if (uv < 6) return { label: 'Moderate', tone: 'moderate' };
  if (uv < 8) return { label: 'High', tone: 'usg' };
  if (uv < 11) return { label: 'Very high', tone: 'unhealthy' };
  return { label: 'Extreme', tone: 'very' };
}
