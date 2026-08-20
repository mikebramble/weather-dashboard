// Mock API responses shaped like the real thing, including the specific
// failure modes the original dashboard tripped over.

const HOUR = 3600000;

export const TZ = 'America/Denver';
export const LAT = 40.0150;
export const LON = -105.2705;

/** Local midnight today, in the mock's time zone. */
export function localMidnight(now = Date.now()) {
  const key = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
  let t = now - 30 * HOUR;
  const k = (x) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(x));
  while (k(t) !== key) t += HOUR;
  while (k(t - 60000) === key) t -= 60000;
  return t;
}

function iso(ms) {
  return new Date(ms).toISOString().replace('.000Z', '+00:00');
}

/** Build a gridpoint variable as hourly blocks. */
function hourlyBlocks(startMs, count, fn) {
  const values = [];
  for (let i = 0; i < count; i++) {
    const v = fn(i);
    if (v === null) continue;
    values.push({ validTime: `${iso(startMs + i * HOUR)}/PT1H`, value: v });
  }
  return { uom: 'wmoUnit:degC', values };
}

/** Build a variable as six-hour blocks — the shape QPF actually arrives in. */
function sixHourBlocks(startMs, hours, fn) {
  const values = [];
  for (let i = 0; i < hours; i += 6) {
    const v = fn(i);
    if (v === null) continue;
    values.push({ validTime: `${iso(startMs + i * HOUR)}/PT6H`, value: v });
  }
  return { uom: 'wmoUnit:mm', values };
}

export function makePoint() {
  return {
    properties: {
      gridId: 'BOU',
      gridX: 62,
      gridY: 79,
      timeZone: TZ,
      relativeLocation: { properties: { city: 'Boulder', state: 'CO' } },
      forecast: 'https://api.weather.gov/gridpoints/BOU/62,79/forecast',
      forecastGridData: 'https://api.weather.gov/gridpoints/BOU/62,79',
      observationStations: 'https://api.weather.gov/gridpoints/BOU/62,79/stations',
      forecastZone: 'https://api.weather.gov/zones/forecast/COZ039',
      fireWeatherZone: 'https://api.weather.gov/zones/fire/COZ212',
      radarStation: 'KFTG',
    },
  };
}

/**
 * Gridded forecast starting six hours before local midnight (as the real one
 * does) and running 190 hours forward.
 */
export function makeGrid({ hours = 190 } = {}) {
  const start = localMidnight() - 6 * HOUR;

  const diurnal = (i) => {
    const h = ((i - 6) % 24 + 24) % 24;
    return 18 + 9 * Math.sin(((h - 9) / 24) * 2 * Math.PI);
  };

  return {
    properties: {
      updateTime: iso(Date.now() - 90 * 60000),
      validTimes: `${iso(start)}/P8DT2H`,
      elevation: { unitCode: 'wmoUnit:m', value: 1655 },

      temperature: hourlyBlocks(start, hours, diurnal),
      apparentTemperature: hourlyBlocks(start, hours, (i) => diurnal(i) + 0.6),
      dewpoint: hourlyBlocks(start, hours, (i) => diurnal(i) - 8),
      relativeHumidity: hourlyBlocks(start, hours, (i) => 45 + 25 * Math.cos((i / 24) * 2 * Math.PI)),
      skyCover: hourlyBlocks(start, hours, (i) => Math.round(30 + 30 * Math.sin(i / 17))),
      probabilityOfPrecipitation: hourlyBlocks(start, hours, (i) =>
        i > 60 && i < 84 ? 45 : 0
      ),
      // 6 mm spread over each PT6H block: the case that inflates 6x if the
      // block value is copied to every hour instead of divided.
      quantitativePrecipitation: sixHourBlocks(start, hours, (i) =>
        i > 60 && i < 84 ? 6 : 0
      ),
      snowfallAmount: sixHourBlocks(start, hours, () => 0),
      windSpeed: hourlyBlocks(start, hours, (i) => 8 + 6 * Math.sin(i / 9)),
      windGust: hourlyBlocks(start, hours, (i) => 14 + 9 * Math.sin(i / 9)),
      windDirection: hourlyBlocks(start, hours, (i) => (200 + i * 3) % 360),
      probabilityOfThunder: hourlyBlocks(start, hours, () => 0),
      weather: {
        values: [
          {
            validTime: `${iso(start + 60 * HOUR)}/PT24H`,
            value: [{ coverage: 'chance', weather: 'rain_showers', intensity: 'light' }],
          },
        ],
      },
      hainesIndex: hourlyBlocks(start, hours, () => 4),
    },
  };
}

