// plan.js — Structured running plan generator
//
// Distance hierarchy guardrail (enforced every week):
//   long run > easy run >= quality run (tempo / intervals / etc.)
//
// All non-long session distances are derived as fractions of the long run
// so the hierarchy can never be violated by the mileage build-up logic.
//
// Race week always has exactly two entries:
//   1. Pre-race shakeout (5 km easy, two days before race)
//   2. Race Day entry (on the actual race date, if known)

const db = require('./db');

// ── Pace derivation ───────────────────────────────────────────────────────────

const RACE_DIST_KM = { '5k': 5, '10k': 10, 'half': 21.0975, 'marathon': 42.195 };

function deriveTargetPaces(paceDistance, paceTimeSecs) {
  const distKm = RACE_DIST_KM[paceDistance];
  if (!distKm || !paceTimeSecs || paceTimeSecs <= 0) return null;

  const minTimeSecs = { '5k': 720, '10k': 1500, 'half': 3300, 'marathon': 7200 }[paceDistance];
  const maxTimeSecs = { '5k': 3600, '10k': 7200, 'half': 14400, 'marathon': 28800 }[paceDistance];
  if (paceTimeSecs < minTimeSecs || paceTimeSecs > maxTimeSecs) return null;

  const t5kSecs     = paceTimeSecs * Math.pow(5 / distKm, 1.06);
  const pace5kSecKm = t5kSecs / 5;

  return {
    easy:      Math.round(pace5kSecKm * 1.36),
    long:      Math.round(pace5kSecKm * 1.30),
    tempo:     Math.round(pace5kSecKm * 1.10),
    intervals: Math.round(pace5kSecKm * 0.98),
  };
}

const LEVEL_PACES = {
  beginner:   { easy: 480, long: 450, tempo: 360, intervals: 300 },
  casual:     { easy: 390, long: 360, tempo: 300, intervals: 240 },
  regular:    { easy: 330, long: 312, tempo: 264, intervals: 210 },
  experienced:{ easy: 288, long: 270, tempo: 228, intervals: 180 },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

function weekdayName(isoDate) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[new Date(isoDate + 'T00:00:00Z').getUTCDay()];
}

// ── Entry point ────────────────────────────────────────────────────────────────

function buildOrUpdatePlan(userId, survey) {
  const {
    goal          = 'half',
    level         = 'casual',
    days          = 3,
    km            = 20,
    timeline      = '12w',
    preferredDays = null,
    longRunDay    = null,
    paceDistance  = null,
    paceTimeSecs  = null,
    raceDate      = null,
  } = survey;

  // Weeks: exact race date wins over duration dropdown
  let weeks;
  if (raceDate) {
    const startMs        = new Date(nextMonday()).getTime();
    const weeksUntilRace = Math.round((new Date(raceDate).getTime() - startMs) / (7 * 24 * 60 * 60 * 1000));
    weeks = clamp(weeksUntilRace, 4, 24);
  } else {
    weeks = { '4w': 4, '8w': 8, '12w': 12, '16w': 16, 'open': 10 }[timeline] || 12;
  }

  // Peak long run by goal distance (km)
  const peakLongRun = { '5k': 8, '10k': 12, 'half': 21, 'marathon': 32, 'general': 14 }[goal] || 21;

  // Peak weekly km — scaled to realistic values for typical day counts
  // These are targets; actual session sizes are derived from peakLongRun, not this.
  const peakKm = { '5k': 30, '10k': 42, 'half': 55, 'marathon': 72, 'general': 35 }[goal] || 55;

  const isRacePlan  = !!(raceDate || ['5k', '10k', 'half', 'marathon'].includes(goal));
  const targetPaces = deriveTargetPaces(paceDistance, paceTimeSecs)
    || LEVEL_PACES[level]
    || LEVEL_PACES.casual;
  const startDate   = nextMonday();
  const startKm     = Math.max(0, km || 0); // user's current weekly km

  db.prepare('DELETE FROM plan_workouts WHERE user_id = ?').run(userId);

  const insert = db.prepare(`
    INSERT INTO plan_workouts (
      user_id, week_number, day_of_week, workout_type, name, description,
      target_distance_km, target_pace_min_km, scheduled_date
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `);

  for (let w = 1; w <= weeks; w++) {
    const sessions = buildWeekSchedule({
      weekNum: w, totalWeeks: weeks, days, startKm, peakKm, peakLong: peakLongRun,
      targetPaces, goal, planStart: startDate, preferredDays, longRunDay,
      isRacePlan, raceDate,
    });

    for (const s of sessions) {
      insert.run(userId, w, s.dayOfWeek, s.type, s.name, s.description,
                 s.distanceKm, s.paceMinKm, s.date);
    }
  }

  const totalRuns = db.prepare(
    "SELECT COUNT(*) as c FROM plan_workouts WHERE user_id = ? AND workout_type NOT IN ('rest','race')"
  ).get(userId).c;

  return { weeks, totalRuns, peakLongRun, startDate };
}

