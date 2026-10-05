// Builds the text handed to an outside chatbot.
//
// Why a share rather than an API call: a Claude or ChatGPT subscription does
// not include API access — they are billed separately — so using what is
// already paid for means handing off to the app, not calling the endpoint.
//
// Two things this file is careful about:
//
// 1. **Tone.** A generic assistant defaults to "you've got this!", which is the
//    register §0 rejects outright: shame is itself a relapse trigger, and
//    cheerleading is the same axis pointed the other way. The prompt states the
//    constraints explicitly rather than hoping.
//
// 2. **Naming.** §0 says the word for the behaviour should not appear outside
//    the app's locked interior, and a shared file lands permanently in another
//    app's history. So the default carries all the *data* and none of the
//    subject. `term` opts into naming it; it is never stored server-side.
import { BUCKETS } from './time.js';
import { DAY_MS, HOUR_MS } from './time.js';

/**
 * Below this an attempt is described in hours, at or above it in whole days.
 *
 * MUST match HOURS_BELOW_MS in frontend/js/calc.js, which applies the same rule
 * to the stats row. The reasoning for two days is written out there. Same
 * duplication as derive()/logicalDate, and the same discipline: a test in each
 * suite pins the boundary so the two cannot drift apart silently.
 */
const HOURS_BELOW_MS = 2 * DAY_MS;

/** "47 hours" / "6 days" — floored in both units, never rounded up. */
function attemptPhrase(ms, fallbackDays) {
  if (ms == null || !Number.isFinite(ms)) return plural(fallbackDays, 'day');
  const safe = Math.max(0, ms);
  return safe < HOURS_BELOW_MS
    ? plural(Math.floor(safe / HOUR_MS), 'hour')
    : plural(Math.floor(safe / DAY_MS), 'day');
}

/** "1 day", "2 days" — the summary is prose, and read by a model as prose. */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const BUCKET_LABEL = {
  morning: 'morning', afternoon: 'afternoon', evening: 'evening', late: 'late night',
};

const TAG_LABEL = {
  alone: 'alone', in_bed: 'in bed', phone: 'on my phone',
  tired: 'tired', bored: 'bored', stressed: 'stressed',
  porn: 'porn', imagination: 'imagination',
};

// Recorded on urges as well as relapses, so these carry a real contrast rather
// than a tautology and belong in riskTags() like any other tag. Still counted
// separately below, because the raw split is worth stating outright.
const MODE = ['porn', 'imagination'];

/** Tally a list of events into bucket and tag frequencies. */
function distribution(events) {
  const buckets = Object.fromEntries(BUCKETS.map(b => [b, 0]));
  const tags = {};
  for (const e of events) {
    if (e.bucket in buckets) buckets[e.bucket]++;
    for (const t of e.context || []) tags[t] = (tags[t] || 0) + 1;
  }
  return { buckets, tags, total: events.length };
}

/** Tags over-represented in relapses relative to urges — the §7 contrast. */
function riskTags(urges, relapses) {
  if (!urges.length || !relapses.length) return [];
  const u = distribution(urges);
  const r = distribution(relapses);
  return Object.keys(r.tags)
    .map(t => ({
      tag: t,
      lift: (r.tags[t] / r.total) - ((u.tags[t] || 0) / u.total),
    }))
    .filter(x => x.lift > 0.1)
    .sort((a, b) => b.lift - a.lift)
    .slice(0, 3)
    .map(x => TAG_LABEL[x.tag] || x.tag);
}

function pct(n, total) { return total ? Math.round((n / total) * 100) : 0; }

/**
 * @param {object} opts
 * @param {'now'|'reflect'} opts.mode
 * @param {object} opts.stats          from getStats()
 * @param {object[]} opts.events       recent events, newest first
 * @param {string|null} opts.term      what to call it, or null to stay neutral
 * @param {boolean} opts.includeNotes  notes may name the behaviour, so they
 *                                     ride with the explicit setting
 */
