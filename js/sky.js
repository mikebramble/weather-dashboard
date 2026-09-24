// sky.js — the Sun and Moon readout cards.
//
// Each card leads with today's value, then shows how it sits in time: a
// sparkline across the surrounding weeks so the rate of change is visible,
// not just the number. Everything here is computed locally (solar.js,
// moon.js); nothing touches the network.
//
// The sparklines are hand-built SVG rather than Chart.js: they are small,
// need no axes machinery, and styling them through CSS classes means a theme
// switch recolours them without a re-render.

import {
  sunriseSunset,
  solarNoon,
  dayLengthAnalytic,
  nextSeasonEvent,
  findCrossings,
  CIVIL,
  HORIZON,
} from './solar.js';
import { moonState, moonriseMoonset, lunarPhaseEvents, nextNewAndFull } from './moon.js';
import {
  startOfLocalDay,
  addLocalDays,
  formatClock,
  formatDate,
  formatDuration,
  formatDelta,
} from './time.js';

const DAY = 86400000;
const HOUR = 3600000;
const SVG_NS = 'http://www.w3.org/2000/svg';

export const SUN_RANGES = {
  '2w': { label: '±2 wk', days: 14 },
  '3m': { label: '±3 mo', days: 91 },
  '1y': { label: '1 yr', days: 182 },
};

const SPARK_HEIGHT = 74;

// --- Small DOM helpers ----------------------------------------------------

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function field(container, label, value, title) {
  const wrap = h('div', 'field');
  wrap.append(h('span', 'field__label', label), h('span', 'field__value', value));
  if (title) wrap.title = title;
  container.appendChild(wrap);
}

function cardShell(title) {
  const card = h('article', 'readout readout--sky');
  const head = h('div', 'readout__head');
  head.appendChild(h('span', 'readout__source', title));
  card.appendChild(head);
  return { card, head };
}

/** Width available to a sparkline; jsdom reports 0, so fall back sensibly. */
function widthOf(node) {
  return Math.max(160, Math.round(node.clientWidth || 280));
}

/**
 * Build an interactive sparkline into `host`.
 *
 * @param {HTMLElement} host   element the SVG fills (full card width)
 * @param {object} o
 * @param {number[]} o.x        x values (days relative to today)
 * @param {Array<{values:number[], className:string, area?:boolean}>} o.layers
 *                              drawn in order; the last is the primary line
 * @param {[number,number]} o.yRange
 * @param {Array<{x:number, label:string, className?:string}>} [o.marks]
 * @param {(i:number)=>string} o.describe  hover readout text for index i
 * @param {(v:number)=>string} [o.yLabel]  labels for the y extremes
 * @param {[string,string]} o.xLabels     labels for the two ends
 * @param {HTMLElement} o.readout   where hover text goes
 * @param {string} o.idleText       readout text when not hovering
 */
