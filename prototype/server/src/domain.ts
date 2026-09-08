import { ONBOARDING_DAYS } from './config.ts';
import { addDays, isAfter, stamp, today } from './clock.ts';
import { all, one, run, uuid } from './db.ts';
import { emit } from './events.ts';
import {
  attestationBlockOf, buildSnapshot, findLesson, findTest, orderedLessons,
  preSnapshotOf, snapshotOf,
} from './snapshot.ts';

export interface Answer { question_id: string; option_index: number; }

const empName = (id: string) =>
  one<{ full_name: string }>('SELECT full_name FROM employees WHERE id = ?', id)?.full_name ?? id;

// ---------- справочные выборки (живой каталог) ----------

export function trajectoryOfPosition(positionId: string) {
  return one<{ id: string; status: string }>(
    'SELECT id, status FROM trajectories WHERE position_id = ?', positionId,
  );
}

// ---------- гейт 1: пре-онбординг ----------

/** Заморозить список материалов пре-онбординга при найме. */
export function takePreSnapshot(employeeId: string) {
  const e = one<any>('SELECT * FROM employees WHERE id = ?', employeeId);
  if (!e) return;
  const traj = trajectoryOfPosition(e.position_id);
  const ids = traj
    ? all<{ id: string }>('SELECT id FROM pre_onboarding_items WHERE trajectory_id = ? ORDER BY ord', traj.id).map((r) => r.id)
    : [];
  run('UPDATE employees SET pre_snapshot_json = ? WHERE id = ?', JSON.stringify(ids), employeeId);
}

export function recomputePreOnboardingDone(employeeId: string) {
  const items = preSnapshotOf(employeeId);
  if (items.length === 0) {
    run('UPDATE employees SET pre_onboarding_done = 1 WHERE id = ?', employeeId);
    return;
  }
  const viewed = new Set(
    all<{ item_id: string }>('SELECT item_id FROM pre_onboarding_views WHERE employee_id = ?', employeeId)
      .map((v) => v.item_id),
  );
  const done = items.every((id) => viewed.has(id)) ? 1 : 0;
  run('UPDATE employees SET pre_onboarding_done = ? WHERE id = ?', done, employeeId);
}

// ---------- открытие онбординга: снимаем копию траектории ----------

export function tryOpenOnboarding(employeeId: string): { opened: boolean; reason?: string } {
  const e = one<any>('SELECT * FROM employees WHERE id = ?', employeeId);
  if (!e) return { opened: false, reason: 'no_employee' };
  if (e.stage !== 'intern') return { opened: false, reason: 'not_intern' };
  if (!e.pre_onboarding_done) return { opened: false, reason: 'pre_onboarding_not_done' };
  if (!e.internship_passed) return { opened: false, reason: 'internship_not_passed' };

  const traj = trajectoryOfPosition(e.position_id);
  if (!traj || traj.status !== 'active') return { opened: false, reason: 'no_active_trajectory' };

  const openedAt = today();
  const snap = buildSnapshot(traj.id, stamp());

  run(
    `UPDATE employees
        SET stage = 'onboarding', onboarding_opened_at = ?, onboarding_due_date = ?, snapshot_json = ?
      WHERE id = ?`,
    openedAt, addDays(openedAt, ONBOARDING_DAYS), JSON.stringify(snap), employeeId,
  );

  // развернуть прогресс по снимку
  for (const l of orderedLessons(snap)) {
    run('INSERT INTO lesson_progress (id, employee_id, lesson_id, status, material_done) VALUES (?,?,?,?,0)',
      uuid(), employeeId, l.lesson_id, 'locked');
  }
  recomputeUnlocks(employeeId);

  emit('stage: intern → onboarding',
    `${empName(employeeId)} — онбординг открыт (снимок траектории зафиксирован), дедлайн ${addDays(openedAt, ONBOARDING_DAYS)}`);
  return { opened: true };
}

// ---------- движок разблокировки (по снимку) ----------

export function recomputeUnlocks(employeeId: string) {
  const snap = snapshotOf(employeeId);
  if (!snap) return;

  let prevPassed = true;
  for (const l of orderedLessons(snap)) {
    let lp = one<any>(
      'SELECT * FROM lesson_progress WHERE employee_id = ? AND lesson_id = ?', employeeId, l.lesson_id,
    );
    if (!lp) {
      run('INSERT INTO lesson_progress (id, employee_id, lesson_id, status, material_done) VALUES (?,?,?,?,0)',
        uuid(), employeeId, l.lesson_id, 'locked');
      lp = { status: 'locked' };
    }
    if (lp.status === 'passed') { prevPassed = true; continue; }
    const target = prevPassed ? 'available' : 'locked';
    if (lp.status !== target) {
      run('UPDATE lesson_progress SET status = ? WHERE employee_id = ? AND lesson_id = ?',
        target, employeeId, l.lesson_id);
    }
    if (prevPassed) prevPassed = false;
  }
}

/** Материал засчитан: для видео — досмотрел до min_watch_pct (проверяется на сервере). */
export function canCompleteMaterial(employeeId: string, lessonId: string): { ok: boolean; need?: number } {
  const snap = snapshotOf(employeeId);
  const l = snap ? findLesson(snap, lessonId) : null;
  const m = l?.material;
  if (!m || m.content_type !== 'video') return { ok: true };
  const need = m.min_watch_pct ?? 90;
  const lp = one<{ video_pct: number }>(
    'SELECT video_pct FROM lesson_progress WHERE employee_id = ? AND lesson_id = ?', employeeId, lessonId);
  return { ok: (lp?.video_pct ?? 0) >= need, need };
}

