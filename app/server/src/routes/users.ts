import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, one, run, uuid } from '../db.ts';
import { authRequired, err, hashPassword } from '../auth.ts';
import { audit, auditRecent } from '../audit.ts';

/**
 * АККАУНТЫ СЛУЖЕБНЫХ ЛЮДЕЙ — кадровиков и администраторов.
 *
 * Аккаунты сотрудников живут не здесь: их заводит HR вместе с человеком,
 * в разделе «Сотрудники». Здесь только те, кто работает в системе.
 *
 * Почему это отдельно от HR. Кадровик ведёт людей и содержание, администратор
 * отвечает за доступы и устройство сети. Если раздать всё всем, отключить
 * или завести кадровика сможет сам кадровик — и смысл разделения пропадает.
 *
 * Удаления здесь нет намеренно. На логин ссылается журнал действий, и стёртый
 * аккаунт превратил бы прошлые записи в бессмыслицу. Отключённый войти не может
 * — этого достаточно, а история остаётся читаемой.
 */

const actor = (req: any) => req?.user?.login ?? 'system';
const newPassword = () => randomBytes(6).toString('base64url');

const createSchema = z.object({
  login: z.string().min(2).max(40).regex(/^[a-zA-Z0-9._-]+$/, 'латиница, цифры, точка, дефис'),
  role: z.enum(['hr', 'admin']),
  /** Не задан — придумаем сами и покажем один раз. */
  password: z.string().min(6).max(72).optional(),
});

export default async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authRequired('admin'));

  app.get('/users', async () => ({
    items: all<any>(
      `SELECT id, login, role, is_active, must_change_password
         FROM users WHERE role IN ('hr','admin') ORDER BY role, login`,
    ).map((u) => ({
      id: u.id, login: u.login, role: u.role,
      is_active: !!u.is_active,
      must_change_password: !!u.must_change_password,
    })),
  }));

  app.post('/users', async (req, reply) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) {
      return reply.code(400).send(err('bad_request', p.error.issues[0]?.message ?? 'Проверьте поля'));
    }
    // Логин должен быть уникален среди всех, включая сотрудников: по нему входят.
    if (one('SELECT 1 FROM users WHERE login = ?', p.data.login)) {
      return reply.code(422).send(err('login_exists', 'Такой логин уже занят'));
    }

    const password = p.data.password ?? newPassword();
    const id = uuid();
    run(
      `INSERT INTO users (id, login, password_hash, role, must_change_password)
       VALUES (?,?,?,?,1)`,
      id, p.data.login, hashPassword(password), p.data.role,
    );
    audit(actor(req), 'user_create', null, `${p.data.role} ${p.data.login}`);
    // Пароль показываем один раз: в базе он лежит только свёрткой.
    return reply.code(201).send({ id, login: p.data.login, role: p.data.role, password });
  });

  app.patch('/users/:id', async (req, reply) => {
    const p = z.object({ is_active: z.boolean() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send(err('bad_request', 'Нужно поле is_active'));

    const id = (req.params as any).id;
    const u = one<any>(`SELECT id, login, role FROM users WHERE id = ? AND role IN ('hr','admin')`, id);
    if (!u) return reply.code(404).send(err('not_found', 'Аккаунт не найден'));

    // Защита от запертой двери, и её достаточно одной: отключить может только
    // действующий администратор, а себя он отключить не вправе — значит хотя бы
    // один живой администратор в системе остаётся всегда.
    if (!p.data.is_active && id === (req as any).user.id) {
      return reply.code(422).send(err('self_disable', 'Нельзя отключить собственный аккаунт'));
    }

    run('UPDATE users SET is_active = ? WHERE id = ?', p.data.is_active ? 1 : 0, id);
    audit(actor(req), p.data.is_active ? 'user_enable' : 'user_disable', null, u.login);
    return { id, is_active: p.data.is_active };
  });

  app.post('/users/:id/reset-password', async (req, reply) => {
    const id = (req.params as any).id;
    const u = one<any>(`SELECT id, login FROM users WHERE id = ? AND role IN ('hr','admin')`, id);
    if (!u) return reply.code(404).send(err('not_found', 'Аккаунт не найден'));

    const password = newPassword();
    run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?',
      hashPassword(password), id);
    audit(actor(req), 'user_reset_password', null, u.login);
    return { login: u.login, password };
  });

  /**
   * Журнал действий. Раньше был доступен и кадровику — то есть человек мог
   * читать записи о самом себе. Смысл журнала в том, чтобы его читал кто-то
   * другой, поэтому он переехал сюда.
   */
  app.get('/audit', async (req) => {
    const limit = Number((req.query as any)?.limit ?? 100);
    return { items: auditRecent(Math.min(Math.max(limit, 1), 500)) };
  });
}
