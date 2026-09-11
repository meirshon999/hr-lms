import { all, one, SHARED } from './db.ts';
import { allRegularLessonsPassed, canCompleteMaterial, isOverdue, trajectoryOfPosition, videoSecOf } from './domain.ts';
import { needFor } from './study.ts';
import {
  attestationBlockOf, orderedLessons, preSnapshotOf, regularBlocks, snapshotOf, findLesson,
} from './snapshot.ts';

const bool = (v: any) => !!v;

// ---------- живой каталог (конструктор) ----------

/**
 * Дерево траектории для конструктора.
 *
 * `locationId` — точка, глазами которой HR сейчас смотрит. У уроков с общим
 * содержимым он видит один и тот же материал на любой точке, у точечных —
 * материал выбранной точки (или пусто, если она его ещё не завела).
 */
export function trajectoryTree(
  trajectoryId: string,
  opts: { withAnswers: boolean; locationId?: string },
) {
  const t = one<any>('SELECT * FROM trajectories WHERE id = ?', trajectoryId);
  if (!t) return null;
  const at = opts.locationId ?? SHARED;
  const pick = (table: 'materials' | 'tests', column: string, ownerId: string) =>
    one<any>(
      `SELECT * FROM ${table} WHERE ${column} = ? AND location_id IN (?, ?)
        ORDER BY CASE location_id WHEN ? THEN 1 ELSE 0 END LIMIT 1`,
      ownerId, at, SHARED, SHARED,
    );

  const pre = all<any>(
    'SELECT * FROM pre_onboarding_items WHERE trajectory_id = ? ORDER BY ord', trajectoryId,
  ).map((i) => ({
    id: i.id, ord: i.ord, title: i.title, content_type: i.content_type,
    file_url: i.file_url, text_body: i.text_body,
  }));

  const blocks = all<any>(
    'SELECT * FROM blocks WHERE trajectory_id = ? ORDER BY ord', trajectoryId,
  ).map((b) => {
    const base: any = { id: b.id, ord: b.ord, title: b.title, kind: b.kind };
    if (b.kind === 'attestation') {
      base.test = testDto(pick('tests', 'block_id', b.id), opts.withAnswers);
    } else {
      base.lessons = all<any>('SELECT * FROM lessons WHERE block_id = ? ORDER BY ord', b.id).map((l) => {
        const material = pick('materials', 'lesson_id', l.id);
        const test = pick('tests', 'lesson_id', l.id);
        return {
          id: l.id, ord: l.ord, title: l.title,
          everywhere: !!l.everywhere,
          content_per_location: !!l.content_per_location,
          locations: l.everywhere ? [] : all<{ location_id: string }>(
            'SELECT location_id FROM lesson_locations WHERE lesson_id = ?', l.id,
          ).map((r) => r.location_id),
          // видно ли HR, что материал именно этой точки, а не общий
          material_of_location: material?.location_id === SHARED ? null : material?.location_id ?? null,
          material: materialDto(material),
          test: testDto(test, opts.withAnswers),
        };
      });
    }
    return base;
  });

  return { id: t.id, position_id: t.position_id, status: t.status, pre_onboarding: pre, blocks };
}

function materialDto(m: any) {
  if (!m) return null;
  return {
    id: m.id, content_type: m.content_type, file_url: m.file_url,
    text_body: m.text_body, min_watch_pct: m.min_watch_pct,
  };
}

function testDto(t: any, withAnswers: boolean) {
  if (!t) return null;
  const qs = all<any>('SELECT * FROM questions WHERE test_id = ? ORDER BY ord', t.id).map((q) => ({
    id: q.id, ord: q.ord, text: q.text, options: JSON.parse(q.options),
    ...(withAnswers ? { correct_index: q.correct_index } : {}),
  }));
  return { id: t.id, pass_mark_pct: t.pass_mark_pct, questions: qs };
}

export function positionDto(p: any) {
  const traj = trajectoryOfPosition(p.id);
  return { id: p.id, name: p.name, trajectory_status: traj?.status ?? 'draft', trajectory_id: traj?.id ?? null };
}

