// charts.js — the meteogram itself.
//
// Four stacked panels sharing one time axis: temperature, precipitation,
// cloud and humidity, wind. Splitting precipitation out of the temperature
// panel lets the temperature panel carry dewpoint, which is the single most
// useful line the original dashboard was missing.

import { darkIntervals, HORIZON, CIVIL, NAUTICAL } from './solar.js';

const HOUR = 3600 * 1000;

/** Pull the live palette out of CSS so themes drive the canvas too. */
export function readTheme() {
  const s = getComputedStyle(document.documentElement);
  const v = (name) => s.getPropertyValue(name).trim();
  return {
    ink: v('--ink'),
    inkDim: v('--ink-dim'),
    inkFaint: v('--ink-faint'),
    line: v('--line'),
    lineStrong: v('--line-strong'),
    surface: v('--surface'),
    temp: v('--temp'),
    apparent: v('--apparent'),
    dewpoint: v('--dewpoint'),
    precip: v('--precip'),
    qpf: v('--qpf'),
    rh: v('--rh'),
    sky: v('--sky'),
    wind: v('--wind'),
    gust: v('--gust'),
    night: v('--night'),
    twilightNautical: v('--twilight-nautical'),
    twilightCivil: v('--twilight-civil'),
  };
}

/** Fractional position of an instant across the plot area, 0 at left. */
function fractionFor(ms, labels) {
  const first = labels[0];
  const last = labels[labels.length - 1];
  if (last === first) return 0;
  return (ms - first) / (last - first);
}

/** Pixel x for an instant, given a chart's plot area. */
export function pixelFor(ms, labels, chartArea) {
  const f = fractionFor(ms, labels);
  return chartArea.left + f * (chartArea.right - chartArea.left);
}

/* -------------------------------------------------------------------------
   Twilight shading
   -------------------------------------------------------------------------
   The original alternated a flat grey block per calendar day, which encodes
   nothing physical. This paints three nested bands from real solar elevation:
   civil twilight, nautical twilight, and full night. The result is that the
   plot background *is* the day/night cycle — you can see the nights getting
   longer across the week, and the temperature minimum sitting just after each
   sunrise where it belongs.
   ------------------------------------------------------------------------- */
/**
 * Precompute the twilight bands for a window.
 *
 * This must happen once per location, NOT once per draw. Each call scans a
 * week at ten-minute resolution and bisects every crossing, so it costs a few
 * thousand trigonometric evaluations. Multiply that by three thresholds, four
 * panels, and a redraw on every pointer move and the crosshair would crawl.
 *
 * Widest band first: sun below -6 deg is a superset of sun below -12, which is
 * a superset of sun below the horizon. The fills are translucent, so painting
 * them in that order compounds them into a graded dusk.
 */
export function computeTwilightBands(start, end, lat, lon) {
  return [
    { key: 'twilightCivil', intervals: darkIntervals(start, end, lat, lon, CIVIL) },
    { key: 'twilightNautical', intervals: darkIntervals(start, end, lat, lon, NAUTICAL) },
    { key: 'night', intervals: darkIntervals(start, end, lat, lon, HORIZON) },
  ];
}

function twilightPlugin(getContext) {
  return {
    id: 'twilight',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      const c = getContext();
      if (!c || !c.labels || c.labels.length < 2 || !c.twilightBands) return;

      const { labels, theme } = c;

      ctx.save();
      ctx.beginPath();
      ctx.rect(
        chartArea.left,
        chartArea.top,
        chartArea.right - chartArea.left,
        chartArea.bottom - chartArea.top
      );
      ctx.clip();

      for (const band of c.twilightBands) {
        ctx.fillStyle = theme[band.key];
        for (const iv of band.intervals) {
          const x0 = pixelFor(iv.start, labels, chartArea);
          const x1 = pixelFor(iv.end, labels, chartArea);
          ctx.fillRect(
            x0,
            chartArea.top,
            Math.max(1, x1 - x0),
            chartArea.bottom - chartArea.top
          );
        }
      }
      ctx.restore();
    },
  };
}

