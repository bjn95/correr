// plan.js — Structured running plan generator
//
// Design principle: the long run anchors every week.
// All other session distances are derived as ratios of the long run so the
// hierarchy  long > easy >= quality  is structurally guaranteed.
//
// Session content and coaching descriptions come from coachingData.js.
// The algorithm here handles distances, paces, dates, and progression.

const db           = require('./db');
const coachingData = require('./coachingData');
const { LEVEL_PROFILE_META } = coachingData;

// ── Constants ─────────────────────────────────────────────────────────────────

const RACE_DIST_KM = { '5k': 5, '10k': 10, 'half': 21.0975, 'marathon': 42.195 };

// Peak long run per goal — intentionally below race distance (injury prevention).
const PEAK_LONG_BY_GOAL = { '5k': 7, '10k': 11, 'half': 19, 'marathon': 29, 'general': 13 };

// Starting long run as a fraction of peakLong based on runner's current longest run.
const START_LONG_PCT = {
  none:    0.24,
  '0to5':  0.30,
  '5to10': 0.40,
  '10to16':0.55,
  '16plus':0.72,
};

// Level-based fallback paces (sec/km) when no reference time is provided.
const LEVEL_PACES = {
  beginner:   { easy: 480, long: 450, tempo: 390, intervals: 330 },
  casual:     { easy: 390, long: 360, tempo: 312, intervals: 258 },
  regular:    { easy: 330, long: 312, tempo: 264, intervals: 216 },
  experienced:{ easy: 288, long: 270, tempo: 228, intervals: 186 },
};

// Map current longest run to a pace level
const PACE_LEVEL = {
  none:    'beginner',
  '0to5':  'beginner',
  '5to10': 'casual',
  '10to16':'regular',
  '16plus':'experienced',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

// Count how many days in `selected` are adjacent (±1 in week cycle) to `day`.
// Uses wrap-around so Sun and Mon count as adjacent.
function countAdjacentTo(day, selected, allDays) {
  const n   = allDays.length;
  const idx = allDays.indexOf(day);
  let count = 0;
  if (selected.has(allDays[(idx - 1 + n) % n])) count++;
  if (selected.has(allDays[(idx + 1)     % n])) count++;
  return count;
}

// Intensity rank used to order consecutive running days (higher = harder).
// Long run is pinned (rank 99) so it never gets swapped out.
const INTENSITY_RANK = {
  intervals: 6, tempo: 5, hills: 5, cruise: 4,
  progression: 3, fartlek: 3, strides: 2, easy: 1,
  long: 99, shakeout: 0,
};

function weekdayName(isoDate) {
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(isoDate + 'T00:00:00Z').getUTCDay()];
}

// ── Pace derivation (Riegel formula) ─────────────────────────────────────────

function deriveTargetPaces(paceDistance, paceTimeSecs) {
  const distKm = RACE_DIST_KM[paceDistance];
  if (!distKm || !paceTimeSecs || paceTimeSecs <= 0) return null;

  const minTimes = { '5k': 660,  '10k': 1380, 'half': 3120,  'marathon': 6600  };
  const maxTimes = { '5k': 3600, '10k': 7200, 'half': 14400, 'marathon': 28800 };
  if (paceTimeSecs < minTimes[paceDistance] || paceTimeSecs > maxTimes[paceDistance]) return null;

  // Riegel: t2 = t1 × (d2/d1)^1.06
  const t5k = paceTimeSecs * Math.pow(5 / distKm, 1.06);
  const p5k = t5k / 5;  // sec/km at 5K pace

  return {
    easy:      Math.round(p5k * 1.38),  // Zone 2 — genuinely easy
    long:      Math.round(p5k * 1.32),  // Easy/long — slightly faster than easy
    tempo:     Math.round(p5k * 1.12),  // Lactate threshold
    intervals: Math.round(p5k * 0.97),  // VO2max / interval pace
  };
}

// ── Entry point ────────────────────────────────────────────────────────────────

