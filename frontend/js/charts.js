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

  // ── Scrub ─────────────────────────────────────────────────────────────────

  /**
   * A plot wrapper plus the tooltip that rides over it.
   *
   * The pill tracks x and stays pinned to the top. Anchoring it to the point's
   * y instead would put it on top of the series at exactly the moment the
   * series is being read, and make it leap around as the line does.
   *
   * Clamped to the wrapper on both edges: at the ends of the range an
   * x-centred pill hangs off the panel, and on a phone that is a horizontal
   * scrollbar rather than a tooltip.
   *
   * aria-live because the visual channel here is entirely positional.
   */
  function plot(host) {
    const wrap = document.createElement('div');
    wrap.className = 'chart-plot';
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.setAttribute('aria-live', 'polite');
    wrap.append(tip);
    host.append(wrap);

    let hintEl = null;
    return {
      wrap,
      /** @param {string} html  @param {number} cx  centre, in px within wrap */
      show(html, cx) {
        tip.innerHTML = html;
        tip.classList.add('is-on');
        // Measured after the content is in, or the clamp uses the old width.
        const half = tip.offsetWidth / 2;
        const max = wrap.clientWidth - tip.offsetWidth;
        tip.style.left = `${Math.max(0, Math.min(max, cx - half))}px`;
        hintEl?.remove();
        hintEl = null;
      },
      hint(text) {
        hintEl = document.createElement('p');
        hintEl.className = 'chart-hint';
        hintEl.textContent = text;
        host.append(hintEl);
      },
    };
  }

  /**
   * Pointer-drag scrubbing on one element.
   *
   * Pointer events rather than touch events, so the same handler serves a mouse
   * without a second code path. Capture is taken on the target, which is what
   * keeps the drag alive once the finger leaves the plot — otherwise sliding
   * off the right edge silently ends the gesture mid-read.
   *
   * There is no release handler on purpose. The value stays on screen after the
   * finger lifts, because lifting the finger is precisely when it becomes
   * readable — clearing on pointerup would hide the number the gesture was for.
   */
  function scrub(target, onPoint) {
    const handle = e => {
      // A drag that started on the plot is a read, never a page scroll.
      e.preventDefault();
      onPoint(e.clientX, e.clientY);
    };
    target.addEventListener('pointerdown', e => {
      // Capture can fail if the pointer is already gone; the scrub still works
      // for as long as the finger stays over the element, so this is not fatal.
      try { target.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
      handle(e);
    });
    // Ungated: a touch pointer only emits moves while it is down, so this is a
    // drag on a phone and hover-to-read on a desktop, from one handler.
    target.addEventListener('pointermove', handle);
  }

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
      class: 'chart-scrub',
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

    // ── Scrub overlay ───────────────────────────────────────────────────────
    // Appended last so it paints over the series. Hidden until first touch:
    // a rule parked at day zero looks like a marked date rather than a cursor.
    const rule = el('line', {
      y1: P.t, y2: P.t + ih, stroke: INK(), 'stroke-width': 1, opacity: 0, x1: 0, x2: 0,
    });
    const dot = k => el('circle', { r: 3.5, fill: k, stroke: SURFACE(), 'stroke-width': 1.5, opacity: 0 });
    const dot7 = dot(SLIP());
    const dot30 = dot(CLEAN());
    svg.append(rule, dot30, dot7);

    const p = plot(host);
    p.wrap.append(svg);

    const fmt1 = v => (Math.round(v * 10) / 10).toFixed(1);
    const place = (node, i, v) => {
      if (v == null) return node.setAttribute('opacity', 0);
      node.setAttribute('cx', x(i));
      node.setAttribute('cy', y(v));
      node.setAttribute('opacity', 1);
    };

    scrub(svg, clientX => {
      const box = svg.getBoundingClientRect();
      if (!box.width) return;
      // Client px → viewBox units. The SVG scales to the container width, so the
      // ratio is the only thing that carries across; reading offsetX would be
      // wrong by exactly that scale factor.
      const vx = ((clientX - box.left) / box.width) * W;
      const t = data.length === 1 ? 0 : ((vx - P.l) / iw) * (data.length - 1);
      const i = Math.max(0, Math.min(data.length - 1, Math.round(t)));
      const d = data[i];

      rule.setAttribute('x1', x(i));
      rule.setAttribute('x2', x(i));
      rule.setAttribute('opacity', 0.5);
      place(dot7, i, d.per_week_7d);
      place(dot30, i, d.per_week_30d);

      // Nulls are gaps here too: a day whose window predates the record has no
      // rate, and printing 0.0 would assert the thing the gaps exist to avoid.
      const parts = [];
      if (d.per_week_7d == null) {
        parts.push('<span class="ro-dim">not enough history yet</span>');
      } else {
        parts.push(`${fmt1(d.per_week_7d)}<span class="ro-dim">/wk</span>`);
        if (d.per_week_30d != null) {
          parts.push(`<span class="ro-dim">30-day</span> ${fmt1(d.per_week_30d)}`);
        }
        if (!wellLogged(d)) parts.push('<span class="ro-dim">· thin</span>');
      }
      // Value first, date under it — the value is what the gesture is for, and
      // the date is how you confirm you landed on the right day.
      p.show(`${parts.join(' ')}<br><span class="ro-dim">${fmtDay(d.day)}</span>`,
             (x(i) / W) * box.width);
    });

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

    p.hint('Drag across the chart to read a day.');
  }

  // ── Day ribbon ────────────────────────────────────────────────────────────

  /**
   * One cell per day. "No data" is its own state — a day with nothing logged is
   * not a day nothing happened, and colouring it as clean would present a gap in
   * the record as a run of good days.
   */
  /**
   * What a day says, as plain words. The hover title and the scrub pill format
   * it differently but must never word it differently — two spellings of
   * "nothing logged" is how they end up disagreeing about what the grey means.
   */
  function cellWords(d) {
    return {
      what: d.count > 1 ? `${d.count} slips`
        : d.state === 'relapse' ? 'slip'
        : d.state === 'clean' ? 'logged, no slip'
        : 'nothing logged',
      // A slip is the thing being looked for, so it carries the weight; the
      // grey is de-emphasised for the same reason it is grey in the grid.
      emphasis: d.count > 1 || d.state === 'relapse' ? 'b'
        : d.state === 'clean' ? null : 'dim',
      confirmed: !!d.confirmed,
    };
  }

  const cellTitle = d => {
    const w = cellWords(d);
    return `${fmtDay(d.day)} — ${w.what}${w.confirmed ? ', day confirmed' : ''}`;
  };

  const cellTip = d => {
    const w = cellWords(d);
    const what = w.emphasis === 'b' ? `<b>${w.what}</b>`
      : w.emphasis === 'dim' ? `<span class="ro-dim">${w.what}</span>`
      : w.what;
    return `${what}${w.confirmed ? ' <span class="ro-dim">· confirmed</span>' : ''}` +
      `<br><span class="ro-dim">${fmtDay(d.day)}</span>`;
  };

  function ribbon(host, days) {
    host.innerHTML = '';
    if (!days.length) return empty(host, 'Nothing logged yet.');

    const p = plot(host);
    const grid = document.createElement('div');
    grid.className = 'ribbon';
    for (const d of days) {
      const cell = document.createElement('span');
      // More slips is lighter — sequential within one hue, never a second
      // colour, so the ramp reads as "more of the same thing" rather than a new
      // state. Lighter and not darker because the surface is dark; see the
      // --viz-slip-2 note in styles.css.
      const heavy = d.count > 1 ? ` ribbon-multi${Math.min(d.count, 3)}` : '';
      cell.className = `ribbon-cell ribbon-${d.state}${heavy}`;
      if (d.state !== 'pad') {
        cell.title = cellTitle(d);
        // The scrub hit-tests the DOM, so the day rides on the node rather than
        // being recovered from grid arithmetic that would have to stay in sync
        // with the CSS.
        cell._day = d;
      }
      if (d.confirmed) cell.classList.add('ribbon-confirmed');
      grid.append(cell);
    }
    p.wrap.append(grid);

    let focused = null;
    scrub(grid, (clientX, clientY) => {
      const hit = document.elementFromPoint(clientX, clientY);
      // Off the grid, or on a pad cell: hold the last reading rather than
      // blanking it. Dragging past the end of a week should not wipe the value
      // you were reading on the way there.
      const cell = hit && hit.classList?.contains('ribbon-cell') && hit._day ? hit : null;
      if (!cell || cell === focused) return;
      focused?.classList.remove('is-focus');
      cell.classList.add('is-focus');
      focused = cell;

      // Anchored to the cell's centre within the wrapper, not the viewport.
      const box = cell.getBoundingClientRect();
      const wrapBox = p.wrap.getBoundingClientRect();
      p.show(cellTip(cell._day), box.left - wrapBox.left + box.width / 2);
    });

    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    legend.innerHTML =
      `<span><i style="background:${SLIP()}"></i>slip</span>` +
      `<span><i class="swatch-multi"></i>more than one</span>` +
      `<span><i style="background:${CLEAN()}"></i>logged, no slip</span>` +
      `<span><i style="background:${UNKNOWN()}"></i>nothing logged</span>`;
    host.append(legend);

    p.hint('Drag across the grid to read a day.');
  }

  return { rolling, ribbon };
})();