function sparkline(host, o) {
  host.innerHTML = '';
  const W = widthOf(host);
  const H = SPARK_HEIGHT;
  const pad = { top: 8, bottom: 14, left: 0, right: 0 };

  const [x0, x1] = [o.x[0], o.x[o.x.length - 1]];
  const [y0, y1] = o.yRange;
  const X = (x) => pad.left + ((x - x0) / (x1 - x0 || 1)) * (W - pad.left - pad.right);
  const Y = (y) => pad.top + (1 - (y - y0) / (y1 - y0 || 1)) * (H - pad.top - pad.bottom);
  const base = H - pad.bottom;

  const root = svg('svg', {
    class: 'spark__svg',
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
  });

  const path = (values) =>
    values
      .map((v, i) => (v === null ? null : `${X(o.x[i]).toFixed(1)},${Y(v).toFixed(1)}`))
      .filter(Boolean)
      .join(' L');

  for (const layer of o.layers) {
    const d = path(layer.values);
    if (!d) continue;
    if (layer.area) {
      root.appendChild(
        svg('path', {
          class: layer.className,
          d: `M${X(x0).toFixed(1)},${base} L${d} L${X(x1).toFixed(1)},${base} Z`,
        })
      );
    } else {
      root.appendChild(svg('path', { class: layer.className, d: `M${d}` }));
    }
  }

  const primary = o.layers[o.layers.length - 1].values;
  const nearest = (xv) => {
    let i = 0;
    let best = Infinity;
    o.x.forEach((x, j) => {
      const d = Math.abs(x - xv);
      if (d < best) {
        best = d;
        i = j;
      }
    });
    return i;
  };

  // Event markers (phases, solstices). Each label goes on whichever side of
  // the curve is empty at that point, so it never sits across the line.
  for (const m of o.marks || []) {
    if (m.x < x0 || m.x > x1) continue;
    const x = X(m.x);
    const v = primary[nearest(m.x)];
    const curveHigh = v !== null && Y(v) < (pad.top + base) / 2;
    root.appendChild(svg('line', { class: 'spark__mark', x1: x, x2: x, y1: pad.top, y2: base }));
    const t = svg('text', {
      class: `spark__mark-label ${m.className || ''}`,
      x: Math.min(W - 2, Math.max(2, x)),
      y: curveHigh ? base - 3 : pad.top + 1,
      'text-anchor': x < 20 ? 'start' : x > W - 20 ? 'end' : 'middle',
      'dominant-baseline': curveHigh ? 'auto' : 'hanging',
    });
    t.textContent = m.label;
    root.appendChild(t);
  }

  // Today.
  const todayIdx = o.x.indexOf(0);
  const tx = X(0);
  root.appendChild(svg('line', { class: 'spark__today', x1: tx, x2: tx, y1: pad.top - 4, y2: base }));
  if (todayIdx >= 0 && primary[todayIdx] !== null) {
    root.appendChild(svg('circle', { class: 'spark__dot', cx: tx, cy: Y(primary[todayIdx]), r: 3.5 }));
  }

  // Axis end labels along the bottom edge.
  const [l, r] = o.xLabels;
  const lt = svg('text', { class: 'spark__axis', x: 4, y: H - 3 });
  lt.textContent = l;
  const rt = svg('text', { class: 'spark__axis', x: W - 4, y: H - 3, 'text-anchor': 'end' });
  rt.textContent = r;
  root.append(lt, rt);

  // Label the curve's own extremes at their true heights. Labelling the
  // padded axis limits instead would misstate the range of the data.
  if (o.yLabel) {
    const vals = primary.filter((v) => v !== null);
    const hi = Math.max(...vals);
    const lo = Math.min(...vals);
    for (const [v, below] of [[hi, false], [lo, true]]) {
      const y = Y(v);
      root.appendChild(svg('line', { class: 'spark__tick', x1: 0, x2: 5, y1: y, y2: y }));
      const t = svg('text', {
        class: 'spark__axis',
        x: 8,
        y: below ? y - 3 : y + 3,
        'dominant-baseline': below ? 'auto' : 'hanging',
      });
      t.textContent = o.yLabel(v);
      root.appendChild(t);
    }
  }

  // Hover guide.
  const guide = svg('line', { class: 'spark__guide', y1: pad.top - 4, y2: base, visibility: 'hidden' });
  const hoverDot = svg('circle', { class: 'spark__hover-dot', r: 3, visibility: 'hidden' });
  root.append(guide, hoverDot);

  root.addEventListener('pointermove', (e) => {
    const rect = root.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / (rect.width || W)) * W;
    const xv = x0 + ((px - pad.left) / (W - pad.left - pad.right)) * (x1 - x0);
    const i = nearest(xv);
    const gx = X(o.x[i]);
    guide.setAttribute('x1', gx);
    guide.setAttribute('x2', gx);
    guide.setAttribute('visibility', 'visible');
    if (primary[i] !== null) {
      hoverDot.setAttribute('cx', gx);
      hoverDot.setAttribute('cy', Y(primary[i]));
      hoverDot.setAttribute('visibility', 'visible');
    }
    o.readout.textContent = o.describe(i);
    o.readout.dataset.active = 'true';
  });
  root.addEventListener('pointerleave', () => {
    guide.setAttribute('visibility', 'hidden');
    hoverDot.setAttribute('visibility', 'hidden');
    o.readout.textContent = o.idleText;
    o.readout.dataset.active = 'false';
  });

  host.appendChild(root);
  o.readout.textContent = o.idleText;
}

