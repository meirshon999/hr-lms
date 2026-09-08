import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, migrate, wipe } from '../db.ts';
import { advanceDays, clearOverride, isOverridden, setToday, today } from '../clock.ts';
import { seed } from '../seed.ts';
import { isOverdue, tryOpenOnboarding } from '../domain.ts';
import { loadUser, err } from '../auth.ts';
import { clearEvents, emit, recentEvents } from '../events.ts';

const overdueSeen = new Set<string>();

/**
 * Служебные ручки прототипа: демо-часы и полный сброс.
 * В реальной версии этого модуля нет.
 */
export default async function devRoutes(app: FastifyInstance) {
  const requireAuth = async (req: any, reply: any) => {
    if (!loadUser(req)) return reply.code(401).send(err('unauthorized', 'Нужен вход'));
  };

  app.get('/dev/clock', async () => ({ today: today(), overridden: isOverridden() }));

  app.post('/dev/clock', { preHandler: requireAuth }, async (req, reply) => {
    const p = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Формат даты YYYY-MM-DD'));
    setToday(p.data.date);
    runJobs();
    return { today: today(), overridden: isOverridden() };
  });

  app.post('/dev/clock/advance', { preHandler: requireAuth }, async (req, reply) => {
    const p = z.object({ days: z.number().int() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'days — целое число'));
    advanceDays(p.data.days);
    runJobs();
    return { today: today(), overridden: isOverridden() };
  });

  app.post('/dev/clock/reset', { preHandler: requireAuth }, async () => {
    clearOverride();
    return { today: today(), overridden: isOverridden() };
  });

  app.post('/dev/reset', { preHandler: requireAuth }, async () => {
    wipe();
    migrate();
    clearEvents();
    overdueSeen.clear();
    seed();
    return { ok: true };
  });

  app.get('/dev/events', async () => ({ events: recentEvents() }));
}

/** «ежедневные джобы»: интерны (кнопка стажировки) + пометка просрочки. */
function runJobs() {
  for (const e of all<{ id: string }>(`SELECT id FROM employees WHERE stage = 'intern'`)) {
    tryOpenOnboarding(e.id);
  }
  for (const e of all<any>(`SELECT * FROM employees WHERE stage = 'onboarding'`)) {
    if (isOverdue(e) && !overdueSeen.has(e.id)) {
      overdueSeen.add(e.id);
      emit('просрочка', `${e.full_name} — дедлайн ${e.onboarding_due_date} прошёл`);
    }
  }
}