/**
 * Worded forecast. `days` controls how far it reaches, so we can reproduce
 * the case where the gridded data outruns the worded product.
 */
export function makeForecast({ days = 7 } = {}) {
  const midnight = localMidnight();
  const periods = [];
  let n = 1;

  for (let d = 0; d < days; d++) {
    const dayStart = midnight + d * 24 * HOUR + 6 * HOUR;
    periods.push({
      number: n++,
      name: d === 0 ? 'Today' : 'Day',
      startTime: iso(dayStart),
      endTime: iso(dayStart + 12 * HOUR),
      isDaytime: true,
      temperature: 78 + d,
      shortForecast: d === 3 ? 'Chance Rain Showers' : 'Sunny',
      icon: `https://api.weather.gov/icons/land/day/${d === 3 ? 'rain,40' : 'skc'}?size=medium`,
    });
    periods.push({
      number: n++,
      name: d === 0 ? 'Tonight' : 'Night',
      startTime: iso(dayStart + 12 * HOUR),
      endTime: iso(dayStart + 24 * HOUR),
      isDaytime: false,
      temperature: 58 + d,
      shortForecast: 'Clear',
      icon: 'https://api.weather.gov/icons/land/night/skc?size=medium',
    });
  }

  return { properties: { updated: iso(Date.now() - 2 * HOUR), periods } };
}

export function makeStations() {
  return {
    features: [
      {
        // Nearest station: a mesonet site. Reports temperature and wind only,
        // never a worded present-weather description. This is the station the
        // original dashboard picked, and why the panel read
        // "Conditions Not Reported".
        id: 'https://api.weather.gov/stations/GDHC2',
        geometry: { type: 'Point', coordinates: [-105.402, 40.061] },
        properties: {
          stationIdentifier: 'GDHC2',
          name: 'Gold Hill RAWS',
          elevation: { unitCode: 'wmoUnit:m', value: 2591 },
        },
      },
      {
        // Second nearest: a full ASOS with everything.
        id: 'https://api.weather.gov/stations/KBDU',
        geometry: { type: 'Point', coordinates: [-105.226, 40.039] },
        properties: {
          stationIdentifier: 'KBDU',
          name: 'Boulder Municipal Airport',
          elevation: { unitCode: 'wmoUnit:m', value: 1612 },
        },
      },
      {
        id: 'https://api.weather.gov/stations/KBJC',
        geometry: { type: 'Point', coordinates: [-105.117, 39.909] },
        properties: {
          stationIdentifier: 'KBJC',
          name: 'Rocky Mountain Metropolitan Airport',
          elevation: { unitCode: 'wmoUnit:m', value: 16559 },
        },
      },
    ],
  };
}

const q = (value, unit = 'wmoUnit:degC') => ({
  value,
  unitCode: unit,
  qualityControl: 'V',
});

/**
 * Observation history per station. Note the deliberate holes: GDHC2's newest
 * report has a null temperature (sensor dropout) and no description at all.
 * A single /observations/latest call against this station returns a panel
 * with nothing in it — which is exactly the reported symptom.
 */
