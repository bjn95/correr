// routes/strava.js
// Handles Strava OAuth 2.0 flow + webhook subscription + activity sync

const express = require('express');
const axios = require('axios');
const db = require('../db');
const { buildOrUpdatePlan } = require('../plan');

const router = express.Router();

const STRAVA_BASE = 'https://www.strava.com/api/v3';
const STRAVA_AUTH = 'https://www.strava.com/oauth';

// ── 1. Redirect user to Strava OAuth consent screen ───────────────────────────
// GET /auth/strava/connect?userId=<correr_user_id>
router.get('/connect', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  // Store userId in session so we can retrieve it on callback
  req.session.correrUserId = userId;

  const params = new URLSearchParams({
    client_id:     process.env.STRAVA_CLIENT_ID,
    redirect_uri:  `${process.env.BASE_URL}/auth/strava/callback`,
    response_type: 'code',
    approval_prompt: 'auto',
    // activity:read — see completed runs
    // activity:read_all — see private runs too
    scope: 'read,activity:read_all',
  });

  req.session.save(() => res.redirect(`${STRAVA_AUTH}/authorize?${params}`));
});

// ── 2. Strava redirects back here with ?code=xxx ──────────────────────────────
// GET /auth/strava/callback
router.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  const userId = req.session.correrUserId;

  if (error) {
    return res.redirect(`${process.env.FRONTEND_URL}?strava_error=${error}`);
  }
  if (!code || !userId) {
    return res.status(400).send('Missing code or session. Please try connecting again.');
  }

  try {
    // Exchange authorisation code for tokens
    const tokenRes = await axios.post(`${STRAVA_AUTH}/token`, {
      client_id:     process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    });

    const {
      access_token,
      refresh_token,
      expires_at,
      athlete,
    } = tokenRes.data;

    // Upsert user — may already exist from Garmin auth
    const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!existing) {
      return res.status(404).send('User not found — please create your plan first.');
    }

    // Clear strava_id from any other user row that already has it
    db.prepare(`
      UPDATE users SET strava_id = NULL, strava_access_token = NULL,
        strava_refresh_token = NULL, strava_token_expires = NULL
      WHERE strava_id = ? AND id != ?
    `).run(String(athlete.id), userId);

    // If connecting a different Strava account, wipe the old activities so
    // stale data from the previous account doesn't bleed through
    const currentUser = db.prepare('SELECT strava_id FROM users WHERE id = ?').get(userId);
    if (currentUser?.strava_id && currentUser.strava_id !== String(athlete.id)) {
      db.prepare('DELETE FROM activities WHERE user_id = ? AND source = ?').run(userId, 'strava');
    }

    db.prepare(`
      UPDATE users SET
        strava_id            = ?,
        strava_access_token  = ?,
        strava_refresh_token = ?,
        strava_token_expires = ?,
        strava_athlete_name  = ?,
        strava_profile_pic   = ?
      WHERE id = ?
    `).run(
      String(athlete.id),
      access_token,
      refresh_token,
      expires_at,
      `${athlete.firstname} ${athlete.lastname}`.trim(),
      athlete.profile_medium || athlete.profile,
      userId,
    );

    // Kick off a backfill of recent activities (last 30 days)
    syncRecentActivities(userId, access_token).catch(console.error);

    // Redirect back to the app with success flag
    res.redirect(`${process.env.FRONTEND_URL}?strava_connected=1`);

  } catch (err) {
    console.error('Strava OAuth error:', err.response?.data || err.message);
    res.redirect(`${process.env.FRONTEND_URL}?strava_error=token_exchange_failed`);
  }
});

// ── 3. Strava webhook — validation handshake (GET) ────────────────────────────
// GET /webhook/strava
router.get('/strava', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.STRAVA_VERIFY_TOKEN) {
    console.log('✅ Strava webhook verified');
    res.json({ 'hub.challenge': challenge });
  } else {
    res.sendStatus(403);
  }
});

