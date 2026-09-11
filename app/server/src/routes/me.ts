import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { all, one, run, uuid } from '../db.ts';
import { authRequired, err } from '../auth.ts';
import { stamp } from '../clock.ts';
import { beat } from '../study.ts';
import {
  allRegularLessonsPassed, canCompleteMaterial, markLessonPassedIfReady, SCROLL_DONE_PCT,
  recomputePreOnboardingDone, recordAttempt, submitAttestation, tryOpenOnboarding,
} from '../domain.ts';
import { attestationBlockOf, findLesson, preSnapshotOf, snapshotOf } from '../snapshot.ts';
import { myLesson, myTrajectory } from '../serializers.ts';

/** Шаг удара сердца. Больше одного шага за раз не засчитываем. */
const BEAT_STEP_SEC = 15;

/** «Ещё 40 секунд» человеку понятнее, чем «ещё 0.7 минуты». */
const aboutMinutes = (sec: number) =>
  sec >= 90 ? `${Math.ceil(sec / 60)} мин` : `${Math.max(5, Math.ceil(sec / 5) * 5)} сек`;

function emp(req: FastifyRequest, reply: FastifyReply) {
  const u = (req as any).user;
  const e = u.employee_id ? one<any>('SELECT * FROM employees WHERE id = ?', u.employee_id) : null;
  if (!e) { reply.code(404).send(err('no_employee', 'Профиль сотрудника не найден')); return null; }
  return e;
}

const answersSchema = z.object({
  answers: z.array(z.object({ question_id: z.string(), option_index: z.number().int() })),
});

