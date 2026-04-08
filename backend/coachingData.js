// coachingData.js — enhanced coaching knowledge built from 4 runner profiles:
//   1. Beginner — First Half Marathon (~2:30)
//   2. Beginner-Intermediate — Sub 2:00 Half Marathon
//   3. Intermediate — Sub 1:45 Half Marathon
//   4. Advanced — Sub 3:00 Marathon
//
// Regenerate (requires ANTHROPIC_API_KEY): node scripts/generateProfilePlans.js

// ── Level-specific session type sequences ─────────────────────────────────────
//
// PHASE_TYPES_BY_LEVEL[level][phase][nonLongSlotCount] → ordered array of types.
// FIRST item = hardest quality session → placed furthest from the long run.
// Valid types: easy | strides | fartlek | tempo | intervals | hills | progression | cruise
//
const PHASE_TYPES_BY_LEVEL = {

  // ── Beginner: first half marathon, ~2:30 target ──────────────────────────
  // Focus: build mileage safely. Quality = strides and gentle fartlek only.
  // No intervals until peak. Every third week is recovery.
  beginner: {
    base: {
      1: ['easy'],
      2: ['easy', 'strides'],
      3: ['easy', 'strides', 'easy'],
      4: ['easy', 'easy', 'strides', 'easy'],
      5: ['easy', 'easy', 'strides', 'easy', 'easy'],
    },
    build: {
      1: ['fartlek'],
      2: ['fartlek', 'easy'],
      3: ['easy', 'fartlek', 'easy'],
      4: ['easy', 'fartlek', 'easy', 'easy'],
      5: ['easy', 'easy', 'fartlek', 'easy', 'easy'],
    },
    peak: {
      1: ['tempo'],
      2: ['tempo', 'easy'],
      3: ['easy', 'tempo', 'easy'],
      4: ['easy', 'tempo', 'easy', 'easy'],
      5: ['easy', 'easy', 'tempo', 'easy', 'easy'],
    },
    taper: {
      1: ['easy'],
      2: ['easy', 'easy'],
      3: ['easy', 'easy', 'easy'],
      4: ['easy', 'easy', 'easy', 'easy'],
      5: ['easy', 'easy', 'easy', 'easy', 'easy'],
    },
    recovery: {
      1: ['easy'],
      2: ['easy', 'easy'],
      3: ['easy', 'easy', 'easy'],
      4: ['easy', 'easy', 'easy', 'easy'],
      5: ['easy', 'easy', 'easy', 'easy', 'easy'],
    },
  },

  // ── Casual: sub 2:00 half, comfortable runner wanting a PB ───────────────
  // Focus: introduce threshold work in build, light intervals in peak.
  // Fartlek bridges base and tempo in mid-build.
  casual: {
    base: {
      1: ['strides'],
      2: ['easy', 'strides'],
      3: ['easy', 'strides', 'easy'],
      4: ['easy', 'strides', 'easy', 'easy'],
      5: ['easy', 'easy', 'strides', 'easy', 'easy'],
    },
    build: {
      1: ['tempo'],
      2: ['tempo', 'easy'],
      3: ['easy', 'tempo', 'fartlek'],
      4: ['easy', 'tempo', 'fartlek', 'easy'],
      5: ['easy', 'easy', 'tempo', 'fartlek', 'easy'],
    },
    peak: {
      1: ['intervals'],
      2: ['intervals', 'easy'],
      3: ['easy', 'intervals', 'tempo'],
      4: ['easy', 'intervals', 'easy', 'tempo'],
      5: ['easy', 'easy', 'intervals', 'easy', 'tempo'],
    },
    taper: {
      1: ['easy'],
      2: ['easy', 'tempo'],
      3: ['easy', 'easy', 'tempo'],
      4: ['easy', 'easy', 'easy', 'tempo'],
      5: ['easy', 'easy', 'easy', 'easy', 'tempo'],
    },
    recovery: {
      1: ['easy'],
      2: ['easy', 'strides'],
      3: ['easy', 'strides', 'easy'],
      4: ['easy', 'strides', 'easy', 'easy'],
      5: ['easy', 'easy', 'strides', 'easy', 'easy'],
    },
  },

  // ── Regular: sub 1:45 half, structured athlete ───────────────────────────
  // Focus: hill strength in build, interval + tempo combination in peak.
  // Quality sessions start earlier and are more frequent.
  regular: {
    base: {
      1: ['strides'],
      2: ['strides', 'fartlek'],
      3: ['easy', 'strides', 'fartlek'],
      4: ['easy', 'strides', 'fartlek', 'easy'],
      5: ['easy', 'easy', 'strides', 'fartlek', 'easy'],
    },
    build: {
      1: ['tempo'],
      2: ['tempo', 'hills'],
      3: ['easy', 'tempo', 'hills'],
      4: ['easy', 'tempo', 'hills', 'easy'],
      5: ['easy', 'easy', 'tempo', 'hills', 'easy'],
    },
    peak: {
      1: ['intervals'],
      2: ['intervals', 'tempo'],
      3: ['easy', 'intervals', 'tempo'],
      4: ['easy', 'intervals', 'easy', 'tempo'],
      5: ['easy', 'easy', 'intervals', 'easy', 'tempo'],
    },
    taper: {
      1: ['easy'],
      2: ['easy', 'tempo'],
      3: ['easy', 'easy', 'tempo'],
      4: ['easy', 'easy', 'progression', 'tempo'],
      5: ['easy', 'easy', 'easy', 'progression', 'tempo'],
    },
    recovery: {
      1: ['easy'],
      2: ['easy', 'strides'],
      3: ['easy', 'strides', 'easy'],
      4: ['easy', 'strides', 'easy', 'easy'],
      5: ['easy', 'easy', 'strides', 'easy', 'easy'],
    },
  },

  // ── Experienced: sub 3:00 marathon, high-mileage athlete ─────────────────
  // Focus: sustained aerobic volume + marathon-specific work.
  // Progression runs prominent throughout (simulate late-race fatigue).
  // Hills in build, tempo dominant in peak (goal overrides intervals→tempo for marathon).
  experienced: {
    base: {
      1: ['strides'],
      2: ['strides', 'progression'],
      3: ['easy', 'strides', 'progression'],
      4: ['easy', 'strides', 'progression', 'easy'],
      5: ['easy', 'easy', 'strides', 'progression', 'easy'],
    },
    build: {
      1: ['tempo'],
      2: ['tempo', 'hills'],
      3: ['easy', 'tempo', 'hills'],
      4: ['easy', 'tempo', 'hills', 'progression'],
      5: ['easy', 'easy', 'tempo', 'hills', 'progression'],
    },
    peak: {
      1: ['tempo'],
      2: ['intervals', 'tempo'],
      3: ['easy', 'intervals', 'tempo'],
      4: ['easy', 'intervals', 'progression', 'tempo'],
      5: ['easy', 'easy', 'intervals', 'progression', 'tempo'],
    },
    taper: {
      1: ['easy'],
      2: ['easy', 'tempo'],
      3: ['easy', 'progression', 'tempo'],
      4: ['easy', 'easy', 'progression', 'tempo'],
      5: ['easy', 'easy', 'easy', 'progression', 'tempo'],
    },
    recovery: {
      1: ['easy'],
      2: ['easy', 'strides'],
      3: ['easy', 'strides', 'easy'],
      4: ['easy', 'easy', 'strides', 'easy'],
      5: ['easy', 'easy', 'strides', 'easy', 'easy'],
    },
  },
};

