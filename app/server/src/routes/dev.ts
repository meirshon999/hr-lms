import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, migrate, run, wipe } from '../db.ts';
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

  /**
   * ПЕРЕМОТКА ВРЕМЕНИ НА МАТЕРИАЛЕ.
   *
   * Доказательство прочтения держится на настоящих часах: чтобы засчитать
   * пятиминутный текст, надо провести на нём пять минут. Для человека это
   * и есть смысл, а для сквозной проверки — пять минут простоя на каждый урок.
   *
   * Поэтому здесь, и только на тестовом сервере, время можно проставить сразу.
   * В боевом режиме этого модуля нет вовсе — он не «закрыт правами», а не
   * зарегистрирован.
   */
  app.post('/dev/study', { preHandler: requireAuth }, async (req, reply) => {
    const p = z.object({
      employee_id: z.string(),
      lesson_id: z.string().optional(),
      seconds: z.number().int().min(0).max(100000).optional(),
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Нужен employee_id'));

    const sec = p.data.seconds ?? 100000;
    if (p.data.lesson_id) {
      run(`UPDATE lesson_progress SET seconds_spent = ?, scroll_pct = 100
            WHERE employee_id = ? AND lesson_id = ?`, sec, p.data.employee_id, p.data.lesson_id);
    } else {
      run('UPDATE lesson_progress SET seconds_spent = ?, scroll_pct = 100 WHERE employee_id = ?',
        sec, p.data.employee_id);
    }
    return { ok: true, seconds: sec };
  });

  /** Список аккаунтов с паролями для экрана входа. Только тестовый сервер. */
  app.get('/demo/accounts', async () => {
    const users = all<any>(`SELECT u.login, u.role, e.full_name, e.stage
                              FROM users u LEFT JOIN employees e ON e.id = u.employee_id
                             WHERE u.is_active = 1 ORDER BY u.role, u.login`);
    return users.map((x) => ({
      login: x.login, password: `${x.login}123`, role: x.role,
      name: x.full_name ?? null, stage: x.stage ?? null,
    }));
  });

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
    seed({ demo: true }); // сброс демо возвращает именно демо-данные, а не боевую пустоту
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