export function buildContext({ mode, stats, events, term = null, includeNotes = false, now = Date.now() }) {
  const subject = term || 'a habit I\'m working on';
  const urges = events.filter(e => e.kind === 'urge');
  const relapses = events.filter(e => e.kind === 'relapse');
  const dist = distribution(urges);

  const lines = [];

  // ── The instructions ──
  lines.push(
    `I want to talk through something. Below is data from an app I use to track ${subject}.`,
    '',
    // The text may be pasted into an existing chat rather than a new one, and
    // there is no way to know which from here — so this is phrased to be true
    // either way. A fresh conversation simply has nothing to carry over.
    // Saying the figures *replace* the old ones matters most: on a second paste
    // the assistant otherwise has two sets of numbers and no ordering.
    'If we have talked about this earlier in this conversation, keep everything I',
    'told you then — same situation, just refreshed. The figures below replace any',
    'you already have.',
    '',
    'How I want you to respond:',
    '- Curious and matter-of-fact. Not disappointed, not congratulatory.',
    '- No cheerleading and no pep talk. "You\'ve got this" is not useful to me.',
    '- Shame makes this worse, not better, so please avoid any framing where I have',
    '  something to feel bad about or a streak I might "throw away".',
    '- Refer to the data, not to my character. "Four of five late-night urges this',
    '  week" rather than "you\'re doing well".',
    '- Ask me questions before offering advice. You have numbers; you don\'t have',
    '  the context behind them.',
  );

  if (mode === 'now') {
    lines.push(
      '',
      'Right now: I\'m in a difficult moment, not reflecting calmly. Keep your first',
      'reply short. Help me think, and don\'t give me a long read.',
    );
  } else {
    lines.push(
      '',
      'Right now: I\'m reflecting, not in a difficult moment. Take your time.',
    );
  }

  // ── The data ──
  lines.push('', '---', '', 'Where things stand:');

  if (stats.streak_days != null) {
    let line = `- ${attemptPhrase(stats.streak_ms, stats.streak_days)} since the last slip`;
    if (stats.confidence?.unverified) {
      // Names its own unit rather than saying "6 of them". "Them" used to be
      // unambiguous when the streak was always in days; now the sentence can
      // open with "47 hours", and "6 of them" would silently mean six hours.
      line += ` (unconfirmed for ${plural(stats.confidence.unverified_days, 'day')}` +
        ` — I wasn't logging)`;
    }
    lines.push(line);
  } else if (stats.has_data) {
    lines.push(`- Tracking for ${plural(stats.days_tracked, 'day')}; no slip logged yet`);
  }

  if (stats.best_days != null) {
    lines.push(`- Longest stretch so far: ${attemptPhrase(stats.best_ms, stats.best_days)}`);
  }
  if (stats.median_attempt_days != null) {
    lines.push(`- Typical stretch: ${attemptPhrase(stats.median_attempt_ms, stats.median_attempt_days)}` +
      ` (across ${plural(stats.attempt_count, 'attempt')})`);
  }
  lines.push(`- Last 30 days: ${stats.relapses_30d} slips, ${stats.urges_30d} urges logged`);
  // Said in its own line and in neutral words: a release is not the habit, so
  // it is not a slip and moves none of the figures above — but a chatbot reading
  // a long gap should know it was not all willpower. Nothing finer than the
  // word goes out, whatever tags were recorded.
  if (stats.releases_30d) {
    lines.push(`- Also ${plural(stats.releases_30d, 'release')} in the last 30 days that are not the habit` +
      ` itself, so not counted as slips — but they may account for some of the longer gaps.`);
  }

  if (dist.total) {
    const busiest = BUCKETS
      .map(b => ({ b, n: dist.buckets[b] }))
      .sort((a, b) => b.n - a.n)[0];
    lines.push(
      '',
      'When urges show up:',
      ...BUCKETS
        .filter(b => dist.buckets[b] > 0)
        .map(b => `- ${BUCKET_LABEL[b]}: ${dist.buckets[b]} (${pct(dist.buckets[b], dist.total)}%)`),
    );
    if (busiest.n / dist.total > 0.4) {
      lines.push(`The ${BUCKET_LABEL[busiest.b]} cluster is the obvious one.`);
    }
  }

  // What was involved, counted over the slips that were actually *asked*.
  //
  // This became a required field partway through, so earlier slips carry no
  // mode tag at all. Counting those in the denominator would report "2 of 10"
  // when eight of the ten were never asked — an understatement that looks like
  // a finding. No "mandatory since" date is needed to fix it: an answered slip
  // is one carrying at least one mode tag, which the requirement guarantees
  // from here on, so the data says for itself which side of the change it is on.
  const modeAnswered = relapses.filter(r => MODE.some(t => (r.context || []).includes(t)));
  if (modeAnswered.length) {
    const counts = MODE.map(t => ({
      t, n: modeAnswered.filter(r => (r.context || []).includes(t)).length,
    })).filter(x => x.n > 0);
    if (counts.length) {
      const caveat = modeAnswered.length < relapses.length
        ? ` (the other ${relapses.length - modeAnswered.length} predate my recording this)`
        : '';
      lines.push('', `Of ${modeAnswered.length} slips where I noted what was involved${caveat}: ${
        counts.map(c => `${c.n} involved ${TAG_LABEL[c.t]}`).join(', ')}.`);
    }
  }

  const risky = riskTags(urges, relapses);
  if (risky.length) {
    lines.push(
      '',
      `What tends to be true when I slip, more than when I just get an urge: ${risky.join(', ')}.`,
    );
  }

  // Satisfaction against the gap it ended — the thing that field exists for.
  const rated = relapses.filter(r => r.satisfaction != null);
  if (rated.length >= 2) {
    const sorted = [...relapses].sort((a, b) => a.ts_utc - b.ts_utc);
    const pairs = [];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].satisfaction == null) continue;
      pairs.push({
        gap: Math.round((sorted[i].ts_utc - sorted[i - 1].ts_utc) / DAY_MS),
        sat: sorted[i].satisfaction,
      });
    }
    if (pairs.length) {
      lines.push(
        '',
        'Afterwards, rated 0–5 for whether it felt worth it, against how long the',
        'stretch before it was:',
        ...pairs.slice(-6).map(p => `- after ${p.gap} days: ${p.sat}/5`),
      );
    }
  }

  // 0 none · 1 yes (legacy) · 2 mild · 3 strong · 4 don't recall. Only the first
  // four are a rate; a "don't recall" is an answer about memory, not about the
  // morning, and folding it in either direction would invent a trend.
  //
  // Found by the field rather than by the kind: readings live on `morning_check`
  // now and on `daily` for rows written before the two were separated, and an
  // answered morning is an answered morning whichever screen recorded it.
  const recalled_mornings = events.filter(
    e => e.morning_wood != null && e.morning_wood <= 3);
  if (recalled_mornings.length >= 3) {
    const present = recalled_mornings.filter(e => e.morning_wood > 0);
    lines.push('', `Morning erections: ${present.length} of the last ${recalled_mornings.length} mornings I could remember.`);

    // The split is only mentioned where it was actually asked. Rows carrying the
    // legacy 1 predate the question, and counting them as either strength would
    // manufacture the distinction rather than report it.
    const strong = present.filter(e => e.morning_wood === 3).length;
    const mild = present.filter(e => e.morning_wood === 2).length;
    if (strong || mild) lines.push(`Of those: ${strong} strong, ${mild} mild.`);
  }

  if (includeNotes) {
    const notes = events.filter(e => e.note).slice(0, 8);
    if (notes.length) {
      lines.push('', 'Notes I wrote at the time:',
        ...notes.map(e => `- ${new Date(e.ts_utc).toISOString().slice(0, 10)}: ${e.note}`));
    }
  }

  lines.push('', '---', '', mode === 'now'
    ? 'That\'s the picture. I\'d like to talk about what\'s going on for me right now.'
    : 'That\'s the picture. I\'d like to think about what\'s going on and what to try next.');

  return lines.join('\n');
}