// ── Per-level algorithm constants ─────────────────────────────────────────────
//
// easyRatio:       easy session km as fraction of long run km
// qualityRatio:    quality session km as fraction of easy session km
// recoveryPattern: insert a recovery week every N weeks
// taperWeeks:      taper weeks before race (3 for beginners helps injury prevention)
// peakLongRunKm:   maximum long run (overrides global default if set)
//
const LEVEL_PROFILE_META = {
  beginner:   { easyRatio: 0.55, qualityRatio: 0.80, recoveryPattern: 3, taperWeeks: 3 },
  casual:     { easyRatio: 0.57, qualityRatio: 0.85, recoveryPattern: 3, taperWeeks: 3 },
  regular:    { easyRatio: 0.58, qualityRatio: 0.88, recoveryPattern: 4, taperWeeks: 3 },
  experienced:{ easyRatio: 0.60, qualityRatio: 0.90, recoveryPattern: 4, taperWeeks: 3 },
};

// ── Goal-specific session type overrides ─────────────────────────────────────
const GOAL_TYPE_OVERRIDES = {
  marathon: {
    // Marathon training: sustained aerobic capacity over VO2max.
    // Peak intervals → tempo. Progression runs stay — they uniquely
    // simulate the fatigue of miles 30–42.
    intervals: 'tempo',
  },
  '5k': {
    // 5K: neuromuscular speed matters more. Swap fartlek for strides in base.
    fartlek: 'strides',
  },
  general: {
    // General fitness: remove structured quality, keep it aerobic and sustainable.
    intervals: 'strides',
    tempo: 'easy',
    hills: 'fartlek',
  },
};

