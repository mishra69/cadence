// Time derivation (plan §3). The highest-risk file in the app: get this wrong
// and every chart is subtly wrong forever, with nothing to warn you.
//
// The stored source of truth is always (ts_utc, tz). Everything here is a pure
// function over that pair, so scripts/rebuild-derived.ts can recompute the whole
// table at any time — which is what makes day_boundary_hour a *setting* rather
// than a permanent commitment.
//
// Requires full ICU. Workers ships it; `node` ships it; a stripped build would
// silently fall back to UTC, so assertTimeZoneSupport() checks at boot.

const BOUNDARY_DEFAULT = 4;

// One formatter per (tz, purpose) — Intl.DateTimeFormat construction is by far
// the expensive part, and a nightly sweep derives thousands of rows.
const partsCache = new Map();

function partsFormatter(tz) {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      // h23, not hour12:false — some ICU builds render midnight as "24" under
      // hour12:false, which would put every midnight event in the wrong bucket.
      hourCycle: 'h23',
    });
    partsCache.set(tz, f);
  }
  return f;
}

/**
 * Wall-clock fields for an instant, in a named zone.
 * @returns {{year:number, month:number, day:number, hour:number, minute:number}}
 */
export function localParts(tsUtc, tz) {
  const parts = partsFormatter(tz).formatToParts(new Date(tsUtc));
  const g = {};
  for (const p of parts) if (p.type !== 'literal') g[p.type] = Number(p.value);
  return { year: g.year, month: g.month, day: g.day, hour: g.hour, minute: g.minute };
}

/** 'YYYY-MM-DD' for a calendar date, shifted by `deltaDays`. Pure arithmetic. */
function shiftDate(year, month, day, deltaDays) {
  // Date.UTC does the month/year/leap-year borrowing. Safe here precisely
  // because these are calendar fields, not an instant — no zone is involved.
  const d = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return d.toISOString().slice(0, 10);
}

/**
 * Derive the cached time fields for an event.
 *
 * NOTE — this deliberately differs from the sketch in plan §3, which shifted the
 * *instant* by four hours before formatting. That is off by a day for events in
 * the 04:00–05:00 window on a DST spring-forward date: four elapsed hours before
 * 04:30 PDT is 23:30 PST the previous day, so the shift moves an event that is
 * plainly after the boundary into the previous logical day. Shifting the *wall
 * clock* instead — read the local hour, then borrow a calendar day if it falls
 * before the boundary — is pure date arithmetic and cannot be perturbed by any
 * offset change. §9's spring-forward test is what pins this down.
 *
 * @param {number} tsUtc epoch ms
 * @param {string} tz IANA zone name, e.g. 'Asia/Kolkata'. Never an offset.
 * @param {number} [boundaryHour] local hour at which a logical day starts
 * @returns {{logical_day:string, local_hour:number, bucket:string}}
 */
export function derive(tsUtc, tz, boundaryHour = BOUNDARY_DEFAULT) {
  const { year, month, day, hour } = localParts(tsUtc, tz);
  const logical_day = hour < boundaryHour
    ? shiftDate(year, month, day, -1)
    : shiftDate(year, month, day, 0);
  return { logical_day, local_hour: hour, bucket: bucketFor(hour) };
}

/**
 * Coarse time-of-day bucket. Four of these × 7 weekdays = the 28-cell grid the
 * phase 4 risk model is sized for.
 */
export function bucketFor(localHour) {
  if (localHour < 4) return 'late';
  if (localHour < 12) return 'morning';
  if (localHour < 17) return 'afternoon';
  if (localHour < 22) return 'evening';
  return 'late';
}

export const BUCKETS = ['morning', 'afternoon', 'evening', 'late'];

/**
 * The inverse of localParts: the instant at which a wall clock in `tz` reads
 * the given fields. Fields may be out of range and are normalised the way
 * Date.UTC does it, so hour 25 is 01:00 the next day.
 *
 * Phase 2 needs this to turn "21:14 local tomorrow" into the epoch ms a Durable
 * Object alarm is armed for; scripts/seed-synthetic.ts needs it to place an
 * event at a *local* hour rather than a UTC one.
 *
 * Iterates because the offset depends on the answer: guess, measure the error
 * in the zone, correct. Two passes converge everywhere; the third is for the
 * pathological case of a guess landing inside a DST transition. Local times
 * that do not exist (the skipped hour) resolve to the instant just after the
 * jump, which is the only sensible answer.
 */
export function fromLocal(tz, year, month, day, hour = 0, minute = 0) {
  const want = Date.UTC(year, month - 1, day, hour, minute);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess, tz);
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    if (got === want) break;
    guess -= got - want;
  }
  return guess;
}

/** Weekday 0–6 (Sunday=0) in the event's own zone, for the phase 4 grid. */
export function localWeekday(tsUtc, tz) {
  const { year, month, day } = localParts(tsUtc, tz);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** True if `tz` is a zone this runtime actually knows. */
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz.includes('/')) return false;   // rejects '+05:30' and 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fail loudly at boot on a runtime without full ICU, where every zone silently
 * resolves to UTC and the data is quietly wrong from the first event onward.
 */
export function assertTimeZoneSupport() {
  // 2026-01-01T00:00:00Z is 05:30 in Kolkata — only a real tz database says so.
  const { hour, minute } = localParts(Date.UTC(2026, 0, 1), 'Asia/Kolkata');
  if (hour !== 5 || minute !== 30) {
    throw new Error('runtime lacks full ICU: timezone derivation would be wrong');
  }
}

export const DAY_MS = 86_400_000;

/**
 * Streak in days (plan §3): pure elapsed time since the last relapse, never a
 * count of distinct logical_day values.
 *
 * I fly between US Pacific, US Eastern and IST. Counting days breaks in both
 * directions across the Pacific — westbound skips a calendar day and the streak
 * jumps 2 over ~30 elapsed hours; eastbound crosses 04:00 twice and double-counts.
 * Elapsed time is immune to both, and monotonic by construction.
 */
export function streakDays(lastRelapseTsUtc, now = Date.now()) {
  if (lastRelapseTsUtc == null) return null;   // no relapse on record — caller decides what to show
  return Math.max(0, Math.floor((now - lastRelapseTsUtc) / DAY_MS));
}
