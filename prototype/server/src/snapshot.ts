import { all, one } from './db.ts';

/**
 * СНИМОК ТРАЕКТОРИИ.
 *
 * При открытии онбординга структура траектории (блоки → уроки → материал + тест
 * + вопросы с верными ответами) копируется в `employees.snapshot_json`.
 * Дальше обучение сотрудника живёт ТОЛЬКО на снимке: правки каталога не могут
 * сломать того, кто уже учится. Новые правки достаются только новым назначениям.
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
export interface Snapshot { taken_at: string; trajectory_id: string; blocks: SnapBlock[]; }

function testOf(where: 'lesson_id' | 'block_id', ownerId: string): SnapTest | null {
  const t = one<any>(`SELECT * FROM tests WHERE ${where} = ?`, ownerId);
  if (!t) return null;
  return {
    test_id: t.id,
    pass_mark_pct: t.pass_mark_pct,
    questions: all<any>('SELECT * FROM questions WHERE test_id = ? ORDER BY ord', t.id).map((q) => ({
      question_id: q.id, text: q.text, options: JSON.parse(q.options), correct_index: q.correct_index,
    })),
  };
}

/** Снять копию живой траектории. */
export function buildSnapshot(trajectoryId: string, takenAt: string): Snapshot {
  const blocks = all<any>('SELECT * FROM blocks WHERE trajectory_id = ? ORDER BY ord', trajectoryId)
    .map<SnapBlock>((b) => {
      if (b.kind === 'attestation') {
        return { block_id: b.id, title: b.title, kind: 'attestation', lessons: [], test: testOf('block_id', b.id) };
      }
      const lessons = all<any>('SELECT * FROM lessons WHERE block_id = ? ORDER BY ord', b.id).map<SnapLesson>((l) => {
        const m = one<any>('SELECT * FROM materials WHERE lesson_id = ?', l.id);
        return {
          lesson_id: l.id, title: l.title, ord: l.ord,
          material: m ? {
            content_type: m.content_type, file_url: m.file_url,
            text_body: m.text_body, min_watch_pct: m.min_watch_pct,
          } : null,
          test: testOf('lesson_id', l.id),
        };
      });
      return { block_id: b.id, title: b.title, kind: 'regular', lessons, test: null };
    });
  return { taken_at: takenAt, trajectory_id: trajectoryId, blocks };
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