// ---------- прогресс по снимку ----------

const lessonStatus = (empId: string, lessonId: string) =>
  one<any>('SELECT * FROM lesson_progress WHERE employee_id = ? AND lesson_id = ?', empId, lessonId);

function progressCounts(employeeId: string) {
  const snap = snapshotOf(employeeId);
  if (!snap) return { passed: 0, total: 0 };
  const lessons = orderedLessons(snap);
  const passed = lessons.filter((l) => lessonStatus(employeeId, l.lesson_id)?.status === 'passed').length;
  return { passed, total: lessons.length };
}

export function employeeRow(e: any) {
  const pos = one<any>('SELECT name FROM positions WHERE id = ?', e.position_id);
  return {
    id: e.id, iin: e.iin, full_name: e.full_name,
    position: pos?.name ?? '—', position_id: e.position_id,
    location: one<any>('SELECT name FROM locations WHERE id = ?', e.location_id)?.name ?? '—',
    location_id: e.location_id,
    phone: e.phone, start_date: e.start_date, stage: e.stage,
    onboarding_due_date: e.onboarding_due_date, overdue: isOverdue(e),
    paused: !!e.paused_at,
    progress: progressCounts(e.id),
  };
}

export function employeeCard(e: any) {
  const preIds = preSnapshotOf(e.id);
  const preItems = preIds
    .map((id) => one<any>('SELECT * FROM pre_onboarding_items WHERE id = ?', id))
    .filter(Boolean);
  const preViews = new Set(
    all<{ item_id: string }>('SELECT item_id FROM pre_onboarding_views WHERE employee_id = ?', e.id)
      .map((v) => v.item_id),
  );

  const snap = snapshotOf(e.id);
  const blocks = snap ? regularBlocks(snap).map((b) => ({
    id: b.block_id, title: b.title,
    lessons: b.lessons.map((l) => {
      const lp = lessonStatus(e.id, l.lesson_id);
      const attempts = l.test ? one<{ n: number }>(
        'SELECT COUNT(*) n FROM test_attempts WHERE employee_id = ? AND test_id = ?', e.id, l.test.test_id,
      )!.n : 0;
      return {
        id: l.lesson_id, title: l.title,
        status: lp?.status ?? 'locked', material_done: bool(lp?.material_done),
        test_attempts: attempts, passed_at: lp?.passed_at ?? null,
        /* Сколько человек провёл на материале и сколько полагалось. Кадровик
           должен видеть «прочитал за 12 секунд текст на четыре минуты» — без
           этого доказательство есть только внутри системы. */
        seconds_spent: lp?.seconds_spent ?? 0,
        needed_seconds: needFor(l.material, videoSecOf(l.material?.file_url ?? null)).seconds,
      };
    }),
  })) : [];

  const att = snap ? attestationBlockOf(snap) : null;
  const attAttempts = att?.test ? all<any>(
    'SELECT attempt_no, score_pct, passed, submitted_at FROM test_attempts WHERE employee_id = ? AND test_id = ? ORDER BY attempt_no',
    e.id, att.test.test_id,
  ) : [];

  const user = one<any>('SELECT login FROM users WHERE employee_id = ?', e.id);
  const traj = trajectoryOfPosition(e.position_id);

  return {
    id: e.id, iin: e.iin, full_name: e.full_name, phone: e.phone, start_date: e.start_date,
    position: one<any>('SELECT name FROM positions WHERE id = ?', e.position_id)?.name ?? '—',
    position_id: e.position_id,
    location: one<any>('SELECT name FROM locations WHERE id = ?', e.location_id)?.name ?? '—',
    location_id: e.location_id,
    login: user?.login ?? null,
    stage: e.stage,
    paused_at: e.paused_at ?? null,
    internship_passed: bool(e.internship_passed),
    pre_onboarding: {
      done: bool(e.pre_onboarding_done),
      viewed: preItems.filter((i: any) => preViews.has(i.id)).length,
      total: preItems.length,
    },
    onboarding_opened_at: e.onboarding_opened_at,
    onboarding_due_date: e.onboarding_due_date,
    overdue: isOverdue(e),
    completed_at: e.completed_at,
    archived_at: e.archived_at,
    trajectory_status: traj?.status ?? null,
    snapshot_taken_at: snap?.taken_at ?? null,
    blocks,
    attestation: { attempts: attAttempts.map((a: any) => ({ ...a, passed: bool(a.passed) })) },
  };
}