// ── 4. Strava webhook — incoming events (POST) ────────────────────────────────
// POST /webhook/strava
router.post('/strava', async (req, res) => {
  // Respond immediately so Strava doesn't retry
  res.sendStatus(200);

  const { object_type, aspect_type, object_id, owner_id } = req.body;

  // We only care about new activities
  if (object_type !== 'activity' || aspect_type !== 'create') return;

  // Find the Correr user by Strava athlete ID
  const user = db.prepare('SELECT * FROM users WHERE strava_id = ?').get(String(owner_id));
  if (!user) return;

  try {
    const token = await getFreshStravaToken(user);
    const activity = await fetchStravaActivity(object_id, token);
    if (!activity) return;

    // Only process runs
    if (!['Run', 'VirtualRun', 'TrailRun'].includes(activity.sport_type)) return;

    upsertActivity(user.id, 'strava', activity);
    matchActivityToPlan(user.id, activity);
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});

// ── 5. Disconnect Strava ──────────────────────────────────────────────────────
// POST /auth/strava/disconnect
router.post('/disconnect', (req, res) => {
  const userId = req.session.correrUserId || req.body.userId;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  db.prepare(`
    UPDATE users SET
      strava_id            = NULL,
      strava_access_token  = NULL,
      strava_refresh_token = NULL,
      strava_token_expires = NULL,
      strava_athlete_name  = NULL,
      strava_profile_pic   = NULL
    WHERE id = ?
  `).run(userId);

  // Remove activities tied to this Strava account so they don't linger
  db.prepare('DELETE FROM activities WHERE user_id = ? AND source = ?').run(userId, 'strava');

  res.json({ disconnected: true });
});

// ── 6. Manual sync endpoint (for the frontend "Sync now" button) ──────────────
// POST /auth/strava/sync
router.post('/sync', async (req, res) => {
  const userId = req.session.correrUserId || req.body.userId;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user?.strava_access_token) {
    return res.status(400).json({ error: 'Strava not connected' });
  }

  try {
    const token = await getFreshStravaToken(user);
    const count = await syncRecentActivities(userId, token);
    res.json({ synced: count });
  } catch (err) {
    console.error('Manual sync error:', err.message);
    res.status(500).json({ error: 'Sync failed' });
  }
});

