// plan.js — Generates a structured running plan from survey answers
// and saves plan_workouts rows to the DB, ready for Garmin sync

const db = require('./db');

// ── Pace derivation ───────────────────────────────────────────────────────────

const RACE_DIST_KM = { '5k': 5, '10k': 10, 'half': 21.0975, 'marathon': 42.195 };

// Riegel formula: predict 5K time from any race result, then derive training paces (sec/km)
function deriveTargetPaces(paceDistance, paceTimeSecs) {
  const distKm = RACE_DIST_KM[paceDistance];
  if (!distKm || !paceTimeSecs || paceTimeSecs <= 0) return null;

  // Sanity bounds (wildly unrealistic times → ignore)
  const minTimeSecs = { '5k': 720, '10k': 1500, 'half': 3300, 'marathon': 7200 }[paceDistance];
  const maxTimeSecs = { '5k': 3600, '10k': 7200, 'half': 14400, 'marathon': 28800 }[paceDistance];
  if (paceTimeSecs < minTimeSecs || paceTimeSecs > maxTimeSecs) return null;

  // Riegel: T_5k = T * (5 / D)^1.06
  const t5kSecs = paceTimeSecs * Math.pow(5 / distKm, 1.06);
  const pace5kSecKm = t5kSecs / 5; // seconds per km at 5K effort

  return {
    easy:      Math.round(pace5kSecKm * 1.36), // comfortable aerobic
    long:      Math.round(pace5kSecKm * 1.30), // long run easy effort
    tempo:     Math.round(pace5kSecKm * 1.10), // lactate threshold
    intervals: Math.round(pace5kSecKm * 0.98), // close to 5K race pace
  };
}

// Level-based fallback paces (sec/km)
const LEVEL_PACES = {
  beginner:   { easy: 480, long: 450, tempo: 360, intervals: 300 }, // ~8:00 easy
  casual:     { easy: 390, long: 360, tempo: 300, intervals: 240 }, // ~6:30 easy
  regular:    { easy: 330, long: 312, tempo: 264, intervals: 210 }, // ~5:30 easy
  experienced:{ easy: 288, long: 270, tempo: 228, intervals: 180 }, // ~4:48 easy
};

// Entry point — called from the /api/plan POST route
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
  } = survey;

  // Derive plan parameters from survey
  const weeks       = { '4w': 4, '8w': 8, '12w': 12, '16w': 16, 'open': 10 }[timeline] || 12;
  const peakKm      = { '5k': 35, '10k': 50, 'half': 65, 'marathon': 80, 'general': 40 }[goal] || 65;
  const peakLongRun = { '5k': 8,  '10k': 12, 'half': 21, 'marathon': 32, 'general': 15 }[goal] || 21;

  // Derive target training paces — from race time if provided, else level-based
  const targetPaces = deriveTargetPaces(paceDistance, paceTimeSecs)
    || LEVEL_PACES[level]
    || LEVEL_PACES.casual;

  // Calculate start date (next Monday)
  const startDate = nextMonday();

  // Delete any existing plan for this user before regenerating
  db.prepare('DELETE FROM plan_workouts WHERE user_id = ?').run(userId);

  const insertWorkout = db.prepare(`
    INSERT INTO plan_workouts (
      user_id, week_number, day_of_week, workout_type, name, description,
      target_distance_km, target_pace_min_km, scheduled_date
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `);

  // Weekly mileage progresses from current km to peak, with a cutback every 4th week
  for (let w = 1; w <= weeks; w++) {
    const isCutback = w % 4 === 0 && w !== weeks;
    const progressFraction = isCutback ? 0.8 : w / weeks;
    const weeklyKm = Math.round(km + (peakKm - km) * progressFraction);

    const schedule = buildWeekSchedule(
      w, weeks, days, weeklyKm, peakLongRun,
      targetPaces, focus, startDate, preferredDays, longRunDay
    );

    for (const session of schedule) {
      insertWorkout.run(
        userId,
        w,
        session.dayOfWeek,
        session.type,
        session.name,
        session.description,
        session.distanceKm,
        session.paceMinKm,
        session.date,
      );
    }
  }

  // Return summary for the API response
  const totalRuns = db.prepare(
    "SELECT COUNT(*) as c FROM plan_workouts WHERE user_id = ? AND workout_type != 'rest'"
  ).get(userId).c;

  return {
    weeks,
    totalRuns,
    peakLongRun,
    startDate,
  };
}

// ── Week schedule builder ─────────────────────────────────────────────────────

