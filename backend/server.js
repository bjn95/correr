// server.js — Correr backend
// Node.js + Express
// Run: npm start  (or npm run dev for hot-reload with nodemon)

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const session = require('express-session');
const db      = require('./db');
const { buildOrUpdatePlan } = require('./plan');

const { router: stravaRouter, matchAllActivitiesToPlan } = require('./routes/strava');

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
// Body: { goal, longestRun, days, timeline, userId? }
// If userId is provided and exists, updates that user's plan instead of creating a new one
// Returns: { userId, weeks, totalRuns, peakLongRun, startDate }
app.post('/api/plan', (req, res) => {
  const { goal, longestRun, days, timeline, planName, preferredDays, longRunDay, paceDistance, paceTimeSecs, raceDate, targetTimeSecs, currentRunDays } = req.body;
  const existingId = req.body.userId || req.session.correrUserId;
  const existing = existingId ? db.prepare('SELECT id FROM users WHERE id = ?').get(existingId) : null;

  const preferredDaysJson = preferredDays ? JSON.stringify(preferredDays) : null;

  let userId;
  if (existing) {
    db.prepare(`
      UPDATE users SET survey_goal=?, survey_level=?, survey_days=?, survey_timeline=?, plan_name=?,
        survey_preferred_days=?, survey_long_run_day=?, survey_pace_distance=?, survey_pace_time_s=?, target_race_date=?, survey_target_time_s=?, survey_current_days=?
      WHERE id=?
    `).run(goal, longestRun, days || 3, timeline, planName || null,
           preferredDaysJson, longRunDay || null, paceDistance || null, paceTimeSecs || null, raceDate || null, targetTimeSecs || null, currentRunDays ?? null, existing.id);
    userId = existing.id;
  } else {
    const result = db.prepare(`
      INSERT INTO users (survey_goal, survey_level, survey_days, survey_timeline, plan_name,
        survey_preferred_days, survey_long_run_day, survey_pace_distance, survey_pace_time_s, target_race_date, survey_target_time_s, survey_current_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(goal, longestRun, days || 3, timeline, planName || null,
           preferredDaysJson, longRunDay || null, paceDistance || null, paceTimeSecs || null, raceDate || null, targetTimeSecs || null, currentRunDays ?? null);
    userId = result.lastInsertRowid;
  }

  req.session.correrUserId = userId;

  // Find or create the user's single AI plan record
  let aiPlan = db.prepare('SELECT id FROM plans WHERE user_id = ? AND type = ? ORDER BY created_at ASC LIMIT 1').get(userId, 'ai');
  if (!aiPlan) {
    const r = db.prepare('INSERT INTO plans (user_id, name, type) VALUES (?,?,?)').run(userId, planName || 'AI Smart Plan', 'ai');
    aiPlan = { id: r.lastInsertRowid };
  } else if (planName) {
    db.prepare('UPDATE plans SET name = ? WHERE id = ?').run(planName, aiPlan.id);
  }

  const plan = buildOrUpdatePlan(userId, { goal, longestRun, days, timeline, preferredDays, longRunDay, paceDistance, paceTimeSecs, raceDate, planName }, aiPlan.id);

  // Re-link existing Strava activities to the freshly generated workouts
  const hasStrava = db.prepare('SELECT strava_id FROM users WHERE id = ?').get(userId)?.strava_id;
  if (hasStrava) matchAllActivitiesToPlan(userId);

  res.json({ userId, planId: aiPlan.id, ...plan });
});

// POST /api/plan/custom — save a manually designed plan
app.post('/api/plan/custom', (req, res) => {
  try {
    const { planName, startDate, workouts } = req.body;
    const existingId = req.body.userId || req.session.correrUserId;
    const existing = existingId ? db.prepare('SELECT id FROM users WHERE id = ?').get(existingId) : null;

    let userId;
    if (existing) {
      db.prepare('UPDATE users SET plan_name = ? WHERE id = ?').run(planName || 'My Custom Plan', existing.id);
      userId = existing.id;
    } else {
      const result = db.prepare('INSERT INTO users (plan_name) VALUES (?)').run(planName || 'My Custom Plan');
      userId = result.lastInsertRowid;
    }
    req.session.correrUserId = userId;

    // Each custom plan save creates a fresh plan record
    const planRecord = db.prepare('INSERT INTO plans (user_id, name, type) VALUES (?,?,?)').run(userId, planName || 'Custom Plan', 'custom');
    const planId = planRecord.lastInsertRowid;

    const insert = db.prepare(`
      INSERT INTO plan_workouts
        (user_id, plan_id, week_number, day_of_week, workout_type, name, description, target_distance_km, target_pace_min_km, scheduled_date, completed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);

    const saveWorkouts = db.transaction(() => {
      for (const w of (workouts || [])) {
        insert.run(userId, planId, w.week || 1, w.day, w.type, w.name || w.type, w.detail || null, w.distance || null, w.pace || null, w.scheduledDate || null);
      }
    });
    saveWorkouts();

    res.json({ userId, planId, saved: workouts?.length || 0 });
  } catch (err) {
    console.error('POST /api/plan/custom error:', err);
    res.status(500).json({ error: err.message || 'Failed to save plan' });
  }
});

// GET /api/plan?userId=xxx&planId=xxx — get plan workouts
app.get('/api/plan', (req, res) => {
  const userId = req.query.userId || req.session.correrUserId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Resolve which plan to load
  let planId = req.query.planId || null;
  if (!planId) {
    const latest = db.prepare('SELECT id FROM plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId);
    planId = latest?.id || null;
  }

  // Auto-match any newly synced activities to plan workouts
  matchAllActivitiesToPlan(userId);

  const workouts = planId
    ? db.prepare(`
        SELECT pw.*,
          a.distance_m    AS actual_distance_m,
          a.moving_time_s AS actual_moving_time_s,
          a.avg_pace_s_km AS actual_avg_pace_s_km,
          a.name          AS actual_activity_name
        FROM plan_workouts pw
        LEFT JOIN activities a ON pw.linked_activity_id = a.id
        WHERE pw.plan_id = ?
        ORDER BY pw.week_number, pw.scheduled_date
      `).all(planId)
    : [];

  // Group by week
  const byWeek = {};
  for (const w of workouts) {
    if (!byWeek[w.week_number]) byWeek[w.week_number] = [];
    byWeek[w.week_number].push(w);
  }

  const planRecord = planId ? db.prepare('SELECT name, type FROM plans WHERE id = ?').get(planId) : null;
  const summary = {
    planId,
    weeks:       Math.max(...workouts.map(w => w.week_number), 0),
    totalRuns:   workouts.filter(w => w.workout_type !== 'rest').length,
    completed:   workouts.filter(w => w.completed).length,
    peakLongRun: Math.max(...workouts.filter(w => w.workout_type === 'long').map(w => w.target_distance_km), 0),
    stravaConnected: !!user.strava_access_token,
    stravaAthleteName: user.strava_athlete_name,
    planName: planRecord?.name || user.plan_name || null,
    planType: planRecord?.type || 'ai',
  };

  const survey = {
    goal:          user.survey_goal,
    longestRun:    user.survey_level,
    days:          user.survey_days,
    timeline:      user.survey_timeline,
    preferredDays:  user.survey_preferred_days ? JSON.parse(user.survey_preferred_days) : null,
    longRunDay:     user.survey_long_run_day  || null,
    paceDistance:   user.survey_pace_distance || null,
    paceTimeSecs:   user.survey_pace_time_s   || null,
    raceDate:       user.target_race_date     || null,
    targetTimeSecs: user.survey_target_time_s || null,
  };

  res.json({ summary, workouts, byWeek, survey });
});

// GET /api/plans?userId=xxx — list all plans for a user
app.get('/api/plans', (req, res) => {
  const userId = req.query.userId || req.session.correrUserId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const plans = db.prepare('SELECT * FROM plans WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  const result = plans.map(p => {
    const ws = db.prepare('SELECT week_number, workout_type, completed FROM plan_workouts WHERE plan_id = ?').all(p.id);
    const nonRest = ws.filter(w => w.workout_type !== 'rest');
    return {
      id: p.id, name: p.name, type: p.type, createdAt: p.created_at,
      weeks: ws.length ? Math.max(...ws.map(w => w.week_number)) : 0,
      totalRuns: nonRest.length,
      completed: ws.filter(w => w.completed).length,
    };
  });
  res.json(result);
});

// DELETE /api/plans/:planId — delete a plan and its workouts
app.delete('/api/plans/:planId', (req, res) => {
  const planId = parseInt(req.params.planId);
  const userId = req.body?.userId || req.session.correrUserId;
  // Verify ownership
  const plan = db.prepare('SELECT user_id FROM plans WHERE id = ?').get(planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  if (userId && String(plan.user_id) !== String(userId)) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM plan_workouts WHERE plan_id = ?').run(planId);
  db.prepare('DELETE FROM plans WHERE id = ?').run(planId);
  res.json({ ok: true });
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

  // Activity stats from Strava syncs
  const actStats = db.prepare(`
    SELECT
      COUNT(*)                            AS total_activities,
      ROUND(SUM(distance_m) / 1000.0, 1) AS total_km,
      SUM(moving_time_s)                  AS total_time_s,
      ROUND(MAX(distance_m) / 1000.0, 1) AS longest_km,
      ROUND(AVG(CASE WHEN avg_pace_s_km > 0 THEN avg_pace_s_km END)) AS avg_pace_s
    FROM activities
    WHERE user_id = ? AND sport_type IN ('Run','VirtualRun','TrailRun')
  `).get(userId) || {};

  // Plan stats
  const planStats = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE workout_type != 'rest')  AS total_planned,
      COUNT(*) FILTER (WHERE completed = 1)           AS total_completed,
      MAX(week_number)                                AS plan_weeks,
      COUNT(DISTINCT week_number) FILTER (WHERE completed = 1) AS weeks_with_run
    FROM plan_workouts WHERE user_id = ?
  `).get(userId) || {};

  const totalPlanned  = planStats.total_planned  || 0;
  const totalCompleted = planStats.total_completed || 0;
  const completionRate = totalPlanned > 0 ? Math.round((totalCompleted / totalPlanned) * 100) : 0;

  const totalTimeSec = actStats.total_time_s || 0;
  const totalTimeH   = Math.floor(totalTimeSec / 3600);
  const totalTimeM   = Math.floor((totalTimeSec % 3600) / 60);
  const totalTimeStr = totalTimeH > 0 ? `${totalTimeH}h ${totalTimeM}m` : totalTimeM > 0 ? `${totalTimeM}m` : '—';

  const avgPaceSec = actStats.avg_pace_s || 0;
  const avgPaceStr = avgPaceSec > 0
    ? `${Math.floor(avgPaceSec / 60)}:${String(avgPaceSec % 60).padStart(2, '0')}`
    : '—';

  res.json({
    id: user.id,
    createdAt: user.created_at,
    strava: {
      connected:      !!user.strava_access_token,
      athleteName:    user.strava_athlete_name || null,
      profilePic:     user.strava_profile_pic  || null,
      activitiesCount: actStats.total_activities || 0,
    },
    survey: {
      goal:          user.survey_goal,
      longestRun:    user.survey_level,
      days:          user.survey_days,
      timeline:      user.survey_timeline,
      preferredDays: user.survey_preferred_days ? JSON.parse(user.survey_preferred_days) : null,
      longRunDay:    user.survey_long_run_day || null,
      raceDate:      user.target_race_date    || null,
      targetTimeSecs: user.survey_target_time_s || null,
    },
    extra: {
      age:            user.age             || null,
      targetRaceName: user.target_race_name || null,
      targetRaceDate: user.target_race_date || null,
      targetRaceTime: user.target_race_time || null,
    },
    stats: {
      totalDistanceKm:  actStats.total_km     || 0,
      totalRuns:        actStats.total_activities || 0,
      totalTime:        totalTimeStr,
      longestRunKm:     actStats.longest_km   || 0,
      avgPace:          avgPaceStr,
      totalPlanned,
      totalCompleted,
      completionRate,
      planWeeks:        planStats.plan_weeks  || 0,
      weeksWithRun:     planStats.weeks_with_run || 0,
    },
  });
});

// PATCH /api/profile — update extra profile fields
app.patch('/api/profile', (req, res) => {
  const userId = req.body.userId || req.session.correrUserId;
  if (!userId) return res.status(401).json({ error: 'userId required' });

  const { age, targetRaceName, targetRaceDate, targetRaceTime } = req.body;
  db.prepare(`
    UPDATE users SET age=?, target_race_name=?, target_race_date=?, target_race_time=?
    WHERE id=?
  `).run(age || null, targetRaceName || null, targetRaceDate || null, targetRaceTime || null, userId);

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

// PATCH /api/plan/start-date — shift all workout dates to a new start date
app.patch('/api/plan/start-date', (req, res) => {
  const userId = req.body.userId || req.session.correrUserId;
  if (!userId) return res.status(401).json({ error: 'userId required' });

  const { startDate, planId } = req.body;
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return res.status(400).json({ error: 'Invalid date' });
  }

  // Resolve which plan to shift — use provided planId or fall back to most recent
  const resolvedPlanId = planId || db.prepare(
    'SELECT id FROM plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(userId)?.id;
  if (!resolvedPlanId) return res.status(404).json({ error: 'No plan found' });

  const workouts = db.prepare(
    'SELECT id, week_number, day_of_week, workout_type FROM plan_workouts WHERE plan_id = ? ORDER BY week_number, day_of_week'
  ).all(resolvedPlanId);
  if (!workouts.length) return res.status(404).json({ error: 'No workouts found' });

  // Rebuild every scheduled_date from week_number + day_of_week + startDate.
  // This works whether dates were previously set or all null (e.g. custom plans
  // saved without a start date).  Race-day entries keep their fixed date.
  const DAY_OFFSETS = { Mon:0, Tue:1, Wed:2, Thu:3, Fri:4, Sat:5, Sun:6 };
  const startMs = new Date(startDate + 'T00:00:00Z').getTime();
  const update  = db.prepare('UPDATE plan_workouts SET scheduled_date = ? WHERE id = ?');

  db.transaction(() => {
    for (const w of workouts) {
      if (w.workout_type === 'race') continue;  // race date is user-defined, leave it
      const dayOff = DAY_OFFSETS[w.day_of_week] ?? 0;
      const offset = (w.week_number - 1) * 7 + dayOff;
      update.run(new Date(startMs + offset * 86400000).toISOString().slice(0, 10), w.id);
    }
  })();

  res.json({ startDate });
});

// PATCH /api/plan/rename — rename the user's plan
app.patch('/api/plan/rename', (req, res) => {
  const userId = req.body.userId || req.session.correrUserId;
  if (!userId) return res.status(401).json({ error: 'userId required' });
  const { planName } = req.body;
  db.prepare('UPDATE users SET plan_name = ? WHERE id = ?').run(planName || null, userId);
  res.json({ planName: planName || null });
});

// DELETE /api/plan — delete all plan workouts for a user
app.delete('/api/plan', (req, res) => {
  const userId = req.body.userId || req.session.correrUserId;
  if (!userId) return res.status(401).json({ error: 'userId required' });

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare('DELETE FROM plan_workouts WHERE user_id = ?').run(userId);
  res.json({ deleted: true });
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