export default async function meRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authRequired('employee'));

  // ---------- пре-онбординг (по снимку, снятому при найме) ----------
  app.get('/me/pre-onboarding', async (req, reply) => {
    const e = emp(req, reply); if (!e) return;
    const ids = preSnapshotOf(e.id);
    const viewed = new Set(
      all<{ item_id: string }>('SELECT item_id FROM pre_onboarding_views WHERE employee_id = ?', e.id)
        .map((v) => v.item_id),
    );
    const items = ids
      .map((id) => one<any>('SELECT * FROM pre_onboarding_items WHERE id = ?', id))
      .filter(Boolean)
      .map((i: any) => ({
        id: i.id, title: i.title, content_type: i.content_type,
        file_url: i.file_url, text_body: i.text_body, viewed: viewed.has(i.id),
      }));
    return { done: !!e.pre_onboarding_done, items };
  });

  app.post('/me/pre-onboarding/:itemId/view', async (req, reply) => {
    const e = emp(req, reply); if (!e) return;
    const { itemId } = req.params as { itemId: string };
    if (!preSnapshotOf(e.id).includes(itemId))
      return reply.code(404).send(err('not_found', 'Материал не найден'));
    run(
      `INSERT INTO pre_onboarding_views (id, employee_id, item_id, viewed_at) VALUES (?,?,?,?)
       ON CONFLICT(employee_id, item_id) DO NOTHING`,
      uuid(), e.id, itemId, stamp(),
    );
    recomputePreOnboardingDone(e.id);
    const open = tryOpenOnboarding(e.id);
    return { ok: true, onboarding_opened: open.opened };
  });

  // ---------- траектория и уроки (по снимку) ----------
  app.get('/me/trajectory', async (req, reply) => {
    const e = emp(req, reply); if (!e) return;
    if (e.stage === 'intern')
      return reply.code(409).send(err('onboarding_not_open', 'Онбординг ещё не открыт'));
    return myTrajectory(e);
  });

  app.get('/me/lessons/:lessonId', async (req, reply) => {
    const e = emp(req, reply); if (!e) return;
    const dto = myLesson(e, (req.params as any).lessonId);
    if (!dto) return reply.code(404).send(err('not_found', 'Урок не найден'));
    if (dto.status === 'locked') return reply.code(403).send(err('locked', 'Урок ещё закрыт'));
    return dto;
  });

  /**
   * УДАР СЕРДЦА: «я всё ещё на этой странице, прошло ещё N секунд».
   *
   * Заменил собой доверчивый приём процента просмотра. Раньше клиент говорил
   * «просмотрено 100%», и сервер это записывал — обойти можно было одним
   * запросом. Теперь присланные секунды режутся по часам сервера: чтобы
   * накопить десять минут, нужно потратить десять настоящих минут.
   *
   * Клиент шлёт удары только когда вкладка открыта и видео играет, но на это
   * мы не полагаемся — полагаемся на разницу во времени между ударами.
   */
  app.post('/me/lessons/:lessonId/beat', async (req, reply) => {
    const e = emp(req, reply); if (!e) return;
    const { lessonId } = req.params as { lessonId: string };
    const p = z.object({
      seconds: z.number().int().min(0).max(120),
      scroll_pct: z.number().int().min(0).max(100).optional(),
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'seconds 0–120'));

    const lp = one<any>('SELECT * FROM lesson_progress WHERE employee_id = ? AND lesson_id = ?', e.id, lessonId);
    if (!lp) return reply.code(404).send(err('not_found', 'Урок не найден'));
    if (lp.status === 'locked') return reply.code(403).send(err('locked', 'Урок ещё закрыт'));

    const r = beat(e.id, lessonId, p.data.seconds, p.data.scroll_pct ?? 0, BEAT_STEP_SEC);
    const gate = canCompleteMaterial(e.id, lessonId);
    return {
      seconds_spent: r.seconds_spent,
      scroll_pct: r.scroll_pct,
      needed_seconds: gate.need?.seconds ?? 0,
      need_scroll: gate.need?.scroll ?? false,
      can_complete: gate.ok,
    };
  });

  app.post('/me/lessons/:lessonId/material-done', async (req, reply) => {
    const e = emp(req, reply); if (!e) return;
    const { lessonId } = req.params as { lessonId: string };
    const lp = one<any>('SELECT * FROM lesson_progress WHERE employee_id = ? AND lesson_id = ?', e.id, lessonId);
    if (!lp) return reply.code(404).send(err('not_found', 'Урок не найден'));
    if (lp.status === 'locked') return reply.code(403).send(err('locked', 'Урок ещё закрыт'));

    const gate = canCompleteMaterial(e.id, lessonId);
    if (!gate.ok) {
      // Человеку говорим, чего именно не хватает: «нельзя» без причины он
      // прочитает как поломку и пойдёт к кадровику.
      const left = Math.max(0, (gate.need?.seconds ?? 0) - (gate.spent ?? 0));
      const needScroll = gate.need?.scroll && (gate.scroll ?? 0) < SCROLL_DONE_PCT;
      const msg = needScroll && left > 0
        ? `Дочитайте до конца и побудьте на странице ещё ${aboutMinutes(left)}`
        : needScroll
          ? 'Дочитайте материал до конца'
          : `Побудьте на материале ещё ${aboutMinutes(left)}`;
      return reply.code(422).send(err('material_not_studied', msg, {
        seconds_spent: gate.spent, needed_seconds: gate.need?.seconds,
        scroll_pct: gate.scroll,
      }));
    }

    run('UPDATE lesson_progress SET material_done = 1 WHERE employee_id = ? AND lesson_id = ?', e.id, lessonId);
    markLessonPassedIfReady(e.id, lessonId);
    return { ok: true };
  });

  app.post('/me/lessons/:lessonId/test', async (req, reply) => {
    const e = emp(req, reply); if (!e) return;
    const { lessonId } = req.params as { lessonId: string };
    const parsed = answersSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(err('bad_request', 'Некорректные ответы'));

    const lp = one<any>('SELECT * FROM lesson_progress WHERE employee_id = ? AND lesson_id = ?', e.id, lessonId);
    if (!lp) return reply.code(404).send(err('not_found', 'Урок не найден'));
    if (lp.status === 'locked') return reply.code(403).send(err('locked', 'Урок ещё закрыт'));

    const snap = snapshotOf(e.id);
    const lesson = snap ? findLesson(snap, lessonId) : null;
    if (!lesson?.test) return reply.code(404).send(err('no_test', 'У урока нет теста'));

    const res = recordAttempt(e.id, lesson.test.test_id, parsed.data.answers);
    if (res.passed) markLessonPassedIfReady(e.id, lessonId);
    return res;
  });

  // ---------- аттестация ----------
  app.get('/me/attestation', async (req, reply) => {
    const e = emp(req, reply); if (!e) return;
    const snap = snapshotOf(e.id);
    const block = snap ? attestationBlockOf(snap) : null;
    if (!block?.test) return reply.code(404).send(err('no_attestation', 'Аттестация не настроена'));
    if (!allRegularLessonsPassed(e.id))
      return reply.code(403).send(err('lessons_incomplete', 'Сначала пройдите все уроки'));

    const last = one<any>(
      'SELECT attempt_no, score_pct, passed FROM test_attempts WHERE employee_id = ? AND test_id = ? ORDER BY attempt_no DESC LIMIT 1',
      e.id, block.test.test_id,
    );
    return {
      test_id: block.test.test_id, pass_mark_pct: block.test.pass_mark_pct,
      questions: block.test.questions.map((q) => ({ id: q.question_id, text: q.text, options: q.options })),
      last_attempt: last ? { ...last, passed: !!last.passed } : null,
      completed: e.stage === 'completed',
    };
  });

  app.post('/me/attestation', async (req, reply) => {
    const e = emp(req, reply); if (!e) return;
    const parsed = answersSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(err('bad_request', 'Некорректные ответы'));
    try {
      return submitAttestation(e.id, parsed.data.answers);
    } catch (e2: any) {
      const map: Record<string, string> = {
        no_attestation: 'Аттестация не настроена',
        lessons_incomplete: 'Сначала пройдите все уроки',
      };
      return reply.code(422).send(err(e2.message, map[e2.message] ?? 'Не удалось'));
    }
  });
}