/** Day boundaries and a marker for the current time. */
function gridlinePlugin(getContext) {
  return {
    id: 'gridlines',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      const c = getContext();
      if (!c || !c.labels) return;

      ctx.save();
      ctx.strokeStyle = c.theme.lineStrong;
      ctx.lineWidth = 1;
      for (const boundary of c.dayBoundaries || []) {
        const x = Math.round(pixelFor(boundary, c.labels, chartArea)) + 0.5;
        if (x <= chartArea.left || x >= chartArea.right) continue;
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
      }
      ctx.restore();
    },
    afterDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      const c = getContext();
      if (!c || !c.labels) return;

      const now = Date.now();
      if (now < c.labels[0] || now > c.labels[c.labels.length - 1]) return;
      const x = pixelFor(now, c.labels, chartArea);

      ctx.save();
      ctx.strokeStyle = c.theme.ink;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.restore();
    },
  };
}

/** Vertical line following the pointer, drawn on every panel at once. */
function crosshairPlugin(getContext) {
  return {
    id: 'crosshair',
    afterDatasetsDraw(chart) {
      const c = getContext();
      const { chartArea, ctx } = chart;
      if (!chartArea || !c || c.probeIndex === null || c.probeIndex === undefined) return;

      const labels = c.labels;
      const x = pixelFor(labels[c.probeIndex], labels, chartArea);

      ctx.save();
      ctx.strokeStyle = c.theme.ink;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.restore();
    },
  };
}

/* -------------------------------------------------------------------------
   Wind direction
   -------------------------------------------------------------------------
   Wind direction was absent from the original charts entirely, which leaves
   out half of what wind is. Arrows point downwind — the direction air is
   travelling — because that reads more naturally on a time series than the
   meteorological "from" convention. The panel caption says so explicitly.
   ------------------------------------------------------------------------- */
function windArrowPlugin(getContext) {
  return {
    id: 'windArrows',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      const c = getContext();
      if (!c || !c.windDirections) return;

      const { labels, windDirections, theme } = c;
      const y = chartArea.top + 11;
      const spanPx = chartArea.right - chartArea.left;
      // Aim for an arrow roughly every 34 px, snapped to whole hours.
      const stride = Math.max(3, Math.round((labels.length / spanPx) * 34));

      ctx.save();
      ctx.strokeStyle = theme.wind;
      ctx.fillStyle = theme.wind;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1.25;
      ctx.lineCap = 'round';

      for (let i = 0; i < labels.length; i += stride) {
        const from = windDirections[i];
        if (from === null || from === undefined) continue;
        const x = pixelFor(labels[i], labels, chartArea);
        if (x < chartArea.left + 6 || x > chartArea.right - 6) continue;

        // Bearing the air is heading toward, then to canvas angle where 0
        // radians points along +x (screen right, i.e. east).
        const toward = (from + 180) % 360;
        const angle = ((toward - 90) * Math.PI) / 180;

        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.moveTo(-6, 0);
        ctx.lineTo(4, 0);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(6, 0);
        ctx.lineTo(1.5, -3);
        ctx.lineTo(1.5, 3);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    },
  };
}

/** Soft vertical gradient under a line, from the series colour to nothing. */
function fadeFill(color, opacity = 0.22) {
  return (context) => {
    const { chart } = context;
    const { ctx, chartArea } = chart;
    if (!chartArea) return 'transparent';
    const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    g.addColorStop(0, withAlpha(color, opacity));
    g.addColorStop(1, withAlpha(color, 0));
    return g;
  };
}

