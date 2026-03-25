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
const garminRouter  = require('./routes/garmin');

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
app.use('/auth/garmin',  garminRouter);

// Webhook routes (Strava uses GET for validation, POST for events)
app.use('/webhook', stravaRouter);

// ── Plan API ──────────────────────────────────────────────────────────────────

// POST /api/plan — save survey answers + generate plan
// Body: { goal, level, days, km, timeline, focus }
// Returns: { userId, weeks, totalRuns, peakLongRun, startDate }
app.post('/api/plan', (req, res) => {
  const { goal, level, days, km, timeline, focus } = req.body;

  // Create a new user row for this session
  const result = db.prepare(`
    INSERT INTO users (survey_goal, survey_level, survey_days, survey_km, survey_timeline, survey_focus)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(goal, level, days || 3, km || 20, timeline, focus);

  const userId = result.lastInsertRowid;
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
    garminConnected: !!user.garmin_oauth_token,
    stravaConnected: !!user.strava_access_token,
    stravaAthleteName: user.strava_athlete_name,
  };

  res.json({ summary, workouts, byWeek });
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
    garmin: {
      connected: !!user.garmin_oauth_token,
      userId:    user.garmin_user_id || null,
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
