import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DB_PATH } from './config.ts';

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

export const uuid = () => randomUUID();

/** Общий вариант контента — тот, что действует на всех точках сразу. */
export const SHARED = '*';

/** Версия схемы. Растёт при изменениях, несовместимых с прежними данными. */
const SCHEMA_VERSION = 2;

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
  is_active     INTEGER NOT NULL DEFAULT 1,
  -- выдан временный пароль: до смены пускаем только на экран смены пароля
  must_change_password INTEGER NOT NULL DEFAULT 0
);

-- Точка сети: ресторан, караоке, боулинг. Города может не быть — впишут позже.
CREATE TABLE IF NOT EXISTS locations (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  city      TEXT,
  ord       INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
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

-- Пре-онбординг общий на всю сеть: про компанию, а не про конкретную точку.
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

-- Каркас урока один на сеть. Два независимых признака решают, как он живёт на точках:
--   everywhere = 0        → урок есть только на точках из lesson_locations
--   content_per_location  → материал и тест свои у каждой точки, а не общие
CREATE TABLE IF NOT EXISTS lessons (
  id                   TEXT PRIMARY KEY,
  block_id             TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  ord                  INTEGER NOT NULL,
  title                TEXT NOT NULL,
  everywhere           INTEGER NOT NULL DEFAULT 1,
  content_per_location INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS lesson_locations (
  lesson_id   TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (lesson_id, location_id)
);

-- location_id = '*' — общий вариант; иначе вариант конкретной точки.
CREATE TABLE IF NOT EXISTS materials (
  id            TEXT PRIMARY KEY,
  lesson_id     TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  location_id   TEXT NOT NULL DEFAULT '*',
  content_type  TEXT NOT NULL CHECK (content_type IN ('video','pdf','text')),
  file_url      TEXT,
  text_body     TEXT,
  min_watch_pct INTEGER,
  UNIQUE (lesson_id, location_id)
);

CREATE TABLE IF NOT EXISTS tests (
  id            TEXT PRIMARY KEY,
  lesson_id     TEXT REFERENCES lessons(id) ON DELETE CASCADE,
  block_id      TEXT REFERENCES blocks(id) ON DELETE CASCADE,
  location_id   TEXT NOT NULL DEFAULT '*',
  pass_mark_pct INTEGER NOT NULL DEFAULT 70,
  UNIQUE (lesson_id, location_id),
  UNIQUE (block_id, location_id)
);

CREATE TABLE IF NOT EXISTS questions (
  id            TEXT PRIMARY KEY,
  test_id       TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL,
  text          TEXT NOT NULL,
  options       TEXT NOT NULL,
  correct_index INTEGER NOT NULL
);

-- ИИН — ключ человека в сети: имя можно записать иначе, номер один и тот же.
-- Телефон намеренно НЕ уникален: он меняется, и на него нельзя опираться.
CREATE TABLE IF NOT EXISTS employees (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  iin                  TEXT NOT NULL UNIQUE,
  full_name            TEXT NOT NULL,
  position_id          TEXT NOT NULL REFERENCES positions(id),
  location_id          TEXT NOT NULL REFERENCES locations(id),
  phone                TEXT NOT NULL,
  start_date           TEXT NOT NULL,
  stage                TEXT NOT NULL DEFAULT 'intern' CHECK (stage IN ('intern','onboarding','completed','archived')),
  internship_passed    INTEGER NOT NULL DEFAULT 0,
  pre_onboarding_done  INTEGER NOT NULL DEFAULT 0,
  onboarding_opened_at TEXT,
  onboarding_due_date  TEXT,
  completed_at         TEXT,
  archived_at          TEXT,
  -- пауза онбординга (болезнь/отпуск): пока стоит, дедлайн не идёт
  paused_at            TEXT,
  created_at           TEXT NOT NULL,
  -- снимок структуры пре-онбординга (список id) — замораживается при найме
  pre_snapshot_json    TEXT,
  -- снимок траектории под точку сотрудника — при открытии онбординга
  snapshot_json        TEXT
);
CREATE INDEX IF NOT EXISTS idx_emp_location ON employees(location_id);
CREATE INDEX IF NOT EXISTS idx_emp_stage ON employees(stage);

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

CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  orig_name   TEXT NOT NULL,
  mime        TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- video | pdf | image
  ext         TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- Черновик урока, собранный ИИ. Лежит отдельно от каталога: пока HR его не
-- подтвердил, ни один сотрудник его не видит (C-13).
CREATE TABLE IF NOT EXISTS ai_drafts (
  id          TEXT PRIMARY KEY,
  lesson_id   TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL DEFAULT '*',
  source_text TEXT NOT NULL,
  draft_json  TEXT NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (lesson_id, location_id)
);

-- План траектории, предложенный ИИ по документу. В каталог не смотрит:
-- пока человек не нажмёт «Создать», это просто предложение (правило C-13).
CREATE TABLE IF NOT EXISTS ai_plans (
  id            TEXT PRIMARY KEY,
  trajectory_id TEXT NOT NULL UNIQUE REFERENCES trajectories(id) ON DELETE CASCADE,
  source_text   TEXT NOT NULL,
  sections_json TEXT NOT NULL,
  plan_json     TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- Кусок исходника, из которого вырос урок. Нужен, чтобы кадровик не искал
-- нужный абзац в сорокастраничном регламенте заново: открыл сборку урока —
-- исходник уже в поле.
CREATE TABLE IF NOT EXISTS ai_lesson_sources (
  lesson_id   TEXT PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE,
  source_text TEXT NOT NULL
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

/** Добавляет колонку, если её ещё нет: SCHEMA идёт через CREATE TABLE IF NOT EXISTS
 *  и на уже существующей базе новые поля сама не создаёт. */
function addColumnIfMissing(table: string, column: string, decl: string) {
  const cols = all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

const tableExists = (name: string) =>
  !!one(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, name);

export function migrate() {
  // База от прототипа несовместима: телефон там уникален, точек и ИИН нет,
  // а материал привязан к уроку один к одному. Переносить демо-данные некуда
  // и незачем — честнее остановиться и сказать об этом прямо.
  if (tableExists('employees')) {
    const version = Number(getState('schema_version') ?? 1);
    const cols = all<{ name: string }>('PRAGMA table_info(employees)');
    if (version < SCHEMA_VERSION && !cols.some((c) => c.name === 'iin')) {
      throw new Error(
        `База версии ${version} несовместима с версией ${SCHEMA_VERSION} (точки, ИИН, ` +
        `контент по точкам). Боевых данных в ней нет — удалите файл базы (${DB_PATH}) ` +
        'и запустите сервер заново.',
      );
    }
  }

  db.exec(SCHEMA);
  addColumnIfMissing('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
  setState('schema_version', String(SCHEMA_VERSION));
}

/** Полный сброс: удаляет все данные (только тестовый сервер). */
export function wipe() {
  const tables = [
    'audit_log', 'ai_drafts', 'ai_plans', 'ai_lesson_sources', 'test_attempts', 'lesson_progress', 'pre_onboarding_views', 'employees',
    'questions', 'tests', 'materials', 'lesson_locations', 'lessons', 'blocks',
    'pre_onboarding_items', 'trajectories', 'positions', 'locations', 'users',
    'app_state', 'files',
  ];
  db.exec('PRAGMA foreign_keys = OFF;');
  for (const t of tables) db.exec(`DELETE FROM ${t};`);
  db.exec('PRAGMA foreign_keys = ON;');
  setState('schema_version', String(SCHEMA_VERSION));
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