/** Add an alpha channel to a hex or rgb colour string. */
export function withAlpha(color, alpha) {
  const c = color.trim();
  if (c.startsWith('#')) {
    const hex = c.length === 4
      ? c.slice(1).split('').map((h) => h + h).join('')
      : c.slice(1, 7);
    const n = parseInt(hex, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  if (c.startsWith('rgb')) {
    const nums = c.match(/[\d.]+/g);
    return `rgba(${nums[0]}, ${nums[1]}, ${nums[2]}, ${alpha})`;
  }
  return c;
}

const LINE_BASE = {
  fill: false,
  tension: 0.35,
  pointRadius: 0,
  pointHoverRadius: 0,
  borderWidth: 1.75,
  spanGaps: false,
};

/**
 * Build the four panels.
 *
 * @param {object} spec
 * @param {object} spec.canvases  { temp, precip, cloud, wind } canvas elements
 * @param {Function} spec.getContext  returns shared render context
 * @param {object} spec.data  converted series ready to plot
 * @param {object} spec.units
 * @returns {Chart[]}
 */
export function buildCharts({ canvases, getContext, data, units, timeZone, formatHour }) {
  const ctxRef = getContext();
  const theme = ctxRef.theme;
  const labels = ctxRef.labels;
  const indices = labels.map((_, i) => i);

  // Every panel reserves the same axis width so the plot areas line up and
  // the day rail can be positioned once for all of them.
  const AXIS_WIDTH = 58;
  const lockAxis = (scale) => {
    scale.width = AXIS_WIDTH;
  };

  const shared = (isBottom) => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    normalized: true,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: { enabled: false },
      decimation: { enabled: false },
    },
    scales: {
      x: {
        type: 'category',
        offset: false,
        grid: { display: false, drawTicks: isBottom },
        border: { display: isBottom, color: theme.line },
        ticks: {
          display: isBottom,
          autoSkip: false,
          maxRotation: 0,
          color: theme.inkFaint,
          font: { size: 10, family: 'ui-monospace, monospace' },
          callback(value, index) {
            const ms = labels[index];
            if (ms === undefined) return null;
            const h = Number(
              new Intl.DateTimeFormat('en-US', {
                timeZone,
                hour: 'numeric',
                hour12: false,
              }).format(new Date(ms))
            ) % 24;
            return h % 6 === 0 && h !== 0 ? formatHour(ms) : null;
          },
        },
      },
    },
  });

  const yBase = {
    grid: { color: withAlpha(theme.line, 0.9), drawTicks: false },
    border: { display: false },
    ticks: {
      color: theme.inkFaint,
      font: { size: 10, family: 'ui-monospace, monospace' },
      padding: 6,
      maxTicksLimit: 6,
    },
    afterFit: lockAxis,
  };

  const plugins = [
    twilightPlugin(getContext),
    gridlinePlugin(getContext),
    crosshairPlugin(getContext),
  ];

  const charts = [];

  // --- 1. Temperature, apparent temperature, dewpoint ---------------------
  charts.push(
    new Chart(canvases.temp, {
      type: 'line',
      data: {
        labels: indices,
        datasets: [
          {
            ...LINE_BASE,
            label: 'Temperature',
            data: data.temperature,
            borderColor: theme.temp,
            backgroundColor: fadeFill(theme.temp, 0.2),
            fill: 'start',
            borderWidth: 2,
          },
          {
            ...LINE_BASE,
            label: 'Feels like',
            data: data.apparent,
            borderColor: theme.apparent,
            borderDash: [4, 3],
            borderWidth: 1.4,
          },
          {
            ...LINE_BASE,
            label: 'Dewpoint',
            data: data.dewpoint,
            borderColor: theme.dewpoint,
          },
        ],
      },
      options: {
        ...shared(false),
        scales: {
          ...shared(false).scales,
          y: {
            ...yBase,
            position: 'left',
            title: {
              display: true,
              text: units.symbol('temp'),
              color: theme.inkFaint,
              font: { size: 10, family: 'ui-monospace, monospace' },
            },
          },
        },
      },
      plugins,
    })
  );

  // --- 2. Precipitation: probability as area, amount as bars -------------
  charts.push(
    new Chart(canvases.precip, {
      type: 'bar',
      data: {
        labels: indices,
        datasets: [
          {
            type: 'line',
            ...LINE_BASE,
            label: 'Chance',
            data: data.pop,
            borderColor: theme.precip,
            backgroundColor: fadeFill(theme.precip, 0.3),
            fill: 'start',
            yAxisID: 'yPct',
            order: 2,
          },
          {
            type: 'bar',
            label: 'Amount',
            data: data.qpf,
            backgroundColor: withAlpha(theme.qpf, 0.85),
            borderWidth: 0,
            yAxisID: 'yAmt',
            barPercentage: 1,
            categoryPercentage: 1,
            order: 1,
          },
        ],
      },
      options: {
        ...shared(false),
        scales: {
          ...shared(false).scales,
          yPct: {
            ...yBase,
            position: 'left',
            min: 0,
            max: 100,
            ticks: { ...yBase.ticks, stepSize: 50, callback: (v) => `${v}%` },
          },
          yAmt: {
            ...yBase,
            position: 'right',
            min: 0,
            suggestedMax: units.name === 'imperial' ? 0.05 : 1,
            grid: { display: false },
            ticks: {
              ...yBase.ticks,
              maxTicksLimit: 3,
              callback: (v) =>
                v === 0 ? '' : Number(v).toFixed(units.name === 'imperial' ? 3 : 2),
            },
            title: {
              display: true,
              text: units.symbol('precipRate') + '/h',
              color: theme.inkFaint,
              font: { size: 10, family: 'ui-monospace, monospace' },
            },
          },
        },
      },
      plugins,
    })
  );

  // --- 3. Cloud cover and relative humidity ------------------------------
  charts.push(
    new Chart(canvases.cloud, {
      type: 'line',
      data: {
        labels: indices,
        datasets: [
          {
            ...LINE_BASE,
            label: 'Sky cover',
            data: data.skyCover,
            borderColor: withAlpha(theme.sky, 0.85),
            backgroundColor: fadeFill(theme.sky, 0.3),
            fill: 'start',
            borderWidth: 1.25,
          },
          {
            ...LINE_BASE,
            label: 'Humidity',
            data: data.humidity,
            borderColor: theme.rh,
          },
        ],
      },
      options: {
        ...shared(false),
        scales: {
          ...shared(false).scales,
          y: {
            ...yBase,
            min: 0,
            max: 100,
            ticks: { ...yBase.ticks, stepSize: 50, callback: (v) => `${v}%` },
          },
        },
      },
      plugins,
    })
  );

  // --- 4. Wind speed, gusts, and direction -------------------------------
  charts.push(
    new Chart(canvases.wind, {
      type: 'line',
      data: {
        labels: indices,
        datasets: [
          {
            ...LINE_BASE,
            label: 'Wind',
            data: data.windSpeed,
            borderColor: theme.wind,
            backgroundColor: fadeFill(theme.wind, 0.2),
            fill: 'start',
          },
          {
            ...LINE_BASE,
            label: 'Gusts',
            data: data.windGust,
            borderColor: theme.gust,
            borderDash: [4, 3],
            borderWidth: 1.4,
          },
        ],
      },
      options: {
        ...shared(true),
        layout: { padding: { top: 20 } },
        scales: {
          ...shared(true).scales,
          y: {
            ...yBase,
            min: 0,
            title: {
              display: true,
              text: units.symbol('speed'),
              color: theme.inkFaint,
              font: { size: 10, family: 'ui-monospace, monospace' },
            },
          },
        },
      },
      plugins: [...plugins, windArrowPlugin(getContext)],
    })
  );

  return charts;
}