// ── Week schedule builder ─────────────────────────────────────────────────────

function buildWeekSchedule({ weekNum, totalWeeks, days, startKm, peakKm, peakLong,
                              targetPaces, goal, planStart, preferredDays, longRunDay,
                              isRacePlan, raceDate }) {

  const weeksFromEnd = totalWeeks - weekNum;
  const isRaceWeek   = weeksFromEnd === 0 && isRacePlan;

  // Build phase: 0.0 (week 1) → 1.0 (last build week before taper)
  const buildWeeks = Math.max(totalWeeks - 3, 1);
  const buildPhase = clamp((weekNum - 1) / buildWeeks, 0, 1);

  // ── Pace setup ────────────────────────────────────────────────────────────
  // Quality sessions ease off target in early weeks, sharpen as plan progresses
  const progressFrac   = buildPhase;
  const tempoSlack     = Math.round((1 - progressFrac) * 20);
  const intervalsSlack = Math.round((1 - progressFrac) * 25);
  const secToMin = s => s / 60;

  const paceMap = {
    easy:        secToMin(targetPaces.easy),
    long:        secToMin(targetPaces.long),
    tempo:       secToMin(targetPaces.tempo     + tempoSlack),
    intervals:   secToMin(targetPaces.intervals + intervalsSlack),
    fartlek:     secToMin(targetPaces.easy),
    hills:       secToMin(targetPaces.intervals + intervalsSlack),
    progression: secToMin(targetPaces.tempo     + tempoSlack),
    cruise:      secToMin(targetPaces.tempo     + tempoSlack),
    shakeout:    secToMin(targetPaces.easy),
  };

  // ── Day resolution ────────────────────────────────────────────────────────
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
    : (DEFAULT_DAYS[clamp(days, 2, 6)] || DEFAULT_DAYS[3]);

  const effectiveLongRunDay = (longRunDay && activeDays.includes(longRunDay))
    ? longRunDay
    : activeDays[activeDays.length - 1];

  // ── Race week: shakeout + race day only ───────────────────────────────────
  if (isRaceWeek) {
    return buildRaceWeekSessions({ weekNum, totalWeeks, planStart, raceDate, goal, paceMap });
  }

  // ── Long run km for this week ─────────────────────────────────────────────
  // Starts at ~30% of peakLong (or user's current fitness) and grows to 100%.
  // Every 3rd build week is a recovery week at ~80% of the previous.
  const startLong  = clamp(Math.round(Math.max(startKm, 15) * 0.32), 5, Math.round(peakLong * 0.38));
  const isCutback  = weekNum > 3 && (weekNum - 1) % 3 === 2 && weeksFromEnd > 2;
  let   longKm;

  if (weeksFromEnd === 1) {
    longKm = Math.round(peakLong * 0.60);
  } else if (weeksFromEnd === 2) {
    longKm = Math.round(peakLong * 0.80);
  } else if (isCutback) {
    const prevPhase = clamp((weekNum - 2) / buildWeeks, 0, 1);
    longKm = Math.round((startLong + (peakLong - startLong) * prevPhase) * 0.80);
  } else {
    longKm = Math.round(startLong + (peakLong - startLong) * buildPhase);
  }
  longKm = Math.max(6, longKm);

  // ── Non-long session distances (guardrailed against long run) ─────────────
  //
  // Rule: long > easy >= quality (tempo/intervals/etc.)
  //
  // Easy:    55–60 % of long run, capped at 15 km
  // Quality: 85 % of easy (slightly shorter — these are harder sessions)
  //
  const easyKm    = clamp(Math.round(longKm * 0.58), 4, Math.min(15, longKm - 2));
  const qualityKm = clamp(Math.round(easyKm  * 0.85), 4, easyKm);

  // Explicit type→distance map — every type maps to easy or quality tier
  const distanceMap = {
    easy:        easyKm,
    long:        longKm,
    tempo:       qualityKm,
    intervals:   Math.max(4, Math.round(qualityKm * 0.90)),
    fartlek:     easyKm,          // warmup + efforts + cooldown = easy-length session
    hills:       qualityKm,
    progression: easyKm,          // easy-start + tempo-finish = easy-length total
    cruise:      qualityKm,
  };

  // Final guardrail assertion: long must be strictly the longest session
  distanceMap.long = Math.max(distanceMap.long, distanceMap.easy + 2);

  // ── Quality session type for this week ────────────────────────────────────
  const nonLongDays  = activeDays.filter(d => d !== effectiveLongRunDay);
  const nonLongTypes = resolveQualityTypes(nonLongDays.length, buildPhase, goal, false, weeksFromEnd <= 2);

  // ── Build session list ────────────────────────────────────────────────────
  const sessions    = [];
  const weekStart   = addDays(planStart, (weekNum - 1) * 7);
  let   nonLongIdx  = 0;

  activeDays.forEach(day => {
    const type    = day === effectiveLongRunDay ? 'long' : (nonLongTypes[nonLongIdx++] || 'easy');
    const dayOff  = ALL_DAYS.indexOf(day);
    sessions.push({
      dayOfWeek:   day,
      type,
      name:        sessionName(type, distanceMap[type], goal),
      description: sessionDescription(type, distanceMap[type], paceMap[type], goal),
      distanceKm:  distanceMap[type],
      paceMinKm:   paceMap[type],
      date:        addDays(weekStart, dayOff),
    });
  });

  return sessions;
}

