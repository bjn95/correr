#!/usr/bin/env node
// scripts/generateProfilePlans.js
//
// Calls Claude with 4 runner profiles to generate detailed training plans.
// Extracts coaching insights and writes upgraded coachingData.js + planProfiles.js.
//
// Usage: ANTHROPIC_API_KEY=sk-ant-... node scripts/generateProfilePlans.js

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');

const COACHING_PATH  = path.join(__dirname, '../coachingData.js');
const PROFILES_PATH  = path.join(__dirname, '../planProfiles.js');

// ── Profiles ─────────────────────────────────────────────────────────────────

const PROFILES = [
  {
    id: 'beginner_half',
    label: 'Beginner — First Half Marathon',
    goal: 'half', level: 'beginner', weeks: 16, daysPerWeek: 3,
    longestRun: '0to5',
    description: 'Complete beginner. Has done a few 5km runs. Never raced. Goal is simply to complete their first half marathon injury-free and feel good doing it. Target time is around 2:30.',
  },
  {
    id: 'casual_sub2_half',
    label: 'Beginner-Intermediate — Sub 2:00 Half Marathon',
    goal: 'half', level: 'casual', weeks: 14, daysPerWeek: 4,
    longestRun: '5to10',
    description: 'Has run a few half marathons around 2:10–2:20. Runs 3–4x per week casually. Goal is to break 2 hours (5:41/km pace). Comfortable with easy runs but has done little structured quality work.',
  },
  {
    id: 'regular_sub145_half',
    label: 'Intermediate — Sub 1:45 Half Marathon',
    goal: 'half', level: 'regular', weeks: 12, daysPerWeek: 5,
    longestRun: '10to16',
    description: 'Consistent runner, 40–55km/week. Previous half PB around 1:52. Goal is sub 1:45 (4:58/km). Comfortable with tempo runs, has done some track work. Wants periodised training with real quality sessions.',
  },
  {
    id: 'experienced_sub3_marathon',
    label: 'Advanced — Sub 3:00 Marathon',
    goal: 'marathon', level: 'experienced', weeks: 18, daysPerWeek: 6,
    longestRun: '16plus',
    description: 'High-mileage runner, 60–80km/week. Marathon PB 3:12. Goal is sub 3 hours (4:15/km). Has done structured training before. Needs periodised plan with marathon-specific long runs, medium-long runs, threshold work, and a proper 3-week taper.',
  },
];

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM = `You are an elite running coach with 20+ years experience coaching athletes from beginners to sub-3hr marathoners. You apply Jack Daniels VDOT methodology, 80/20 polarised training, Pfitzinger's periodisation approach, and British Athletics coaching principles.

You output ONLY valid JSON — no markdown fences, no explanation, no preamble. The JSON will be parsed directly by Node.js.`;

// ── User prompt per profile ───────────────────────────────────────────────────

