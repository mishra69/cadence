// Progress charts — hand-rolled SVG.
//
// No chart library: a CDN one installs fine and then fails to run offline, and
// vendoring a whole library for three simple shapes is not a trade worth making.
//
// Palette is validated, not guessed. The two categorical steps below passed all
// six checks against Cadence's #202638 surface — lightness band, chroma floor,
// CVD separation, normal-vision floor, and 3:1 contrast. The app's UI accent
// (#7c9cf5) and warm (#d9a05b) both sit *above* the dark lightness band, so they
// are deliberately not reused as data colors.
const Charts = (() => {
  // Read from CSS rather than duplicated: the ribbon is drawn with CSS classes
  // and the line chart with SVG, and two copies of a hex is how one gets changed
  // without the other being re-validated.
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const SLIP = () => css('--viz-slip');
  const CLEAN = () => css('--viz-clean');
  const UNKNOWN = () => css('--viz-unknown');
  const GRID = () => css('--line');
  const INK = () => css('--text-dim');
  const SURFACE = () => css('--bg');

  const NS = 'http://www.w3.org/2000/svg';
  const el = (name, attrs = {}) => {
    const n = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };

  const fmtDay = d => new Date(`${d}T12:00:00Z`)
    .toLocaleDateString([], { day: 'numeric', month: 'short' });

  /** An empty state that says what it is waiting for, not just that it is empty. */
  function empty(host, message) {
    host.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = message;
    host.append(p);
  }

  // ── Relapses per week ─────────────────────────────────────────────────────

  /**
   * Two series on ONE axis, both in "per week". A 7-day count against a 30-day
   * count would be two scales on one chart — the most common charting mistake —
   * so the 30-day window is expressed per week and the comparison is honest:
   * one is the noisy read, the other the smoothed one.
   *
   * Nulls are gaps, never zeroes. A window that does not fit inside recorded
   * history has no value, and drawing it along the floor would assert "no
   * relapses" for every day before tracking began.
   *
   * Where the trailing week was barely logged, the line is drawn faded: the
   * count is real but it is a floor, not a measurement, and a confident solid
   * line through an unlogged week reads as a good week.
   */
  function rolling(host, data, { coverageFloor = 0.5 } = {}) {
    host.innerHTML = '';
    const drawn = data.filter(d => d.per_week_7d != null);
    if (!drawn.length) {
      return empty(host, 'A weekly rate needs seven days of history behind it. Keep logging.');
    }

    const W = 320, H = 132, P = { t: 10, r: 10, b: 20, l: 24 };
    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    const max = Math.max(2, ...data.map(d => Math.max(d.per_week_7d ?? 0, d.per_week_30d ?? 0)));

    const svg = el('svg', {
      viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img',
      'aria-label': `Relapses per week, ${data[0].day} to ${data[data.length - 1].day}`,
    });

    const x = i => P.l + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
    const y = v => P.t + ih - (v / max) * ih;

    // Hairline, solid, recessive — never dashed.
    const step = Math.max(1, Math.ceil(max / 3));
    for (let g = 0; g <= max; g += step) {
      svg.append(el('line', { x1: P.l, y1: y(g), x2: W - P.r, y2: y(g), stroke: GRID(), 'stroke-width': 1 }));
      const t = el('text', { x: P.l - 6, y: y(g) + 3, fill: INK(), 'font-size': 8, 'text-anchor': 'end' });
      t.textContent = g;
      svg.append(t);
    }

    /** Split into runs of consecutive non-null points, so gaps stay gaps. */
    const runs = (key, filter = () => true) => {
      const out = [];
      let cur = [];
      data.forEach((d, i) => {
        if (d[key] == null || !filter(d)) {
          if (cur.length) out.push(cur);
          cur = [];
        } else {
          cur.push({ i, v: d[key] });
        }
      });
      if (cur.length) out.push(cur);
      return out;
    };
    const path = pts => pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i)},${y(p.v)}`).join(' ');

    const draw = (pts, stroke, opacity = 1) => {
      if (pts.length < 2) {
        if (pts.length === 1) {
          svg.append(el('circle', { cx: x(pts[0].i), cy: y(pts[0].v), r: 2, fill: stroke, opacity }));
        }
        return;
      }
      svg.append(el('path', {
        d: path(pts), fill: 'none', stroke, 'stroke-width': 2, opacity,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      }));
    };

    // The smoothed series sits underneath, so the noisy one reads on top of it.
    for (const r of runs('per_week_30d')) draw(r, CLEAN());

    // Well-logged stretches solid; thin ones faded, so a zero from not logging
    // does not look like a zero from not slipping.
    const wellLogged = d => (d.coverage_7d ?? 0) >= coverageFloor;
    for (const r of runs('per_week_7d', d => !wellLogged(d))) draw(r, SLIP(), 0.35);
    for (const r of runs('per_week_7d', wellLogged)) draw(r, SLIP());

    const last = drawn[drawn.length - 1];
    const lastIdx = data.indexOf(last);
    svg.append(el('circle', {
      cx: x(lastIdx), cy: y(last.per_week_7d), r: 4, fill: SLIP(),
      stroke: SURFACE(), 'stroke-width': 2, opacity: wellLogged(last) ? 1 : 0.35,
    }));

    for (const [i, anchor] of [[0, 'start'], [data.length - 1, 'end']]) {
      const t = el('text', { x: x(i), y: H - 6, fill: INK(), 'font-size': 8, 'text-anchor': anchor });
      t.textContent = fmtDay(data[i].day);
      svg.append(t);
    }

    host.append(svg);

    const hasSmooth = data.some(d => d.per_week_30d != null);
    const thin = data.some(d => d.per_week_7d != null && !wellLogged(d));
    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    legend.innerHTML =
      `<span><i style="background:${SLIP()}"></i>per week</span>` +
      (hasSmooth
        ? `<span><i style="background:${CLEAN()}"></i>30-day average</span>`
        : `<span class="chart-note">30-day average needs 30 days of history</span>`);
    host.append(legend);

    if (thin) {
      const note = document.createElement('p');
      note.className = 'chart-note';
      note.textContent = 'Faded stretches are weeks with little logged — a low count there may just be a gap in the record.';
      host.append(note);
    }
  }

  // ── Day ribbon ────────────────────────────────────────────────────────────

  /**
   * One cell per day. "No data" is its own state — a day with nothing logged is
   * not a day nothing happened, and colouring it as clean would present a gap in
   * the record as a run of good days.
   */
  function ribbon(host, days) {
    host.innerHTML = '';
    if (!days.length) return empty(host, 'Nothing logged yet.');

    const grid = document.createElement('div');
    grid.className = 'ribbon';
    for (const d of days) {
      const cell = document.createElement('span');
      // More slips is darker — sequential within one hue, never a second colour,
      // so the ramp reads as "more of the same thing" rather than a new state.
      const heavy = d.count > 1 ? ` ribbon-multi${Math.min(d.count, 3)}` : '';
      cell.className = `ribbon-cell ribbon-${d.state}${heavy}`;
      cell.title = d.state === 'pad' ? '' : `${fmtDay(d.day)} — ${
        d.count > 1 ? `${d.count} slips`
          : d.state === 'relapse' ? 'slip'
          : d.state === 'clean' ? 'logged, no slip' : 'nothing logged'
      }${d.confirmed ? ', day confirmed' : ''}`;
      if (d.confirmed) cell.classList.add('ribbon-confirmed');
      grid.append(cell);
    }
    host.append(grid);

    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    legend.innerHTML =
      `<span><i style="background:${SLIP()}"></i>slip</span>` +
      `<span><i class="swatch-multi"></i>more than one</span>` +
      `<span><i style="background:${CLEAN()}"></i>logged, no slip</span>` +
      `<span><i style="background:${UNKNOWN()}"></i>nothing logged</span>`;
    host.append(legend);
  }

  return { rolling, ribbon };
})();