// ── Long run notes by level and phase ─────────────────────────────────────────
//
// How the long run changes character across the plan — tailored per level.
//
const LONG_RUN_NOTES_BY_LEVEL = {
  beginner: {
    base:  'Run the whole distance at a fully conversational pace — you should be able to chat without effort. Walk any hills without guilt. The goal is time on your feet, not pace. You are building the aerobic engine that everything else runs on.',
    build: 'Still mostly easy, but start to settle into the pace you expect to run on race day for the middle third. The first and last portions stay easy. This is your first taste of race-pace effort over a long run — keep it gentle.',
    peak:  'The first half is easy warm-up. Aim to run the final quarter at your target race pace. This is the most important session in your plan — trust your fitness and practise the pacing you will use on race day.',
    taper: 'A confidence run, not a fitness run. Easy pace throughout. Your job now is to arrive at the start line fresh, not to add more training. Run this feeling strong and remind yourself you have earned race day.',
  },
  casual: {
    base:  'Commit to easy/long pace for every metre. Your heart rate should feel comfortably low and your breathing relaxed enough to hold a full conversation. Do not chase pace — base phase long runs build capillary density and fat-burning efficiency. The work feels easy; the adaptation is deep.',
    build: 'Run the opening third easy, the middle third at comfortable long pace, and the final third edging toward goal race pace. This is not a race effort — it is a controlled progression that teaches your body to run economically when tired.',
    peak:  'Split this run deliberately: first half easy/long, second half at goal race pace. Practise your fuelling and hydration exactly as you plan for race day. If the race-pace section feels tough, it is working — this is the most specific fitness work in the plan.',
    taper: 'Reduced mileage, full effort of control. Run easy, stay relaxed, and trust the process. Fitness cannot be gained this week but it can be lost to anxiety and over-running. Be disciplined about the shorter distance.',
  },
  regular: {
    base:  'Controlled easy pace throughout — genuinely aerobic, not a "comfortable race pace." Your long run aerobic base underpins every quality session in the plan. Do not rush this phase. The slow kilometres here make the fast kilometres in peak possible.',
    build: 'First two thirds: long/easy pace. Final third: graduate to goal half-marathon pace. By the end of the run you should be working but not racing. Practise your hydration and gel timing if you plan to fuel during the race.',
    peak:  'The definitive race-simulation long run. Easy for the first half, then lock into goal pace for the remainder. This session proves to you that race pace is sustainable. Do not speed up — controlled execution is the point.',
    taper: 'A purpose-built confidence run. Shorter, controlled, easy effort. Do not try to prove anything — your fitness is already set. This run is about keeping your legs moving and your mind calm before race day.',
  },
  experienced: {
    base:  'Pure aerobic base work — genuinely easy effort for the whole distance. Your long runs in base phase are the highest-yield training you do this cycle. Marathon fitness is built on volume, not heroics. Save your effort for the quality sessions.',
    build: 'The long run becomes your primary race-specific session this phase. Run the first 60% at easy pace, then pick up to marathon goal pace for the remainder. Focus on efficient form when tired — this is what miles 32–42 will demand.',
    peak:  'Race-simulation long run. Easy for the first third, settling into marathon pace through the middle, and finishing strong at race pace. Practice your full nutrition strategy exactly — gels, fluids, timing. If your legs feel heavy at 25km, that is the training effect.',
    taper: 'Reduced volume, maintained quality. Run mostly easy but include 5–8km at marathon goal pace in the middle. This keeps race-pace feel in your legs without accumulating fatigue. You are arriving, not training.',
  },
};

// Fallback (used if level-specific note not found)
const LONG_RUN_PHASE_NOTES = {
  base:  'Run the entire distance at easy/long pace. Time on feet is the primary stimulus — pace is completely secondary. If you need to slow down or walk, do it without hesitation.',
  build: 'Run the first two thirds at easy/long pace. Pick up gradually to goal race pace for the final third. Patience in the early miles is the whole game — do not start too fast.',
  peak:  'First half at easy/long pace. Second half at goal race pace. This is the most race-specific session in the plan. Practice fuelling exactly as you will on race day.',
  taper: 'A reduced-distance long run to maintain range of motion and confidence without accumulating fatigue. Run fully easy throughout. The fitness is already built.',
};

