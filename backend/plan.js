// plan.js — Generates a structured running plan from survey answers
// and saves plan_workouts rows to the DB, ready for Garmin sync
//
// Session type progression (based on Hal Higdon / Jack Daniels / Pfitzinger):
//   Early build (0–35%):  fartlek + progression runs  — gentle intro to faster work
//   Mid build  (35–65%):  hill repeats + tempo        — strength & threshold base
//   Late build (65%+):    goal-specific intervals + tempo — race-specific speed
//   Taper weeks:          shorter quality work
//   Race week:            easy runs only

const db = require('./db');

// ── Pace derivation ───────────────────────────────────────────────────────────

const RACE_DIST_KM = { '5k': 5, '10k': 10, 'half': 21.0975, 'marathon': 42.195 };

// Riegel formula: predict 5K time from any race result, then derive training paces (sec/km)
function deriveTargetPaces(paceDistance, paceTimeSecs) {
  const distKm = RACE_DIST_KM[paceDistance];
  if (!distKm || !paceTimeSecs || paceTimeSecs <= 0) return null;

  const minTimeSecs = { '5k': 720, '10k': 1500, 'half': 3300, 'marathon': 7200 }[paceDistance];
  const maxTimeSecs = { '5k': 3600, '10k': 7200, 'half': 14400, 'marathon': 28800 }[paceDistance];
  if (paceTimeSecs < minTimeSecs || paceTimeSecs > maxTimeSecs) return null;

  // Riegel: T_5k = T * (5 / D)^1.06
  const t5kSecs = paceTimeSecs * Math.pow(5 / distKm, 1.06);
  const pace5kSecKm = t5kSecs / 5;

  return {
    easy:      Math.round(pace5kSecKm * 1.36), // comfortable aerobic
    long:      Math.round(pace5kSecKm * 1.30), // long run easy effort
    tempo:     Math.round(pace5kSecKm * 1.10), // lactate threshold
    intervals: Math.round(pace5kSecKm * 0.98), // VO2max / 5K race pace
  };
}

// Level-based fallback paces (sec/km)
const LEVEL_PACES = {
  beginner:   { easy: 480, long: 450, tempo: 360, intervals: 300 },
  casual:     { easy: 390, long: 360, tempo: 300, intervals: 240 },
  regular:    { easy: 330, long: 312, tempo: 264, intervals: 210 },
  experienced:{ easy: 288, long: 270, tempo: 228, intervals: 180 },
};

// ── Entry point ────────────────────────────────────────────────────────────────

function buildOrUpdatePlan(userId, survey) {
  const {
    goal          = 'half',
    level         = 'casual',
    days          = 3,
    km            = 20,
    timeline      = '12w',
    focus         = 'health',
    preferredDays = null,
    longRunDay    = null,
    paceDistance  = null,
    paceTimeSecs  = null,
    raceDate      = null,
  } = survey;

  // Derive weeks from raceDate if provided, else from timeline string
  let weeks;
  if (raceDate) {
    const startDate = nextMonday();
    const startMs = new Date(startDate).getTime();
    const raceMs  = new Date(raceDate).getTime();
    const weeksUntilRace = Math.round((raceMs - startMs) / (7 * 24 * 60 * 60 * 1000));
    weeks = Math.max(4, Math.min(24, weeksUntilRace));
  } else {
    weeks = { '4w': 4, '8w': 8, '12w': 12, '16w': 16, 'open': 10 }[timeline] || 12;
  }

  const peakKm      = { '5k': 35, '10k': 50, 'half': 65, 'marathon': 80, 'general': 40 }[goal] || 65;
  const peakLongRun = { '5k': 8,  '10k': 12, 'half': 21, 'marathon': 32, 'general': 15 }[goal] || 21;
  const isRacePlan  = raceDate || ['5k', '10k', 'half', 'marathon'].includes(goal);

  const targetPaces = deriveTargetPaces(paceDistance, paceTimeSecs)
    || LEVEL_PACES[level]
    || LEVEL_PACES.casual;

  const startDate = nextMonday();

  db.prepare('DELETE FROM plan_workouts WHERE user_id = ?').run(userId);

  const insertWorkout = db.prepare(`
    INSERT INTO plan_workouts (
      user_id, week_number, day_of_week, workout_type, name, description,
      target_distance_km, target_pace_min_km, scheduled_date
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `);

  for (let w = 1; w <= weeks; w++) {
    const weeksFromEnd = weeks - w;

    // ── Mileage progression with 3-week taper ──────────────────────────────
    let weeklyKm;
    if (weeksFromEnd === 0) {
      weeklyKm = Math.round(peakKm * (isRacePlan ? 0.35 : 0.55));
    } else if (weeksFromEnd === 1) {
      weeklyKm = Math.round(peakKm * (isRacePlan ? 0.60 : 0.75));
    } else if (weeksFromEnd === 2) {
      weeklyKm = Math.round(peakKm * 0.82);
    } else {
      const buildWeeks = Math.max(weeks - 3, 1);
      const buildIdx   = w - 1;
      const isCutback  = buildIdx > 0 && buildIdx % 3 === 2;
      const progressFraction = isCutback
        ? ((buildIdx - 1) / buildWeeks) * 0.85
        : buildIdx / buildWeeks;
      weeklyKm = Math.round(km + (peakKm - km) * Math.min(progressFraction, 1));
    }

    const schedule = buildWeekSchedule(
      w, weeks, days, weeklyKm, peakLongRun,
      targetPaces, goal, startDate, preferredDays, longRunDay, isRacePlan
    );

    for (const session of schedule) {
      insertWorkout.run(
        userId, w, session.dayOfWeek, session.type, session.name,
        session.description, session.distanceKm, session.paceMinKm, session.date,
      );
    }
  }

  const totalRuns = db.prepare(
    "SELECT COUNT(*) as c FROM plan_workouts WHERE user_id = ? AND workout_type != 'rest'"
  ).get(userId).c;

  return { weeks, totalRuns, peakLongRun, startDate };
}