// ── Race week sessions ────────────────────────────────────────────────────────

function buildRaceWeekSessions({ weekNum, totalWeeks, planStart, raceDate, goal, paceMap }) {
  const ALL_DAYS  = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const weekStart = addDays(planStart, (weekNum - 1) * 7);
  const sessions  = [];

  // Shakeout: 2 days before race date (defaults to Friday if no race date)
  let shakeoutDate, shakeoutDay;
  if (raceDate) {
    shakeoutDate = addDays(raceDate, -2);
    // If shakeout falls before the start of race week, push to Monday
    if (shakeoutDate < weekStart) shakeoutDate = weekStart;
    shakeoutDay = weekdayName(shakeoutDate);
  } else {
    shakeoutDate = addDays(weekStart, 4); // Friday
    shakeoutDay  = 'Fri';
  }

  sessions.push({
    dayOfWeek:   shakeoutDay,
    type:        'shakeout',
    name:        'Pre-Race Shakeout',
    description: 'A very light 20–30 min jog two days before race day — keep it genuinely easy. The goal is to flush out any stiffness and keep your legs feeling sharp, not to add fitness. Include 4–6 × 10-second gentle strides at the end to wake up your fast-twitch fibres. Then rest tomorrow.',
    distanceKm:  5,
    paceMinKm:   paceMap.shakeout,
    date:        shakeoutDate,
  });

  // Race day entry — only if we know the exact date
  if (raceDate) {
    const raceDay      = weekdayName(raceDate);
    const raceDistKm   = { '5k': 5, '10k': 10, 'half': 21.1, 'marathon': 42.2 }[goal] || null;
    const raceDistText = raceDistKm ? `${raceDistKm}km` : 'your race';
    sessions.push({
      dayOfWeek:   raceDay,
      type:        'race',
      name:        raceDistKm ? `Race Day — ${raceDistText}` : 'Race Day',
      description: `Race day! Warm up gently for 10–15 min at easy pace — don't skip this. Line up, start conservatively (the first kilometre always feels easy; resist the urge to go with the crowd), then build into your race. Trust your training. You've done the work.`,
      distanceKm:  raceDistKm || 0,
      paceMinKm:   null,
      date:        raceDate,
    });
  }

  return sessions;
}

