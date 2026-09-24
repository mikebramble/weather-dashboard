// layout.test.mjs — panel alignment under REAL Chart.js layout.
//
// The integration harness uses a Chart.js stub with a fixed plot area, which
// is exactly why it never noticed the precipitation panel was 58 px narrower
// than the others. This test runs js/charts.js through the real library on a
// native canvas and measures the plot areas Chart.js actually computes.
//
// Needs the optional dev dependencies `chart.js` and `canvas`. If they are not
// installed it reports SKIP and exits cleanly rather than failing.

import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let RealChart, registerables;
try {
  require('canvas');
  ({ Chart: RealChart, registerables } = require('chart.js'));
} catch {
  console.log('SKIP  layout tests need the "canvas" and "chart.js" dev dependencies');
  process.exit(0);
}
RealChart.register(...registerables);

const dom = new JSDOM('<!doctype html><html data-theme="dark"><body></body></html>', {
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.getComputedStyle = dom.window.getComputedStyle;

const HEIGHTS = { temp: 210, precip: 120, cloud: 110, wind: 150 };
let WIDTH = 1100;

// Fixed-size and non-responsive; every other part of layout is the real thing.
globalThis.Chart = class extends RealChart {
  constructor(canvas, config) {
    canvas.width = WIDTH;
    canvas.height = HEIGHTS[canvas.dataset.panel];
    config.options = { ...config.options, responsive: false, devicePixelRatio: 1 };
    super(canvas, config);
  }
};

const { buildCharts, plotMisalignment } = await import('../js/charts.js');
const { Units } = await import('../js/units.js');

let failures = 0;
function ok(name, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n      ' + detail : ''}`);
}

const HOUR = 3600000;
const labels = Array.from({ length: 168 }, (_, i) => Date.UTC(2026, 8, 24, 6) + i * HOUR);
const wave = (a, b, p = 4) => labels.map((_, i) => +(a + b * Math.sin(i / p)).toFixed(4));
const theme = new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : '#888888') });

function build(system, width, data) {
  WIDTH = width;
  document.body.innerHTML = '';
  const canvases = {};
  for (const id of Object.keys(HEIGHTS)) {
    const c = document.createElement('canvas');
    c.dataset.panel = id;
    document.body.appendChild(c);
    canvases[id] = c;
  }
  const units = new Units(system);
  const ctx = {
    labels,
    lat: 40,
    lon: -105,
    theme,
    dayBoundaries: [],
    windDirections: labels.map(() => 200),
    probeIndex: null,
    twilightBands: [],
    hidden: new Set(),
  };
  return buildCharts({
    canvases,
    getContext: () => ctx,
    data,
    units,
    timeZone: 'America/Denver',
    formatHour: () => '6 AM',
  });
}

// Deliberately awkward data: heavy rain (wide QPF tick labels), triple-digit
// temperatures, and big gusts, to push every axis toward its widest labels.
const heavy = {
  temperature: wave(95, 20),
  apparent: wave(102, 22),
  dewpoint: wave(60, 8),
  pop: wave(60, 40),
  qpf: wave(0.35, 0.34, 3),
  skyCover: wave(50, 50),
  humidity: wave(50, 45),
  windSpeed: wave(25, 20),
  windGust: wave(45, 35),
};
const dry = { ...heavy, qpf: labels.map(() => 0), pop: labels.map(() => 0) };

for (const system of ['imperial', 'metric']) {
  for (const width of [880, 1100, 1440]) {
    for (const [name, data] of [['heavy rain', heavy], ['dry', dry]]) {
      const charts = build(system, width, data);
      const drift = plotMisalignment(charts);
      const a = charts.map((c) => c.chartArea);
      ok(
        `${system}, ${width}px, ${name}: all four plot areas identical`,
        drift <= 0.5,
        `left ${a.map((x) => x.left.toFixed(1)).join('/')}  right ${a.map((x) => x.right.toFixed(1)).join('/')}`
      );

      // The specific regression: precipitation versus temperature.
      const x = (c, i) => c.chartArea.left + (i / 167) * (c.chartArea.right - c.chartArea.left);
      const worst = Math.max(...[0, 84, 167].map((i) => Math.abs(x(charts[1], i) - x(charts[0], i))));
      ok(`${system}, ${width}px, ${name}: precip crosshair tracks temperature`, worst <= 0.5, `${worst.toFixed(2)} px`);

      for (const [i, c] of charts.entries()) {
        if (!c.scales.yMirror) continue;
        const l = c.scales.y.ticks.map((t) => t.value).join(',');
        const r = c.scales.yMirror.ticks.map((t) => t.value).join(',');
        if (l !== r) ok(`panel ${i} mirror axis repeats the left axis`, false, `[${l}] vs [${r}]`);
      }
      charts.forEach((c) => c.destroy());
    }
  }
}

// Data points are where the overlays (crosshair, day rail) assume.
{
  const charts = build('imperial', 1100, heavy);
  const drift = Math.max(
    ...charts.flatMap((c) =>
      [0, 50, 167].map((j) =>
        Math.abs(c.scales.x.getPixelForValue(j) - (c.chartArea.left + (j / 167) * (c.chartArea.right - c.chartArea.left)))
      )
    )
  );
  ok('Chart.js places points exactly where the overlays assume', drift < 0.01, `${drift.toFixed(3)} px`);
  charts.forEach((c) => c.destroy());
}

console.log(failures === 0 ? '\nAll layout tests passed.' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