// ── 6. GET recent activities for dashboard ────────────────────────────────────
// GET /auth/strava/activities?userId=xxx
router.get('/activities', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const activities = db.prepare(`
    SELECT id, source, name, sport_type, start_date,
           distance_m, moving_time_s, avg_pace_s_km, avg_heart_rate, calories
    FROM activities
    WHERE user_id = ? AND sport_type IN ('Run','VirtualRun','TrailRun')
    ORDER BY start_date DESC
    LIMIT 20
  `).all(userId);

  res.json(activities);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getFreshStravaToken(user) {
  const nowSecs = Math.floor(Date.now() / 1000);
  // Refresh if expires within 5 minutes
  if (user.strava_token_expires > nowSecs + 300) {
    return user.strava_access_token;
  }

  const res = await axios.post(`${STRAVA_AUTH}/token`, {
    client_id:     process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    grant_type:    'refresh_token',
    refresh_token: user.strava_refresh_token,
  });

  const { access_token, refresh_token, expires_at } = res.data;

  db.prepare(`
    UPDATE users SET
      strava_access_token  = ?,
      strava_refresh_token = ?,
      strava_token_expires = ?
    WHERE id = ?
  `).run(access_token, refresh_token, expires_at, user.id);

  return access_token;
}

async function fetchStravaActivity(activityId, token) {
  const res = await axios.get(`${STRAVA_BASE}/activities/${activityId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data;
}

async function syncRecentActivities(userId, token) {
  // Wipe all stored Strava activities and re-import full history.
  // Unlink plan workouts first to satisfy the FK constraint.
  db.prepare(`
    UPDATE plan_workouts SET completed = 0, linked_activity_id = NULL
    WHERE user_id = ? AND linked_activity_id IN (
      SELECT id FROM activities WHERE user_id = ? AND source = 'strava'
    )
  `).run(userId, userId);

  db.prepare(`DELETE FROM activities WHERE user_id = ? AND source = 'strava'`).run(userId);

  // Paginate through all Strava activities (max 200 per page)
  const allActivities = [];
  let page = 1;
  while (true) {
    const res = await axios.get(`${STRAVA_BASE}/athlete/activities`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { per_page: 200, page },
    });
    if (!res.data.length) break;
    allActivities.push(...res.data);
    if (res.data.length < 200) break; // last page
    page++;
  }

  const runs = allActivities.filter(a =>
    ['Run', 'VirtualRun', 'TrailRun'].includes(a.sport_type)
  );

  for (const activity of runs) {
    upsertActivity(userId, 'strava', activity);
  }

  // Match all synced activities to plan workouts
  matchAllActivitiesToPlan(userId);

  return runs.length;
}

function upsertActivity(userId, source, a) {
  // Calculate avg pace in seconds/km from distance + moving time
  let avgPaceSKm = null;
  if (a.distance > 0 && a.moving_time > 0) {
    avgPaceSKm = Math.round((a.moving_time / (a.distance / 1000)));
  }

  db.prepare(`
    INSERT INTO activities (
      user_id, source, external_id, name, sport_type, start_date,
      distance_m, moving_time_s, elapsed_time_s, avg_pace_s_km,
      avg_heart_rate, max_heart_rate, calories, map_polyline, raw_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source, external_id) DO UPDATE SET
      name            = excluded.name,
      avg_heart_rate  = excluded.avg_heart_rate,
      max_heart_rate  = excluded.max_heart_rate,
      calories        = excluded.calories
  `).run(
    userId,
    source,
    String(a.id),
    a.name,
    a.sport_type,
    a.start_date_local || a.start_date,  // prefer local date so timezone doesn't shift the day
    a.distance,
    a.moving_time,
    a.elapsed_time,
    avgPaceSKm,
    a.average_heartrate || null,
    a.max_heartrate || null,
    a.calories || null,
    a.map?.summary_polyline || null,
    JSON.stringify(a),
  );
}

function matchActivityToPlan(userId, activity) {
  // Called per-webhook: match one fresh Strava activity to its plan workout.
  // Use start_date_local (athlete's local time) so a 10pm run on Monday isn't
  // treated as Tuesday because Strava stores UTC in start_date.
  const actDate = (activity.start_date_local || activity.start_date)?.slice(0, 10);
  if (!actDate) return;

  const savedActivity = db.prepare(
    'SELECT id FROM activities WHERE source = ? AND external_id = ?'
  ).get('strava', String(activity.id));
  if (!savedActivity) return;

  matchSavedActivityToWorkout(userId, savedActivity.id, actDate);
}

function matchSavedActivityToWorkout(userId, activityId, actDate) {
  // Skip if this activity is already linked to a workout
  const alreadyLinked = db.prepare(
    'SELECT id FROM plan_workouts WHERE linked_activity_id = ?'
  ).get(activityId);
  if (alreadyLinked) return;

  // Find an unlinked non-rest workout on the same date, scoped to the user's
  // most recently created plan so we match to the active plan only.
  const latestPlan = db.prepare(
    'SELECT id FROM plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(userId);

  const workout = db.prepare(`
    SELECT pw.id FROM plan_workouts pw
    WHERE pw.user_id = ?
      AND pw.scheduled_date = ?
      AND pw.workout_type NOT IN ('rest','race')
      AND pw.linked_activity_id IS NULL
      ${latestPlan ? 'AND pw.plan_id = ?' : ''}
    LIMIT 1
  `).get(...(latestPlan ? [userId, actDate, latestPlan.id] : [userId, actDate]));

  if (workout) {
    db.prepare(`
      UPDATE plan_workouts SET completed = 1, linked_activity_id = ?
      WHERE id = ?
    `).run(activityId, workout.id);
  }
}

// Bulk-match all synced run activities to plan workouts for a user.
// Safe to call repeatedly — skips already-linked activities and workouts.
function matchAllActivitiesToPlan(userId) {
  // start_date now stores start_date_local (set in upsertActivity), so slicing
  // the first 10 chars gives the correct local calendar date.
  const activities = db.prepare(`
    SELECT a.id, substr(a.start_date, 1, 10) AS act_date
    FROM activities a
    WHERE a.user_id = ?
      AND a.sport_type IN ('Run', 'VirtualRun', 'TrailRun')
  `).all(userId);

  for (const a of activities) {
    if (a.act_date) matchSavedActivityToWorkout(userId, a.id, a.act_date);
  }
}

module.exports = { router, matchAllActivitiesToPlan };