// ── Week schedule builder ─────────────────────────────────────────────────────

function buildWeekSchedule(weekNum, totalWeeks, daysPerWeek, weeklyKm, peakLong, targetPaces, goal, planStart, preferredDays, longRunDay, isRacePlan) {

  const weeksFromEnd = totalWeeks - weekNum;
  const isRaceWeek   = weeksFromEnd === 0;
  const isTaper      = weeksFromEnd <= 2;

  // Build phase progress: 0.0 (week 1) → 1.0 (last build week)
  const buildWeeks  = Math.max(totalWeeks - 3, 1);
  const buildPhase  = Math.min((weekNum - 1) / buildWeeks, 1.0);

  // Pace progression: quality sessions begin conservatively and sharpen to target
  const progressFrac   = buildPhase;
  const tempoSlack     = Math.round((1 - progressFrac) * 20); // up to 20 s/km slack early on
  const intervalsSlack = Math.round((1 - progressFrac) * 25);

  const secToMin = s => s / 60;
  const paceMap = {
    easy:        secToMin(targetPaces.easy),
    long:        secToMin(targetPaces.long),
    tempo:       secToMin(targetPaces.tempo     + tempoSlack),
    intervals:   secToMin(targetPaces.intervals + intervalsSlack),
    // Derived paces for new session types
    fartlek:     secToMin(targetPaces.easy),       // reference: easy (effort varies)
    hills:       secToMin(targetPaces.intervals + intervalsSlack), // hard uphill effort
    progression: secToMin(targetPaces.tempo     + tempoSlack),     // target for finish
    cruise:      secToMin(targetPaces.tempo     + tempoSlack),     // threshold blocks
  };

  const ALL_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const DEFAULT_DAYS = {
    2: ['Mon', 'Sat'],
    3: ['Mon', 'Wed', 'Sat'],
    4: ['Mon', 'Tue', 'Thu', 'Sat'],
    5: ['Mon', 'Tue', 'Wed', 'Thu', 'Sat'],
    6: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  };

  let activeDays = (preferredDays && preferredDays.length >= 1)
    ? preferredDays.slice().sort((a, b) => ALL_DAYS.indexOf(a) - ALL_DAYS.indexOf(b))
    : (DEFAULT_DAYS[Math.min(daysPerWeek, 6)] || DEFAULT_DAYS[3]);

  const effectiveLongRunDay = (longRunDay && activeDays.includes(longRunDay))
    ? longRunDay
    : activeDays[activeDays.length - 1];

  const nonLongDays = activeDays.filter(d => d !== effectiveLongRunDay);

  // Resolve quality session types for this week based on build phase and goal
  const nonLongTypes = resolveQualityTypes(nonLongDays.length, buildPhase, goal, isRacePlan && isRaceWeek, isTaper);

  // Long run scaling
  const buildFrac = Math.min((weekNum - 1) / Math.max(totalWeeks - 3, 1), 1);
  let longKm;
  if (isRaceWeek && isRacePlan) {
    longKm = Math.min(10, Math.round(peakLong * 0.35));
  } else if (weeksFromEnd === 1) {
    longKm = Math.round(peakLong * 0.60);
  } else if (weeksFromEnd === 2) {
    longKm = Math.round(peakLong * 0.80);
  } else {
    longKm = Math.round(peakLong * buildFrac);
  }

  const remaining    = weeklyKm - longKm;
  const easyPerRun   = Math.round(remaining / Math.max(nonLongDays.length, 1));
  const qualityKm    = Math.round(easyPerRun * 0.75); // quality sessions slightly shorter

  // Distance budget per type
  const distanceMap = {
    easy:        Math.max(3, easyPerRun),
    long:        Math.max(5, longKm),
    tempo:       Math.max(4, qualityKm),
    intervals:   Math.max(4, qualityKm),
    fartlek:     Math.max(4, easyPerRun),     // covers warmup + reps + cooldown
    hills:       Math.max(4, qualityKm),
    progression: Math.max(4, easyPerRun),
    cruise:      Math.max(5, qualityKm),
  };

  const sessions = [];
  const weekStart = addDays(planStart, (weekNum - 1) * 7);
  let nonLongIdx = 0;

  activeDays.forEach(day => {
    const type = day === effectiveLongRunDay ? 'long' : (nonLongTypes[nonLongIdx++] || 'easy');
    const dayOffset = ALL_DAYS.indexOf(day);
    const sessionDate = addDays(weekStart, dayOffset);

    sessions.push({
      dayOfWeek: day,
      type,
      name: sessionName(type, distanceMap[type], goal),
      description: sessionDescription(type, distanceMap[type], paceMap[type], goal),
      distanceKm: distanceMap[type],
      paceMinKm: paceMap[type],
      date: sessionDate,
    });
  });

  return sessions;
}