function buildOrUpdatePlan(userId, survey, planId) {
  const {
    goal          = 'half',
    longestRun    = '5to10',
    days          = 3,
    timeline      = '12w',
    preferredDays = null,
    longRunDay    = null,
    paceDistance  = null,
    paceTimeSecs  = null,
    raceDate      = null,
    planName      = null,
  } = survey;

  const level = PACE_LEVEL[longestRun] || 'casual';
  const meta  = LEVEL_PROFILE_META[level] || LEVEL_PROFILE_META.casual;

  // ── Plan length ───────────────────────────────────────────────────────────
  let weeks;
  if (raceDate) {
    const msUntilRace = new Date(raceDate).getTime() - new Date(nextMonday()).getTime();
    weeks = clamp(Math.round(msUntilRace / (7 * 86400000)), 4, 24);
  } else {
    weeks = { '4w': 4, '8w': 8, '12w': 12, '16w': 16, 'open': 12 }[timeline] || 12;
  }

  // ── Distances ─────────────────────────────────────────────────────────────
  const peakLong  = PEAK_LONG_BY_GOAL[goal] || 19;
  const startLong = Math.max(4, Math.round(peakLong * (START_LONG_PCT[longestRun] || 0.40)));
  const isRacePlan = !!(raceDate || ['5k','10k','half','marathon'].includes(goal));

  // ── Paces ─────────────────────────────────────────────────────────────────
  const targetPaces = deriveTargetPaces(paceDistance, paceTimeSecs)
    || LEVEL_PACES[level]
    || LEVEL_PACES.casual;

  // ── Long run schedule ─────────────────────────────────────────────────────
  const longRunKms = buildLongRunSchedule(startLong, peakLong, weeks, isRacePlan, meta);

  const startDate = nextMonday();
  db.prepare('DELETE FROM plan_workouts WHERE plan_id = ?').run(planId);

  const insert = db.prepare(`
    INSERT INTO plan_workouts (
      user_id, plan_id, week_number, day_of_week, workout_type, name, description,
      target_distance_km, target_pace_min_km, scheduled_date
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `);

  const taperWeeks      = meta.taperWeeks || (isRacePlan ? 3 : 2);
  const buildWeeksCount = Math.max(weeks - taperWeeks, 1);

  // Recovery weeks: every meta.recoveryPattern weeks (4th for experienced, 3rd for beginners)
  const recoveryWeeks = new Set();
  for (let i = 0; i < longRunKms.length; i++) {
    if (longRunKms[i] < (longRunKms[i - 1] ?? Infinity)) recoveryWeeks.add(i + 1);
  }

  for (let w = 1; w <= weeks; w++) {
    const weeksFromEnd = weeks - w;
    const buildPhase   = clamp((w - 1) / buildWeeksCount, 0, 1);
    const isRaceWeek   = weeksFromEnd === 0 && isRacePlan;
    const isRecovery   = recoveryWeeks.has(w);

    const sessions = buildWeekSessions({
      weekNum: w, totalWeeks: weeks, days, level,
      longKm: longRunKms[w - 1],
      targetPaces, goal, planStart: startDate,
      preferredDays, longRunDay, isRacePlan, raceDate,
      buildPhase, weeksFromEnd, isRaceWeek, isRecovery,
      meta,
    });

    for (const s of sessions) {
      insert.run(userId, planId, w, s.dayOfWeek, s.type, s.name, s.description,
                 s.distanceKm, s.paceMinKm, s.date);
    }
  }

  if (planName) {
    db.prepare('UPDATE users SET plan_name = ? WHERE id = ?').run(planName, userId);
  }

  const totalRuns = db.prepare(
    "SELECT COUNT(*) as c FROM plan_workouts WHERE plan_id = ? AND workout_type NOT IN ('rest','race')"
  ).get(planId).c;

  return { weeks, totalRuns, peakLongRun: peakLong, startDate, planId };
}

// ── Long run schedule ─────────────────────────────────────────────────────────
//
// Progressive long run for every week: build toward peakLong, dip every
// recoveryPattern-th week, then taper.
//
function buildLongRunSchedule(startLong, peakLong, totalWeeks, isRacePlan, meta) {
  const taperWeeks  = meta.taperWeeks || (isRacePlan ? 3 : 2);
  const recovPat    = meta.recoveryPattern || 3;  // recovery every N weeks
  const buildWeeks  = Math.max(totalWeeks - taperWeeks, 1);

  // Count advancing weeks vs recovery dips within the build phase
  let recoveryCount = 0;
  for (let i = 1; i < buildWeeks; i++) {
    if (i % recovPat === 0) recoveryCount++;
  }
  const advancingWeeks = Math.max(buildWeeks - 1 - recoveryCount, 1);

  const idealStep  = (peakLong - startLong) / advancingWeeks;
  const step       = Math.min(idealStep, 3.0);  // cap at 3km/week for safety
  const achievable = Math.min(peakLong, Math.round(startLong + step * advancingWeeks));

  const schedule  = [];
  let current     = startLong;
  let prevBuild   = startLong;

  for (let i = 0; i < buildWeeks; i++) {
    const isLast     = i === buildWeeks - 1;
    const isRecovery = !isLast && i > 0 && i % recovPat === 0;

    if (isLast) {
      schedule.push(achievable);
    } else if (isRecovery) {
      schedule.push(Math.max(startLong, Math.round(prevBuild * 0.87)));
    } else {
      const km = Math.round(clamp(current, startLong, achievable));
      schedule.push(km);
      prevBuild = km;
      current   = Math.min(achievable, current + step);
    }
  }

  // Taper
  schedule.push(Math.round(achievable * 0.78));
  if (taperWeeks >= 2) schedule.push(Math.round(achievable * 0.56));
  if (taperWeeks >= 3) schedule.push(5);

  return schedule;
}

