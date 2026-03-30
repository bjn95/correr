// db.js — SQLite database setup using better-sqlite3
// Stores user tokens and their running plan/activities

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || './correr.db';
const resolvedPath = path.resolve(DB_PATH);
fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
const db = new Database(resolvedPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,

    -- Strava
    strava_id          TEXT UNIQUE,
    strava_access_token  TEXT,
    strava_refresh_token TEXT,
    strava_token_expires INTEGER,   -- Unix timestamp
    strava_athlete_name  TEXT,
    strava_profile_pic   TEXT,

    -- Garmin (OAuth 1.0a)
    garmin_oauth_token        TEXT,
    garmin_oauth_token_secret TEXT,
    garmin_user_id            TEXT,

    -- Survey answers → used to build and update the plan
    survey_goal      TEXT,   -- 5k | 10k | half | marathon | general
    survey_level     TEXT,   -- beginner | casual | regular | experienced
    survey_days      INTEGER,
    survey_km        INTEGER,
    survey_timeline  TEXT,   -- 4w | 8w | 12w | 16w | open
    survey_focus     TEXT    -- speed | endurance | health | weight
  );

  CREATE TABLE IF NOT EXISTS activities (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    synced_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    source          TEXT NOT NULL,   -- 'strava' | 'garmin'
    external_id     TEXT NOT NULL,   -- Strava activity ID or Garmin activity ID
    name            TEXT,
    sport_type      TEXT,
    start_date      TEXT,
    distance_m      REAL,            -- metres
    moving_time_s   INTEGER,         -- seconds
    elapsed_time_s  INTEGER,
    avg_pace_s_km   INTEGER,         -- seconds per km
    avg_heart_rate  REAL,
    max_heart_rate  REAL,
    calories        INTEGER,
    map_polyline    TEXT,
    raw_json        TEXT,            -- full JSON from the source API
    UNIQUE(source, external_id)
  );

  CREATE TABLE IF NOT EXISTS plan_workouts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    week_number     INTEGER NOT NULL,
    day_of_week     TEXT NOT NULL,   -- Mon | Tue | Wed | Thu | Fri | Sat | Sun
    workout_type    TEXT NOT NULL,   -- easy | tempo | intervals | long | rest
    name            TEXT NOT NULL,
    description     TEXT,
    target_distance_km REAL,
    target_pace_min_km REAL,
    garmin_workout_id TEXT,          -- set after pushing to Garmin
    scheduled_date  TEXT,            -- ISO date YYYY-MM-DD
    completed       INTEGER DEFAULT 0,
    linked_activity_id INTEGER REFERENCES activities(id)
  );
`);

// ── Migrations (safe to run on existing DBs) ──────────────────────────────────
for (const sql of [
  'ALTER TABLE users ADD COLUMN age INTEGER',
  'ALTER TABLE users ADD COLUMN target_race_name TEXT',
  'ALTER TABLE users ADD COLUMN target_race_date TEXT',
  'ALTER TABLE users ADD COLUMN target_race_time TEXT',
  'ALTER TABLE users ADD COLUMN pb_5k TEXT',
  'ALTER TABLE users ADD COLUMN pb_10k TEXT',
  'ALTER TABLE users ADD COLUMN pb_half TEXT',
  'ALTER TABLE users ADD COLUMN pb_marathon TEXT',
  'ALTER TABLE users ADD COLUMN pb_1mile TEXT',
  'ALTER TABLE users ADD COLUMN plan_name TEXT',
  'ALTER TABLE users ADD COLUMN survey_preferred_days TEXT',
  'ALTER TABLE users ADD COLUMN survey_long_run_day TEXT',
  'ALTER TABLE users ADD COLUMN survey_pace_distance TEXT',
  'ALTER TABLE users ADD COLUMN survey_pace_time_s INTEGER',
]) {
  try { db.exec(sql); } catch (_) { /* column already exists */ }
}

module.exports = db;