/** A small standalone chart overlaying temperature from several models. */
export function buildModelChart(canvas, { time, series, theme, colors, units, timeZone, formatFull, formatDayShort }) {
  const indices = time.map((_, i) => i);

  return new Chart(canvas, {
    type: 'line',
    data: {
      labels: indices,
      datasets: series.map((s, i) => ({
        ...LINE_BASE,
        label: s.label,
        data: units.series('temp', s.values),
        borderColor: colors[i % colors.length],
        borderWidth: 1.5,
        tension: 0.3,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          backgroundColor: theme.surface,
          borderColor: theme.lineStrong,
          borderWidth: 1,
          titleColor: theme.inkDim,
          bodyColor: theme.ink,
          titleFont: { size: 11, family: 'ui-monospace, monospace' },
          bodyFont: { size: 12, family: 'ui-monospace, monospace' },
          padding: 10,
          callbacks: {
            title: (items) => formatFull(time[items[0].dataIndex]),
            label: (item) =>
              `${item.dataset.label}: ${item.formattedValue} ${units.symbol('temp')}`,
          },
        },
      },
      scales: {
        x: {
          type: 'category',
          offset: false,
          grid: { display: false },
          border: { color: theme.line },
          ticks: {
            autoSkip: false,
            maxRotation: 0,
            color: theme.inkFaint,
            font: { size: 10, family: 'ui-monospace, monospace' },
            callback(value, index) {
              const ms = time[index];
              if (ms === undefined) return null;
              const h = Number(
                new Intl.DateTimeFormat('en-US', {
                  timeZone,
                  hour: 'numeric',
                  hour12: false,
                }).format(new Date(ms))
              ) % 24;
              return h === 12 ? formatDayShort(ms) : null;
            },
          },
        },
        y: {
          grid: { color: withAlpha(theme.line, 0.9), drawTicks: false },
          border: { display: false },
          ticks: {
            color: theme.inkFaint,
            font: { size: 10, family: 'ui-monospace, monospace' },
            padding: 6,
            maxTicksLimit: 6,
          },
          title: {
            display: true,
            text: units.symbol('temp'),
            color: theme.inkFaint,
            font: { size: 10, family: 'ui-monospace, monospace' },
          },
        },
      },
    },
  });
}