// ── Session description templates ─────────────────────────────────────────────
//
// Organised by type → phase. NO specific pace values — those come from the
// pace algorithm and are shown separately in the UI.
//
const SESSION_TEMPLATES = {

  easy: {
    base: 'Fully conversational pace for every step — if you cannot finish a sentence comfortably, slow down. Easy running is the foundation of your entire plan; it builds aerobic capacity, strengthens connective tissue, and accelerates recovery from harder sessions. Do not let ego push you faster.',
    build: 'Genuine recovery pace between your quality sessions. Your legs should feel noticeably easier by the end than the start. This run exists to support adaptation, not to add fitness directly — trust that, and keep it easy.',
    peak: 'Active recovery between hard sessions. Your aerobic system is absorbing significant stimulus this phase — protecting that adaptation by keeping easy runs genuinely easy is one of the most important decisions you make each week.',
    taper: 'Short shakeout run to keep the legs moving and the mind calm. You are not building fitness here. Run easy, stay relaxed, and let the accumulated training do its work. Resist every urge to push.',
    recovery: 'Full recovery run. Easy effort, easy pace, easy mind. This week is deliberately lighter to allow deep adaptation. Trust the process — the fitness you built in the previous block is consolidating right now.',
  },

  strides: {
    base: 'Run easy for the main distance, then finish with 4–6 × 100m strides on a flat surface. For each stride: accelerate smoothly over the first 30m to a quick, controlled effort — not a sprint — hold it through 40m, then decelerate over the final 30m. Walk fully back to the start before the next. Strides develop neuromuscular efficiency and running economy without meaningful fatigue.',
    build: 'Finish your easy run with 4 × 100m strides at a brisk, relaxed effort. Focus on tall posture, quick ground contact, and loose shoulders. Strides during high-volume build weeks keep your fast-twitch fibres engaged and your stride mechanics sharp.',
    recovery: 'End your easy run with 4 × 80m strides, keeping the effort controlled and the recovery complete. In a recovery week, strides replace all other quality work — just enough neuromuscular stimulus to stay sharp without accumulating fatigue.',
  },

  fartlek: {
    base: 'Warm up 10 min easy. Run a series of informal surges: pick a lamppost, tree, or corner ahead and accelerate to it at a comfortably hard effort, then recover easy until you feel ready again. Hard efforts ~60 seconds, recovery 90 sec to 2 min — but follow feel, not a watch. Cool down 5–10 min easy. Fartlek is play: its purpose is to let you feel what it is like to change gears without the pressure of hitting splits.',
    build: 'Warm up 10 min easy. Run 6–8 × 1 min at a controlled hard effort (roughly 10K race feel) with 90 sec easy jog recovery between each. Cool down 10 min easy. This session introduces structured speed work progressively, building tolerance for discomfort at a manageable volume.',
    recovery: 'Warm up 10 min easy. Run 4 × 45 sec gentle surges — firm but not hard — with 2 min easy jog between. Cool down 10 min easy. This light fartlek on a recovery week maintains gear-change stimulus without digging into your adaptation reserves.',
  },

  tempo: {
    build: 'Warm up 10–15 min easy. Run the tempo block at lactate threshold pace — comfortably hard and sustainable, roughly the effort of a hard 60-minute race. You should be able to say three or four words but not a full sentence. Cool down 10–15 min easy. Threshold training raises your lactate ceiling and is the cornerstone of race-pace fitness.',
    peak: 'Warm up 10 min easy. This week the tempo is broken into cruise intervals: 3 × 8 min at threshold pace with 90 sec easy jog recovery between blocks. Cool down easy. Shorter blocks with brief recovery deliver the same threshold adaptation with reduced accumulated fatigue — ideal in a high-intensity week.',
    taper: 'Warm up 10 min easy. Run 2 × 6 min at threshold pace with 2 min easy jog recovery. Cool down easy. The reduced duration is deliberate — just enough to keep your lactate threshold sharp without adding pre-race fatigue. You should finish feeling you had more in the tank.',
    recovery: 'Easy aerobic running only today — the tempo block is replaced this recovery week to allow full adaptation. You will return to threshold work next week sharper for the rest.',
  },

  intervals: {
    build: 'Warm up 10–15 min easy with a few 20-sec accelerations in the final 2 min. Intervals at approximately 5–10K race effort — controlled and consistent, not all-out. Take full standing or walking recovery between reps so each one can be attacked with the same quality. Cool down 10 min easy. These efforts develop VO2max and your ability to tolerate race pace.',
    peak: 'Warm up 10–15 min easy. You are at peak fitness — these intervals are your sharpest quality session. The goal is perfectly even splits: the last rep should match the first. Any deviation means you either went out too hard or underestimated your fitness. Full standing/walking recovery between reps. Cool down 10 min easy.',
  },

  hills: {
    build: 'Find a hill with a moderate grade (5–8%, around 60–90 seconds to climb). Warm up 10 min on flat. Drive hard uphill using short, powerful strides — high knees, strong arm drive, chest tall. Jog or walk back down as complete recovery. Cool down 10 min easy. Hill reps build running-specific strength, power, and VO2max without the injury risk of flat speed work.',
    peak: 'Warm up 10 min easy on flat. Attack each hill rep with maximum controlled effort — think 5K race intensity over a shorter distance. Focus on maintaining form as you fatigue: if your technique collapses, your fitness ceiling drops too. Full descent recovery between reps. Cool down easy.',
  },

  progression: {
    base: 'Start at easy pace and build steadily every 10–15 minutes across the run, finishing the final segment at a comfortably hard tempo effort. No sudden jumps — think of it as a smooth, continuous increase in effort. The physiological goal is teaching your body to recruit faster muscle fibres progressively, which directly mimics the demands of the second half of a race.',
    build: 'Begin easy and build every 15 minutes, finishing the final 20% of the run at goal race pace or slightly faster. The transition should feel earned, not forced. A well-executed progression run is one of the most effective sessions in endurance training — it practises running fast on tired legs in the safest possible way.',
    peak: 'Your most race-specific non-long session. Begin easy, build steadily, and commit to running the final third at goal race pace. The cumulative fatigue makes this significantly harder than standalone tempo work. If the final segment feels like a grind, that is exactly the training response you are after.',
    taper: 'A gentle progression run to maintain neuromuscular readiness without accumulated fatigue. Start easy and build to a moderate tempo effort only in the final 10 minutes. Short, focused, purposeful — your body is consolidating everything it has built. Do not push beyond tempo effort.',
  },

  cruise: {
    build: 'Warm up 10 min easy. Run 3 × 8 min at threshold pace (comfortably hard, roughly 10-mile race effort) with 90 sec easy jog recovery between blocks. Cool down 10 min easy. Cruise intervals develop lactate threshold with less total stress than a continuous tempo run — the brief recoveries allow slightly better quality on each block.',
    peak: 'Warm up 10 min easy. Run 4 × 6 min at threshold pace with 60 sec easy jog recovery. The tighter recovery amplifies the lactate challenge. Cool down easy. At peak fitness your threshold pace should feel controlled — if it feels easy, you are ready to race.',
  },

  shakeout: {
    race: 'A very easy 20–30 min jog to flush out stiffness — nothing more. The goal is to remind your legs they know how to run, not to add any fitness. Finish with 4 × 10-second gentle accelerations up to race pace to prime your neuromuscular system. Rest completely tomorrow. Everything you need is already in your body.',
  },

  race: {
    race: 'Warm up 10–15 min easy with a few light accelerations to race pace in the final 2 minutes. Line up calm. Execute the first half 5–10 seconds per km more conservative than goal pace — it will feel too easy, which means it is correct. Build through the middle. If you have managed the first half well, you will have genuine energy for a strong finish. Negative split: come home faster than you went out.',
  },
};

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
// Uses level to select the right profile, then applies goal-specific overrides.
//
function resolveSessionTypes(nonLongCount, phaseName, goal, isRecovery, level) {
  const effectivePhase = isRecovery ? 'recovery' : phaseName;
  const slots = clamp(nonLongCount, 1, 5);

  const levelKey   = level || 'casual';
  const levelData  = PHASE_TYPES_BY_LEVEL[levelKey] || PHASE_TYPES_BY_LEVEL.casual;
  const phaseData  = levelData[effectivePhase] || levelData.build || {};
  const base       = phaseData[String(slots)] || ['easy'];

  const overrides = GOAL_TYPE_OVERRIDES[goal] || {};
  return base.map(t => overrides[t] || t);
}

// ── Long run note lookup ──────────────────────────────────────────────────────
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
