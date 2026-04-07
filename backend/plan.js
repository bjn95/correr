// plan.js — Structured running plan generator
//
// Design principle: the long run is the anchor of every week.
// All other session distances are derived as fixed ratios of the long run,
// so the hierarchy  long > easy >= quality  is structurally guaranteed.
//
// Session types and descriptions come from coachingData.js (pre-computed
// coaching knowledge). The structural algorithm here handles distances,
// paces, dates, and long-run progression.

const db           = require('./db');
const coachingData = require('./coachingData');

// ── Constants ─────────────────────────────────────────────────────────────────

const RACE_DIST_KM = { '5k': 5, '10k': 10, 'half': 21.0975, 'marathon': 42.195 };

// Peak long run for each goal — set below race distance intentionally;
// reaching race distance in training isn't necessary and risks injury.
const PEAK_LONG_BY_GOAL = { '5k': 7, '10k': 11, 'half': 19, 'marathon': 29, 'general': 13 };

// Where the long run starts, as a fraction of peakLong, based on the
// user's longest run in the past month.
const START_LONG_PCT = {
  none:   0.26,   // never / rarely run
  '0to5': 0.32,   // up to 5km
  '5to10':0.42,   // 5–10km
  '10to16':0.58,  // 10–16km
  '16plus':0.74,  // over 16km
};

// Level-based fallback training paces (sec/km)
const LEVEL_PACES = {
  beginner:   { easy: 480, long: 450, tempo: 360, intervals: 300 },
  casual:     { easy: 390, long: 360, tempo: 300, intervals: 240 },
  regular:    { easy: 330, long: 312, tempo: 264, intervals: 210 },
  experienced:{ easy: 288, long: 270, tempo: 228, intervals: 180 },
};

// Map longest-run answer to a pace level
const PACE_LEVEL = {
  none:    'beginner',
  '0to5':  'beginner',
  '5to10': 'casual',
  '10to16':'regular',
  '16plus':'experienced',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

function weekdayName(isoDate) {
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(isoDate + 'T00:00:00Z').getUTCDay()];
}

// ── Pace derivation (Riegel formula) ─────────────────────────────────────────

