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

    return { by_stage: byStage, total: emps.length, overdue, avg_onboarding_days: avgOnboardingDays, funnel };
  });

  app.get('/audit', async (req) => {
    const limit = Number((req.query as any)?.limit ?? 100);
    return { items: auditRecent(Math.min(Math.max(limit, 1), 500)) };
  });
}