// --- Moon glyph -----------------------------------------------------------

/**
 * A rendered Moon at the current phase. The lit limb is on the right while
 * waxing as seen from the northern hemisphere; south of the equator the view
 * is mirrored, so the glyph is too.
 */
export function moonGlyph(illumination, waxing, southern, size = 44) {
  const r = size / 2 - 1;
  const c = size / 2;
  const root = svg('svg', {
    class: 'moon-glyph',
    width: size,
    height: size,
    viewBox: `0 0 ${size} ${size}`,
    role: 'img',
    'aria-label': `Moon ${Math.round(illumination * 100)}% illuminated`,
  });
  root.appendChild(svg('circle', { class: 'moon-glyph__dark', cx: c, cy: c, r }));

  const k = Math.max(0, Math.min(1, illumination));
  if (k > 0.005) {
    // Lit limb: a semicircle on the right. Terminator: a half-ellipse whose
    // width shrinks to zero at quarter phase and bulges past centre when
    // gibbous.
    const rx = Math.abs(1 - 2 * k) * r;
    const terminatorSweep = k < 0.5 ? 0 : 1;
    const d =
      `M${c},${c - r} A${r},${r} 0 0 1 ${c},${c + r} ` +
      `A${rx.toFixed(2)},${r} 0 0 ${terminatorSweep} ${c},${c - r} Z`;
    const lit = svg('path', { class: 'moon-glyph__lit', d });
    const mirrored = waxing === southern; // lit limb on the left
    if (mirrored) lit.setAttribute('transform', `translate(${size},0) scale(-1,1)`);
    root.appendChild(lit);
  }
  root.appendChild(svg('circle', { class: 'moon-glyph__rim', cx: c, cy: c, r }));
  return root;
}

// --- Sun card ---------------------------------------------------------------