function makeProfilePrompt(profile) {
  return `Generate a complete ${profile.weeks}-week training plan for this runner:

Profile: ${profile.label}
Goal: ${profile.goal} (${profile.goal === 'marathon' ? '42.195km' : '21.0975km'})
Description: ${profile.description}
Days per week: ${profile.daysPerWeek}
Plan length: ${profile.weeks} weeks

Output a JSON object with these exact keys:

{
  "id": "${profile.id}",
  "label": "${profile.label}",
  "levelKey": "${profile.level}",

  "peakLongRunKm": <number: peak long run distance>,
  "startLongRunKm": <number: first week long run distance>,
  "qualityRatio": <number 0.7–0.95: quality session km as fraction of easy session km>,
  "easyRatio": <number 0.50–0.65: easy session km as fraction of long run km>,
  "recoveryPattern": <number 3 or 4: weeks between recovery weeks, e.g. 3 means every 3rd week>,
  "taperWeeks": <number 2 or 3>,

  "phaseTypes": {
    "base":     { "1": [...], "2": [...], "3": [...], "4": [...], "5": [...] },
    "build":    { "1": [...], "2": [...], "3": [...], "4": [...], "5": [...] },
    "peak":     { "1": [...], "2": [...], "3": [...], "4": [...], "5": [...] },
    "taper":    { "1": [...], "2": [...], "3": [...], "4": [...], "5": [...] },
    "recovery": { "1": [...], "2": [...], "3": [...], "4": [...], "5": [...] }
  },

  "sessionDescriptions": {
    "<type>": {
      "<phase>": "<2-4 sentence coaching description. NO specific pace numbers. Include: physiological rationale, structural cue (warm-up/main/cool-down), motivational note tailored to this runner profile>"
    }
  },

  "longRunNotes": {
    "base":  "<2-3 sentences on how the long run should feel in base phase for this profile>",
    "build": "<2-3 sentences on build phase long run character>",
    "peak":  "<2-3 sentences on peak long run — include race-pace work specifics>",
    "taper": "<1-2 sentences on taper long run>"
  },

  "weeklyExamples": [
    {
      "weekType": "base",
      "weekNumber": <representative week number>,
      "sessions": [
        { "day": "Mon|Tue|Wed|Thu|Fri|Sat|Sun", "type": "<session_type>", "distanceKm": <number>, "description": "<brief>" }
      ]
    },
    {
      "weekType": "build",
      "weekNumber": <representative week>,
      "sessions": [...]
    },
    {
      "weekType": "peak",
      "weekNumber": <representative week>,
      "sessions": [...]
    }
  ]
}

IMPORTANT RULES:
- Session types must only be from: easy, strides, tempo, intervals, fartlek, hills, progression, cruise, marathon_pace, shakeout, race
- phaseTypes arrays must be ordered: hardest quality session FIRST (this session is placed furthest from the long run in the week)
- For ${profile.level === 'beginner' ? 'beginner: no intervals until peak phase, use fartlek and strides in build instead' : ''}${profile.level === 'casual' ? 'casual: introduce tempo in build, light intervals only in peak' : ''}${profile.level === 'regular' ? 'regular: quality sessions from mid-build, hills and intervals both present' : ''}${profile.level === 'experienced' && profile.goal === 'marathon' ? 'experienced marathon: use marathon_pace in long run descriptions, progression runs prominent, medium-long emphasis noted in descriptions' : ''}
- sessionDescriptions must cover all session types you use across all phases
- Be genuinely specific to this profile — a beginner long run description is VERY different from an advanced marathon runner`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set');
    process.exit(1);
  }

  const client = new Anthropic();
  const results = [];

  for (const profile of PROFILES) {
    console.log(`\nGenerating plan for: ${profile.label}...`);
    try {
      const response = await client.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 6000,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: makeProfilePrompt(profile) }],
      });

      const text = response.content[0]?.text?.trim();
      if (!text) throw new Error('Empty response');

      // Strip any accidental markdown fences
      const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      const parsed = JSON.parse(cleaned);
      results.push(parsed);
      console.log(`  ✓ ${profile.label} — tokens: ${response.usage?.input_tokens}in / ${response.usage?.output_tokens}out`);
    } catch (err) {
      console.error(`  ✗ Failed for ${profile.label}: ${err.message}`);
      process.exit(1);
    }
  }

  // ── Synthesise and write output files ──────────────────────────────────────

  writeProfilesFile(results);
  writeCoachingData(results);

  console.log(`\nWritten:\n  ${PROFILES_PATH}\n  ${COACHING_PATH}`);
  console.log('\nReview with: git diff backend/');
}

// ── Write planProfiles.js ─────────────────────────────────────────────────────

function writeProfilesFile(profiles) {
  const lines = [
    '// planProfiles.js — AI-generated profile-specific training constants',
    '// Generated by scripts/generateProfilePlans.js — do not edit by hand',
    '',
    `const PLAN_PROFILES = ${JSON.stringify(profiles, null, 2)};`,
    '',
    'module.exports = { PLAN_PROFILES };',
  ];
  fs.writeFileSync(PROFILES_PATH, lines.join('\n'), 'utf8');
}

// ── Write coachingData.js ─────────────────────────────────────────────────────