// ── Quality session type resolver ─────────────────────────────────────────────
//
// Phases follow Hal Higdon / Jack Daniels methodology:
//   Early build  (0–35%): fartlek + progression — gentle introduction to faster work
//   Mid build   (35–65%): hill repeats + tempo — leg strength and threshold base
//   Late build    (65%+): goal-specific intervals + tempo — race-specific sharpening
//   Taper (last 3 weeks): easy + light tempo — no hard interval sessions
//   Race week:            handled separately by buildRaceWeekSessions
//
function resolveQualityTypes(nonLongCount, buildPhase, goal, isRaceWeek, isTaper) {
  if (isRaceWeek) return Array(nonLongCount).fill('easy');

  let speedType, tempoType;
  if (isTaper) {
    speedType = 'easy';
    tempoType = 'tempo';
  } else if (buildPhase < 0.35) {
    speedType = 'fartlek';
    tempoType = 'progression';
  } else if (buildPhase < 0.65) {
    speedType = 'hills';
    tempoType = 'tempo';
  } else {
    speedType = goalIntervalType(goal);
    tempoType = 'tempo';
  }

  const templates = {
    1: [speedType],
    2: ['easy', tempoType],
    3: ['easy', speedType, tempoType],
    4: ['easy', speedType, 'easy', tempoType],
    5: ['easy', speedType, 'easy', tempoType, 'easy'],
  };
  return templates[clamp(nonLongCount, 1, 5)] || templates[2];
}

function goalIntervalType(goal) {
  if (goal === 'marathon') return 'cruise';
  return 'intervals'; // 5k/10k/half → distance-specific reps in sessionDescription
}

// ── Session naming ────────────────────────────────────────────────────────────

