// Boots the real index.html + app.js inside jsdom against mocked APIs.
// Chart.js is replaced by a recording stub that still invokes every plugin
// hook, so the canvas drawing code (twilight bands, wind arrows, crosshair)
// is genuinely executed rather than skipped.

import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as mocks from './mocks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** A 2D context that records every call so drawing can be asserted on. */
function makeCtx() {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
  };
  const ctx = {
    calls,
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    rect: record('rect'),
    clip: record('clip'),
    fill: record('fill'),
    fillRect: record('fillRect'),
    stroke: record('stroke'),
    translate: record('translate'),
    rotate: record('rotate'),
    setLineDash: record('setLineDash'),
    fillText: record('fillText'),
    measureText: () => ({ width: 40 }),
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  return ctx;
}

class ChartStub {
  static instances = [];

  constructor(canvas, config) {
    this.canvas = canvas || { getBoundingClientRect: () => ({ left: 0, top: 0 }) };
    this.config = config;
    this.data = config.data;
    this.options = config.options;
    this.ctx = makeCtx();
    this.chartArea = { left: 58, right: 940, top: 8, bottom: 200 };
    this.destroyed = false;
    ChartStub.instances.push(this);
    this.runPlugins();
  }

  runPlugins() {
    for (const p of this.config.plugins || []) {
      p.beforeDatasetsDraw?.(this);
      p.afterDatasetsDraw?.(this);
    }
  }

  render() {
    this.runPlugins();
  }

  update() {
    this.runPlugins();
  }

  destroy() {
    this.destroyed = true;
  }

  getDatasetMeta() {
    return { data: [] };
  }
}

/** Router mapping request URLs to mock payloads. */
function makeFetch(scenario) {
  const log = [];
  return {
    log,
    fetch: async (url) => {
      const u = String(url);
      log.push(u);

      const json = (body) => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => body,
      });

      if (u.includes('/points/')) return json(mocks.makePoint());
      if (u.includes('/stations') && !u.includes('/observations')) {
        return json(mocks.makeStations());
      }
      if (u.includes('/observations')) {
        return json(mocks.makeObservations(u));
      }
      if (u.includes('/forecast') && u.includes('gridpoints')) {
        return json(mocks.makeForecast({ days: scenario.forecastDays ?? 7 }));
      }
      if (u.includes('gridpoints/BOU/62,79')) return json(mocks.makeGrid());
      if (u.includes('/alerts/active')) {
        return json(mocks.makeAlerts({ withAlert: scenario.alerts !== false }));
      }
      if (u.includes('/products/types/AFD')) return json(mocks.makeAfd().list);
      if (u.includes('/products/')) return json(mocks.makeAfd().product);
      if (u.includes('air-quality')) return json(mocks.makeAirQuality());
      if (u.includes('geocoding-api')) return json(mocks.makeGeocode());
      if (u.includes('open-meteo.com/v1/forecast')) return json(mocks.makeModels());

      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
    },
  };
}

export async function boot(scenario = {}) {
  const html = readFileSync(resolve(root, 'index.html'), 'utf8')
    // Strip the CDN tag; we inject the stub instead.
    .replace(/<script[^>]*cdn\.jsdelivr[^>]*><\/script>/s, '')
    // The module is loaded manually below so we control timing.
    .replace(/<script type="module"[^>]*><\/script>/, '');

  const dom = new JSDOM(html, {
    url: 'https://example.github.io/weather-dashboard/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });

  const { window } = dom;
  const { fetch, log } = makeFetch(scenario);

  window.Chart = ChartStub;
  window.fetch = fetch;
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  // getComputedStyle in jsdom does not resolve custom properties, so feed the
  // palette in directly from the stylesheet's dark block.
  const css = readFileSync(resolve(root, 'styles.css'), 'utf8');
  const darkBlock = css.slice(
    css.indexOf(":root[data-theme='dark']"),
    css.indexOf(":root[data-theme='light']")
  );
  const lightBlock = css.slice(css.indexOf(":root[data-theme='light']"));
  const parseVars = (block) => {
    const out = {};
    for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      out[m[1]] = m[2].trim();
    }
    return out;
  };
  const palettes = { dark: parseVars(darkBlock), light: parseVars(lightBlock) };

  const realGCS = window.getComputedStyle.bind(window);
  window.getComputedStyle = (elm, pseudo) => {
    const style = realGCS(elm, pseudo);
    if (elm === window.document.documentElement) {
      const theme = window.document.documentElement.dataset.theme || 'dark';
      const vars = palettes[theme] || palettes.dark;
      return {
        ...style,
        getPropertyValue: (name) =>
          name.startsWith('--') ? (vars[name] ?? '#888888') : style.getPropertyValue(name),
      };
    }
    return style;
  };

  // Globals the modules reach for.
  for (const key of [
    'document', 'window', 'localStorage', 'Chart', 'fetch', 'ResizeObserver',
    'requestAnimationFrame', 'cancelAnimationFrame', 'Intl', 'AbortController',
    'ResizeObserver', 'Image', 'HTMLElement', 'Event', 'CustomEvent', 'Node',
  ]) {
    globalThis[key] = window[key] ?? globalThis[key];
  }
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Chart = ChartStub;
  globalThis.fetch = fetch;
  globalThis.localStorage = window.localStorage;
  globalThis.getComputedStyle = window.getComputedStyle;
  globalThis.Image = window.Image;
  globalThis.Event = window.Event;
  globalThis.URL = window.URL;
  globalThis.URLSearchParams = window.URLSearchParams;
  globalThis.history = window.history;
  globalThis.location = window.location;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.ResizeObserver = window.ResizeObserver;
  globalThis.setInterval = () => 0; // keep the refresh timer from holding the process

  ChartStub.instances.length = 0;

  const appUrl =
    pathToFileURL(resolve(root, 'js/app.js')).href + `?t=${Date.now()}${Math.random()}`;
  const app = await import(appUrl);

  // Let the promise chain settle.
  await new Promise((r) => setTimeout(r, 60));
  await new Promise((r) => setTimeout(r, 60));

  return { dom, window, doc: window.document, app, charts: ChartStub.instances, log };
}