function writeCoachingData(profiles) {
  // Build PHASE_TYPES_BY_LEVEL by merging all profiles
  const byLevel = {};
  const sessionDescriptions = {};
  const longRunNotes = {};

  for (const p of profiles) {
    byLevel[p.levelKey]       = p.phaseTypes;
    longRunNotes[p.levelKey]  = p.longRunNotes;

    for (const [type, phases] of Object.entries(p.sessionDescriptions || {})) {
      if (!sessionDescriptions[type]) sessionDescriptions[type] = {};
      for (const [phase, desc] of Object.entries(phases)) {
        // Later profiles (more experienced) overwrite earlier ones for the same type/phase
        sessionDescriptions[type][phase] = desc;
      }
    }
  }

  // Build per-profile metadata map for plan.js to use
  const profileMeta = {};
  for (const p of profiles) {
    profileMeta[p.levelKey] = {
      peakLongRunKm:    p.peakLongRunKm,
      startLongRunKm:   p.startLongRunKm,
      qualityRatio:     p.qualityRatio,
      easyRatio:        p.easyRatio,
      recoveryPattern:  p.recoveryPattern,
      taperWeeks:       p.taperWeeks,
    };
  }

  const code = `// coachingData.js — generated by scripts/generateProfilePlans.js
// Built from 4 AI-coached runner profiles. Do not edit by hand.
// To regenerate: node scripts/generateProfilePlans.js

// ── Level-specific session type sequences ─────────────────────────────────────
//
// PHASE_TYPES_BY_LEVEL[level][phase][nonLongSlots] → ordered array of session types
// Hardest quality session is FIRST — it gets placed furthest from the long run.
//
const PHASE_TYPES_BY_LEVEL = ${JSON.stringify(byLevel, null, 2)};

// ── Per-level plan algorithm constants ───────────────────────────────────────
//
// easyRatio: easy session km as fraction of long run km
// qualityRatio: quality session km as fraction of easy session km
// recoveryPattern: insert a recovery week every N weeks
// taperWeeks: how many taper weeks before race
//
const LEVEL_PROFILE_META = ${JSON.stringify(profileMeta, null, 2)};

// ── Goal-specific session type overrides ─────────────────────────────────────
//
// Applied on top of PHASE_TYPES_BY_LEVEL. Only genuine differences listed.
//
const GOAL_TYPE_OVERRIDES = {
  marathon: {
    // Marathon: sustained aerobic work over VO2max. Swap peak intervals for tempo.
    // progression runs stay — they simulate late-race fatigue perfectly.
    intervals: 'tempo',
  },
  '5k': {
    // 5K: more neuromuscular work. Swap fartlek for strides in base.
    fartlek: 'strides',
  },
  general: {
    // General fitness: keep it enjoyable and aerobic.
    intervals: 'strides',
    tempo: 'easy',
    hills: 'fartlek',
  },
};

// ── Long run phase notes by level ─────────────────────────────────────────────
//
// Coaching notes for the long run, tailored per runner level and phase.
//
const LONG_RUN_NOTES_BY_LEVEL = ${JSON.stringify(longRunNotes, null, 2)};

// ── Fallback long run phase notes (used if level-specific not found) ──────────
const LONG_RUN_PHASE_NOTES = {
  base:  'Run the entire distance at easy/long pace. Time on feet is the primary stimulus — pace is completely secondary. If you need to slow down or walk, do it without hesitation.',
  build: 'Run the first two thirds at easy/long pace. Pick up gradually to goal race pace for the final third. Patience in the early miles is the whole game — do not start too fast.',
  peak:  'First half at easy/long pace. Second half at goal race pace. This is the most race-specific session in the plan. Practice fuelling exactly as you will on race day.',
  taper: 'A reduced-distance long run to maintain range of motion and confidence without accumulating fatigue. Run fully easy throughout. The fitness is already built.',
};

// ── Session description templates ─────────────────────────────────────────────
//
// Coaching descriptions for each session type × phase combination.
// NO specific pace numbers — those come from target_pace_min_km.
//
const SESSION_TEMPLATES = ${JSON.stringify(sessionDescriptions, null, 2)};

// ── Phase boundary calculator ─────────────────────────────────────────────────
function buildPhaseToName(buildPhase, isTaper) {
  if (isTaper)           return 'taper';
  if (buildPhase < 0.30) return 'base';
  if (buildPhase < 0.65) return 'build';
  return 'peak';
}

// ── Session type resolver ─────────────────────────────────────────────────────
//
// Returns the ordered array of session types for non-long slots in a given week.
// Accepts level to pick the right profile, then applies goal overrides.
//
function resolveSessionTypes(nonLongCount, phaseName, goal, isRecovery, level) {
  const effectivePhase = isRecovery ? 'recovery' : phaseName;
  const slots = clamp(nonLongCount, 1, 5);

  // Resolve from level-specific table, with graceful fallback
  const levelKey    = level || 'casual';
  const levelPhases = PHASE_TYPES_BY_LEVEL[levelKey] || PHASE_TYPES_BY_LEVEL.casual;
  const phaseSlots  = levelPhases[effectivePhase] || levelPhases.build || {};
  const base        = phaseSlots[String(slots)] || phaseSlots[slots] || ['easy'];

  const overrides = GOAL_TYPE_OVERRIDES[goal] || {};
  return base.map(t => overrides[t] || t);
}

// ── Long run description lookup ───────────────────────────────────────────────
function getLongRunNote(phaseName, level) {
  const levelNotes = LONG_RUN_NOTES_BY_LEVEL[level] || {};
  return levelNotes[phaseName] || LONG_RUN_PHASE_NOTES[phaseName] || LONG_RUN_PHASE_NOTES.base;
}

// ── Session description lookup ────────────────────────────────────────────────
function getSessionDescription(type, phaseName) {
  const byPhase = SESSION_TEMPLATES[type];
  if (!byPhase) return null;
  return byPhase[phaseName] || byPhase.build || byPhase.base || Object.values(byPhase)[0] || null;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

module.exports = {
  PHASE_TYPES_BY_LEVEL,
  LEVEL_PROFILE_META,
  GOAL_TYPE_OVERRIDES,
  LONG_RUN_PHASE_NOTES,
  LONG_RUN_NOTES_BY_LEVEL,
  SESSION_TEMPLATES,
  buildPhaseToName,
  resolveSessionTypes,
  getLongRunNote,
  getSessionDescription,
};
`;

  fs.writeFileSync(COACHING_PATH, code, 'utf8');
}

main().catch(err => { console.error(err); process.exit(1); });
