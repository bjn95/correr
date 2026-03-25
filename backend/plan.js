// plan.js — Generates a structured running plan from survey answers
// and saves plan_workouts rows to the DB, ready for Garmin sync

const db = require('./db');

// Entry point — called from the /api/plan POST route
function buildOrUpdatePlan(userId, survey) {
  const {
    goal     = 'half',
    level    = 'casual',
    days     = 3,
    km       = 20,
    timeline = '12w',
    focus    = 'health',
  } = survey;

  // Derive plan parameters from survey
  const weeks       = { '4w': 4, '8w': 8, '12w': 12, '16w': 16, 'open': 10 }[timeline] || 12;
  const peakKm      = { '5k': 35, '10k': 50, 'half': 65, 'marathon': 80, 'general': 40 }[goal] || 65;
  const peakLongRun = { '5k': 8,  '10k': 12, 'half': 21, 'marathon': 32, 'general': 15 }[goal] || 21;

  // Base pace per km in minutes, adjusted for level
  const basePace = { beginner: 7.5, casual: 6.5, regular: 5.5, experienced: 4.5 }[level] || 6.5;

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

    const schedule = buildWeekSchedule(w, weeks, days, weeklyKm, peakLongRun, basePace, focus, startDate);

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

function buildWeekSchedule(weekNum, totalWeeks, daysPerWeek, weeklyKm, peakLong, basePace, focus, planStart) {

  // Taper in the last 2 weeks
  const isTaper = weekNum > totalWeeks - 2;

  // The 7 days of the week with preferred session types
  // We build a template then pick based on daysPerWeek
  const DAY_TEMPLATES = {
    2: ['long', 'easy'],
    3: ['easy', 'long', 'easy'],
    4: ['easy', 'tempo', 'long', 'easy'],
    5: ['easy', 'tempo', 'easy', 'long', 'easy'],
    6: ['easy', 'tempo', 'easy', 'intervals', 'long', 'easy'],
  };

  const sessionTypes = DAY_TEMPLATES[Math.min(daysPerWeek, 6)] || DAY_TEMPLATES[3];

  // Days of the week, starting Monday. We spread sessions across the week.
  const ALL_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const PREFERRED_DAYS = {
    2: ['Mon', 'Sat'],
    3: ['Mon', 'Wed', 'Sat'],
    4: ['Mon', 'Tue', 'Thu', 'Sat'],
    5: ['Mon', 'Tue', 'Wed', 'Thu', 'Sat'],
    6: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  };

  const activeDays = PREFERRED_DAYS[Math.min(daysPerWeek, 6)] || PREFERRED_DAYS[3];

  // Distribute weekly km across session types
  const longKm      = Math.min(peakLong * (weekNum / totalWeeks), peakLong);
  const remaining   = weeklyKm - longKm;
  const easyPerRun  = Math.round(remaining / Math.max(sessionTypes.filter(t => t === 'easy').length, 1));
  const tempoKm     = Math.round(easyPerRun * 0.8);
  const intervalsKm = Math.round(easyPerRun * 0.7);

  const distanceMap = {
    easy:      Math.max(3, Math.round(isTaper ? easyPerRun * 0.7 : easyPerRun)),
    tempo:     Math.max(3, Math.round(isTaper ? tempoKm * 0.8    : tempoKm)),
    intervals: Math.max(3, Math.round(isTaper ? intervalsKm * 0.7 : intervalsKm)),
    long:      Math.max(5, Math.round(isTaper ? longKm * 0.6      : longKm)),
  };

  // Pace targets — tempo is faster, intervals faster still, easy/long slower
  const paceMap = {
    easy:      basePace + 1.0,
    long:      basePace + 0.8,
    tempo:     basePace - 0.5,
    intervals: basePace - 1.0,
  };

  const sessions = [];

  // Week start date
  const weekStart = addDays(planStart, (weekNum - 1) * 7);

  activeDays.forEach((day, idx) => {
    const type = sessionTypes[idx] || 'easy';
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