function sessionName(type, km, goal) {
  switch (type) {
    case 'easy':        return `Easy Run ${km}km`;
    case 'long':        return `Long Run ${km}km`;
    case 'tempo':       return `Tempo Run ${km}km`;
    case 'progression': return `Progression Run ${km}km`;
    case 'fartlek':     return `Fartlek ${km}km`;
    case 'hills':       return `Hill Repeats ${km}km`;
    case 'cruise':      return `Cruise Intervals ${km}km`;
    case 'intervals':   return intervalSessionName(km, goal);
    default:            return `Run ${km}km`;
  }
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
  const paceStr = paceMinKm ? formatPace(paceMinKm) : null;

  switch (type) {
    case 'easy':
      return `Comfortable conversational pace${paceStr ? ` — target ${paceStr}/km` : ''}. Effort should feel easy throughout; you should be able to speak in full sentences. If in doubt, slow down.`;

    case 'long':
      return `Your weekly long run at easy effort${paceStr ? ` — target ${paceStr}/km` : ''}. Time on feet is the goal, not pace. Run at a pace you could sustain all day. Bring water or plan a route past fountains.`;

    case 'tempo': {
      const block = Math.max(2, Math.round(km * 0.60));
      return `Sustained threshold effort. Warm up 10 min easy, then run ${block}km at tempo pace${paceStr ? ` (${paceStr}/km)` : ''} — comfortably hard, you can speak only a few words. Cool down 10 min easy. Builds lactate threshold.`;
    }

    case 'progression':
      return `Progression run. Start at easy pace and gradually increase effort across the run, finishing the final 15–20 min at tempo effort${paceStr ? ` (${paceStr}/km target)` : ''}. Teaches pace control and how to run strong when tired.`;

    case 'fartlek': {
      const reps = clamp(Math.round((km - 2) * 1.5), 4, 10);
      return `Fartlek (speed play). Warm up 10 min easy, then run ${reps} × 1 min hard effort / 2 min easy recovery${paceStr ? `. Hard pace target: ${paceStr}/km` : ''}. Finish 5–10 min easy. Keep hard efforts controlled — not a sprint.`;
    }

    case 'hills': {
      const reps = clamp(Math.round(km * 1.1), 5, 12);
      return `Hill repeats. Find a 5–8% gradient hill (60–90 sec to climb). Warm up 10 min easy on flat. Run ${reps} × hard uphill effort — drive your arms, stay tall, push through the top. Jog back down as full recovery. Cool down 10 min easy. Builds leg strength and VO2max.`;
    }

    case 'intervals':
      return intervalDescription(km, paceStr, goal);

    case 'cruise': {
      const blocks = clamp(Math.round(km / 3), 2, 4);
      const blockKm = Math.round((km * 0.70) / blocks * 10) / 10;
      return `Cruise intervals. Warm up 10–15 min easy. Run ${blocks} × ${blockKm}km at threshold pace${paceStr ? ` (${paceStr}/km)` : ''} with 90 sec easy jog recovery. Cool down easy. Longer threshold blocks train your body to sustain race pace for extended periods.`;
    }

    default:
      return `Run ${km}km${paceStr ? ` at ${paceStr}/km` : ''}.`;
  }
}

function intervalDescription(km, paceStr, goal) {
  switch (goal) {
    case '5k': {
      const reps = clamp(Math.round(km * 1000 / 600), 4, 14);
      return `Track intervals. Warm up 10–15 min easy. Run ${reps} × 400m${paceStr ? ` at ${paceStr}/km` : ''} with 200m easy jog recovery. Cool down 10 min easy. Short, fast reps build VO2max and reinforce efficient form. Run consistent splits — don't go out too hard.`;
    }
    case '10k': {
      const reps = clamp(Math.round(km * 1000 / 1100), 3, 8);
      return `800m intervals. Warm up 10–15 min easy. Run ${reps} × 800m${paceStr ? ` at ${paceStr}/km` : ''} with 400m easy jog recovery. Cool down 10 min easy. 800m reps are the cornerstone of 10K training — they sharpen VO2max and teach you to hold pace when fatigued.`;
    }
    case 'half': {
      const reps = clamp(Math.round(km * 1000 / 1400), 3, 6);
      return `1000m intervals. Warm up 10–15 min easy. Run ${reps} × 1000m${paceStr ? ` at ${paceStr}/km` : ''} with 400m easy jog recovery. Cool down 10 min easy. Longer reps develop the sustained speed needed at half marathon effort.`;
    }
    default: {
      const reps = clamp(Math.round(km * 1000 / 700), 4, 10);
      return `Track or road intervals. Warm up 10–15 min easy. Run ${reps} × 400m${paceStr ? ` at ${paceStr}/km` : ''} with 200m easy jog recovery. Cool down 10 min easy. Focus on consistent effort across all reps.`;
    }
  }
}

function formatPace(paceMinKm) {
  if (!paceMinKm) return null;
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
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

module.exports = { buildOrUpdatePlan };