// ── Quality session type resolver ─────────────────────────────────────────────
//
// Rotates through session types as the plan progresses, matching the approach
// used in Hal Higdon Intermediate and Jack Daniels plans:
//   Early build  → fartlek (speed intro) + progression (tempo intro)
//   Mid build    → hill repeats (strength/VO2max) + tempo
//   Late build   → goal-specific intervals + tempo
//   Taper        → shorter quality — tempo only, no hard intervals
//   Race week    → easy runs across the board
//
function resolveQualityTypes(nonLongCount, buildPhase, goal, isRaceWeek, isTaper) {
  if (isRaceWeek) return Array(nonLongCount).fill('easy');

  let speedType, tempoType;

  if (isTaper) {
    // Taper: drop the interval session, keep one light tempo
    speedType = 'easy';
    tempoType = 'tempo';
  } else if (buildPhase < 0.35) {
    // Early build: gentle introduction to faster running
    speedType = 'fartlek';
    tempoType = 'progression';
  } else if (buildPhase < 0.65) {
    // Mid build: hill strength work + sustained tempo
    speedType = 'hills';
    tempoType = 'tempo';
  } else {
    // Late build: race-specific intervals + tempo
    speedType = goalIntervalType(goal);
    tempoType = 'tempo';
  }

  // Map types to day slots
  const templates = {
    1: [speedType],
    2: ['easy', tempoType],
    3: ['easy', speedType, tempoType],
    4: ['easy', speedType, 'easy', tempoType],
    5: ['easy', speedType, 'easy', tempoType, 'easy'],
  };
  return templates[Math.min(nonLongCount, 5)] || templates[2];
}

// Returns the most appropriate interval type for the goal race distance.
// Shorter races → shorter, faster reps. Longer races → longer threshold blocks.
function goalIntervalType(goal) {
  switch (goal) {
    case '5k':      return 'intervals';  // 400m reps at VO2max
    case '10k':     return 'intervals';  // 800m reps at VO2max
    case 'half':    return 'intervals';  // 1000m reps, slightly above threshold
    case 'marathon':return 'cruise';     // cruise intervals at threshold
    default:        return 'intervals';
  }
}

// ── Session naming ────────────────────────────────────────────────────────────

function sessionName(type, km, goal) {
  const names = {
    easy:        `Easy Run ${km}km`,
    long:        `Long Run ${km}km`,
    tempo:       `Tempo Run ${km}km`,
    progression: `Progression Run ${km}km`,
    fartlek:     `Fartlek ${km}km`,
    hills:       `Hill Repeats ${km}km`,
    intervals:   intervalSessionName(km, goal),
    cruise:      `Cruise Intervals ${km}km`,
  };
  return names[type] || `Run ${km}km`;
}

function intervalSessionName(km, goal) {
  switch (goal) {
    case '5k':   return `400m Intervals ${km}km`;
    case '10k':  return `800m Intervals ${km}km`;
    case 'half': return `1000m Intervals ${km}km`;
    default:     return `Intervals ${km}km`;
  }
}

// ── Session descriptions ──────────────────────────────────────────────────────

