import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DB_PATH } from './config.ts';

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

export const uuid = () => randomUUID();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  login         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('employee','hr','admin')),
  employee_id   TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS positions (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trajectories (
  id          TEXT PRIMARY KEY,
  position_id TEXT NOT NULL UNIQUE REFERENCES positions(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active'))
);

CREATE TABLE IF NOT EXISTS pre_onboarding_items (
  id            TEXT PRIMARY KEY,
  trajectory_id TEXT NOT NULL REFERENCES trajectories(id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL,
  title         TEXT NOT NULL,
  content_type  TEXT NOT NULL CHECK (content_type IN ('video','pdf','text')),
  file_url      TEXT,
  text_body     TEXT
);

CREATE TABLE IF NOT EXISTS blocks (
  id            TEXT PRIMARY KEY,
  trajectory_id TEXT NOT NULL REFERENCES trajectories(id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'regular' CHECK (kind IN ('regular','attestation'))
);

CREATE TABLE IF NOT EXISTS lessons (
  id       TEXT PRIMARY KEY,
  block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  ord      INTEGER NOT NULL,
  title    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS materials (
  id            TEXT PRIMARY KEY,
  lesson_id     TEXT NOT NULL UNIQUE REFERENCES lessons(id) ON DELETE CASCADE,
  content_type  TEXT NOT NULL CHECK (content_type IN ('video','pdf','text')),
  file_url      TEXT,
  text_body     TEXT,
  min_watch_pct INTEGER
);

CREATE TABLE IF NOT EXISTS tests (
  id            TEXT PRIMARY KEY,
  lesson_id     TEXT UNIQUE REFERENCES lessons(id) ON DELETE CASCADE,
  block_id      TEXT UNIQUE REFERENCES blocks(id) ON DELETE CASCADE,
  pass_mark_pct INTEGER NOT NULL DEFAULT 70
);

CREATE TABLE IF NOT EXISTS questions (
  id            TEXT PRIMARY KEY,
  test_id       TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL,
  text          TEXT NOT NULL,
  options       TEXT NOT NULL,
  correct_index INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  full_name            TEXT NOT NULL,
  position_id          TEXT NOT NULL REFERENCES positions(id),
  phone                TEXT NOT NULL UNIQUE,
  start_date           TEXT NOT NULL,
  stage                TEXT NOT NULL DEFAULT 'intern' CHECK (stage IN ('intern','onboarding','completed','archived')),
  internship_passed    INTEGER NOT NULL DEFAULT 0,
  pre_onboarding_done  INTEGER NOT NULL DEFAULT 0,
  onboarding_opened_at TEXT,
  onboarding_due_date  TEXT,
  completed_at         TEXT,
  archived_at          TEXT,
  created_at           TEXT NOT NULL,
  -- снимок структуры пре-онбординга (список id) — замораживается при найме
  pre_snapshot_json    TEXT,
  -- снимок траектории (блоки/уроки/материалы/тесты/вопросы) — при открытии онбординга
  snapshot_json        TEXT
);

CREATE TABLE IF NOT EXISTS pre_onboarding_views (
  id          TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL REFERENCES pre_onboarding_items(id) ON DELETE CASCADE,
  viewed_at   TEXT NOT NULL,
  UNIQUE (employee_id, item_id)
);

-- lesson_id / test_id ниже указывают на СНИМОК сотрудника, а не на живой каталог,
-- поэтому внешних ключей на lessons/tests тут нет: контент могли удалить.
CREATE TABLE IF NOT EXISTS lesson_progress (
  id            TEXT PRIMARY KEY,
  employee_id   TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  lesson_id     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'locked' CHECK (status IN ('locked','available','passed')),
  material_done INTEGER NOT NULL DEFAULT 0,
  video_pct     INTEGER NOT NULL DEFAULT 0,
  passed_at     TEXT,
  UNIQUE (employee_id, lesson_id)
);

CREATE TABLE IF NOT EXISTS test_attempts (
  id           TEXT PRIMARY KEY,
  employee_id  TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  test_id      TEXT NOT NULL,
  attempt_no   INTEGER NOT NULL,
  answers      TEXT NOT NULL,
  score_pct    INTEGER NOT NULL,
  passed       INTEGER NOT NULL,
  submitted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  actor_login TEXT NOT NULL,
  action      TEXT NOT NULL,
  employee_id TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_emp ON audit_log(employee_id);
`;

export function migrate() {
  db.exec(SCHEMA);
}

/** Полный сброс: удаляет все данные (для кнопки «Сбросить демо»). */
export function wipe() {
  const tables = [
    'audit_log', 'test_attempts', 'lesson_progress', 'pre_onboarding_views', 'employees',
    'questions', 'tests', 'materials', 'lessons', 'blocks', 'pre_onboarding_items',
    'trajectories', 'positions', 'users', 'app_state',
  ];
  db.exec('PRAGMA foreign_keys = OFF;');
  for (const t of tables) db.exec(`DELETE FROM ${t};`);
  db.exec('PRAGMA foreign_keys = ON;');
}

// --- маленькие помощники запросов ---
export const one = <T = any>(sql: string, ...params: any[]): T | undefined =>
  db.prepare(sql).get(...params) as T | undefined;

export const all = <T = any>(sql: string, ...params: any[]): T[] =>
  db.prepare(sql).all(...params) as T[];

export const run = (sql: string, ...params: any[]) => db.prepare(sql).run(...params);

export const getState = (key: string): string | undefined =>
  (one<{ value: string }>('SELECT value FROM app_state WHERE key = ?', key))?.value;

export const setState = (key: string, value: string) =>
  run(
    'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, value,
  );
