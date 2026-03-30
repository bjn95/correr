// server.js — Correr backend
// Node.js + Express
// Run: npm start  (or npm run dev for hot-reload with nodemon)

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const session = require('express-session');
const db      = require('./db');
const { buildOrUpdatePlan } = require('./plan');

const stravaRouter  = require('./routes/strava');

const app  = express();
const PORT = process.env.PORT || 3001;

// Trust Railway's reverse proxy so secure cookies work over HTTPS
app.set('trust proxy', 1);

// ── Middleware ─────────────────────────────────────────────────────────────────

app.use(cors({
  origin: [
    'https://correr.app',
    'https://www.correr.app',
    'http://localhost:3000',
    'http://localhost:5500',  // local dev with live-server
  ],
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret:            process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge:   24 * 60 * 60 * 1000, // 24h
  },
}));

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Auth routes ────────────────────────────────────────────────────────────────
app.use('/auth/strava',  stravaRouter);

// Webhook routes (Strava uses GET for validation, POST for events)
app.use('/webhook', stravaRouter);

// ── Plan API ──────────────────────────────────────────────────────────────────

// POST /api/plan — save survey answers + generate plan
// Body: { goal, level, days, km, timeline, focus, userId? }
// If userId is provided and exists, updates that user's plan instead of creating a new one
// Returns: { userId, weeks, totalRuns, peakLongRun, startDate }
app.post('/api/plan', (req, res) => {
  const { goal, level, days, km, timeline, focus, planName } = req.body;
  const existingId = req.body.userId || req.session.correrUserId;
  const existing = existingId ? db.prepare('SELECT id FROM users WHERE id = ?').get(existingId) : null;

  let userId;
  if (existing) {
    db.prepare(`
      UPDATE users SET survey_goal=?, survey_level=?, survey_days=?, survey_km=?, survey_timeline=?, survey_focus=?, plan_name=?
      WHERE id=?
    `).run(goal, level, days || 3, km || 20, timeline, focus, planName || null, existing.id);
    userId = existing.id;
  } else {
    const result = db.prepare(`
      INSERT INTO users (survey_goal, survey_level, survey_days, survey_km, survey_timeline, survey_focus, plan_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(goal, level, days || 3, km || 20, timeline, focus, planName || null);
    userId = result.lastInsertRowid;
  }

  req.session.correrUserId = userId;
  const plan = buildOrUpdatePlan(userId, { goal, level, days, km, timeline, focus });

  res.json({ userId, ...plan });
});

// GET /api/plan?userId=xxx — get the plan workouts
app.get('/api/plan', (req, res) => {
  const userId = req.query.userId || req.session.correrUserId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const workouts = db.prepare(`
    SELECT * FROM plan_workouts
    WHERE user_id = ?
    ORDER BY week_number, scheduled_date
  `).all(userId);

  // Group by week
  const byWeek = {};
  for (const w of workouts) {
    if (!byWeek[w.week_number]) byWeek[w.week_number] = [];
    byWeek[w.week_number].push(w);
  }

  const summary = {
    weeks:       Math.max(...workouts.map(w => w.week_number), 0),
    totalRuns:   workouts.filter(w => w.workout_type !== 'rest').length,
    completed:   workouts.filter(w => w.completed).length,
    peakLongRun: Math.max(...workouts.filter(w => w.workout_type === 'long').map(w => w.target_distance_km), 0),
    stravaConnected: !!user.strava_access_token,
    stravaAthleteName: user.strava_athlete_name,
    planName: user.plan_name || null,
  };

  const survey = {
    goal:     user.survey_goal,
    level:    user.survey_level,
    days:     user.survey_days,
    km:       user.survey_km,
    timeline: user.survey_timeline,
    focus:    user.survey_focus,
  };

  res.json({ summary, workouts, byWeek, survey });
});

// GET /api/activities?userId=xxx — activities synced from Strava/Garmin
app.get('/api/activities', (req, res) => {
  const userId = req.query.userId || req.session.correrUserId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const activities = db.prepare(`
    SELECT id, source, name, sport_type, start_date,
           distance_m, moving_time_s, avg_pace_s_km, avg_heart_rate, calories
    FROM activities
    WHERE user_id = ?
    ORDER BY start_date DESC
    LIMIT 30
  `).all(userId);

  // Enrich with formatted pace
  const enriched = activities.map(a => ({
    ...a,
    distance_km:  a.distance_m ? (a.distance_m / 1000).toFixed(2) : null,
    pace_formatted: a.avg_pace_s_km ? formatPace(a.avg_pace_s_km) : null,
    duration_formatted: a.moving_time_s ? formatDuration(a.moving_time_s) : null,
  }));

  res.json(enriched);
});

// GET /api/progress?userId=xxx — weekly mileage summary for dashboard chart
app.get('/api/progress', (req, res) => {
  const userId = req.query.userId || req.session.correrUserId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  // Actual km per week from synced activities
  const actual = db.prepare(`
    SELECT
      strftime('%Y-%W', start_date) as week_key,
      ROUND(SUM(distance_m) / 1000.0, 1) as km
    FROM activities
    WHERE user_id = ? AND sport_type IN ('Run','VirtualRun','TrailRun')
    GROUP BY week_key
    ORDER BY week_key DESC
    LIMIT 12
  `).all(userId);

  // Planned km per week from plan
  const planned = db.prepare(`
    SELECT
      week_number,
      ROUND(SUM(target_distance_km), 1) as km
    FROM plan_workouts
    WHERE user_id = ? AND workout_type != 'rest'
    GROUP BY week_number
    ORDER BY week_number
  `).all(userId);

  res.json({ actual, planned });
});

// GET /api/profile?userId=xxx — full user profile (no tokens)
app.get('/api/profile', (req, res) => {
  const userId = req.query.userId || req.session.correrUserId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const activitiesCount = db.prepare(
    "SELECT COUNT(*) as c FROM activities WHERE user_id = ? AND source = 'strava'"
  ).get(userId)?.c || 0;

  const totalRuns = db.prepare(
    "SELECT COUNT(*) as c FROM plan_workouts WHERE user_id = ? AND workout_type != 'rest'"
  ).get(userId)?.c || 0;

  const completed = db.prepare(
    'SELECT COUNT(*) as c FROM plan_workouts WHERE user_id = ? AND completed = 1'
  ).get(userId)?.c || 0;

  res.json({
    id: user.id,
    createdAt: user.created_at,
    strava: {
      connected:    !!user.strava_access_token,
      athleteName:  user.strava_athlete_name || null,
      profilePic:   user.strava_profile_pic  || null,
      activitiesCount,
    },
    survey: {
      goal:     user.survey_goal,
      level:    user.survey_level,
      days:     user.survey_days,
      km:       user.survey_km,
      timeline: user.survey_timeline,
      focus:    user.survey_focus,
    },
    extra: {
      age:             user.age             || null,
      targetRaceName:  user.target_race_name || null,
      targetRaceDate:  user.target_race_date || null,
      targetRaceTime:  user.target_race_time || null,
    },
    pbs: {
      mile:     user.pb_1mile    || null,
      '5k':     user.pb_5k      || null,
      '10k':    user.pb_10k     || null,
      half:     user.pb_half    || null,
      marathon: user.pb_marathon || null,
    },
    stats: { totalRuns, completed },
  });
});

// PATCH /api/profile — update extra profile fields
app.patch('/api/profile', (req, res) => {
  const userId = req.body.userId || req.session.correrUserId;
  if (!userId) return res.status(401).json({ error: 'userId required' });

  const { age, targetRaceName, targetRaceDate, targetRaceTime,
          pb1mile, pb5k, pb10k, pbHalf, pbMarathon } = req.body;
  db.prepare(`
    UPDATE users SET
      age=?, target_race_name=?, target_race_date=?, target_race_time=?,
      pb_1mile=?, pb_5k=?, pb_10k=?, pb_half=?, pb_marathon=?
    WHERE id=?
  `).run(
    age || null, targetRaceName || null, targetRaceDate || null, targetRaceTime || null,
    pb1mile || null, pb5k || null, pb10k || null, pbHalf || null, pbMarathon || null,
    userId
  );

  res.json({ updated: true });
});

// PATCH /api/workout/:id/move — drag-and-drop a workout to a different day
app.patch('/api/workout/:id/move', (req, res) => {
  const workoutId = req.params.id;
  const { newDay, userId: bodyUserId } = req.body;
  const userId = bodyUserId || req.session.correrUserId;
  if (!userId) return res.status(401).json({ error: 'userId required' });

  const DAY_OFFSETS = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  if (!(newDay in DAY_OFFSETS)) return res.status(400).json({ error: 'Invalid day' });

  const workout = db.prepare('SELECT * FROM plan_workouts WHERE id = ? AND user_id = ?').get(workoutId, userId);
  if (!workout) return res.status(404).json({ error: 'Workout not found' });

  // Recalculate scheduled_date for the new day
  let newDate = null;
  if (workout.scheduled_date) {
    const d = new Date(workout.scheduled_date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - DAY_OFFSETS[workout.day_of_week] + DAY_OFFSETS[newDay]);
    newDate = d.toISOString().slice(0, 10);
  }

  // Check for an existing workout on the target day (swap if found)
  const conflict = db.prepare(
    'SELECT * FROM plan_workouts WHERE user_id = ? AND week_number = ? AND day_of_week = ? AND id != ?'
  ).get(userId, workout.week_number, newDay, workoutId);

  db.transaction(() => {
    db.prepare('UPDATE plan_workouts SET day_of_week = ?, scheduled_date = ? WHERE id = ?')
      .run(newDay, newDate, workoutId);
    if (conflict) {
      db.prepare('UPDATE plan_workouts SET day_of_week = ?, scheduled_date = ? WHERE id = ?')
        .run(workout.day_of_week, workout.scheduled_date, conflict.id);
    }
  })();

  const updated = db.prepare(
    'SELECT * FROM plan_workouts WHERE user_id = ? AND week_number = ? ORDER BY scheduled_date'
  ).all(userId, workout.week_number);

  res.json({ workouts: updated });
});

// PATCH /api/plan/rename — rename the user's plan
app.patch('/api/plan/rename', (req, res) => {
  const userId = req.body.userId || req.session.correrUserId;
  if (!userId) return res.status(401).json({ error: 'userId required' });
  const { planName } = req.body;
  db.prepare('UPDATE users SET plan_name = ? WHERE id = ?').run(planName || null, userId);
  res.json({ planName: planName || null });
});

// POST /api/workout/:id/toggle — mark a workout complete or incomplete
app.post('/api/workout/:id/toggle', (req, res) => {
  const workoutId = req.params.id;
  const userId = req.body.userId || req.session.correrUserId;
  if (!userId) return res.status(401).json({ error: 'userId required' });

  const workout = db.prepare('SELECT * FROM plan_workouts WHERE id = ? AND user_id = ?').get(workoutId, userId);
  if (!workout) return res.status(404).json({ error: 'Workout not found' });

  const newCompleted = workout.completed ? 0 : 1;
  db.prepare('UPDATE plan_workouts SET completed = ? WHERE id = ?').run(newCompleted, workoutId);
  res.json({ id: Number(workoutId), completed: newCompleted });
});

// GET /api/status?userId=xxx — connection status for both integrations
app.get('/api/status', (req, res) => {
  const userId = req.query.userId || req.session.correrUserId;
  if (!userId) return res.status(200).json({ connected: false });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(200).json({ connected: false });

  const activitiesCount = db.prepare(
    "SELECT COUNT(*) as c FROM activities WHERE user_id = ? AND source = 'strava'"
  ).get(userId)?.c || 0;

  res.json({
    userId: user.id,
    strava: {
      connected:       !!user.strava_access_token,
      athleteName:     user.strava_athlete_name || null,
      profilePic:      user.strava_profile_pic  || null,
      activitiesCount,
    },
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatPace(secondsPerKm) {
  const mins = Math.floor(secondsPerKm / 60);
  const secs = secondsPerKm % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🏃 Correr backend running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = app;