function sessionDescription(type, km, paceMinKm, goal) {
  const paceStr = formatPace(paceMinKm);

  switch (type) {
    case 'easy':
      return `Comfortable conversational pace. Target ${paceStr}/km. Effort should feel easy throughout — you should be able to speak in full sentences.`;

    case 'long':
      return `Your weekly long run at easy effort. Target ${paceStr}/km. Time on feet is the goal, not pace. Run at a pace you could sustain for hours. Stay relaxed and hydrate well.`;

    case 'tempo': {
      const tempoKm = Math.max(2, Math.round(km * 0.65)); // tempo block within the run
      return `Sustained threshold effort. Warm up 10–15 min easy, then run ${tempoKm}km at tempo pace (${paceStr}/km) — comfortably hard, able to speak only a few words. Cool down easy. Builds lactate threshold.`;
    }

    case 'progression':
      return `Progression run. Start at easy pace and gradually build across the run, finishing the final 15–20 min at tempo effort (${paceStr}/km). Great for teaching pace control and body awareness.`;

    case 'fartlek': {
      const reps = Math.max(4, Math.round((km - 2) * 1.5)); // reps within the run
      return `Fartlek (speed play). Run easy for 10 min as warmup, then alternate ${reps} × 1 min hard effort (near ${paceStr}/km) with 2 min easy recovery. Finish with 5–10 min easy cooldown. Keep the hard efforts controlled, not an all-out sprint.`;
    }

    case 'hills': {
      const reps = Math.max(5, Math.min(12, Math.round(km * 1.2)));
      return `Hill repeats. Find a moderate hill (5–8% grade, 60–90 sec to climb). Warm up 10 min easy on flat ground, then run ${reps} × hard uphill effort at near-maximum effort — drive your arms and stay tall. Jog back down as recovery. Cool down 10 min easy. Builds leg strength and VO2max without the joint stress of track intervals.`;
    }

    case 'intervals':
      return intervalDescription(km, paceStr, goal);

    case 'cruise': {
      const numBlocks = Math.max(2, Math.min(4, Math.round(km / 3.5)));
      const blockKm = Math.round((km * 0.7) / numBlocks * 10) / 10;
      return `Cruise intervals. Warm up 10–15 min easy, then run ${numBlocks} × ${blockKm}km at threshold pace (${paceStr}/km) with 60–90 sec easy jog recovery between blocks. Cool down easy. Threshold blocks build the ability to sustain marathon/half marathon race pace.`;
    }

    default:
      return `Run ${km}km at ${paceStr}/km.`;
  }
}

function intervalDescription(km, paceStr, goal) {
  switch (goal) {
    case '5k': {
      const reps = Math.min(14, Math.max(4, Math.round(km * 1000 / 600)));
      return `Track intervals. Warm up 10–15 min easy. Run ${reps} × 400m at target pace (${paceStr}/km) with 200m easy jog recovery between reps. Cool down 10 min easy. Fast 400s build VO2max and reinforce efficient running form. Focus on consistent splits — don't go out too hard.`;
    }
    case '10k': {
      const reps = Math.min(8, Math.max(3, Math.round(km * 1000 / 1100)));
      return `800m intervals. Warm up 10–15 min easy. Run ${reps} × 800m at target pace (${paceStr}/km) with 400m easy jog recovery. Cool down 10 min easy. 800m reps are the cornerstone of 10K training — they sharpen VO2max and teach you to run fast while fatigued.`;
    }
    case 'half': {
      const reps = Math.min(6, Math.max(3, Math.round(km * 1000 / 1400)));
      return `1000m intervals. Warm up 10–15 min easy. Run ${reps} × 1000m at target pace (${paceStr}/km) with 400m easy jog recovery. Cool down 10 min easy. Longer reps build the sustained speed needed for half marathon race pace.`;
    }
    default: {
      const reps = Math.min(10, Math.max(4, Math.round(km * 1000 / 700)));
      return `Track or road intervals. Warm up 10–15 min easy. Run ${reps} × 400m at target pace (${paceStr}/km) with 200m easy jog recovery. Cool down 10 min easy. Focus on consistent effort across all reps.`;
    }
  }
}

function formatPace(paceMinKm) {
  const mins = Math.floor(paceMinKm);
  const secs = Math.round((paceMinKm - mins) * 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function nextMonday() {
  const d = new Date();
  const day = d.getUTCDay();
  const daysUntilMonday = day === 1 ? 0 : (8 - day) % 7;
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  return toISODate(d);
}

function addDays(isoDate, days) {
  const d = new Date(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

module.exports = { buildOrUpdatePlan };