export function makeObservations(stationId) {
  const now = Date.now();
  const mk = (offsetMin, props) => ({
    properties: {
      timestamp: iso(now - offsetMin * 60000),
      ...props,
    },
  });

  if (stationId.includes('GDHC2')) {
    return {
      features: [
        mk(8, {
          temperature: q(null),
          dewpoint: q(null),
          relativeHumidity: q(null, 'wmoUnit:percent'),
          windSpeed: q(11.2, 'wmoUnit:km_h-1'),
          windDirection: q(245, 'wmoUnit:degree_(angle)'),
          textDescription: '',
        }),
        mk(28, {
          temperature: q(24.4),
          dewpoint: q(9.4),
          relativeHumidity: q(38, 'wmoUnit:percent'),
          windSpeed: q(9.3, 'wmoUnit:km_h-1'),
          windDirection: q(250, 'wmoUnit:degree_(angle)'),
          textDescription: '',
        }),
        mk(48, {
          temperature: q(23.9),
          dewpoint: q(9.1),
          relativeHumidity: q(39, 'wmoUnit:percent'),
          windSpeed: q(7.4, 'wmoUnit:km_h-1'),
          windDirection: q(255, 'wmoUnit:degree_(angle)'),
          textDescription: '',
        }),
      ],
    };
  }

  if (stationId.includes('KBDU')) {
    return {
      features: [
        mk(12, {
          temperature: q(25.6),
          dewpoint: q(11.1),
          relativeHumidity: q(40, 'wmoUnit:percent'),
          windSpeed: q(13, 'wmoUnit:km_h-1'),
          windDirection: q(240, 'wmoUnit:degree_(angle)'),
          windGust: q(24, 'wmoUnit:km_h-1'),
          barometricPressure: q(101320, 'wmoUnit:Pa'),
          visibility: q(16090, 'wmoUnit:m'),
          textDescription: 'Mostly Clear',
          icon: 'https://api.weather.gov/icons/land/day/few?size=medium',
          cloudLayers: [{ amount: 'FEW', base: { value: 3600 } }],
        }),
        mk(72, {
          temperature: q(24.4),
          textDescription: 'Clear',
        }),
      ],
    };
  }

  return { features: [] };
}

export function makeAlerts({ withAlert = true } = {}) {
  if (!withAlert) return { features: [] };
  const now = Date.now();
  return {
    features: [
      {
        properties: {
          event: 'Red Flag Warning',
          severity: 'Severe',
          certainty: 'Likely',
          urgency: 'Expected',
          onset: iso(now + 4 * HOUR),
          ends: iso(now + 30 * HOUR),
          effective: iso(now),
          expires: iso(now + 30 * HOUR),
          headline: 'Red Flag Warning issued for the Front Range foothills',
          description:
            'Gusty downslope winds and low humidity will produce critical fire weather conditions.',
          instruction: 'Avoid activities that could produce a spark.',
        },
      },
      {
        properties: {
          event: 'Heat Advisory',
          severity: 'Moderate',
          onset: iso(now + 20 * HOUR),
          ends: iso(now + 50 * HOUR),
          headline: 'Heat Advisory in effect',
          description: 'High temperatures near 100 expected.',
          instruction: null,
        },
      },
    ],
  };
}

export function makeAirQuality() {
  return {
    current: {
      time: Math.floor((Date.now() - 20 * 60000) / 1000),
      us_aqi: 63,
      pm2_5: 15.4,
      pm10: 28.1,
      ozone: 74,
      nitrogen_dioxide: 12,
      uv_index: 8.3,
    },
  };
}

export function makeModels() {
  const start = localMidnight();
  const n = 168;
  const time = Array.from({ length: n }, (_, i) => Math.floor((start + i * HOUR) / 1000));
  const base = (i, bias, spreadScale) => {
    const h = i % 24;
    return (
      18 +
      9 * Math.sin(((h - 9) / 24) * 2 * Math.PI) +
      bias +
      spreadScale * (i / n) * Math.sin(i / 13)
    );
  };
  return {
    hourly: {
      time,
      temperature_2m_ecmwf_ifs025: time.map((_, i) => base(i, 0, 2)),
      temperature_2m_gfs_seamless: time.map((_, i) => base(i, 0.7, 3)),
      temperature_2m_icon_seamless: time.map((_, i) => base(i, -0.5, 2.5)),
      temperature_2m_gem_seamless: time.map((_, i) => base(i, 0.2, 3.5)),
    },
  };
}

export function makeAfd() {
  return {
    list: {
      '@graph': [
        {
          '@id': 'https://api.weather.gov/products/abc-123',
          issuanceTime: iso(Date.now() - 3 * HOUR),
        },
      ],
    },
    product: {
      issuanceTime: iso(Date.now() - 3 * HOUR),
      issuingOffice: 'KBOU',
      productText:
        'AREA FORECAST DISCUSSION\nNational Weather Service Denver/Boulder CO\n\n.SYNOPSIS...\nModels are in reasonable agreement through midweek. The ECMWF is\nnotably drier than the GFS beyond day 5.\n',
    },
  };
}

export function makeGeocode() {
  return {
    results: [
      {
        name: 'Longmont',
        admin1: 'Colorado',
        country: 'United States',
        country_code: 'US',
        latitude: 40.1672,
        longitude: -105.1019,
        elevation: 263,
        timezone: TZ,
      },
    ],
  };
}