// ── Week session builder ──────────────────────────────────────────────────────

function buildWeekSessions({ weekNum, totalWeeks, days, level, longKm, targetPaces, goal,
                              planStart, preferredDays, longRunDay, isRacePlan, raceDate,
                              buildPhase, weeksFromEnd, isRaceWeek, isRecovery, meta }) {

  // Pace setup — quality paces ease off early in the plan, sharpen as it matures
  const tempoSlack     = Math.round((1 - buildPhase) * 18);
  const intervalsSlack = Math.round((1 - buildPhase) * 22);
  const s2m = s => s / 60;

  const paceMap = {
    easy:        s2m(targetPaces.easy),
    long:        s2m(targetPaces.long),
    strides:     s2m(targetPaces.easy),
    tempo:       s2m(targetPaces.tempo     + tempoSlack),
    intervals:   s2m(targetPaces.intervals + intervalsSlack),
    fartlek:     s2m(targetPaces.easy),
    hills:       s2m(targetPaces.intervals + intervalsSlack),
    progression: s2m(targetPaces.tempo     + tempoSlack),
    cruise:      s2m(targetPaces.tempo     + tempoSlack),
    shakeout:    s2m(targetPaces.easy),
  };

  // Day resolution
  const ALL_DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const DEFAULT_DAYS = {
    2: ['Tue','Sat'],
    3: ['Tue','Thu','Sat'],
    4: ['Mon','Tue','Thu','Sat'],
    5: ['Mon','Tue','Wed','Thu','Sat'],
    6: ['Mon','Tue','Wed','Thu','Fri','Sat'],
  };

  const activeDays = (() => {
    if (!preferredDays || preferredDays.length === 0)
      return DEFAULT_DAYS[clamp(days, 2, 6)] || DEFAULT_DAYS[3];

    const sorted = preferredDays.slice().sort((a, b) => ALL_DAYS.indexOf(a) - ALL_DAYS.indexOf(b));
    if (days >= sorted.length) return sorted;  // enough available — use all

    // Long run day is always locked in
    const anchor = (longRunDay && sorted.includes(longRunDay)) ? longRunDay : sorted[sorted.length - 1];
    const pool   = sorted.filter(d => d !== anchor);  // remaining available days
    const need   = Math.max(0, days - 1);             // non-long slots required

    if (pool.length <= need) return sorted;  // pool exhausted — use all

    // Greedily pick days that minimise adjacencies to already-selected days.
    // Use weekly rotation (step-based) as a tiebreaker so day variety is
    // preserved across weeks even when gap preference dominates.
    const step     = Math.max(1, need);
    const startIdx = ((weekNum - 1) * step) % pool.length;
    const selected = new Set([anchor]);

    // Build a rotation-ordered version of the pool as tiebreaker priority
    const rotationOrder = pool.map((_, i) => pool[(startIdx + i) % pool.length]);

    for (let i = 0; i < need; i++) {
      const remaining = rotationOrder.filter(d => !selected.has(d));
      if (!remaining.length) break;

      // Sort by (adjacency count ASC, rotation order ASC) — prefer gaps first
      remaining.sort((a, b) => {
        const adjA = countAdjacentTo(a, selected, ALL_DAYS);
        const adjB = countAdjacentTo(b, selected, ALL_DAYS);
        if (adjA !== adjB) return adjA - adjB;
        return rotationOrder.indexOf(a) - rotationOrder.indexOf(b);
      });

      selected.add(remaining[0]);
    }

    return sorted.filter(d => selected.has(d));
  })();

  const effectiveLongDay = (longRunDay && activeDays.includes(longRunDay))
    ? longRunDay
    : activeDays[activeDays.length - 1];

  // Race week
  if (isRaceWeek) {
    return buildRaceWeekSessions({ weekNum, planStart, raceDate, goal, paceMap });
  }

  // ── Session distances — anchored to longKm ────────────────────────────────
  //
  // Level profile constants drive easyRatio and qualityRatio.
  // Hierarchy guaranteed: long > easy >= quality
  //
  const easyRatio    = meta.easyRatio    || 0.57;
  const qualityRatio = meta.qualityRatio || 0.85;

  const easyKm    = clamp(Math.round(longKm * easyRatio), 4, Math.min(14, longKm - 2));
  const qualityKm = clamp(Math.round(easyKm * qualityRatio), 4, easyKm);
  const safeLong  = Math.max(longKm, easyKm + 2);

  const distMap = {
    easy:        easyKm,
    long:        safeLong,
    tempo:       qualityKm,
    intervals:   Math.max(4, Math.round(qualityKm * 0.88)),
    strides:     easyKm,
    fartlek:     Math.max(easyKm, Math.round(easyKm * 1.05)),
    hills:       Math.max(5, Math.round(qualityKm * 0.90)),
    progression: easyKm,
    cruise:      qualityKm,
  };

  // Session types for non-long days — from level-aware coaching data
  const nonLongDays  = activeDays.filter(d => d !== effectiveLongDay);
  const isTaper      = weeksFromEnd <= (meta.taperWeeks || 3) - 1;
  const phaseName    = coachingData.buildPhaseToName(buildPhase, isTaper);
  const sessionTypes = coachingData.resolveSessionTypes(nonLongDays.length, phaseName, goal, isRecovery, level);

  const weekStart = addDays(planStart, (weekNum - 1) * 7);
  const sessions  = [];
  let   nlIdx     = 0;

  for (const day of activeDays) {
    const type   = day === effectiveLongDay ? 'long' : (sessionTypes[nlIdx++] || 'easy');
    const dayOff = ALL_DAYS.indexOf(day);
    sessions.push({
      dayOfWeek:   day,
      type,
      name:        sessionName(type, distMap[type], goal),
      description: buildDescription(type, phaseName, distMap[type], paceMap[type], goal, level),
      distanceKm:  distMap[type],
      paceMinKm:   paceMap[type],
      date:        addDays(weekStart, dayOff),
    });
  }

  // ── Intensity ordering for consecutive days ─────────────────────────────
  // When two running days are back-to-back, ensure the harder session comes
  // first so the easier day acts as active recovery.  Never move the long run.
  const n = ALL_DAYS.length;
  for (let i = 0; i < sessions.length - 1; i++) {
    const a = sessions[i];
    const b = sessions[i + 1];
    const idxA = ALL_DAYS.indexOf(a.dayOfWeek);
    const idxB = ALL_DAYS.indexOf(b.dayOfWeek);
    const consecutive = (idxB - idxA + n) % n === 1;
    if (!consecutive) continue;
    if (a.type === 'long' || b.type === 'long') continue;  // never displace long run

    const rankA = INTENSITY_RANK[a.type] ?? 1;
    const rankB = INTENSITY_RANK[b.type] ?? 1;
    if (rankB <= rankA) continue;  // already in correct order (harder ≥ easier)

    // Swap types between the two sessions, rebuild everything that depends on type
    [a.type, b.type] = [b.type, a.type];
    for (const s of [a, b]) {
      s.name        = sessionName(s.type, distMap[s.type], goal);
      s.description = buildDescription(s.type, phaseName, distMap[s.type], paceMap[s.type], goal, level);
      s.distanceKm  = distMap[s.type];
      s.paceMinKm   = paceMap[s.type];
    }
  }

  return sessions;
}