export function sunCard({ lat, lon, timeZone, now = Date.now(), range = '2w', onRange }) {
  const { card, head } = cardShell('Sun');

  const today0 = startOfLocalDay(now, timeZone);
  const tomorrow0 = addLocalDays(today0, timeZone, 1);
  const yesterday0 = addLocalDays(today0, timeZone, -1);

  const { sunrise, sunset } = sunriseSunset(today0, lat, lon);
  const prev = sunriseSunset(yesterday0, lat, lon);

  // Range control.
  const seg = h('div', 'seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Sparkline range');
  for (const [key, r] of Object.entries(SUN_RANGES)) {
    const b = h('button', 'seg__btn', r.label);
    b.type = 'button';
    b.dataset.range = key;
    b.setAttribute('aria-pressed', String(key === range));
    b.addEventListener('click', () => {
      seg.querySelectorAll('.seg__btn').forEach((x) =>
        x.setAttribute('aria-pressed', String(x === b))
      );
      drawSpark(key);
      onRange?.(key);
    });
    seg.appendChild(b);
  }
  head.appendChild(seg);

  // Headline: today's day length and how fast it is changing.
  const primary = h('div', 'readout__primary');
  const value = h('div', 'readout__value readout__value--small');
  const caption = h('div', 'readout__caption');

  const length = sunrise && sunset ? sunset - sunrise : null;
  const prevLength = prev.sunrise && prev.sunset ? prev.sunset - prev.sunrise : null;

  if (length !== null) {
    value.textContent = formatDuration(length);
    const delta = prevLength !== null ? length - prevLength : null;
    caption.append(
      h('span', null, 'of daylight'),
      h('br'),
      h(
        'span',
        `trend ${delta === null ? '' : delta >= 0 ? 'trend--up' : 'trend--down'}`,
        delta === null ? '' : `${delta >= 0 ? '▲' : '▼'} ${formatDelta(delta)} vs yesterday`
      )
    );
  } else {
    const up = sunriseSunset(today0, lat, lon);
    value.textContent = up.sunrise || up.sunset ? '—' : '24h 00m';
    caption.textContent = 'No sunrise or sunset today';
  }
  primary.append(value, caption);

  // Sparkline.
  const readout = h('div', 'spark__readout');
  const band = h('div', 'spark');

  function drawSpark(key) {
    const N = SUN_RANGES[key].days;
    const x = [];
    const light = [];
    const noons = [];
    // Weekly sampling is plenty for a year; daily for shorter ranges.
    const step = N > 100 ? 2 : 1;
    for (let d = -N; d <= N; d += step) {
      // Noon of day d: approximate local midnight is fine here, because
      // solarNoon snaps to the nearest transit regardless of a DST hour.
      const noon = solarNoon(today0 + d * DAY, lat, lon).ms;
      x.push(d);
      noons.push(noon);
      light.push(dayLengthAnalytic(noon, lat, HORIZON) / HOUR);
    }
    if (!x.includes(0)) {
      // Guarantee a sample at today for the marker.
      const noon = solarNoon(today0, lat, lon).ms;
      const at = x.findIndex((v) => v > 0);
      x.splice(at, 0, 0);
      noons.splice(at, 0, noon);
      light.splice(at, 0, dayLengthAnalytic(noon, lat, HORIZON) / HOUR);
    }

    // The y-range hugs the curve so the slope — the rate of change — is what
    // the eye reads. A fixed 0-24 h axis would flatten two weeks to a line.
    const lo = Math.min(...light);
    const hi = Math.max(...light);
    const padY = Math.max(0.05, (hi - lo) * 0.18);

    // Equinoxes and solstices that fall in the window.
    const marks = [];
    let t = today0 - N * DAY;
    for (let guard = 0; guard < 6; guard++) {
      const ev = nextSeasonEvent(t);
      if (ev.ms > today0 + N * DAY) break;
      marks.push({
        x: (ev.ms - today0) / DAY,
        label: ev.name.includes('solstice') ? 'Sol' : 'Eq',
        className: 'spark__mark-label--sun',
      });
      t = ev.ms + DAY;
    }

    sparkline(band, {
      x,
      layers: [
        { values: light, className: 'spark__area spark__area--sun', area: true },
        { values: light, className: 'spark__line spark__line--sun' },
      ],
      yRange: [Math.max(0, lo - padY), Math.min(24, hi + padY)],
      marks,
      yLabel: (v) => formatDuration(v * HOUR),
      xLabels: [formatDate(today0 - N * DAY, timeZone), formatDate(today0 + N * DAY, timeZone)],
      readout,
      idleText: `Day length across ${key === '1y' ? 'the year' : SUN_RANGES[key].label}`,
      describe: (i) => {
        const noon = noons[i];
        const L = light[i] * HOUR;
        return (
          `${formatDate(noon, timeZone)} · ${formatDuration(L)} · ` +
          `▲ ${formatClock(noon - L / 2, timeZone)}  ▼ ${formatClock(noon + L / 2, timeZone)}`
        );
      },
    });
  }

  // Fields.
  const fields = h('div', 'readout__fields');
  const noon = solarNoon(today0, lat, lon);
  const civilTimes = civilDawnDusk(today0, tomorrow0, lat, lon);
  const season = nextSeasonEvent(now);
  const daysTo = Math.round((startOfLocalDay(season.ms, timeZone) - today0) / DAY);

  field(fields, 'Sunrise', sunrise ? formatClock(sunrise, timeZone) : 'None');
  field(fields, 'Sunset', sunset ? formatClock(sunset, timeZone) : 'None');
  field(fields, 'First light', civilTimes.dawn ? formatClock(civilTimes.dawn, timeZone) : '—',
    'Start of civil twilight: the Sun 6° below the horizon');
  field(fields, 'Last light', civilTimes.dusk ? formatClock(civilTimes.dusk, timeZone) : '—',
    'End of civil twilight: the Sun 6° below the horizon');
  field(fields, 'Solar noon', `${formatClock(noon.ms, timeZone)} · ${noon.elevation.toFixed(1)}°`,
    'Time of transit and the Sun’s elevation then');
  field(fields, season.name.replace(/^(\w{3})\w*/, '$1'),
    `${formatDate(season.ms, timeZone)} · ${daysTo === 0 ? 'today' : `in ${daysTo} d`}`,
    `${season.name}: ${formatDate(season.ms, timeZone)}, ${formatClock(season.ms, timeZone)} local`);

  card.append(primary, readout, band, fields);
  // The band has no width until it is in the document, so the caller draws it
  // once attached, and again whenever the card is resized.
  return {
    element: card,
    draw: () => drawSpark(seg.querySelector('[aria-pressed="true"]').dataset.range),
  };
}

