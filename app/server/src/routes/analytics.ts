import type { FastifyInstance } from 'fastify';
import { all, one } from '../db.ts';
import { authRequired } from '../auth.ts';
import { daysBetweenStamps as daysBetween } from '../clock.ts';
import { isOverdue } from '../domain.ts';
import { funnelByPosition } from '../funnel.ts';


export default async function analyticsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authRequired('hr', 'admin'));

  app.get('/analytics', async (req) => {
    // Разрез по точке: наполнение у точек разное, и общая по сети воронка
    // прячет ту точку, где люди застревают.
    const location = ((req.query as Record<string, string>)?.location || '').trim() || undefined;
    const emps = all<any>('SELECT * FROM employees');

    const byStage = { intern: 0, onboarding: 0, completed: 0, archived: 0 } as Record<string, number>;
    for (const e of emps) byStage[e.stage] = (byStage[e.stage] ?? 0) + 1;

    const overdue = emps.filter(isOverdue).length;

    const durations = emps
      .filter((e) => e.stage === 'completed' && e.onboarding_opened_at && e.completed_at)
      .map((e) => daysBetween(e.onboarding_opened_at, e.completed_at));
    const avgOnboardingDays = durations.length
      ? Math.round((durations.reduce((s, d) => s + d, 0) / durations.length) * 10) / 10
      : null;

    // Сравнение точек — то, чего у руководства раньше не было вовсе.
    // Считаем по одинаковым правилам, поэтому цифры сопоставимы между точками.
    const by_location = all<any>('SELECT * FROM locations WHERE is_active = 1 ORDER BY ord, name')
      .map((loc) => {
        const here = emps.filter((e) => e.location_id === loc.id);
        const done = here.filter((e) => e.stage === 'completed');
        const dur = done
          .filter((e) => e.onboarding_opened_at && e.completed_at)
          .map((e) => daysBetween(e.onboarding_opened_at, e.completed_at));
        // Доля дошедших считается от тех, кто вообще начал учиться: делить на
        // всех вместе со стажёрами значило бы занижать точку, которая недавно
        // набрала людей.
        const started = here.filter((e) => e.stage === 'onboarding' || e.stage === 'completed').length;
        return {
          location_id: loc.id,
          name: loc.name,
          total: here.filter((e) => e.stage !== 'archived').length,
          intern: here.filter((e) => e.stage === 'intern').length,
          onboarding: here.filter((e) => e.stage === 'onboarding').length,
          completed: done.length,
          overdue: here.filter(isOverdue).length,
          completion_pct: started ? Math.round((done.length / started) * 100) : null,
          avg_onboarding_days: dur.length
            ? Math.round((dur.reduce((s, d) => s + d, 0) / dur.length) * 10) / 10
            : null,
        };
      });

    // Самые проваливаемые тесты по сети: где люди спотыкаются чаще всего.
    const hardest = all<any>(`
      SELECT test_id,
             COUNT(*) attempts,
             SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) passed
        FROM test_attempts
       GROUP BY test_id
      HAVING attempts >= 3
    `).map((r) => {
      const fail_pct = Math.round(((r.attempts - r.passed) / r.attempts) * 100);
      // Название урока живёт в снимках, а не в живом каталоге: тест могли удалить.
      const lesson = one<{ title: string }>(
        'SELECT l.title FROM lessons l JOIN tests t ON t.lesson_id = l.id WHERE t.id = ?', r.test_id,
      );
      const block = lesson ? null : one<{ title: string }>(
        'SELECT b.title FROM blocks b JOIN tests t ON t.block_id = b.id WHERE t.id = ?', r.test_id,
      );
      return { title: lesson?.title ?? block?.title ?? 'Удалённый тест', attempts: r.attempts, fail_pct };
    }).filter((x) => x.fail_pct > 0)
      .sort((a, b) => b.fail_pct - a.fail_pct)
      .slice(0, 5);

    return {
      by_stage: byStage, total: emps.length, overdue,
      avg_onboarding_days: avgOnboardingDays,
      by_location, hardest,
      funnel: funnelByPosition(location),
    };
  });

  /**
   * ЧТО ЖДЁТ ЧЕЛОВЕКА. Маленький и дешёвый ответ — его спрашивает каждый экран
   * кадровика, чтобы показать цифру в боковом меню.
   *
   * Уведомлений в системе нет по решению заказчика, и это оставляет слепое
   * пятно: стажёр прочитал пре-онбординг, нажал «Продолжить» и ждёт, пока
   * кадровик отметит стажировку. Кадровик об этом не узнает, пока не зайдёт
   * в список. Цифра в меню и есть замена уведомлению: она видна отовсюду.
   */
  app.get('/attention', async () => {
    const waiting = all<{ n: number }>(
      `SELECT COUNT(*) n FROM employees
        WHERE stage = 'intern' AND pre_onboarding_done = 1 AND internship_passed = 0`,
    )[0]?.n ?? 0;
    const overdue = all<any>(`SELECT * FROM employees WHERE stage = 'onboarding'`)
      .filter(isOverdue).length;
    return { waiting_internship: waiting, overdue };
  });

  // Журнал действий переехал к администратору — см. routes/users.ts.
}
