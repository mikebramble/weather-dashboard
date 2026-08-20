// units.js — display-layer unit handling.
//
// Everything upstream of this module stays in SI, matching what the NWS
// gridpoint actually serves. Conversion happens once, at render time, so
// switching units never requires refetching.

const SYSTEMS = {
  imperial: {
    temp: { to: (c) => (c * 9) / 5 + 32, symbol: '°F', decimals: 0 },
    speed: { to: (kmh) => kmh * 0.5399568, symbol: 'kt', decimals: 0 },
    precip: { to: (mm) => mm / 25.4, symbol: 'in', decimals: 2 },
    // Hourly rates need finer precision than totals: at two decimals,
    // anything lighter than 0.005 in/h rounds away to nothing.
    precipRate: { to: (mm) => mm / 25.4, symbol: 'in', decimals: 3 },
    distance: { to: (m) => m / 1609.344, symbol: 'mi', decimals: 1 },
    height: { to: (m) => m * 3.2808399, symbol: 'ft', decimals: 0 },
    pressure: { to: (pa) => pa / 3386.389, symbol: 'inHg', decimals: 2 },
  },
  metric: {
    temp: { to: (c) => c, symbol: '°C', decimals: 0 },
    speed: { to: (kmh) => kmh, symbol: 'km/h', decimals: 0 },
    precip: { to: (mm) => mm, symbol: 'mm', decimals: 1 },
    precipRate: { to: (mm) => mm, symbol: 'mm', decimals: 2 },
    distance: { to: (m) => m / 1000, symbol: 'km', decimals: 1 },
    height: { to: (m) => m, symbol: 'm', decimals: 0 },
    pressure: { to: (pa) => pa / 100, symbol: 'hPa', decimals: 0 },
  },
};

export class Units {
  constructor(system = 'imperial') {
    this.system = SYSTEMS[system] ? system : 'imperial';
  }

  get name() {
    return this.system;
  }

  set(system) {
    if (SYSTEMS[system]) this.system = system;
  }

  toggle() {
    this.system = this.system === 'imperial' ? 'metric' : 'imperial';
    return this.system;
  }

  #spec(kind) {
    return SYSTEMS[this.system][kind];
  }

  /** Convert a single SI value. Returns null for null input. */
  convert(kind, value) {
    if (value === null || value === undefined || Number.isNaN(value)) return null;
    return this.#spec(kind).to(value);
  }

  /** Convert and round to this quantity's display precision. */
  round(kind, value) {
    const v = this.convert(kind, value);
    if (v === null) return null;
    const d = this.#spec(kind).decimals;
    const f = 10 ** d;
    return Math.round(v * f) / f;
  }

  /** Map a whole series, preserving nulls as gaps. */
  series(kind, values) {
    return values.map((v) => this.round(kind, v));
  }

  symbol(kind) {
    return this.#spec(kind).symbol;
  }

  /** Formatted value with unit, e.g. "72 °F". Placeholder for missing data. */
  format(kind, value, { withSymbol = true, placeholder = '—' } = {}) {
    const v = this.round(kind, value);
    if (v === null) return placeholder;
    const d = this.#spec(kind).decimals;
    const text = v.toFixed(d);
    return withSymbol ? `${text} ${this.#spec(kind).symbol}` : text;
  }

  /** Temperature without a space before the degree sign, for big readouts. */
  formatTemp(value, { placeholder = '—' } = {}) {
    const v = this.round('temp', value);
    return v === null ? placeholder : `${v}${this.#spec('temp').symbol}`;
  }
}

/** Percentages and other unitless quantities. */
export function formatPercent(value, placeholder = '—') {
  if (value === null || value === undefined || Number.isNaN(value)) return placeholder;
  return `${Math.round(value)}%`;
}

/** One decimal place, or a placeholder. */
export function formatNumber(value, decimals = 0, placeholder = '—') {
  if (value === null || value === undefined || Number.isNaN(value)) return placeholder;
  return Number(value).toFixed(decimals);
}