function civilDawnDusk(dayStart, dayEnd, lat, lon) {
  const c = findCrossings(dayStart, dayEnd, lat, lon, CIVIL);
  return {
    dawn: c.find((x) => x.rising)?.ms ?? null,
    dusk: c.find((x) => !x.rising)?.ms ?? null,
  };
}

// --- Moon card --------------------------------------------------------------

export function moonCard({ lat, lon, timeZone, now = Date.now() }) {
  const { card } = cardShell('Moon');

  const today0 = startOfLocalDay(now, timeZone);
  const tomorrow0 = addLocalDays(today0, timeZone, 1);
  const state = moonState(now);

  const primary = h('div', 'readout__primary');
  primary.appendChild(moonGlyph(state.illumination, state.waxing, lat < 0));
  const value = h('div', 'readout__value readout__value--small', `${Math.round(state.illumination * 100)}%`);
  const caption = h('div', 'readout__caption');
  caption.append(
    h('span', null, state.name),
    h('br'),
    h('span', 'trend', `${state.waxing ? '▲ waxing' : '▼ waning'} · ${state.age.toFixed(1)} d old`)
  );
  primary.append(value, caption);

  const readout = h('div', 'spark__readout');
  const band = h('div', 'spark spark--moon');

  const N = 15;
  const stepH = 6;
  const x = [];
  const illum = [];
  const times = [];
  for (let t = -N * 24; t <= N * 24; t += stepH) {
    const ms = now + t * HOUR;
    x.push(t / 24);
    times.push(ms);
    illum.push(moonState(ms).illumination * 100);
  }

  const events = lunarPhaseEvents(now - N * DAY, now + N * DAY);
  const LABEL = { new: 'New', first: '1st Q', full: 'Full', last: '3rd Q' };
  const marks = events
    .filter((e) => e.type === 'new' || e.type === 'full')
    .map((e) => ({ x: (e.ms - now) / DAY, label: LABEL[e.type], className: 'spark__mark-label--moon' }));

  const draw = () =>
    sparkline(band, {
      x,
      layers: [
        { values: illum, className: 'spark__area spark__area--moon', area: true },
        { values: illum, className: 'spark__line spark__line--moon' },
      ],
      yRange: [0, 100],
      marks,
      xLabels: [formatDate(now - N * DAY, timeZone), formatDate(now + N * DAY, timeZone)],
      readout,
      idleText: 'Illumination across ±15 days',
      describe: (i) => {
        const s = moonState(times[i]);
        return `${formatDate(times[i], timeZone)} · ${Math.round(s.illumination * 100)}% · ${s.name}`;
      },
    });

  const { rise, set } = moonriseMoonset(today0, tomorrow0, lat, lon);
  const { nextNew, nextFull } = nextNewAndFull(now);

  const fields = h('div', 'readout__fields');
  field(fields, 'Moonrise', rise ? formatClock(rise, timeZone) : 'None today',
    rise ? '' : 'The Moon rises about 50 minutes later each day, so roughly once a month a day has no moonrise.');
  field(fields, 'Moonset', set ? formatClock(set, timeZone) : 'None today');
  field(fields, 'Next full', nextFull ? `${formatDate(nextFull, timeZone)} · ${formatClock(nextFull, timeZone)}` : '—');
  field(fields, 'Next new', nextNew ? `${formatDate(nextNew, timeZone)} · ${formatClock(nextNew, timeZone)}` : '—');

  card.append(primary, readout, band, fields);
  return { element: card, draw };
}
