// ai-plan.js
// Generates training plans by calling the Claude API.
// Falls back gracefully if ANTHROPIC_API_KEY is not set or the call fails.

const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');
const { SYSTEM_PROMPT, buildUserMessage } = require('./prompts/systemPrompt');

// ── Constants ─────────────────────────────────────────────────────────────────

const RACE_DIST_KM = { '5k': 5, '10k': 10, 'half': 21.0975, 'marathon': 42.195 };
const GOAL_DIST_LABEL = {
  '5k': '5K', '10k': '10K', 'half': 'Half Marathon',
  'marathon': 'Marathon', 'general': 'General Fitness',
};

// Conservative default current HM times by longestRun category
const DEFAULT_HM_TIMES_SECS = {
  none:    8400,   // ~2:20
  '0to5':  7200,   // ~2:00
  '5to10': 6000,   // ~1:40
  '10to16':5100,   // ~1:25
  '16plus':4500,   // ~1:15
};

const DAY_OFFSETS = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(totalSecs) {
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = Math.round(totalSecs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatPace(secPerKm) {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}/km`;
}

function formatPaceRange(midSecPerKm, halfRangeSecs) {
  return `${formatPace(midSecPerKm - halfRangeSecs)}–${formatPace(midSecPerKm + halfRangeSecs)}`;
}

// ── Pace derivation ───────────────────────────────────────────────────────────

/**
 * From the survey, compute current and goal times plus all training paces.
 * Returns an object suitable for spreading into buildUserMessage().
 */
function computePaces(survey) {
  const {
    goal       = 'half',
    longestRun = '5to10',
    paceDistance,
    paceTimeSecs,
  } = survey;

  const goalDistKm  = RACE_DIST_KM[goal] || 21.0975;
  const goalDistLabel = GOAL_DIST_LABEL[goal] || 'Half Marathon';

  // ── Current time for the goal distance ─────────────────────────────────────
  let currentGoalTimeSecs;
  if (paceDistance && paceTimeSecs && RACE_DIST_KM[paceDistance]) {
    // Riegel: scale the user's known time to the goal distance
    const fromKm = RACE_DIST_KM[paceDistance];
    currentGoalTimeSecs = Math.round(paceTimeSecs * Math.pow(goalDistKm / fromKm, 1.06));
  } else {
    // Infer from longestRun category, scaled from HM baseline
    const hmBase = DEFAULT_HM_TIMES_SECS[longestRun] || 6000;
    currentGoalTimeSecs = Math.round(hmBase * Math.pow(goalDistKm / 21.0975, 1.06));
  }

  // ── Goal time: ~7% improvement (realistic for a structured plan) ────────────
  const goalTimeSecs   = Math.round(currentGoalTimeSecs * 0.93);
  const goalPaceSecKm  = goalTimeSecs / goalDistKm;

  return {
    goalDistance:   goalDistLabel,
    currentRaceTime: formatTime(currentGoalTimeSecs),
    goalRaceTime:    formatTime(goalTimeSecs),
    // Pace ranges (+/- 7–8 secs from midpoint)
    easyPace:      formatPaceRange(goalPaceSecKm + 75, 8),
    thresholdPace: formatPaceRange(goalPaceSecKm + 45, 5),
    intervalPace:  formatPaceRange(goalPaceSecKm -  7, 5),
    racePace:      formatPace(goalPaceSecKm),
  };
}

// ── DB writer ─────────────────────────────────────────────────────────────────

function nextMonday() {
  const d = new Date();
  const day = d.getUTCDay(); // 0 = Sun
  const add = day === 0 ? 1 : 8 - day;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add));
}

function savePlanToDB(userId, plan, surveyPlanName) {
  db.prepare('DELETE FROM plan_workouts WHERE user_id = ?').run(userId);

  const insert = db.prepare(`
    INSERT INTO plan_workouts (
      user_id, week_number, day_of_week, workout_type, name, description,
      target_distance_km, target_pace_min_km, scheduled_date
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `);

  const start = nextMonday();

  db.transaction(() => {
    for (const week of plan.weeks) {
      for (const session of week.sessions) {
        const dayOffset = (week.weekNumber - 1) * 7 + (DAY_OFFSETS[session.day] ?? 0);
        const d = new Date(start);
        d.setUTCDate(start.getUTCDate() + dayOffset);

        insert.run(
          userId,
          week.weekNumber,
          session.day,
          session.type,
          session.name,
          session.description || null,
          session.distanceKm  ?? null,
          session.paceMinKm   ?? null,
          d.toISOString().slice(0, 10),
        );
      }
    }
  })();

  // Persist the AI-generated plan name
  const resolvedName = surveyPlanName || plan.planName || null;
  db.prepare('UPDATE users SET plan_name = ? WHERE id = ?').run(resolvedName, userId);

  const workouts = db.prepare(
    'SELECT * FROM plan_workouts WHERE user_id = ? ORDER BY week_number, scheduled_date'
  ).all(userId);

  return {
    weeks:       plan.totalWeeks,
    totalRuns:   workouts.filter(w => w.workout_type !== 'rest').length,
    peakLongRun: Math.max(...workouts.filter(w => w.workout_type === 'long').map(w => w.target_distance_km || 0), 0),
    planName:    resolvedName,
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Generate a training plan via Claude and persist it to the database.
 *
 * @param {number} userId
 * @param {object} survey  — the parsed survey fields from POST /api/plan
 * @returns {object}       — { weeks, totalRuns, peakLongRun, planName }
 */
async function generatePlanWithClaude(userId, survey) {
  const {
    days         = 3,
    timeline     = '12w',
    raceDate     = null,
    preferredDays,
    longRunDay,
    planName,
  } = survey;

  // ── Plan length ─────────────────────────────────────────────────────────────
  let weeksAvailable;
  if (raceDate) {
    const ms = new Date(raceDate).getTime() - Date.now();
    weeksAvailable = Math.max(4, Math.min(24, Math.round(ms / (7 * 86400000))));
  } else {
    weeksAvailable = { '4w': 4, '8w': 8, '12w': 12, '16w': 16, 'open': 10 }[timeline] || 12;
  }

  // ── Paces ───────────────────────────────────────────────────────────────────
  const paces = computePaces(survey);

  // ── User message ────────────────────────────────────────────────────────────
  const userMessage = buildUserMessage({
    ...paces,
    daysPerWeek:    days,
    preferredDays:  preferredDays || [],
    longRunDay:     longRunDay    || null,
    weeksAvailable,
    injuryNotes:    survey.injuryNotes || null,
  });

  // ── Claude API call with prompt caching ─────────────────────────────────────
  const client = new Anthropic();

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 32000,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userMessage }],
  });

  // ── Parse ────────────────────────────────────────────────────────────────────
  const raw = response.content[0]?.text?.trim();
  if (!raw) throw new Error('Claude returned empty response');

  let plan;
  try {
    plan = JSON.parse(raw);
  } catch {
    throw new Error(`Claude response was not valid JSON: ${raw.slice(0, 200)}`);
  }

  if (plan.error) throw new Error(`Plan generation failed: ${plan.error}`);
  if (!Array.isArray(plan.weeks) || plan.weeks.length === 0) {
    throw new Error('Claude returned a plan with no weeks');
  }

  return savePlanToDB(userId, plan, planName);
}

module.exports = { generatePlanWithClaude };
