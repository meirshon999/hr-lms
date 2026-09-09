import type { FastifyInstance } from 'fastify';
import { all, one } from '../db.ts';
import { authRequired } from '../auth.ts';
import { isOverdue } from '../domain.ts';
import { regularBlocks, snapshotOf } from '../snapshot.ts';
import { auditRecent } from '../audit.ts';

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

export default async function analyticsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authRequired('hr', 'admin'));

  app.get('/analytics', async () => {
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

    // Воронка строится по снимку каждого сотрудника: блоки берём из снимка
    // того, кто дальше всех — так видно реальную структуру когорты.
    const positions = all<any>('SELECT * FROM positions ORDER BY name');
    const funnel = positions.map((pos) => {
      const cohort = emps.filter(
        (e) => e.position_id === pos.id && (e.stage === 'onboarding' || e.stage === 'completed'),
      );
      if (cohort.length === 0) return null;

      const snaps = cohort.map((e) => ({ e, snap: snapshotOf(e.id) })).filter((x) => x.snap);
      if (snaps.length === 0) return null;
      const reference = snaps.reduce((best, x) =>
        regularBlocks(x.snap!).length > regularBlocks(best.snap!).length ? x : best, snaps[0]);

      const blocks = regularBlocks(reference.snap!).map((b) => {
        const passed = snaps.filter(({ e, snap }) => {
          const myBlock = regularBlocks(snap!).find((x) => x.block_id === b.block_id);
          if (!myBlock || myBlock.lessons.length === 0) return false;
          return myBlock.lessons.every((l) =>
            one<{ status: string }>(
              'SELECT status FROM lesson_progress WHERE employee_id = ? AND lesson_id = ?', e.id, l.lesson_id,
            )?.status === 'passed');
        }).length;
        return { title: b.title, passed };
      });

      return {
        position: pos.name,
        cohort: cohort.length,
        blocks,
        attested: cohort.filter((e) => e.stage === 'completed').length,
      };
    }).filter(Boolean);

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
      by_location, hardest, funnel,
    };
  });

  app.get('/audit', async (req) => {
    const limit = Number((req.query as any)?.limit ?? 100);
    return { items: auditRecent(Math.min(Math.max(limit, 1), 500)) };
  });
}