// ---------- экраны сотрудника ----------

export function myTrajectory(e: any) {
  const snap = snapshotOf(e.id);
  if (!snap) return { stage: e.stage, trajectory: null, progress: { passed: 0, total: 0 }, block_count: 0 };

  const blocks = regularBlocks(snap).map((b) => ({
    id: b.block_id, title: b.title,
    lessons: b.lessons.map((l) => {
      const lp = lessonStatus(e.id, l.lesson_id);
      return {
        id: l.lesson_id, title: l.title,
        status: lp?.status ?? 'locked',
        material_done: bool(lp?.material_done),
        material_type: l.material?.content_type ?? null,
      };
    }),
  }));

  const counts = { passed: 0, total: 0 };
  for (const b of blocks) for (const l of b.lessons) { counts.total++; if (l.status === 'passed') counts.passed++; }

  const att = attestationBlockOf(snap);
  const attPassed = att?.test
    ? !!one('SELECT 1 FROM test_attempts WHERE employee_id = ? AND test_id = ? AND passed = 1 LIMIT 1', e.id, att.test.test_id)
    : false;

  return {
    stage: e.stage,
    onboarding_due_date: e.onboarding_due_date,
    overdue: isOverdue(e),
    completed_at: e.completed_at,
    progress: counts,
    block_count: blocks.length,
    trajectory: {
      blocks,
      attestation: {
        available: allRegularLessonsPassed(e.id),
        passed: attPassed,
        question_count: att?.test?.questions.length ?? 0,
        pass_mark_pct: att?.test?.pass_mark_pct ?? 0,
      },
    },
  };
}

export function myLesson(e: any, lessonId: string) {
  const lp = lessonStatus(e.id, lessonId);
  if (!lp) return null;
  const snap = snapshotOf(e.id);
  const l = snap ? findLesson(snap, lessonId) : null;
  if (!l) return null;

  const lessons = snap ? orderedLessons(snap) : [];
  const idx = lessons.findIndex((x) => x.lesson_id === lessonId);

  const lastAttempt = l.test ? one<any>(
    'SELECT attempt_no, score_pct, passed FROM test_attempts WHERE employee_id = ? AND test_id = ? ORDER BY attempt_no DESC LIMIT 1',
    e.id, l.test.test_id,
  ) : null;

  return {
    id: l.lesson_id, title: l.title, status: lp.status,
    material_done: bool(lp.material_done),
    video_pct: lp.video_pct ?? 0,
    /* Сколько человек уже провёл на материале и сколько нужно. Показываем ему
       самому: «нельзя засчитать» без объяснения читается как поломка. */
    study: (() => {
      const g = canCompleteMaterial(e.id, lessonId);
      return {
        seconds_spent: g.spent ?? 0,
        needed_seconds: g.need?.seconds ?? 0,
        need_scroll: g.need?.scroll ?? false,
        scroll_pct: g.scroll ?? 0,
        can_complete: g.ok,
        why: g.need?.why ?? '',
      };
    })(),
    index: idx + 1, total: lessons.length,
    material: l.material,
    test: l.test ? {
      id: l.test.test_id, pass_mark_pct: l.test.pass_mark_pct,
      questions: l.test.questions.map((q) => ({ id: q.question_id, text: q.text, options: q.options })),
      last_attempt: lastAttempt ? { ...lastAttempt, passed: bool(lastAttempt.passed) } : null,
    } : null,
  };
}