// ── Race week ─────────────────────────────────────────────────────────────────

function buildRaceWeekSessions({ weekNum, planStart, raceDate, goal, paceMap }) {
  const ALL_DAYS  = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const weekStart = addDays(planStart, (weekNum - 1) * 7);
  const sessions  = [];

  let shakeoutDate = raceDate ? addDays(raceDate, -2) : addDays(weekStart, 4);
  if (shakeoutDate < weekStart) shakeoutDate = weekStart;
  const shakeoutDay = weekdayName(shakeoutDate);

  sessions.push({
    dayOfWeek:   shakeoutDay,
    type:        'shakeout',
    name:        'Pre-Race Shakeout',
    description: 'A very easy 20–30 min jog to flush out any stiffness — nothing more. Keep the effort genuinely conversational. Finish with 4–6 × 10-second gentle strides (not sprints) to wake your legs up. Rest completely tomorrow.',
    distanceKm:  5,
    paceMinKm:   paceMap.shakeout,
    date:        shakeoutDate,
  });

  if (raceDate) {
    const raceDay  = weekdayName(raceDate);
    const raceDist = { '5k': 5, '10k': 10, 'half': 21.1, 'marathon': 42.2 }[goal] || null;
    sessions.push({
      dayOfWeek:   raceDay,
      type:        'race',
      name:        raceDist ? `Race Day — ${raceDist}km` : 'Race Day',
      description: `Race day! Warm up gently for 10–15 min. Start conservatively — go out at target pace, not faster. Trust your training and your taper. You have done the work.`,
      distanceKm:  raceDist || 0,
      paceMinKm:   null,
      date:        raceDate,
    });
  }

  return sessions;
}