function deriveTargetPaces(paceDistance, paceTimeSecs) {
  const distKm = RACE_DIST_KM[paceDistance];
  if (!distKm || !paceTimeSecs || paceTimeSecs <= 0) return null;

  const minTimes = { '5k': 720, '10k': 1500, 'half': 3300, 'marathon': 7200 };
  const maxTimes = { '5k': 3600, '10k': 7200, 'half': 14400, 'marathon': 28800 };
  if (paceTimeSecs < minTimes[paceDistance] || paceTimeSecs > maxTimes[paceDistance]) return null;

  const t5k = paceTimeSecs * Math.pow(5 / distKm, 1.06);
  const p5k = t5k / 5;
  return {
    easy:      Math.round(p5k * 1.36),
    long:      Math.round(p5k * 1.30),
    tempo:     Math.round(p5k * 1.10),
    intervals: Math.round(p5k * 0.98),
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

  // ── Plan length ───────────────────────────────────────────────────────────
  let weeks;
  if (raceDate) {
    const msUntilRace = new Date(raceDate).getTime() - new Date(nextMonday()).getTime();
    weeks = clamp(Math.round(msUntilRace / (7 * 86400000)), 4, 24);
  } else {
    weeks = { '4w': 4, '8w': 8, '12w': 12, '16w': 16, 'open': 10 }[timeline] || 12;
  }

  // ── Distances ─────────────────────────────────────────────────────────────
  const peakLong   = PEAK_LONG_BY_GOAL[goal] || 19;
  const startLong  = Math.max(4, Math.round(peakLong * (START_LONG_PCT[longestRun] || 0.42)));
  const isRacePlan = !!(raceDate || ['5k','10k','half','marathon'].includes(goal));

  // ── Paces ─────────────────────────────────────────────────────────────────
  const targetPaces = deriveTargetPaces(paceDistance, paceTimeSecs)
    || LEVEL_PACES[PACE_LEVEL[longestRun]]
    || LEVEL_PACES.casual;

  // ── Long run schedule for every week ─────────────────────────────────────
  const longRunKms = buildLongRunSchedule(startLong, peakLong, weeks, isRacePlan);

  const startDate = nextMonday();
  db.prepare('DELETE FROM plan_workouts WHERE plan_id = ?').run(planId);

  const insert = db.prepare(`
    INSERT INTO plan_workouts (
      user_id, plan_id, week_number, day_of_week, workout_type, name, description,
      target_distance_km, target_pace_min_km, scheduled_date
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `);

  const taperWeeks = isRacePlan ? 3 : 2;
  const buildWeeksCount = Math.max(weeks - taperWeeks, 1);

  // Recovery weeks: any build week where the long run is less than the previous week
  const recoveryWeeks = new Set();
  for (let i = 1; i < longRunKms.length; i++) {
    if (longRunKms[i] < longRunKms[i - 1]) recoveryWeeks.add(i + 1); // 1-based week num
  }

  for (let w = 1; w <= weeks; w++) {
    const weeksFromEnd = weeks - w;
    const buildPhase   = clamp((w - 1) / buildWeeksCount, 0, 1);
    const isRaceWeek   = weeksFromEnd === 0 && isRacePlan;
    const isRecovery   = recoveryWeeks.has(w);

    const sessions = buildWeekSessions({
      weekNum: w, totalWeeks: weeks, days,
      longKm: longRunKms[w - 1],
      targetPaces, goal, planStart: startDate,
      preferredDays, longRunDay, isRacePlan, raceDate,
      buildPhase, weeksFromEnd, isRaceWeek, isRecovery,
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
// Builds a progressive long run distance for every week of the plan.
//
// Build phase pattern: grow toward peakLong, dipping ~12% every 4th week
// for recovery. The step size is calculated so the final build week hits
// peakLong (capped at a maximum safe weekly increase of 3km).
//
// Taper:   race plans → 80%, 60%, shakeout(5km)
//          non-race   → 80%, 65%
//
function buildLongRunSchedule(startLong, peakLong, totalWeeks, isRacePlan) {
  const taperWeeks  = isRacePlan ? 3 : 2;
  const buildWeeks  = Math.max(totalWeeks - taperWeeks, 1);

  // Count non-recovery advancing weeks in the build phase
  const recoveryCount   = Math.floor((buildWeeks - 1) / 4); // every 4th week
  const advancingWeeks  = buildWeeks - 1 - recoveryCount;   // last week forced to peak

  // Step per advancing week — cap at 3km to prevent overly aggressive plans
  const idealStep  = (peakLong - startLong) / Math.max(advancingWeeks, 1);
  const step       = Math.min(idealStep, 3.0);

  // Achievable peak given the step cap
  const achievablePeak = Math.min(peakLong, Math.round(startLong + step * advancingWeeks));

  const schedule  = [];
  let   current   = startLong;        // tracks the "build" level
  let   prevBuild = startLong;        // last non-recovery value (for recovery dip calc)

  for (let i = 0; i < buildWeeks; i++) {
    const isLast     = i === buildWeeks - 1;
    const isRecovery = !isLast && i > 0 && (i + 1) % 4 === 0;

    if (isLast) {
      schedule.push(achievablePeak);
    } else if (isRecovery) {
      // Dip to 88% of the previous build week — keeps recovery meaningful
      // but avoids big jumps when returning
      schedule.push(Math.max(startLong, Math.round(prevBuild * 0.88)));
    } else {
      const km = Math.round(clamp(current, startLong, achievablePeak));
      schedule.push(km);
      prevBuild = km;
      current   = Math.min(achievablePeak, current + step);
    }
  }

  // Taper weeks
  schedule.push(Math.round(achievablePeak * 0.78));        // taper 1: ~80%
  if (taperWeeks >= 2) schedule.push(Math.round(achievablePeak * 0.58)); // taper 2: ~60%
  if (taperWeeks >= 3) schedule.push(5);                   // race week: shakeout only

  return schedule;
}

// ── Week session builder ──────────────────────────────────────────────────────

function buildWeekSessions({ weekNum, totalWeeks, days, longKm, targetPaces, goal,
                              planStart, preferredDays, longRunDay, isRacePlan, raceDate,
                              buildPhase, weeksFromEnd, isRaceWeek, isRecovery }) {

  // Pace setup — quality sessions ease off in early weeks, sharpen as plan matures
  const tempoSlack     = Math.round((1 - buildPhase) * 20);
  const intervalsSlack = Math.round((1 - buildPhase) * 25);
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
    2: ['Mon','Sat'],
    3: ['Mon','Wed','Sat'],
    4: ['Mon','Tue','Thu','Sat'],
    5: ['Mon','Tue','Wed','Thu','Sat'],
    6: ['Mon','Tue','Wed','Thu','Fri','Sat'],
  };

  const activeDays = (() => {
    if (!preferredDays || preferredDays.length === 0)
      return DEFAULT_DAYS[clamp(days, 2, 6)] || DEFAULT_DAYS[3];
    const sorted = preferredDays.slice().sort((a, b) => ALL_DAYS.indexOf(a) - ALL_DAYS.indexOf(b));
    if (days >= sorted.length) return sorted;
    // Trim to `days` slots: always keep longRunDay (last/specified), spread the rest evenly
    const anchor = (longRunDay && sorted.includes(longRunDay)) ? longRunDay : sorted[sorted.length - 1];
    const others = sorted.filter(d => d !== anchor);
    const need   = Math.max(0, days - 1);
    const selected = new Set([anchor]);
    if (need > 0 && others.length > 0) {
      for (let i = 0; i < need; i++) {
        selected.add(others[Math.min(Math.round(i * (others.length / need)), others.length - 1)]);
      }
    }
    return sorted.filter(d => selected.has(d));
  })();

  const effectiveLongDay = (longRunDay && activeDays.includes(longRunDay))
    ? longRunDay
    : activeDays[activeDays.length - 1];

  // Race week: special handling — shakeout + race entry only
  if (isRaceWeek) {
    return buildRaceWeekSessions({ weekNum, planStart, raceDate, goal, paceMap });
  }

  // ── Session distances — all anchored to longKm ───────────────────────────
  //
  // Guaranteed hierarchy: long > easy >= quality
  //
  // Easy:    55–60% of long run, hard-capped at 13km
  // Quality: 85% of easy (harder session = slightly shorter)
  //
  const easyKm    = clamp(Math.round(longKm * 0.58), 4, Math.min(13, longKm - 2));
  const qualityKm = clamp(Math.round(easyKm  * 0.85), 4, easyKm);

  // Sanity check (shouldn't fail, but belt-and-braces)
  const safeLongKm = Math.max(longKm, easyKm + 2);

  const distMap = {
    easy:        easyKm,
    long:        safeLongKm,
    tempo:       qualityKm,
    intervals:   Math.max(4, Math.round(qualityKm * 0.90)),
    strides:     easyKm,
    fartlek:     easyKm,
    hills:       qualityKm,
    progression: easyKm,
    cruise:      qualityKm,
  };

  // Session types for non-long slots — from coaching data
  const nonLongDays  = activeDays.filter(d => d !== effectiveLongDay);
  const isTaper      = weeksFromEnd <= 2;
  const phaseName    = coachingData.buildPhaseToName(buildPhase, isTaper);
  const sessionTypes = coachingData.resolveSessionTypes(nonLongDays.length, phaseName, goal, isRecovery);

  // Build session list
  const weekStart = addDays(planStart, (weekNum - 1) * 7);
  const sessions  = [];
  let   nlIdx     = 0;

  for (const day of activeDays) {
    const type   = day === effectiveLongDay ? 'long' : (sessionTypes[nlIdx++] || 'easy');
    const dayOff = ALL_DAYS.indexOf(day);
    const effectivePhaseName = type === 'long' ? phaseName : phaseName;
    sessions.push({
      dayOfWeek:   day,
      type,
      name:        sessionName(type, distMap[type], goal),
      description: buildDescription(type, effectivePhaseName, distMap[type], paceMap[type], goal),
      distanceKm:  distMap[type],
      paceMinKm:   paceMap[type],
      date:        addDays(weekStart, dayOff),
    });
  }

  return sessions;
}

// ── Race week ─────────────────────────────────────────────────────────────────

function buildRaceWeekSessions({ weekNum, planStart, raceDate, goal, paceMap }) {
  const ALL_DAYS  = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const weekStart = addDays(planStart, (weekNum - 1) * 7);
  const sessions  = [];

  // Shakeout: 2 days before race (defaults to Friday if no exact date)
  let shakeoutDate = raceDate ? addDays(raceDate, -2) : addDays(weekStart, 4);
  if (shakeoutDate < weekStart) shakeoutDate = weekStart; // keep within race week
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

  // Race Day entry (only if exact date is known)
  if (raceDate) {
    const raceDay    = weekdayName(raceDate);
    const raceDist   = { '5k': 5, '10k': 10, 'half': 21.1, 'marathon': 42.2 }[goal] || null;
    sessions.push({
      dayOfWeek:   raceDay,
      type:        'race',
      name:        raceDist ? `Race Day — ${raceDist}km` : 'Race Day',
      description: `Race day! Warm up gently for 10–15 min. Start conservatively — go out at target pace, not faster. Trust your training and your taper. You've done the work.`,
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
// Combines a coaching template from coachingData.js with algorithmically
// computed specifics (rep counts, pace references, long run phase notes).
//
function buildDescription(type, phaseName, km, paceMinKm, goal) {
  const p = paceMinKm ? formatPace(paceMinKm) : null;

  // Long run: coaching template + phase-specific progression note
  if (type === 'long') {
    const phaseNote = coachingData.LONG_RUN_PHASE_NOTES[phaseName]
      || coachingData.LONG_RUN_PHASE_NOTES.base;
    return phaseNote;
  }

  // For interval/structured sessions, compute rep counts and append to template
  const template = coachingData.getSessionDescription(type, phaseName);

  switch (type) {
    case 'intervals': {
      const repDist = goal === '5k' ? 400 : goal === '10k' ? 800 : 1000;
      const reps    = clamp(Math.round((km * 1000) / (repDist + 200)), 3, 8);
      const paceStr = p ? ` at ${p}/km` : '';
      return (template || '') + ` ${reps} × ${repDist}m${paceStr} with full standing recovery between reps.`;
    }

    case 'tempo': {
      const block   = Math.max(2, Math.round(km * 0.60));
      const paceStr = p ? ` (target: ${p}/km)` : '';
      return (template || '') + ` Tempo block: ${block}km${paceStr}.`;
    }

    case 'fartlek': {
      const reps    = clamp(Math.round((km - 2) * 1.5), 4, 10);
      const paceStr = p ? ` Hard efforts ~${p}/km.` : '';
      return (template || '') + ` ${reps} × 1 min hard / 2 min easy.${paceStr}`;
    }

    case 'hills': {
      const reps = clamp(Math.round(km * 1.1), 5, 12);
      return (template || '') + ` ${reps} reps.`;
    }

    case 'cruise': {
      const blocks  = clamp(Math.round(km / 3), 2, 4);
      const bKm     = Math.round((km * 0.70) / blocks * 10) / 10;
      const paceStr = p ? ` at ${p}/km` : '';
      return (template || '') + ` ${blocks} × ${bKm}km${paceStr} with 90 sec recovery.`;
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