export function markLessonPassedIfReady(employeeId: string, lessonId: string) {
  const lp = one<any>(
    'SELECT * FROM lesson_progress WHERE employee_id = ? AND lesson_id = ?', employeeId, lessonId,
  );
  if (!lp || lp.status === 'passed') return;

  const snap = snapshotOf(employeeId);
  const lesson = snap ? findLesson(snap, lessonId) : null;
  const test = lesson?.test ?? null;
  const hasPass = test
    ? !!one('SELECT 1 FROM test_attempts WHERE employee_id = ? AND test_id = ? AND passed = 1 LIMIT 1',
            employeeId, test.test_id)
    : true; // урок без теста закрывается одним материалом

  if (lp.material_done && hasPass) {
    run(`UPDATE lesson_progress SET status = 'passed', passed_at = ? WHERE employee_id = ? AND lesson_id = ?`,
      stamp(), employeeId, lessonId);
    recomputeUnlocks(employeeId);
    emit('урок пройден', `${empName(employeeId)} — «${lesson?.title ?? lessonId}»`);
    if (allRegularLessonsPassed(employeeId))
      emit('готов к аттестации', `${empName(employeeId)} — все уроки пройдены`);
  }
}

export function allRegularLessonsPassed(employeeId: string): boolean {
  const snap = snapshotOf(employeeId);
  if (!snap) return false;
  const lessons = orderedLessons(snap);
  if (lessons.length === 0) return false;
  return lessons.every((l) =>
    one<{ status: string }>(
      'SELECT status FROM lesson_progress WHERE employee_id = ? AND lesson_id = ?', employeeId, l.lesson_id,
    )?.status === 'passed');
}

// ---------- оценка теста (по снимку, не по живому каталогу) ----------

export function gradeTest(employeeId: string, testId: string, answers: Answer[]) {
  const snap = snapshotOf(employeeId);
  const test = snap ? findTest(snap, testId) : null;
  if (!test) throw new Error('test_not_in_snapshot');
  const byId = new Map(answers.map((a) => [a.question_id, a.option_index]));
  let correct = 0;
  for (const q of test.questions) if (byId.get(q.question_id) === q.correct_index) correct++;
  const total = test.questions.length;
  const score_pct = total ? Math.round((correct / total) * 100) : 0;
  return { score_pct, passed: score_pct >= test.pass_mark_pct, total, correct, pass_mark_pct: test.pass_mark_pct };
}

export function recordAttempt(employeeId: string, testId: string, answers: Answer[]) {
  const g = gradeTest(employeeId, testId, answers);
  const prev = one<{ n: number }>(
    'SELECT COALESCE(MAX(attempt_no),0) n FROM test_attempts WHERE employee_id = ? AND test_id = ?',
    employeeId, testId,
  )!.n;
  run(
    `INSERT INTO test_attempts (id, employee_id, test_id, attempt_no, answers, score_pct, passed, submitted_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    uuid(), employeeId, testId, prev + 1, JSON.stringify(answers), g.score_pct, g.passed ? 1 : 0, stamp(),
  );
  return { ...g, attempt_no: prev + 1 };
}

// ---------- аттестация ----------

export function submitAttestation(employeeId: string, answers: Answer[]) {
  const e = one<any>('SELECT * FROM employees WHERE id = ?', employeeId);
  if (!e) throw new Error('no_employee');
  const snap = snapshotOf(employeeId);
  const block = snap ? attestationBlockOf(snap) : null;
  if (!block?.test) throw new Error('no_attestation');
  if (!allRegularLessonsPassed(employeeId)) throw new Error('lessons_incomplete');

  const res = recordAttempt(employeeId, block.test.test_id, answers);
  emit('аттестация', `${empName(employeeId)} — ${res.score_pct}% ${res.passed ? '(сдана)' : '(не сдана)'}`);
  if (res.passed && e.stage === 'onboarding') {
    run(`UPDATE employees SET stage = 'completed', completed_at = ? WHERE id = ?`, stamp(), employeeId);
    emit('stage: onboarding → completed', `${empName(employeeId)} — онбординг завершён`);
  }
  return res;
}

// ---------- кадровые действия ----------

export function archiveEmployee(employeeId: string) {
  emit('stage: → archived', `${empName(employeeId)} — в архив, вход закрыт`);
  run(`UPDATE employees SET stage = 'archived', archived_at = ? WHERE id = ?`, stamp(), employeeId);
  run('UPDATE users SET is_active = 0 WHERE employee_id = ?', employeeId);
}

export function deleteEmployeeCompletely(employeeId: string) {
  const e = one<{ user_id: string }>('SELECT user_id FROM employees WHERE id = ?', employeeId);
  if (!e) return;
  emit('удалён', `${empName(employeeId)} — стажировку не прошёл, профиль удалён`);
  run('DELETE FROM employees WHERE id = ?', employeeId);
  run('DELETE FROM users WHERE id = ?', e.user_id);
}

// ---------- вычисляемое ----------

export function isOverdue(e: any): boolean {
  return e.stage === 'onboarding' && !!e.onboarding_due_date && isAfter(today(), e.onboarding_due_date);
}