// ── Session naming ────────────────────────────────────────────────────────────

function sessionName(type, km, goal) {
  switch (type) {
    case 'easy':        return `Easy Run — ${km}km`;
    case 'long':        return `Long Run — ${km}km`;
    case 'strides':     return `Easy Run + Strides — ${km}km`;
    case 'tempo':       return `Tempo Run — ${km}km`;
    case 'progression': return `Progression Run — ${km}km`;
    case 'fartlek':     return `Fartlek — ${km}km`;
    case 'hills':       return `Hill Repeats — ${km}km`;
    case 'cruise':      return `Cruise Intervals — ${km}km`;
    case 'intervals':
      return goal === '5k'  ? `400m Intervals — ${km}km`
           : goal === '10k' ? `800m Intervals — ${km}km`
           :                  `1km Intervals — ${km}km`;
    default: return `Run — ${km}km`;
  }
}

// ── Session descriptions ──────────────────────────────────────────────────────
//
// Combines coaching template from coachingData.js with computed specifics
// (rep counts, block lengths, pace references).
//
function buildDescription(type, phaseName, km, paceMinKm, goal, level) {
  const p = paceMinKm ? formatPace(paceMinKm) : null;

  // Long run: level + phase-specific note
  if (type === 'long') {
    return coachingData.getLongRunNote(phaseName, level);
  }

  const template = coachingData.getSessionDescription(type, phaseName);

  switch (type) {

    case 'intervals': {
      const repDist = goal === '5k' ? 400 : goal === '10k' ? 800 : 1000;
      // More reps for experienced (higher volume), fewer for beginners
      const maxReps = { beginner: 5, casual: 6, regular: 8, experienced: 10 }[level] || 6;
      const reps    = clamp(Math.round((km * 1000) / (repDist + 250)), 3, maxReps);
      const paceStr = p ? ` at ${p}/km` : '';
      return (template || '') + ` ${reps} × ${repDist}m${paceStr} with full recovery between reps.`;
    }

    case 'tempo': {
      const block   = Math.max(2, Math.round(km * 0.62));
      const paceStr = p ? ` (target: ${p}/km)` : '';
      return (template || '') + ` Tempo block: ${block}km${paceStr}.`;
    }

    case 'cruise': {
      const blocks  = clamp(Math.round(km / 3), 2, 4);
      const bKm     = Math.round((km * 0.70) / blocks * 10) / 10;
      const paceStr = p ? ` at ${p}/km` : '';
      return (template || '') + ` ${blocks} × ${bKm}km${paceStr} with 90 sec recovery.`;
    }

    case 'fartlek': {
      const reps    = clamp(Math.round((km - 2) * 1.4), 4, 10);
      const paceStr = p ? ` Hard efforts ~${p}/km.` : '';
      return (template || '') + ` ${reps} × 1 min hard / 90 sec easy.${paceStr}`;
    }

    case 'hills': {
      const reps = clamp(Math.round(km * 1.1), 5, 14);
      return (template || '') + ` ${reps} reps.`;
    }

    case 'progression': {
      const finalKm = Math.max(1, Math.round(km * 0.25));
      const paceStr = p ? ` finishing at ${p}/km` : '';
      return (template || '') + ` Build into the final ${finalKm}km${paceStr}.`;
    }

    default:
      return template || (p ? `Run at ${p}/km.` : `${km}km run.`);
  }
}

function formatPace(paceMinKm) {
  if (!paceMinKm) return null;
  const m = Math.floor(paceMinKm);
  const s = Math.round((paceMinKm - m) * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function nextMonday() {
  const d = new Date();
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 1 ? 0 : (8 - day) % 7));
  return toISODate(d);
}

function addDays(isoDate, n) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return toISODate(d);
}

function toISODate(d) { return d.toISOString().slice(0, 10); }

module.exports = { buildOrUpdatePlan };
