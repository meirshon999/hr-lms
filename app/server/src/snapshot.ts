import { all, one, SHARED } from './db.ts';

/**
 * СНИМОК ТРАЕКТОРИИ.
 *
 * При открытии онбординга структура траектории (блоки → уроки → материал + тест
 * + вопросы с верными ответами) копируется в `employees.snapshot_json`.
 * Дальше обучение сотрудника живёт ТОЛЬКО на снимке: правки каталога не могут
 * сломать того, кто уже учится. Новые правки достаются только новым назначениям.
 *
 * Снимок снимается ПОД ТОЧКУ сотрудника: уроки, которых на его точке нет,
 * в снимок не попадают, а у остальных берётся вариант его точки — если он есть,
 * иначе общий.
 *
 * Идентификаторы внутри снимка совпадают с исходными на момент копирования,
 * поэтому lesson_progress / test_attempts продолжают работать как обычно.
 */

export interface SnapQuestion { question_id: string; text: string; options: string[]; correct_index: number; }
export interface SnapTest { test_id: string; pass_mark_pct: number; questions: SnapQuestion[]; }
export interface SnapMaterial {
  content_type: 'video' | 'pdf' | 'text';
  file_url: string | null; text_body: string | null; min_watch_pct: number | null;
}
export interface SnapLesson {
  lesson_id: string; title: string; ord: number;
  material: SnapMaterial | null; test: SnapTest | null;
}
export interface SnapBlock {
  block_id: string; title: string; kind: 'regular' | 'attestation';
  lessons: SnapLesson[]; test: SnapTest | null;
}
export interface Snapshot {
  taken_at: string; trajectory_id: string;
  /** Точка, под которую собран снимок. */
  location_id: string;
  blocks: SnapBlock[];
}

/**
 * Вариант точки, если он заведён, иначе общий. Одно правило и для материала,
 * и для теста — благодаря ему урок «свой на каждой точке» и урок «одинаковый
 * везде» читаются одинаковым кодом.
 */
function pickForLocation<T = any>(table: 'materials' | 'tests', column: string, ownerId: string, locationId: string): T | undefined {
  return one<T>(
    `SELECT * FROM ${table} WHERE ${column} = ? AND location_id IN (?, ?)
      ORDER BY CASE location_id WHEN ? THEN 1 ELSE 0 END LIMIT 1`,
    ownerId, locationId, SHARED, SHARED,
  );
}

function testOf(where: 'lesson_id' | 'block_id', ownerId: string, locationId: string): SnapTest | null {
  const t = pickForLocation('tests', where, ownerId, locationId);
  if (!t) return null;
  return {
    test_id: t.id,
    pass_mark_pct: t.pass_mark_pct,
    questions: all<any>('SELECT * FROM questions WHERE test_id = ? ORDER BY ord', t.id).map((q) => ({
      question_id: q.id, text: q.text, options: JSON.parse(q.options), correct_index: q.correct_index,
    })),
  };
}

/** Уроки блока, которые есть на этой точке, по порядку. */
export function lessonsAt(blockId: string, locationId: string) {
  return all<any>(
    `SELECT l.* FROM lessons l
      WHERE l.block_id = ?
        AND (l.everywhere = 1
             OR EXISTS (SELECT 1 FROM lesson_locations ll
                         WHERE ll.lesson_id = l.id AND ll.location_id = ?))
      ORDER BY l.ord`,
    blockId, locationId,
  );
}

/** Снять копию живой траектории под конкретную точку. */
export function buildSnapshot(trajectoryId: string, locationId: string, takenAt: string): Snapshot {
  const blocks = all<any>('SELECT * FROM blocks WHERE trajectory_id = ? ORDER BY ord', trajectoryId)
    .map<SnapBlock>((b) => {
      if (b.kind === 'attestation') {
        return {
          block_id: b.id, title: b.title, kind: 'attestation', lessons: [],
          test: testOf('block_id', b.id, locationId),
        };
      }
      const lessons = lessonsAt(b.id, locationId).map<SnapLesson>((l) => {
        const m = pickForLocation('materials', 'lesson_id', l.id, locationId);
        return {
          lesson_id: l.id, title: l.title, ord: l.ord,
          material: m ? {
            content_type: m.content_type, file_url: m.file_url,
            text_body: m.text_body, min_watch_pct: m.min_watch_pct,
          } : null,
          test: testOf('lesson_id', l.id, locationId),
        };
      });
      return { block_id: b.id, title: b.title, kind: 'regular', lessons, test: null };
    });
  return { taken_at: takenAt, location_id: locationId, trajectory_id: trajectoryId, blocks };
}

// ---------- чтение снимка ----------

export function snapshotOf(employeeId: string): Snapshot | null {
  const e = one<{ snapshot_json: string | null }>('SELECT snapshot_json FROM employees WHERE id = ?', employeeId);
  if (!e?.snapshot_json) return null;
  try { return JSON.parse(e.snapshot_json) as Snapshot; } catch { return null; }
}

export const regularBlocks = (s: Snapshot) => s.blocks.filter((b) => b.kind === 'regular');
export const attestationBlockOf = (s: Snapshot) => s.blocks.find((b) => b.kind === 'attestation') ?? null;

/** Плоский упорядоченный список уроков (только regular-блоки). */
export function orderedLessons(s: Snapshot): Array<SnapLesson & { block_title: string; block_id: string }> {
  return regularBlocks(s).flatMap((b) =>
    b.lessons.map((l) => ({ ...l, block_title: b.title, block_id: b.block_id })));
}

export function findLesson(s: Snapshot, lessonId: string): SnapLesson | null {
  for (const b of regularBlocks(s)) {
    const l = b.lessons.find((x) => x.lesson_id === lessonId);
    if (l) return l;
  }
  return null;
}

export function findTest(s: Snapshot, testId: string): SnapTest | null {
  for (const b of s.blocks) {
    if (b.test?.test_id === testId) return b.test;
    for (const l of b.lessons) if (l.test?.test_id === testId) return l.test;
  }
  return null;
}

/** Снимок пре-онбординга — список id материалов на момент найма. */
export function preSnapshotOf(employeeId: string): string[] {
  const e = one<{ pre_snapshot_json: string | null }>(
    'SELECT pre_snapshot_json FROM employees WHERE id = ?', employeeId);
  if (!e?.pre_snapshot_json) return [];
  try { return JSON.parse(e.pre_snapshot_json) as string[]; } catch { return []; }
}
