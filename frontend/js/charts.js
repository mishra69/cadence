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

  // "release" / "2 releases" — one wording wherever a release is mentioned.
  const releasesWord = n => (n === 1 ? 'release' : `${n} releases`);

  const fmtDay = d => new Date(`${d}T12:00:00Z`)
    .toLocaleDateString([], { day: 'numeric', month: 'short' });

  // Ties a number in the tooltip to the series it came from. With two series
  // the pill reads "4.0/wk 4.9 4-week" and nothing says which dot is which —
  // on the plot the colour is the only thing that distinguishes them, so the
  // tooltip has to carry it too.
  //
  // A swatch rather than colouring the number: these are 3:1 graphical colours,
  // which is the right bar for a mark and well under it for 12.5px text.
  const swatch = c => `<i class="ro-sw" style="background:${c}"></i>`;
  const SEP = '<span class="ro-sep"></span>';

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
   * Two series on ONE axis, both in "per week". A 7-day count against a 28-day
   * count would be two scales on one chart — the most common charting mistake —
   * so the long window is divided by 4 and the comparison is honest: one is the
   * noisy read, the other the smoothed one.
   *
   * 28 days rather than 30 because 28 is exactly four weeks. See the note in
   * worker/lib/series.js for why a window that is not a whole number of weeks
   * puts a 7-day ripple into the line that exists to be the steady one.
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
    const max = Math.max(2, ...data.map(d => Math.max(d.per_week_7d ?? 0, d.per_week_28d ?? 0)));

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
    for (const r of runs('per_week_28d')) draw(r, CLEAN());

    // Well-logged stretches solid; thin ones faded, so a zero from not logging
    // does not look like a zero from not slipping.
    const wellLogged = d => (d.coverage_7d ?? 0) >= coverageFloor;
    for (const r of runs('per_week_7d', d => !wellLogged(d))) draw(r, SLIP(), 0.35);
    for (const r of runs('per_week_7d', wellLogged)) draw(r, SLIP());

    // "Where the line ends" — a resting marker, not a reading. It is hidden as
    // soon as a scrub starts: during a drag the two cursor dots are the answer,
    // and a third dot parked at the right edge reads as another data point
    // rather than as the same series' last value.
    const last = drawn[drawn.length - 1];
    const lastIdx = data.indexOf(last);
    const lastDot = el('circle', {
      cx: x(lastIdx), cy: y(last.per_week_7d), r: 4, fill: SLIP(),
      stroke: SURFACE(), 'stroke-width': 2, opacity: wellLogged(last) ? 1 : 0.35,
    });
    svg.append(lastDot);

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
    const dotAvg = dot(CLEAN());
    svg.append(rule, dotAvg, dot7);

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
      const i = Calc.scrubIndex({
        clientX, boxLeft: box.left, boxWidth: box.width,
        viewWidth: W, padLeft: P.l, innerWidth: iw, count: data.length,
      });
      const d = data[i];

      lastDot.setAttribute('opacity', 0);
      rule.setAttribute('x1', x(i));
      rule.setAttribute('x2', x(i));
      rule.setAttribute('opacity', 0.5);
      place(dot7, i, d.per_week_7d);
      place(dotAvg, i, d.per_week_28d);

      // Nulls are gaps here too: a day whose window predates the record has no
      // rate, and printing 0.0 would assert the thing the gaps exist to avoid.
      const parts = [];
      if (d.per_week_7d == null) {
        parts.push('<span class="ro-dim">not enough history yet</span>');
      } else {
        parts.push(`${swatch(SLIP())}${fmt1(d.per_week_7d)}<span class="ro-dim">/wk</span>`);
        if (d.per_week_28d != null) {
          parts.push(`${swatch(CLEAN())}${fmt1(d.per_week_28d)}<span class="ro-dim">&nbsp;4-week</span>`);
        }
        if (!wellLogged(d)) parts.push('<span class="ro-dim">thin</span>');
      }
      // Value first, date under it — the value is what the gesture is for, and
      // the date is how you confirm you landed on the right day.
      p.show(`${parts.join(SEP)}<br><span class="ro-dim">${fmtDay(d.day)}</span>`,
             (x(i) / W) * box.width);
    });

    const hasSmooth = data.some(d => d.per_week_28d != null);
    const thin = data.some(d => d.per_week_7d != null && !wellLogged(d));
    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    legend.innerHTML =
      `<span><i style="background:${SLIP()}"></i>per week</span>` +
      (hasSmooth
        ? `<span><i style="background:${CLEAN()}"></i>4-week average</span>`
        : `<span class="chart-note">4-week average needs 4 weeks of history</span>`);
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
  const cellTitle = d => {
    const w = Calc.dayWords(d);
    return `${fmtDay(d.day)} — ${w.what}${d.releases ? `, ${releasesWord(d.releases)}` : ''}` +
      `${w.confirmed ? ', day confirmed' : ''}`;
  };

  const cellTip = d => {
    const w = Calc.dayWords(d);
    const what = w.emphasis === 'strong' ? `<b>${w.what}</b>`
      : w.emphasis === 'dim' ? `<span class="ro-dim">${w.what}</span>`
      : w.what;
    return `${what}` +
      `${d.releases ? ` <span class="ro-dim">· ${releasesWord(d.releases)}</span>` : ''}` +
      `${w.confirmed ? ' <span class="ro-dim">· confirmed</span>' : ''}` +
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
      // The outline marks today once anything has been recorded on it: the one
      // grey cell that is grey because the day is not over, not because the
      // app was forgotten.
      if (d.in_progress) cell.classList.add('ribbon-today');
      // A shape, not a colour: the colour already answers "used the app, and
      // did I slip", and a release is neither a slip nor anything more than use.
      if (d.releases) cell.classList.add('ribbon-release');
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
      `<span><i style="background:${CLEAN()}"></i>no slip</span>` +
      `<span><i class="swatch-today" style="background:${UNKNOWN()}"></i>today so far</span>` +
      `<span><i style="background:${UNKNOWN()}"></i>nothing logged</span>` +
      // Only when there is one to explain.
      (days.some(d => d.releases) ? `<span><i class="key-release"></i>release</span>` : '');
    host.append(legend);

  }

  // ── Time between relapses ─────────────────────────────────────────────────

  // From the instant, in local time — not via toISOString(), which is a UTC
  // date and labels a 01:00 relapse in India with the day before.
  const fmtTsDay = ts => new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });
  const fmtWhen = ts => new Date(ts).toLocaleString([], {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });

  /**
   * One bar per attempt, oldest on the left, height in hours.
   *
   * The stats row says "typical 31h"; this is the distribution behind that one
   * number. The reference line is the very same median, so the line and the
   * word above it can never disagree.
   *
   * One series, so one colour and no legend box — the title names it. The
   * attempt still running is drawn hollow rather than in a second colour: it is
   * the same kind of thing, just unfinished, and a lower bound that is still
   * growing must not look as settled as a finished one.
   *
   * Gridlines fall on whole days, because the day boundary is the one worth
   * seeing a bar cross. Bars are capped in width and leave a 2px gap, so a long
   * run of short attempts reads as a run of separate events, not a block.
   */
  function gaps(host, { gaps: data = [], typical_ms = null } = {}) {
    host.innerHTML = '';
    // A single bar is a stat tile pretending to be a chart, and the stats row
    // already is that tile.
    if (!data.some(g => !g.in_progress)) {
      return empty(host, 'A gap needs two relapses to measure.');
    }

    const W = 320, H = 132, P = { t: 10, r: 10, b: 20, l: 28 };
    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    const n = data.length;
    const ticks = Calc.gapTicks(Math.max(...data.map(g => g.ms), typical_ms ?? 0));
    const max = ticks[ticks.length - 1];

    const svg = el('svg', {
      viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', class: 'chart-scrub',
      'aria-label': `Time between relapses, ${n} attempts`,
    });
    const y = v => P.t + ih - (v / max) * ih;
    const band = iw / n;
    const bw = Math.max(1, Math.min(20, band - 2));
    const bx = i => P.l + band * i + (band - bw) / 2;

    for (const t of ticks) {
      svg.append(el('line', { x1: P.l, y1: y(t), x2: W - P.r, y2: y(t), stroke: GRID(), 'stroke-width': 1 }));
      const label = el('text', { x: P.l - 5, y: y(t) + 3, fill: INK(), 'font-size': 8, 'text-anchor': 'end' });
      label.textContent = t === 0 ? '0' : Calc.attemptLabel(t);
      svg.append(label);
    }

    /** Rounded at the data end, square at the baseline. */
    const barPath = (x, top, w) => {
      const h = P.t + ih - top;
      const r = Math.min(4, w / 2, h);
      const b = P.t + ih;
      return `M${x},${b} L${x},${top + r} Q${x},${top} ${x + r},${top} ` +
        `L${x + w - r},${top} Q${x + w},${top} ${x + w},${top + r} L${x + w},${b} Z`;
    };

    data.forEach((g, i) => {
      const top = y(g.ms);
      svg.append(el('path', g.in_progress
        ? { d: barPath(bx(i) + 0.75, top + 0.75, bw - 1.5), fill: 'none', stroke: CLEAN(), 'stroke-width': 1.5 }
        : { d: barPath(bx(i), top, bw), fill: CLEAN() }));
    });

    // Releases inside a gap, at the hour they happened. The bar is still one
    // attempt — a release never ends it — but a long bar with these in it was
    // not all willpower, and this is what stops it being read that way. Same
    // ringed dot as the ribbon, so it is recognisably the same thing.
    data.forEach((g, i) => {
      for (const off of g.releases || []) {
        svg.append(el('circle', {
          cx: bx(i) + bw / 2, cy: y(off), r: 2.4,
          fill: SURFACE(), stroke: css('--text'), 'stroke-width': 1.2,
        }));
      }
    });

    if (typical_ms != null) {
      // Solid hairline in ink, never dashed. Its label is in the key below the
      // plot rather than at the line's end: bars run the full width, so any
      // spot on the line can have a bar under it, and a direct label printed
      // over one is worse than a key one glance away.
      svg.append(el('line', {
        x1: P.l, y1: y(typical_ms), x2: W - P.r, y2: y(typical_ms),
        stroke: INK(), 'stroke-width': 1, opacity: 0.8,
      }));
    }

    const firstEnd = data[0].to_ts ?? data[0].from_ts;
    const lastG = data[n - 1];
    for (const [x, anchor, text] of [
      [P.l, 'start', fmtTsDay(firstEnd)],
      [W - P.r, 'end', lastG.in_progress ? 'now' : fmtTsDay(lastG.to_ts)],
    ]) {
      const t = el('text', { x, y: H - 6, fill: INK(), 'font-size': 8, 'text-anchor': anchor });
      t.textContent = text;
      svg.append(t);
    }

    // Outline on the bar being read. Appended last so it sits over everything.
    const focus = el('path', { fill: 'none', stroke: css('--text'), 'stroke-width': 1.5, opacity: 0 });
    svg.append(focus);

    const p = plot(host);
    p.wrap.append(svg);

    scrub(svg, clientX => {
      const box = svg.getBoundingClientRect();
      if (!box.width) return;
      const i = Calc.bandIndex({
        clientX, boxLeft: box.left, boxWidth: box.width,
        viewWidth: W, padLeft: P.l, innerWidth: iw, count: n,
      });
      const g = data[i];
      focus.setAttribute('d', barPath(bx(i) - 1, y(g.ms) - 1, bw + 2));
      focus.setAttribute('opacity', 1);

      const value = `${swatch(CLEAN())}${Calc.preciseSpan(g.ms)}`;
      const when = g.in_progress
        ? `<span class="ro-dim">so far · since ${fmtWhen(g.from_ts)}</span>`
        : `<span class="ro-dim">${fmtWhen(g.from_ts)} → ${fmtWhen(g.to_ts)}</span>`;
      const rel = g.releases?.length
        ? `${SEP}<span class="ro-dim">includes ${g.releases.length === 1 ? 'a release' : releasesWord(g.releases.length)}</span>`
        : '';
      p.show(`${value}${rel}<br>${when}`, ((bx(i) + bw / 2) / W) * box.width);
    });

    // A key for the two non-obvious marks, not a legend box — one series needs
    // none. Same figure the stats row calls typical, said in the same words.
    const key = document.createElement('div');
    key.className = 'chart-legend';
    if (typical_ms != null) {
      key.innerHTML += `<span><i class="key-rule"></i>typical ${Calc.attemptLabel(typical_ms)}</span>`;
    }
    if (data.some(g => g.in_progress)) {
      key.innerHTML += `<span><i class="key-hollow" style="border-color:${CLEAN()}"></i>current, still running</span>`;
    }
    if (data.some(g => g.releases?.length)) {
      key.innerHTML += `<span><i class="key-release"></i>release, not counted as a slip</span>`;
    }
    if (key.innerHTML) host.append(key);
  }

  return { rolling, ribbon, gaps };
})();