function buildWeekSchedule(weekNum, totalWeeks, daysPerWeek, weeklyKm, peakLong, targetPaces, focus, planStart, preferredDays, longRunDay) {

  // Taper in the last 2 weeks
  const isTaper = weekNum > totalWeeks - 2;

  // Pace progression: quality sessions start conservatively and build to target
  // Easy/long paces stay stable — the effort adapts naturally with fitness
  // Progress reaches 1.0 at the first taper week, then holds
  const buildWeeks = Math.max(totalWeeks - 2, 1);
  const progressFrac = Math.min((weekNum - 1) / buildWeeks, 1.0);
  // Early weeks add slack (sec/km) to tempo and intervals; it reduces to 0 at target
  const tempoSlack     = Math.round((1 - progressFrac) * 20); // starts 20s/km slow
  const intervalsSlack = Math.round((1 - progressFrac) * 25); // starts 25s/km slow

  // Week paces (sec/km) — convert to min/km for storage
  const secToMin = s => s / 60;
  const paceMap = {
    easy:      secToMin(targetPaces.easy),
    long:      secToMin(targetPaces.long),
    tempo:     secToMin(targetPaces.tempo     + tempoSlack),
    intervals: secToMin(targetPaces.intervals + intervalsSlack),
  };

  const ALL_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // Resolve active days — use user-specified days if provided, else defaults
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

  // Resolve long run day — use user-specified if it's in activeDays, else last day
  const effectiveLongRunDay = (longRunDay && activeDays.includes(longRunDay))
    ? longRunDay
    : activeDays[activeDays.length - 1];

  // Session type templates by day count (for non-long sessions)
  const NON_LONG_TYPES = {
    1: [],
    2: ['easy'],
    3: ['easy', 'easy'],
    4: ['easy', 'tempo', 'easy'],
    5: ['easy', 'tempo', 'easy', 'easy'],
    6: ['easy', 'tempo', 'easy', 'intervals', 'easy'],
  };

  const nonLongDays  = activeDays.filter(d => d !== effectiveLongRunDay);
  const nonLongTypes = NON_LONG_TYPES[Math.min(nonLongDays.length, 6)] || NON_LONG_TYPES[2];

  // Distribute weekly km across session types
  const longKm      = Math.min(peakLong * (weekNum / totalWeeks), peakLong);
  const remaining   = weeklyKm - longKm;
  const easyPerRun  = Math.round(remaining / Math.max(nonLongDays.length, 1));
  const tempoKm     = Math.round(easyPerRun * 0.8);
  const intervalsKm = Math.round(easyPerRun * 0.7);

  const distanceMap = {
    easy:      Math.max(3, Math.round(isTaper ? easyPerRun * 0.7 : easyPerRun)),
    tempo:     Math.max(3, Math.round(isTaper ? tempoKm * 0.8    : tempoKm)),
    intervals: Math.max(3, Math.round(isTaper ? intervalsKm * 0.7 : intervalsKm)),
    long:      Math.max(5, Math.round(isTaper ? longKm * 0.6      : longKm)),
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
      name: sessionName(type, distanceMap[type], weekNum),
      description: sessionDescription(type, distanceMap[type], paceMap[type]),
      distanceKm: distanceMap[type],
      paceMinKm: paceMap[type],
      date: sessionDate,
    });
  });

  return sessions;
}

// ── Naming helpers ────────────────────────────────────────────────────────────

function sessionName(type, km, week) {
  const names = {
    easy:      `Easy Run ${km}km`,
    long:      `Long Run ${km}km`,
    tempo:     `Tempo Run ${km}km`,
    intervals: `Intervals ${km}km`,
  };
  return names[type] || `Run ${km}km`;
}

function sessionDescription(type, km, paceMinKm) {
  const paceStr = formatPace(paceMinKm);
  const descriptions = {
    easy: `Comfortable conversational pace. Target ${paceStr}/km. Focus on keeping effort low — you should be able to hold a conversation throughout.`,
    long: `Your weekly long run at easy effort. Target ${paceStr}/km. The goal is time on feet, not speed. Stay relaxed and consistent.`,
    tempo: `Comfortably hard effort — you can speak a few words but not hold a conversation. Target ${paceStr}/km. Builds lactate threshold.`,
    intervals: `Track or road intervals. ${Math.round(km * 1000 / 600)} × 400m repeats with 200m easy jog recovery. Target interval pace ${paceStr}/km.`,
  };
  return descriptions[type] || `Run ${km}km at ${paceStr}/km.`;
}

function formatPace(paceMinKm) {
  const mins = Math.floor(paceMinKm);
  const secs = Math.round((paceMinKm - mins) * 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function nextMonday() {
  const d = new Date();
  const day = d.getUTCDay(); // 0 = Sun, 1 = Mon
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
