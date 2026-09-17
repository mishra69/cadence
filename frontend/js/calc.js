// Client-side logic with no DOM in it.
//
// Everything here decides *what* a control should say or show; the render
// functions in app.js and charts.js decide how to draw it. The split is not
// tidiness — it is the difference between logic a test can reach and logic that
// can only be checked by looking at a phone.
//
// Every UI bug this project has had falls into one of two buckets. The ones that
// were judgements — a colour ramp escalating the wrong way, a chart too sparse
// to read — no test would have caught, and none is attempted. The ones that were
// arithmetic — a clamp, a day boundary, an index — are all in this file.
//
// Deliberately a plain script that assigns one global, exactly like every other
// file in this directory: the page loads it with a `?v=` stamp and the service
// worker precaches it by that URL. A module would import its neighbours
// relatively, and a relative import cannot carry the version query (see the
// note on webpush-edge in deploy.conf). Tests reach it through
// test/helpers/frontend.js rather than by importing it.
var Calc = (function () {
  'use strict';

  var DAY_MS = 86400000;
  var HOUR_MS = 3600000;

  /**
   * The logical day an instant belongs to, as a local Date at midday.
   *
   * Shifts the **wall clock**, not the instant. `ts - 4h` is a day out for an
   * 04:00–05:00 event on the spring-forward DST date, which is the same
   * correction PLAN.md §3 records for the server's derive(). The two must agree:
   * anywhere this disagrees with the server, the app promises a day and the
   * database records a different one.
   */
  function logicalDate(ts, boundaryHour) {
    var d = new Date(ts);
    if (d.getHours() < boundaryHour) d.setDate(d.getDate() - 1);
    d.setHours(12, 0, 0, 0);
    return d;
  }

  /** Whether two instants fall on the same logical day. */
  function sameLogicalDay(a, b, boundaryHour) {
    return logicalDate(a, boundaryHour).getTime() === logicalDate(b, boundaryHour).getTime();
  }

  /**
   * State of the "when did it happen" stepper on the relapse log.
   *
   * `flipped` is the reason the control exists: before the day boundary an event
   * belongs to the *previous* logical day, so a 1am relapse logged at 09:15 is
   * filed a whole day late unless the stepper says so before it is saved.
   *
   * Clamped to the backfill window because the server rejects anything older
   * (worker/lib/events.js), and a client that can build a rejected event is a
   * client that will eventually build one.
   */
  function hourPick(opts) {
    var hoursAgo = opts.hoursAgo;
    var now = opts.now;
    var boundaryHour = opts.boundaryHour;
    var maxBack = opts.backfillDays * 24;

    var clamped = Math.max(0, Math.min(maxBack, hoursAgo));
    var ts = now - clamped * HOUR_MS;
    return {
      hoursAgo: clamped,
      ts: ts,
      canBack: clamped < maxBack,
      canFwd: clamped > 0,
      flipped: !sameLogicalDay(ts, now, boundaryHour),
      logicalDate: logicalDate(ts, boundaryHour),
    };
  }

  /** Clamp a step without letting it leave the window. */
  function stepHoursAgo(hoursAgo, by, backfillDays) {
    return Math.max(0, Math.min(backfillDays * 24, hoursAgo + by));
  }

  /**
   * State of the streak tumbler.
   *
   * Anchored to the last relapse rather than to the logical day, because that is
   * what the streak itself counts — streakDays is elapsed time, not a count of
   * calendar days (§3), so a fill tied to the day boundary would empty at a
   * different moment than the number above it increments.
   *
   * Hidden for the first four hours after a relapse: an empty glass beside a
   * full "24h 0m" is the least useful the thing ever looks, and those are the
   * hours it would be looked at hardest. Measured from the relapse and not from
   * the current cycle — the glass also empties at every daily tick, but that
   * emptying is a day earned rather than a day lost.
   */
  var SETTLE_MS = 4 * HOUR_MS;

  function tumblerState(lastRelapseTs, now) {
    if (lastRelapseTs == null) return { visible: false };

    var elapsed = Math.max(0, now - lastRelapseTs);
    if (elapsed < SETTLE_MS) return { visible: false };

    var into = elapsed % DAY_MS;
    var left = DAY_MS - into;
    return {
      visible: true,
      fill: into / DAY_MS,
      value: remainingLabel(left),
      label: 'to day ' + (Math.floor(elapsed / DAY_MS) + 1),
    };
  }

  /** "9h 12m", or "12m" inside the last hour. Never "0h 12m". */
  function remainingLabel(ms) {
    var hours = Math.floor(ms / HOUR_MS);
    var mins = Math.floor((ms % HOUR_MS) / 60000);
    return hours ? hours + 'h ' + mins + 'm' : mins + 'm';
  }

  /**
   * Which data point a scrub at `clientX` is nearest.
   *
   * Works in viewBox units rather than client pixels: the SVG scales to its
   * container, so the ratio is the only thing that survives the crossing.
   * Reading offsetX instead would be wrong by exactly that scale factor.
   */
  function scrubIndex(opts) {
    var count = opts.count;
    if (count <= 1) return 0;
    var vx = ((opts.clientX - opts.boxLeft) / opts.boxWidth) * opts.viewWidth;
    var t = ((vx - opts.padLeft) / opts.innerWidth) * (count - 1);
    return Math.max(0, Math.min(count - 1, Math.round(t)));
  }

  /**
   * What a ribbon day says, as plain words.
   *
   * The hover title and the scrub pill format it differently but must never
   * word it differently — two spellings of "nothing logged" is how they end up
   * disagreeing about what the grey means.
   */
  function dayWords(d) {
    return {
      what: d.count > 1 ? d.count + ' slips'
        : d.state === 'relapse' ? 'slip'
        : d.state === 'clean' ? 'logged, no slip'
        : 'nothing logged',
      // A slip is the thing being looked for, so it carries the weight; the grey
      // is de-emphasised for the same reason it is grey in the grid.
      emphasis: d.count > 1 || d.state === 'relapse' ? 'strong'
        : d.state === 'clean' ? 'plain' : 'dim',
      confirmed: !!d.confirmed,
    };
  }

  var ACTIONS = ['urge', 'relapse', 'sweep', 'morning'];

  /**
   * The action and notification id carried by a notification's deep link.
   *
   * Reached two ways, which is why it lives here rather than beside either of
   * them: a cold open parses `location.href`, and a tap on an app that is
   * already running parses a URL the service worker posts in, because Safari
   * does not implement WindowClient.navigate(). Both must agree, and an
   * unrecognised action must come back null rather than be handed to a router
   * that will silently do nothing with it.
   */
  function readAction(href, origin) {
    var params = new URL(href, origin).searchParams;
    var action = params.get('action');
    return {
      action: ACTIONS.indexOf(action) === -1 ? null : action,
      notificationId: params.get('n'),
    };
  }

  /**
   * Whether a filed notification tap is too old to act on.
   *
   * A tap the service worker filed is collected when the page next becomes
   * visible, which is usually seconds later but is not guaranteed to be — if
   * the tap failed to raise the app at all, the entry waits for the next
   * launch. That wait is wanted up to a point and unwanted past it, and the
   * point is a judgement; what is testable is that a clock which has gone
   * backwards reads as fresh rather than as impossibly stale.
   */
  function inboxIsStale(filedAt, now, ttlMs) {
    if (filedAt == null) return true;
    return now - filedAt > ttlMs;
  }

  /**
   * How long the app may sit in the background before the lock re-arms.
   *
   * `stored` is the raw localStorage string, so every value it can hold has to
   * be answered for: absent (never set), a number, the -1 sentinel meaning
   * "when I close the app", and junk.
   *
   * The sentinel becomes Infinity so the caller's `away > relockAfter(...)`
   * comparison needs no special case — nothing exceeds Infinity, so resuming
   * never locks. It does not disable the lock: a fresh load locks regardless,
   * which is the property that makes offering this safe at all.
   *
   * Junk fails closed at 0. Locking sooner than asked is a nuisance; failing
   * open is the single outcome the lock exists to prevent.
   */
  function relockAfter(stored, fallbackSeconds) {
    if (stored == null) return fallbackSeconds;
    var n = Number(stored);
    // Order matters: anything unreadable is rejected *before* the sentinel is
    // considered, so a stored '-Infinity' fails closed rather than being taken
    // for a negative and granted the never-lock behaviour.
    if (stored === '' || !Number.isFinite(n)) return 0;
    if (n < 0) return Infinity;
    return n;
  }

  return {
    DAY_MS: DAY_MS,
    ACTIONS: ACTIONS,
    readAction: readAction,
    inboxIsStale: inboxIsStale,
    relockAfter: relockAfter,
    HOUR_MS: HOUR_MS,
    SETTLE_MS: SETTLE_MS,
    logicalDate: logicalDate,
    sameLogicalDay: sameLogicalDay,
    hourPick: hourPick,
    stepHoursAgo: stepHoursAgo,
    tumblerState: tumblerState,
    remainingLabel: remainingLabel,
    scrubIndex: scrubIndex,
    dayWords: dayWords,
  };
})();
