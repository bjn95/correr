// routes/garmin.js
// Garmin Connect Developer Program — Training API
// Uses OAuth 1.0a (Garmin has NOT moved to OAuth 2.0 for this API)
//
// IMPORTANT: The Training API requires a business approval from Garmin.
// Apply at: https://developerportal.garmin.com/developer-programs/connect-developer-api
// You'll get Consumer Key + Secret after approval.

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

// Garmin OAuth 1.0a endpoints
const GARMIN_BASE        = 'https://connectapi.garmin.com';
const GARMIN_AUTH_BASE   = 'https://connect.garmin.com';
const REQUEST_TOKEN_URL  = `${GARMIN_AUTH_BASE}/oauth/authorize`;
const ACCESS_TOKEN_URL   = `${GARMIN_BASE}/oauth-service/oauth/access_token`;
const REQUEST_TOKEN_ENDPOINT = `${GARMIN_BASE}/oauth-service/oauth/request_token`;

// Training API base
const TRAINING_API = `${GARMIN_BASE}/training-api/workout`;

// ── OAuth 1.0a helper ─────────────────────────────────────────────────────────
// Garmin uses OAuth 1.0a with HMAC-SHA1 signing

function buildOAuthHeader(method, url, params = {}, tokenSecret = '') {
  const oauthParams = {
    oauth_consumer_key:     process.env.GARMIN_CONSUMER_KEY,
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        String(Math.floor(Date.now() / 1000)),
    oauth_version:          '1.0',
    ...params,
  };

  // Build base string
  const sortedParams = Object.keys(oauthParams)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(oauthParams[k])}`)
    .join('&');

  const baseString = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(sortedParams),
  ].join('&');

  // Signing key
  const signingKey = `${encodeURIComponent(process.env.GARMIN_CONSUMER_SECRET)}&${encodeURIComponent(tokenSecret)}`;

  // Compute signature
  const signature = crypto
    .createHmac('sha1', signingKey)
    .update(baseString)
    .digest('base64');

  oauthParams.oauth_signature = signature;

  const headerValue = 'OAuth ' + Object.keys(oauthParams)
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(', ');

  return { Authorization: headerValue };
}

// ── 1. Get a Request Token and redirect user to Garmin consent ─────────────────
// GET /auth/garmin/connect?userId=xxx
router.get('/connect', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  req.session.correrUserId = userId;

  try {
    const callbackUrl = `${process.env.BASE_URL}/auth/garmin/callback`;
    const headers = buildOAuthHeader('POST', REQUEST_TOKEN_ENDPOINT, {
      oauth_callback: callbackUrl,
    });

    const response = await axios.post(REQUEST_TOKEN_ENDPOINT, null, { headers });
    const params = new URLSearchParams(response.data);
    const requestToken = params.get('oauth_token');
    const requestTokenSecret = params.get('oauth_token_secret');

    if (!requestToken) throw new Error('No request token returned from Garmin');

    // Temporarily store request token secret in session for the callback
    req.session.garminRequestTokenSecret = requestTokenSecret;
    req.session.garminRequestToken = requestToken;

    // Redirect user to Garmin consent page
    res.redirect(`${REQUEST_TOKEN_URL}?oauth_token=${requestToken}`);

  } catch (err) {
    console.error('Garmin request token error:', err.response?.data || err.message);
    res.redirect(`${process.env.BASE_URL}?garmin_error=request_token_failed`);
  }
});

// ── 2. Garmin redirects back here ─────────────────────────────────────────────
// GET /auth/garmin/callback
router.get('/callback', async (req, res) => {
  const { oauth_token, oauth_verifier } = req.query;
  const userId = req.session.correrUserId;
  const requestTokenSecret = req.session.garminRequestTokenSecret;

  if (!oauth_token || !oauth_verifier || !userId) {
    return res.status(400).send('Missing OAuth params. Please try connecting again.');
  }

  try {
    const headers = buildOAuthHeader(
      'POST',
      ACCESS_TOKEN_URL,
      {
        oauth_token: oauth_token,
        oauth_verifier: oauth_verifier,
      },
      requestTokenSecret
    );

    const response = await axios.post(ACCESS_TOKEN_URL, null, { headers });
    const params = new URLSearchParams(response.data);
    const accessToken       = params.get('oauth_token');
    const accessTokenSecret = params.get('oauth_token_secret');
    const garminUserId      = params.get('user_id');

    // Save Garmin tokens to user record
    const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!existing) return res.status(404).send('User not found');

    db.prepare(`
      UPDATE users SET
        garmin_oauth_token        = ?,
        garmin_oauth_token_secret = ?,
        garmin_user_id            = ?
      WHERE id = ?
    `).run(accessToken, accessTokenSecret, garminUserId, userId);

    // Clean up session
    delete req.session.garminRequestToken;
    delete req.session.garminRequestTokenSecret;

    // Push the user's plan workouts to Garmin
    pushPlanToGarmin(userId, accessToken, accessTokenSecret).catch(console.error);

    res.redirect(`${process.env.BASE_URL}?garmin_connected=1`);

  } catch (err) {
    console.error('Garmin access token error:', err.response?.data || err.message);
    res.redirect(`${process.env.BASE_URL}?garmin_error=access_token_failed`);
  }
});

// ── 3. Push a single structured workout to Garmin ─────────────────────────────
// POST /auth/garmin/push-workout
router.post('/push-workout', async (req, res) => {
  const userId = req.body.userId;
  const workoutId = req.body.workoutId;
  if (!userId || !workoutId) return res.status(400).json({ error: 'userId and workoutId required' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user?.garmin_oauth_token) return res.status(400).json({ error: 'Garmin not connected' });

  const workout = db.prepare('SELECT * FROM plan_workouts WHERE id = ? AND user_id = ?').get(workoutId, userId);
  if (!workout) return res.status(404).json({ error: 'Workout not found' });

  try {
    const garminWorkoutId = await pushWorkout(
      user.garmin_oauth_token,
      user.garmin_oauth_token_secret,
      workout,
      userId,
    );
    res.json({ garminWorkoutId });
  } catch (err) {
    console.error('Push workout error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to push workout to Garmin' });
  }
});

// ── 4. Push all plan workouts for a user ──────────────────────────────────────
// POST /auth/garmin/push-plan
router.post('/push-plan', async (req, res) => {
  const userId = req.body.userId;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user?.garmin_oauth_token) return res.status(400).json({ error: 'Garmin not connected' });

  try {
    const pushed = await pushPlanToGarmin(
      userId,
      user.garmin_oauth_token,
      user.garmin_oauth_token_secret,
    );
    res.json({ pushed });
  } catch (err) {
    console.error('Push plan error:', err.message);
    res.status(500).json({ error: 'Failed to push plan to Garmin' });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// Build a Garmin Training API workout payload from a plan_workouts row
function buildGarminWorkout(planWorkout) {
  const type = planWorkout.workout_type; // easy | tempo | intervals | long | rest

  // Base workout shell
  const workout = {
    workoutName: planWorkout.name,
    description: planWorkout.description || '',
    sport: { sportId: 1 }, // 1 = Running
    estimatedDurationInSecs: Math.round((planWorkout.target_distance_km || 5) * (planWorkout.target_pace_min_km || 6) * 60),
    workoutSegments: [
      {
        segmentOrder: 1,
        sport: { sportId: 1 },
        workoutSteps: buildSteps(type, planWorkout),
      }
    ],
  };

  return workout;
}

function buildSteps(type, w) {
  const distM = (w.target_distance_km || 5) * 1000;
  const paceSecKm = Math.round((w.target_pace_min_km || 6) * 60);
  const warmupDist = 1000;    // 1km warm-up
  const cooldownDist = 1000;  // 1km cool-down

  // Step type keys used by Garmin Training API
  const stepTypes = {
    warmup:   { stepTypeId: 1, stepTypeKey: 'warmup' },
    cooldown: { stepTypeId: 2, stepTypeKey: 'cooldown' },
    interval: { stepTypeId: 3, stepTypeKey: 'interval' },
    recovery: { stepTypeId: 4, stepTypeKey: 'recovery' },
    rest:     { stepTypeId: 5, stepTypeKey: 'rest' },
    run:      { stepTypeId: 6, stepTypeKey: 'active' },
  };

  const mTarget = (metres) => ({
    targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target' },
    endCondition: { conditionTypeId: 2, conditionTypeKey: 'distance' },
    endConditionValue: metres,
  });

  const paceTarget = (paceSecKm, tolerance = 15) => ({
    targetType: { workoutTargetTypeId: 6, workoutTargetTypeKey: 'pace.zone' },
    targetValueOne: paceSecKm - tolerance,
    targetValueTwo: paceSecKm + tolerance,
  });

  switch (type) {
    case 'easy':
    case 'long':
      return [
        { stepOrder: 1, ...stepTypes.warmup, ...mTarget(warmupDist) },
        { stepOrder: 2, ...stepTypes.run,    ...mTarget(distM - warmupDist - cooldownDist), ...paceTarget(paceSecKm) },
        { stepOrder: 3, ...stepTypes.cooldown, ...mTarget(cooldownDist) },
      ];

    case 'tempo':
      // Warm-up 1km, tempo at target pace, cool-down 1km
      return [
        { stepOrder: 1, ...stepTypes.warmup,   ...mTarget(warmupDist) },
        { stepOrder: 2, ...stepTypes.interval, ...mTarget(distM - warmupDist - cooldownDist), ...paceTarget(paceSecKm, 10) },
        { stepOrder: 3, ...stepTypes.cooldown, ...mTarget(cooldownDist) },
      ];

    case 'intervals': {
      // 400m repeats with 200m recovery jog
      const numReps = Math.max(4, Math.round((distM - 2000) / 600));
      const steps = [
        { stepOrder: 1, ...stepTypes.warmup, ...mTarget(1000) },
      ];
      // Repeat group
      for (let i = 0; i < numReps; i++) {
        steps.push({ stepOrder: steps.length + 1, ...stepTypes.interval, ...mTarget(400), ...paceTarget(paceSecKm - 30, 10) });
        if (i < numReps - 1) {
          steps.push({ stepOrder: steps.length + 1, ...stepTypes.recovery, ...mTarget(200) });
        }
      }
      steps.push({ stepOrder: steps.length + 1, ...stepTypes.cooldown, ...mTarget(1000) });
      return steps;
    }

    default:
      return [{ stepOrder: 1, ...stepTypes.run, ...mTarget(distM) }];
  }
}

async function pushWorkout(oauthToken, oauthTokenSecret, planWorkout, userId) {
  const url = TRAINING_API;
  const payload = buildGarminWorkout(planWorkout);

  const headers = buildOAuthHeader('POST', url, { oauth_token: oauthToken }, oauthTokenSecret);
  headers['Content-Type'] = 'application/json';

  const res = await axios.post(url, payload, { headers });
  const garminWorkoutId = res.data.workoutId;

  // Optionally schedule the workout on the Garmin calendar
  if (planWorkout.scheduled_date && garminWorkoutId) {
    await scheduleWorkout(oauthToken, oauthTokenSecret, garminWorkoutId, planWorkout.scheduled_date);
  }

  // Save the Garmin workout ID back to our DB
  db.prepare('UPDATE plan_workouts SET garmin_workout_id = ? WHERE id = ?')
    .run(String(garminWorkoutId), planWorkout.id);

  return garminWorkoutId;
}

async function scheduleWorkout(oauthToken, oauthTokenSecret, garminWorkoutId, date) {
  const url = `${TRAINING_API}/${garminWorkoutId}/schedule`;
  const headers = buildOAuthHeader('POST', url, { oauth_token: oauthToken }, oauthTokenSecret);
  headers['Content-Type'] = 'application/json';

  await axios.post(url, { date }, { headers });
}

async function pushPlanToGarmin(userId, oauthToken, oauthTokenSecret) {
  // Get all un-pushed workouts (no garmin_workout_id yet)
  const workouts = db.prepare(`
    SELECT * FROM plan_workouts
    WHERE user_id = ? AND workout_type != 'rest' AND garmin_workout_id IS NULL
    ORDER BY week_number, day_of_week
  `).all(userId);

  let pushed = 0;
  for (const workout of workouts) {
    try {
      await pushWorkout(oauthToken, oauthTokenSecret, workout, userId);
      pushed++;
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`Failed to push workout ${workout.id}:`, err.message);
    }
  }

  return pushed;
}

module.exports = router;
